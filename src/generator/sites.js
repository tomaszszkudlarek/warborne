import { Tile, Flag, SiteTypes, RUIN_TYPES, SHRINE_TYPES } from './terrainTypes.js';
import { toCellX, toCellZ } from './grid.js';
import { shuffle } from '../core/rng.js';
import { NAME_A, NAME_B } from './settlements.js';

// How well each site type fits a tile type (0 = never). Caves also like
// mountains nearby; see `mountainBonus`.
const SUIT = {
  tower: { [Tile.PLAINS]: 1, [Tile.HILLS]: 1.6, [Tile.FOREST]: 0.7, [Tile.SHORE]: 0.8, [Tile.ICE]: 0.7, [Tile.SWAMP]: 0.3 },
  cave: { [Tile.HILLS]: 1.5, [Tile.FOREST]: 0.5, [Tile.PLAINS]: 0.25, [Tile.ICE]: 0.6, [Tile.VOLCANIC]: 0.4 },
  dungeon: { [Tile.PLAINS]: 1, [Tile.FOREST]: 1.2, [Tile.HILLS]: 1, [Tile.SWAMP]: 0.6, [Tile.ICE]: 0.4 },
  temple: { [Tile.PLAINS]: 1.3, [Tile.SHORE]: 1.2, [Tile.HILLS]: 0.9, [Tile.FOREST]: 0.6 },
  crypt: { [Tile.SWAMP]: 1.6, [Tile.FOREST]: 1.2, [Tile.PLAINS]: 0.8, [Tile.HILLS]: 0.5, [Tile.ICE]: 0.3 },
  circle: { [Tile.PLAINS]: 1.2, [Tile.HILLS]: 1.2, [Tile.FOREST]: 0.6, [Tile.ICE]: 0.8, [Tile.SHORE]: 0.6 },
  sanctum: { [Tile.PLAINS]: 1.2, [Tile.HILLS]: 1, [Tile.SHORE]: 1.2, [Tile.FOREST]: 0.5 },
  obelisk: { [Tile.ICE]: 1.5, [Tile.SWAMP]: 1, [Tile.PLAINS]: 0.7, [Tile.HILLS]: 0.8, [Tile.FOREST]: 0.5 },
};
const BLOCK = Flag.RIVER | Flag.ROAD | Flag.BRIDGE | Flag.CITY | Flag.LAVA | Flag.LAKE | Flag.PORT;
const KEEP_CLEAR = Flag.RIVER | Flag.CITY | Flag.LAVA | Flag.LAKE | Flag.BRIDGE;

/** Type sequence with every type used before any repeats, e.g. 8 ruins -> each of 5 once, then 3 more. */
function typeSequence(types, count, rng) {
  const seq = [];
  while (seq.length < count) seq.push(...shuffle(rng, [...types]));
  return seq.slice(0, count);
}

/**
 * Places ruins and shrines on single tiles away from cities, roads and water.
 * Each type prefers certain terrain; sites are spread apart like cities are.
 * Every site is reachable on foot from some city (same land region), and none
 * sits on a volcano's slopes; shrines stay off volcanic ground altogether.
 */
export function placeSites(g, tiles, flags, tileH, cities, params, rng, region, volcanoes) {
  const { tilesW: W, tilesH: H } = g;
  const nRuins = Math.max(0, params.ruins | 0), nShrines = Math.max(0, params.shrines | 0);
  if (!nRuins && !nShrines) return [];

  const cityRegions = new Set(cities.map((c) => c.region));
  const onVolcano = (tx, ty) => volcanoes.some((v) => {
    const x = (tx + 0.5) * g.tileSize, z = (ty + 0.5) * g.tileSize; // volcano cx/cz are map-corner based
    return Math.hypot(x - v.cx, z - v.cz) < v.radius * 1.6 + g.tileSize;
  });

  // candidate tiles: dry, fairly level, reachable, with a clear ring around them
  const cands = [];
  for (let ty = 1; ty < H - 1; ty++) {
    for (let tx = 1; tx < W - 1; tx++) {
      const t = ty * W + tx;
      const type = tiles[t];
      if (type === Tile.WATER || type === Tile.MOUNTAINS || flags[t] & BLOCK) continue;
      if (!cityRegions.has(region[t]) || onVolcano(tx, ty)) continue;
      let ok = true, mountains = 0;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = (ty + dy) * W + tx + dx;
          if (tiles[n] === Tile.WATER || flags[n] & KEEP_CLEAR || Math.abs(tileH[n] - tileH[t]) > 1.3) { ok = false; break; }
          if (tiles[n] === Tile.MOUNTAINS) mountains++;
        }
      }
      if (ok) cands.push({ t, tx, ty, type, mountainBonus: Math.min(1, mountains / 3) });
    }
  }
  const cityPts = cities.map((c) => [c.tx + 0.5, c.ty + 0.5]);

  // interleave ruins and shrines so neither kind gets only the leftovers
  const ruinSeq = typeSequence(RUIN_TYPES, nRuins, rng);
  const shrineSeq = typeSequence(SHRINE_TYPES, nShrines, rng);
  const order = [];
  for (let i = 0, r = 0, s = 0; i < nRuins + nShrines; i++) {
    if (s >= nShrines || (r < nRuins && r / nRuins <= s / nShrines)) order.push(ruinSeq[r++]);
    else order.push(shrineSeq[s++]);
  }

  const minD = Math.sqrt((W * H) / (nRuins + nShrines + cities.length + 1)) * 0.55;
  const sites = [];
  const usedNames = new Set();
  for (const kind of order) {
    const suit = SUIT[kind];
    let best = null, bestScore = 0;
    for (const relax of [1, 0.7, 0.45, 0.2]) {
      if (best) break;
      for (const c of cands) {
        let s = suit[c.type] || 0;
        if (SiteTypes[kind].kind === 'shrine' && c.type === Tile.VOLCANIC) s = 0;
        if (kind === 'cave') s += c.mountainBonus * 1.2;
        if (s <= 0) continue;
        let dmin = Infinity;
        for (const p of cityPts) dmin = Math.min(dmin, Math.hypot(p[0] - c.tx, p[1] - c.ty));
        if (dmin < 3.5) continue;
        for (const o of sites) dmin = Math.min(dmin, Math.hypot(o.tx - c.tx, o.ty - c.ty));
        if (dmin < minD * relax) continue;
        const score = s * (0.45 + rng() * 0.55) * Math.min(1, dmin / (minD * 1.6));
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
    if (!best) continue;
    const info = SiteTypes[kind];
    let name;
    do {
      name = `${info.title} ${NAME_A[Math.floor(rng() * NAME_A.length)]}${NAME_B[Math.floor(rng() * NAME_B.length)]}`;
    } while (usedNames.has(name) && usedNames.size < 400);
    usedNames.add(name);
    const site = {
      kind: info.kind, type: kind, name, tx: best.tx, ty: best.ty,
      x: (best.tx + 0.5) * g.tileSize - g.worldW / 2,
      z: (best.ty + 0.5) * g.tileSize - g.worldH / 2,
      // entrances face roughly south, toward the default camera
      yaw: (rng() - 0.5) * 2.2,
    };
    if (info.kind === 'ruin') site.danger = 1 + Math.floor(rng() * 3);
    sites.push(site);
    flags[best.t] |= info.kind === 'ruin' ? Flag.RUIN : Flag.SHRINE;
  }
  return sites;
}

/** Levels a small pad under each site and records its ground height. */
export function flattenSites(g, h, sites) {
  const { gw, gh, cellSize } = g;
  const r0 = 0.95, r1 = 1.75;
  for (const s of sites) {
    const ci = toCellX(g, s.x), cj = toCellZ(g, s.z);
    const rc = Math.ceil(r1 / cellSize);
    const inner = [];
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = Math.round(ci) + di, j = Math.round(cj) + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      if (Math.hypot(i - ci, j - cj) * cellSize <= r0) inner.push(h[j * gw + i]);
    }
    inner.sort((a, b) => a - b);
    const target = Math.max(0.25, inner[Math.floor(inner.length / 2)] ?? 0.25);
    s.y = target;
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = Math.round(ci) + di, j = Math.round(cj) + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const d = Math.hypot(i - ci, j - cj) * cellSize;
      if (d > r1) continue;
      const t = Math.min(1, Math.max(0, (d - r0) / (r1 - r0)));
      const k = j * gw + i;
      h[k] = target + (h[k] - target) * t * t * (3 - 2 * t);
    }
  }
}
