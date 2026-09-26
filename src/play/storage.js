// Maps and saved games.
//
// Maps: every *.wlmap file in the project's maps/ folder (made with the Map Forge, forge.html,
// "Save map for the game", or tools/make-map.mjs) is listed in the New Game screen. Vite picks
// the folder up at build time and in the dev server.
// Saves: in the browser's IndexedDB (plus an autosave at the start of every human turn), and as
// .wlsave files to download / open. A save names its map file; the map must still be in maps/.
import { decodeMap } from '../core/mapfile.js';

const MAP_URLS = import.meta.glob('/maps/*.wlmap', { query: '?url', import: 'default', eager: true });

/** [{ file, url }] of the maps in maps/. */
export function listMaps() {
  return Object.entries(MAP_URLS).map(([path, url]) => ({ file: path.split('/').pop(), url })).sort((a, b) => a.file.localeCompare(b.file));
}

const mapCache = new Map();
/** Loads and decodes a map by file name (or a File the player opened). */
export async function loadMap(file) {
  if (file instanceof Blob) return decodeMap(await file.arrayBuffer());
  if (mapCache.has(file)) return mapCache.get(file);
  const entry = listMaps().find((m) => m.file === file);
  if (!entry) throw new Error(`Map "${file}" is not in the maps folder`);
  const p = fetch(entry.url).then((r) => { if (!r.ok) throw new Error(`Could not load ${file}`); return r.arrayBuffer(); }).then(decodeMap);
  mapCache.set(file, p);
  p.catch(() => mapCache.delete(file));
  return p;
}

// --- IndexedDB saves ---------------------------------------------------------------------------------
const DB = 'warlords', STORE = 'saves';
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

/** Saves a game state under `name` ('autosave' replaces the previous autosave). */
export async function saveGame(state, name) {
  const id = name === 'autosave' ? 'autosave' : `${Date.now()}`;
  const rec = {
    id, name, date: new Date().toISOString(), map: state.map.name, mapFile: state.map.file, round: state.round,
    players: state.players.map((p) => ({ name: p.name, color: p.color, human: p.human, alive: p.alive })),
    state: JSON.stringify(state),
  };
  await tx('readwrite', (s) => s.put(rec));
  return rec;
}

export async function listSaves() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => b.date.localeCompare(a.date));
}
export const deleteSave = (id) => tx('readwrite', (s) => s.delete(id));
export async function getSave(id) { return tx('readonly', (s) => s.get(id)); }

export function downloadSave(state) {
  const blob = new Blob([JSON.stringify({ format: 'warlords-save/1', state })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `warlords-${state.map.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-day${state.round}.wlsave`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function readSaveFile(file) {
  const j = JSON.parse(await file.text());
  if (j.format !== 'warlords-save/1') throw new Error('Not a Warlords save file');
  return j.state;
}
