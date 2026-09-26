// Headless generator check: `node tools/preview.mjs [seed] [preset] [out.png]`
// Writes a top-down shaded preview of the generated map and prints stats.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateMap } from '../src/generator/generate.js';
import { presets } from '../src/generator/params.js';
import { Tile, TileInfo, Flag } from '../src/generator/terrainTypes.js';

const seed = Number(process.argv[2] ?? 20240);
const preset = process.argv[3] ?? 'Classic Continent';
const out = process.argv[4] ?? 'preview.png';

const map = generateMap({ ...presets[preset], seed }, (stage, p) => process.stdout.write(`\r${stage.padEnd(28)} ${(p * 100) | 0}%   `));
console.log('\n');
const { grid: g, heights: h, splatA, splatB, climate } = map;
const { gw, gh } = g;

// stats
let land = 0, maxH = -1e9, minH = 1e9;
for (const v of h) { if (v >= 0) land++; maxH = Math.max(maxH, v); minH = Math.min(minH, v); }
const tileCounts = {};
for (const t of map.tiles) tileCounts[TileInfo[t].name] = (tileCounts[TileInfo[t].name] || 0) + 1;
let rv = 0, rd = 0, br = 0;
for (const f of map.flags) { if (f & Flag.RIVER) rv++; if (f & Flag.ROAD) rd++; if (f & Flag.BRIDGE) br++; }
console.log({
  ms: map.stats.ms, grid: `${gw}x${gh}`, land: (land / h.length).toFixed(2), minH: minH.toFixed(2), maxH: maxH.toFixed(2),
  rivers: map.rivers.length, lakes: map.lakes.length, cities: map.cities.length, bridges: map.bridges.length,
  riverTiles: rv, roadTiles: rd, volcanoes: map.volcanoes.length,
  sites: map.sites.map((s) => s.type).join(' '),
  veg: Object.fromEntries(Object.entries(map.vegetation).map(([k, v]) => [k, v.length / 5])),
});
console.log(tileCounts);

// render
const S = 2; // pixels per cell
const W = gw * S, H = gh * S;
const img = new Uint8Array(W * H * 3);
const col = {
  plains: [120, 150, 70], forest: [45, 80, 35], swamp: [70, 80, 50], sand: [205, 190, 140],
  ice: [225, 235, 245], volc: [50, 40, 38], rock: [120, 115, 110],
};
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    const i = Math.min(gw - 2, (px / S) | 0), j = Math.min(gh - 2, (py / S) | 0);
    const k = j * gw + i;
    const a = splatA.subarray(k * 4, k * 4 + 4), b = splatB.subarray(k * 4, k * 4 + 4);
    const rockW = climate[k * 4 + 3] / 255;
    let c = [0, 0, 0], ws = 0;
    const add = (cc, wt) => { c[0] += cc[0] * wt; c[1] += cc[1] * wt; c[2] += cc[2] * wt; ws += wt; };
    add(col.plains, a[0]); add(col.forest, a[1]); add(col.swamp, a[2]); add(col.sand, a[3]);
    add(col.ice, b[0]); add(col.volc, b[1]);
    c = c.map((v) => v / Math.max(1, ws));
    const dx = h[k + 1] - h[k], dz = h[k + gw] - h[k];
    const slope = Math.hypot(dx, dz) / g.cellSize;
    const rk = Math.max(rockW * 0.8, Math.min(1, Math.max(0, (slope - 0.7) / 0.6)));
    c = c.map((v, q) => v * (1 - rk) + col.rock[q] * rk);
    if (h[k] > 7 && climate[k * 4] < 120) c = c.map((v) => v * 0.4 + 240 * 0.6);
    const shade = Math.max(0.35, Math.min(1.4, 1 + (-dx + dz * -0.6) * 0.9));
    c = c.map((v) => v * shade);
    if (h[k] < 0 || !Number.isNaN(map.lakeLevel[k])) {
      const d = Number.isNaN(map.lakeLevel[k]) ? -h[k] : map.lakeLevel[k] - h[k];
      const t = Math.min(1, d / 4);
      c = [30 + 40 * (1 - t), 80 + 60 * (1 - t), 130 + 50 * (1 - t)];
      if (climate[k * 4] / 255 < map.iceThreshold) c = [200, 220, 235];
    }
    if (b[2] > 128) c = [255, 90, 20];
    if (b[3] > 140) c = c.map((v, q) => v * 0.4 + [150, 120, 80][q] * 0.6);
    const o = (py * W + px) * 3;
    img[o] = Math.max(0, Math.min(255, c[0])); img[o + 1] = Math.max(0, Math.min(255, c[1])); img[o + 2] = Math.max(0, Math.min(255, c[2]));
  }
}
const plot = (x, z, rgb, r = 1) => {
  const px = ((x + g.worldW / 2) / g.cellSize) * S, py = ((z + g.worldH / 2) / g.cellSize) * S;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const X = Math.round(px + dx), Y = Math.round(py + dy);
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    img.set(rgb, (Y * W + X) * 3);
  }
};
for (const r of map.rivers) for (let p = 0; p < r.x.length; p++) plot(r.x[p], r.z[p], [40, 110, 200], Math.max(0, Math.round((r.w[p] / g.cellSize) * S * 0.35)));
for (const b of map.bridges) plot(b.x, b.z, [255, 0, 255], 3);
for (const c of map.cities) plot(c.x, c.z, c.owner >= 0 ? [255, 255, 0] : [200, 200, 200], 4);
for (const s of map.sites) plot(s.x, s.z, s.kind === 'ruin' ? [40, 20, 10] : [120, 220, 255], 3);

// PNG encode
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out);
