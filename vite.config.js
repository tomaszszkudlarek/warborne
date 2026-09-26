import { defineConfig } from 'vite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Pages: the game (index.html), the map generator (forge.html) and the spell effects bench.
const pages = ['index.html', 'forge.html', 'spellfx.html'].filter((f) => existsSync(f));

// The game's music: public/music/<mood>/* is served as is; `virtual:music` lists the tracks of
// every mood folder ({ background: [url, …], battle: […], … }), so dropping a file in is enough.
const MUSIC_DIR = resolve('public/music');
const AUDIO = /\.(mp3|ogg|wav|m4a|flac)$/i;
function musicList() {
  let base = '/';
  const id = 'virtual:music', rid = '\0' + id;
  return {
    name: 'music-list',
    configResolved(c) { base = c.base; },
    resolveId: (x) => (x === id ? rid : null),
    load(x) {
      if (x !== rid) return null;
      const moods = {};
      if (existsSync(MUSIC_DIR)) {
        for (const mood of readdirSync(MUSIC_DIR)) {
          const dir = resolve(MUSIC_DIR, mood);
          if (!statSync(dir).isDirectory()) continue;
          moods[mood] = readdirSync(dir).filter((f) => AUDIO.test(f)).sort()
            .map((f) => `${base}music/${encodeURIComponent(mood)}/${encodeURIComponent(f)}`);
        }
      }
      return `export default ${JSON.stringify(moods)};`;
    },
    configureServer(server) {
      const changed = (f) => {
        if (!resolve(f).startsWith(MUSIC_DIR)) return;
        const m = server.moduleGraph.getModuleById(rid);
        if (m) server.moduleGraph.invalidateModule(m);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', changed);
      server.watcher.on('unlink', changed);
    },
  };
}

// The game's version (package.json; `npm run bump -- patch|minor`), shown on the title screen.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

export default defineConfig({
  plugins: [musicList()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: Object.fromEntries(pages.map((f) => [f.replace('.html', ''), f])) },
  },
});
