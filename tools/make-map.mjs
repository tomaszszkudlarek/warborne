// Generates a map headlessly and saves it for the game:
//   node tools/make-map.mjs <seed> "<preset>" "<Map name>" [key=value ...]
// e.g. node tools/make-map.mjs 777 "Twin Realms" "Twin Realms" cities=18 factions=4
// The file lands in maps/ (the folder the game reads its maps from).
import { writeFileSync } from 'node:fs';
import { generateMap } from '../src/generator/generate.js';
import { presets } from '../src/generator/params.js';
import { encodeMap, MAP_FILE_EXT } from '../src/core/mapfile.js';

const [seedArg, preset = 'Classic Continent', name = `Map ${seedArg}`, ...rest] = process.argv.slice(2);
const params = { ...presets[preset], seed: Number(seedArg ?? 20240) };
for (const kv of rest) {
  const [k, v] = kv.split('=');
  params[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
}
const map = generateMap(params);
const bytes = await encodeMap(map, { name, preset });
const file = `maps/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}${MAP_FILE_EXT}`;
writeFileSync(file, bytes);
console.log(`${file}: ${map.grid.tilesW}x${map.grid.tilesH}, ${map.cities.length} cities, ${map.sites.length} sites, ${(bytes.length / 1024).toFixed(0)} KB`);
