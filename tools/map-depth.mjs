// Strategic depth of maps: cities per side, and the median number of turns a 16-MP army needs
// from each capital to the nearest other capital (minCap: the closest pair) and the nearest city.
//   node tools/map-depth.mjs [maps/x.wlmap ...]   (no files: every map in maps/)
import { readFileSync, readdirSync } from 'node:fs';
import { decodeMap } from '../src/core/mapfile.js';
import { Movement } from '../src/game/movement.js';
export async function depth(map) {
  const W = map.grid.tilesW;
  const mv = new Movement(map);
  const caps = map.cities.filter((c) => c.capital);
  const T = (c) => (c.ty + 1) * W + c.tx; // the gate side doesn't matter much here
  const res = [];
  for (const a of caps) {
    const r = mv.reachable({ bonuses: [], fly: false }, T(a), 16 * 40);
    const cost = (c) => { let best = Infinity; for (const t of [c.ty * W + c.tx, c.ty * W + c.tx + 1, (c.ty + 1) * W + c.tx, (c.ty + 1) * W + c.tx + 1]) { const v = r.get ? r.get(t) : r[t]; if (v != null && v < best) best = v; } return best; };
    const capT = Math.min(...caps.filter((c) => c !== a).map(cost)) / 16;
    const nearT = Math.min(...map.cities.filter((c) => c !== a).map(cost)) / 16;
    res.push({ capT, nearT });
  }
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[s.length >> 1]; };
  return { side: (map.cities.length / caps.length).toFixed(1), capTurns: med(res.map((x) => x.capT)).toFixed(1), minCap: Math.min(...res.map((x) => x.capT)).toFixed(1), nearTurns: med(res.map((x) => x.nearT)).toFixed(1) };
}
if (process.argv[1].endsWith('map-depth.mjs')) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('maps').map((f) => `maps/${f}`);
  for (const f of files) {
    const m = await decodeMap(readFileSync(f));
    console.log(f.padEnd(32), `${m.grid.tilesW}x${m.grid.tilesH}`, JSON.stringify(await depth(m)));
  }
}
