// Shrinks the built models for deployment (run by `npm run build` on dist/models; public/models
// stays as Blender exports it): textures to WebP (gltf-transform), then geometry and animation
// meshopt-compressed (gltfpack). Node, mesh and material names and clips are kept, and positions
// stay float (-vpf), since the structure code takes mesh geometry without its node transform.
// The loader decodes it (gltfLoader in src/render/Assets.js). Files already packed are skipped.
//
//   node tools/pack-models.mjs [dir]        (default dist/models)
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = resolve('node_modules/.bin');
const dir = resolve(process.argv[2] ?? 'dist/models');

const files = (function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : f.endsWith('.glb') ? [p] : [];
  });
})(dir);

function packed(file) {
  const b = readFileSync(file);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)));
  return (json.extensionsUsed ?? []).includes('EXT_meshopt_compression');
}

async function pack(file) {
  const tmp = `${file}.webp.glb`, out = `${file}.pack.glb`;
  try {
    await run(join(BIN, 'gltf-transform'), ['webp', file, tmp, '--quality', '85']);
    await run(join(BIN, 'gltfpack'), ['-i', tmp, '-o', out, '-cc', '-kn', '-km', '-ke', '-vpf']);
    renameSync(out, file);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(out, { force: true });
  }
}

let before = 0, after = 0, done = 0;
const queue = files.filter((f) => !packed(f));
async function worker() {
  for (let f; (f = queue.shift()); ) {
    const size = statSync(f).size;
    await pack(f);
    before += size;
    after += statSync(f).size;
    console.log(`[${++done}/${files.length}] ${f.slice(dir.length + 1)}  ${(size / 1e6).toFixed(1)} → ${(statSync(f).size / 1e6).toFixed(1)} MB`);
  }
}
await Promise.all(Array.from({ length: Math.min(4, cpus().length) }, worker));
console.log(`Packed ${done} models: ${(before / 1e6).toFixed(0)} → ${(after / 1e6).toFixed(0)} MB`);
