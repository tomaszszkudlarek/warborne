import { Tile, Flag } from './terrainTypes.js';
import { toCellX, toCellZ } from './grid.js';
import { NAME_A, NAME_B } from './settlements.js';

// Quay top above sea level; matches QUAY_TOP in tools/blender/build_ports.py.
export const PORT_QUAY = 0.32;
// Islets smaller than this (in tiles) without a city don't need a harbour.
const MIN_ISLAND = 8;

const DIRS = [
  { name: 'N', dx: 0, dy: -1 }, { name: 'E', dx: 1, dy: 0 },
  { name: 'S', dx: 0, dy: 1 }, { name: 'W', dx: -1, dy: 0 },
];
const BLOCK = Flag.CITY | Flag.RIVER | Flag.LAKE | Flag.LAVA | Flag.BRIDGE | Flag.RUIN | Flag.SHRINE;
const isSea = (tiles, flags, t) => tiles[t] === Tile.WATER && !(flags[t] & (Flag.LAKE | Flag.FROZEN));

/**
 * Labels connected bodies of open sea (4-connected water that is neither lake nor
 * frozen). Ships sail only within one body. Returns { id per tile (-1 = not sea), sizes }.
 */
export function seaBodies(g, tiles, flags) {
  const { tilesW: W, tilesH: H } = g;
  const id = new Int32Array(W * H).fill(-1);
  const sizes = [];
  const stack = [];
  for (let t0 = 0; t0 < W * H; t0++) {
    if (id[t0] >= 0 || !isSea(tiles, flags, t0)) continue;
    const k = sizes.length;
    let n = 0;
    id[t0] = k;
    stack.push(t0);
    while (stack.length) {
      const t = stack.pop();
      n++;
      const x = t % W, y = (t / W) | 0;
      for (const d of DIRS) {
        const nx = x + d.dx, ny = y + d.dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nt = ny * W + nx;
        if (id[nt] < 0 && isSea(tiles, flags, nt)) { id[nt] = k; stack.push(nt); }
      }
    }
    sizes.push(n);
  }
  return { id, sizes };
}

/**
 * Harbours where armies embark and land. Every landmass (land region) with a
 * usable sea coast gets at least one port, so all islands stay connected by sea;
 * the rest of `params.ports` go to the best remaining coast, spread apart and
 * favouring spots near cities. A port sits on a land tile with open sea on one
 * side (its `dir`), the pier reaching out over the sea tile `seaTx, seaTy`.
 */
export function placePorts(g, tiles, flags, tileH, cities, params, rng, region) {
  const { tilesW: W, tilesH: H } = g;
  const sea = seaBodies(g, tiles, flags);
  // the biggest sea is the one most ports should share
  const mainSea = sea.sizes.indexOf(Math.max(0, ...sea.sizes));

  const cands = [];
  for (let ty = 1; ty < H - 1; ty++) {
    for (let tx = 1; tx < W - 1; tx++) {
      const t = ty * W + tx;
      if (region[t] < 0 || tiles[t] === Tile.WATER || tiles[t] === Tile.MOUNTAINS) continue;
      for (const d of DIRS) {
        const sx = tx + d.dx, sy = ty + d.dy;
        const s = sy * W + sx;
        if (!isSea(tiles, flags, s)) continue;
        // room for the pier and a ship beyond it
        const fx = sx + d.dx, fy = sy + d.dy;
        const deep = fx >= 0 && fy >= 0 && fx < W && fy < H && isSea(tiles, flags, fy * W + fx);
        // open water around the pier, solid land behind the quay
        let water = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const x = sx + ox, y = sy + oy;
          if (x >= 0 && y >= 0 && x < W && y < H && isSea(tiles, flags, y * W + x)) water++;
        }
        const bx = tx - d.dx, by = ty - d.dy;
        const behind = tiles[by * W + bx] !== Tile.WATER;
        let dCity = Infinity;
        for (const c of cities) {
          if (c.region !== region[t]) continue;
          dCity = Math.min(dCity, Math.hypot(c.tx + 0.5 - tx, c.ty + 0.5 - ty));
        }
        // rivers, roads and sites are only a fallback for islands with no better coast
        const blocked = (flags[t] & BLOCK) !== 0;
        let score = 1 + water * 0.25 + (deep ? 1.2 : 0) + (behind ? 0.6 : 0);
        score += dCity < Infinity ? Math.max(0, 2.2 - Math.abs(dCity - 3.5) * 0.35) : 0;
        score -= Math.max(0, tileH[t] - 1.2) * 0.8;
        if (flags[t] & Flag.ROAD) score -= 0.8;
        cands.push({ t, tx, ty, dir: d, s, sx, sy, sea: sea.id[s], region: region[t], score, blocked, deep });
      }
    }
  }

  const ports = [];
  const used = new Set();
  const take = (c) => {
    used.add(c.t);
    ports.push(c);
  };

  // one per landmass (with a city or at least MIN_ISLAND tiles), preferring the main
  // sea so the islands connect to each other
  const regionSize = new Map();
  for (let t = 0; t < W * H; t++) if (region[t] >= 0) regionSize.set(region[t], (regionSize.get(region[t]) || 0) + 1);
  const cityRegions = new Set(cities.map((c) => c.region));
  const regionsWithLand = new Set();
  for (const c of cands) {
    if (cityRegions.has(c.region) || regionSize.get(c.region) >= MIN_ISLAND) regionsWithLand.add(c.region);
  }
  for (const r of [...regionsWithLand].sort((a, b) => a - b)) {
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      if (c.region !== r) continue;
      const s = c.score + (c.sea === mainSea ? 3 : 0) - (c.blocked ? 10 : 0) + rng() * 0.3;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best) take(best);
  }

  // extra ports up to the requested count, spread along the coasts
  const want = Math.max(0, params.ports | 0);
  const minD = Math.sqrt((W * H) / (want + 2)) * 0.45;
  for (const relax of [1, 0.6, 0.35]) {
    while (ports.length < want) {
      let best = null, bestScore = -Infinity;
      for (const c of cands) {
        if (c.blocked || used.has(c.t)) continue;
        let dmin = Infinity;
        for (const p of ports) dmin = Math.min(dmin, Math.hypot(p.tx - c.tx, p.ty - c.ty));
        if (dmin < minD * relax) continue;
        const s = c.score * (0.6 + rng() * 0.4) + Math.min(dmin, minD * 2) * 0.05;
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (!best) break;
      take(best);
    }
  }

  const names = new Set();
  return ports.map((c) => {
    flags[c.t] |= Flag.PORT;
    let name;
    do {
      name = `Port ${NAME_A[Math.floor(rng() * NAME_A.length)]}${NAME_B[Math.floor(rng() * NAME_B.length)]}`;
    } while (names.has(name) && names.size < 400);
    names.add(name);
    const cx = (c.tx + 0.5) * g.tileSize - g.worldW / 2, cz = (c.ty + 0.5) * g.tileSize - g.worldH / 2;
    return {
      name, tx: c.tx, ty: c.ty, dir: c.dir.name, seaTx: c.sx, seaTy: c.sy, sea: c.sea, region: c.region,
      // model origin: the quay edge, on the boundary between the land and sea tiles
      x: cx + c.dir.dx * g.tileSize / 2, z: cz + c.dir.dy * g.tileSize / 2, y: 0,
      yaw: Math.atan2(c.dir.dx, c.dir.dy),
    };
  });
}

/** Whether (x, z) is too near port `p` for a tree: its canopy would hide the quay and the
 * warehouse behind it, and a harbour players can't see is no way off an island. */
export function nearPort(p, x, z) {
  // centre on the land tile behind the quay edge
  const cx = p.x - Math.sin(p.yaw), cz = p.z - Math.cos(p.yaw);
  return Math.hypot(cx - x, cz - z) < 3.2;
}

/** Levels the land behind each quay to the quay top so the warehouse and cargo sit on it. */
export function flattenPorts(g, h, ports) {
  const { gw, gh, cellSize, tileSize } = g;
  for (const p of ports) {
    const dx = Math.sin(p.yaw), dz = Math.cos(p.yaw); // seaward
    const ci = toCellX(g, p.x), cj = toCellZ(g, p.z);
    const rc = Math.ceil((tileSize * 1.3) / cellSize);
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = Math.round(ci) + di, j = Math.round(cj) + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const ox = (i - ci) * cellSize, oz = (j - cj) * cellSize;
      const along = ox * dx + oz * dz; // > 0 out to sea
      const across = Math.abs(-ox * dz + oz * dx);
      if (along > 0.05) continue;
      // full height over the quay footprint (1.9 wide, 1.5 deep), easing out around it
      const ea = Math.max(0, -along - 1.5), ec = Math.max(0, across - 0.95);
      const d = Math.hypot(ea, ec);
      if (d > 0.9) continue;
      const t = Math.min(1, d / 0.9);
      const k = j * gw + i;
      const target = PORT_QUAY - 0.02;
      h[k] = target + (h[k] - target) * t * t * (3 - 2 * t);
    }
  }
}
