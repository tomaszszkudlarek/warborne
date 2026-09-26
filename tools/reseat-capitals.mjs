// Re-picks the capitals of saved maps with the generator's chooseCapitals (farthest apart by
// travel, none marooned alone on an island) and clears trees that hide harbours, keeping the
// terrain as it is:
//   node tools/reseat-capitals.mjs maps/classic-continent.wlmap [more.wlmap ...]
// A side whose capital is still chosen keeps it; the others move to the new capitals.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeMap, encodeMap } from '../src/core/mapfile.js';
import { chooseCapitals } from '../src/generator/settlements.js';
import { nearPort } from '../src/generator/ports.js';
import { CastleLevels } from '../src/generator/terrainTypes.js';
import { Movement } from '../src/game/movement.js';

for (const file of process.argv.slice(2)) {
  const map = await decodeMap(readFileSync(file));
  const { cities } = map;
  const old = cities.filter((c) => c.capital);
  // travel as the game measures it: walking, and sailing only from and to ports
  const move = new Movement(map);
  const costFrom = (t) => { const r = move.reachable({ bonuses: [] }, t, Infinity); return (u) => r.get(u) ?? Infinity; };
  const chosen = chooseCapitals(map.grid, map.tiles, map.flags, cities, old.length, costFrom).map((i) => cities[i]);
  const sides = old.map((c) => c.owner);
  const stay = new Set(chosen.filter((c) => c.capital).map((c) => c.owner));
  const moving = sides.filter((s) => !stay.has(s));
  for (const c of old) if (!chosen.includes(c)) { c.owner = -1; c.capital = false; }
  for (const c of chosen) {
    if (!c.capital) { c.owner = moving.shift(); c.capital = true; }
    c.level = 3;
    c.defense = CastleLevels[3].defense;
  }
  let cleared = 0;
  for (const [kind, v] of Object.entries(map.vegetation)) {
    const keep = [];
    for (let i = 0; i < v.length; i += 5) {
      if (map.ports.some((p) => nearPort(p, v[i], v[i + 2]))) { cleared++; continue; }
      for (let k = 0; k < 5; k++) keep.push(v[i + k]);
    }
    map.vegetation[kind] = new Float32Array(keep);
  }
  writeFileSync(file, await encodeMap(map));
  const moved = chosen.filter((c) => !old.includes(c)).length;
  console.log(`${file}: ${moved} of ${old.length} capitals moved (${chosen.map((c) => c.name).join(', ')}), ${cleared} props cleared from harbours`);
}
