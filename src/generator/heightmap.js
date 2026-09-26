import { makeNoise2D, fbm, ridged } from '../core/noise.js';
import { subRng } from '../core/rng.js';

export const MAX_HEIGHT = 15; // world units at the tallest peaks
export const MAX_DEPTH = 6;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Island seeds for the 'islands' shape: one per cell of a jittered grid, so
 * every island has open sea between it and its neighbours. Positions are in
 * aspect-corrected units (x in [0, aspect], y in [0, 1]).
 */
function islandSeeds(rng, aspect, sizeFactor, landScale) {
  const count = Math.max(4, Math.round((7 * sizeFactor * sizeFactor) / Math.max(0.5, landScale)));
  const rows = Math.max(2, Math.round(Math.sqrt(count / aspect)));
  const cols = Math.max(2, Math.round(count / rows));
  const cw = (aspect * 0.8) / cols, ch = 0.8 / rows;
  const seeds = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      seeds.push({
        x: aspect * 0.1 + (c + 0.5 + (rng() - 0.5) * 0.5) * cw,
        y: 0.1 + (r + 0.5 + (rng() - 0.5) * 0.5) * ch,
        r: Math.min(cw, ch) * (0.3 + rng() * 0.16),
        sx: 0.75 + rng() * 0.5, // elongation, so islands aren't all round
      });
    }
  }
  return { seeds, aspect };
}

// Land is the strongest island falloff at this point. Near the boundary between
// two islands' territories a channel is cut, so noise can't bridge them.
function islandField(isl, u, v, nMask) {
  const x = u * isl.aspect + nMask(u * 5.1, v * 5.1 + 9.4) * 0.035;
  const y = v + nMask(u * 5.1 + 3.7, v * 5.1) * 0.035;
  let f = -Infinity, d1 = Infinity, d2 = Infinity;
  for (const s of isl.seeds) {
    const d = Math.hypot((x - s.x) * s.sx, (y - s.y) / s.sx);
    f = Math.max(f, 1 - d / s.r);
    const dn = d / s.r; // territory by relative distance, so big islands claim more
    if (dn < d1) { d2 = d1; d1 = dn; } else if (dn < d2) d2 = dn;
  }
  const channel = Math.exp(-Math.pow((d2 - d1) / 0.45, 2));
  return Math.max(-0.9, f) - channel * 1.2;
}

// Every map ends in open sea, whatever its shape: land fades out towards the board's
// edge along a ragged line, and the last tiles are always deep water so the board
// melts into the endless ocean around it. Distances are in tiles; `wob` wanders the
// line by a couple of tiles so the coast is never a rectangle. Small boards get a
// narrower rim (distances are measured in tiles of a 54-tile-high board).
const RIM_FADE = [1.5, 7.5]; // elevation bias: full at the edge .. none this far in
const RIM_DEEP = [0.6, 4.0]; // forced depth: deep at the edge .. untouched this far in
function borderInfo(g, seed) {
  const { gw, gh, detail } = g;
  const nB = makeNoise2D(subRng(seed, 'border'));
  const scale = Math.min(1, Math.max(0.65, Math.min(g.tilesW, g.tilesH) / 54));
  const d = new Float32Array(g.n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const edge = Math.min(i, gw - 1 - i, j, gh - 1 - j) / detail;
      const wob = fbm(nB, i / detail * 0.11, j / detail * 0.11, 3) * 2.6;
      d[j * gw + i] = Math.max(0, edge / scale + wob);
    }
  }
  return d;
}

/** Pushes the board's rim under the sea: deep at the edge, shelving up to the coast. */
export function sinkBorder(g, h, seed) {
  const d = borderInfo(g, seed | 0);
  for (let k = 0; k < g.n; k++) {
    const t = smoothstep(RIM_DEEP[0], RIM_DEEP[1], d[k]);
    if (t < 1) h[k] = Math.min(h[k], h[k] * t - MAX_DEPTH * (1 - t));
  }
}

// Large-scale land/sea bias per map shape. u, v in [0,1].
function shapeBias(shape, u, v, nMask, isl) {
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const r2 = dx * dx + dy * dy;
  const edge = Math.max(Math.abs(dx), Math.abs(dy));
  const oceanRim = -smoothstep(0.72, 1.0, edge) * 1.1;
  const wobble = nMask(u * 2.3, v * 2.3) * 0.18;
  switch (shape) {
    case 'islands':
      return islandField(isl, u, v, nMask) * 0.75 - 0.2 + oceanRim;
    case 'archipelago':
      return -r2 * 0.15 + oceanRim + wobble * 0.5;
    case 'pangaea':
      return -Math.pow(edge, 6) * 0.6 + wobble;
    case 'coast': {
      // Ocean along the east edge with a ragged coastline.
      const c = u + nMask(v * 3.1, 7.7) * 0.12;
      return -smoothstep(0.55, 0.95, c) * 1.2 - smoothstep(0.88, 1, Math.abs(dy)) * 0.4 + wobble;
    }
    case 'twoContinents': {
      const channel = Math.exp(-Math.pow((u - 0.5 + nMask(v * 2.7, 3.3) * 0.08) / 0.09, 2));
      return -r2 * 0.25 - channel * 0.9 + oceanRim + wobble;
    }
    case 'inlandSea': {
      const inner = Math.exp(-r2 * 4.5);
      return -Math.pow(edge, 8) * 0.5 - inner * 0.75 + wobble;
    }
    case 'continent':
    default:
      return -r2 * 0.7 + oceanRim + wobble;
  }
}

/**
 * Builds the raw elevation field and converts it to world heights with the sea
 * level placed so that `params.water` of the map is submerged.
 */
export function buildHeightmap(g, params) {
  const seed = params.seed | 0;
  const nC = makeNoise2D(subRng(seed, 'continent'));
  const nW1 = makeNoise2D(subRng(seed, 'warp1'));
  const nW2 = makeNoise2D(subRng(seed, 'warp2'));
  const nMask = makeNoise2D(subRng(seed, 'mask'));
  const nBelt = makeNoise2D(subRng(seed, 'belt'));
  const nRidge = makeNoise2D(subRng(seed, 'ridge'));
  const nHill = makeNoise2D(subRng(seed, 'hill'));
  const nPlat = makeNoise2D(subRng(seed, 'plateau'));

  const { gw, gh } = g;
  const aspect = (gw - 1) / (gh - 1);
  // Feature frequency scales with map size so bigger maps get more features,
  // not blurrier ones.
  const sizeFactor = Math.sqrt((g.tilesW * g.tilesH) / (72 * 54));
  let scale = (2.6 * sizeFactor) / Math.max(0.3, params.landScale);
  if (params.shape === 'islands') scale *= 1.3;
  const isl = params.shape === 'islands' ? islandSeeds(subRng(seed, 'islands'), aspect, sizeFactor, params.landScale) : null;
  if (params.shape === 'archipelago') scale *= 2.6;
  const mountains = params.mountains;
  const rough = params.roughness;

  const rim = borderInfo(g, seed);
  const e = new Float32Array(g.n);
  const mount = new Float32Array(g.n); // mountain contribution, used later for biomes
  for (let j = 0; j < gh; j++) {
    const v = j / (gh - 1);
    for (let i = 0; i < gw; i++) {
      const u = i / (gw - 1);
      const x = u * aspect * scale, y = v * scale;
      // Domain warp for organic, non-grid-like coastlines.
      const wx = fbm(nW1, x * 0.6, y * 0.6, 4) * 0.55;
      const wy = fbm(nW2, x * 0.6 + 5.2, y * 0.6 - 1.3, 4) * 0.55;
      const X = x + wx, Y = y + wy;

      const cont = fbm(nC, X, Y, 6, 2.0, 0.5 + rough * 0.08);
      const k = j * gw + i;
      const base = cont * (isl ? 0.4 : 0.62) + shapeBias(params.shape, u, v, nMask, isl);

      // Mountain ranges: ridged noise masked by a low-frequency "belt".
      const beltN = fbm(nBelt, X * 0.45 + 11, Y * 0.45 - 4, 3);
      const belt = smoothstep(0.05 - mountains * 0.45, 0.45 - mountains * 0.3, beltN);
      const r = ridged(nRidge, X * 1.7, Y * 1.7, 6, 2.05, 0.48 + rough * 0.1);
      const landness = smoothstep(-0.08, 0.2, base);
      // below 0.3 the ranges fade away entirely (0 = no mountains at all)
      const m = r * r * belt * landness * (0.35 * Math.min(1, mountains / 0.3) + mountains * 1.1);

      // Rolling hills and occasional plateaus.
      const hills = fbm(nHill, X * 3.2, Y * 3.2, 4) * (0.03 + rough * 0.07) * landness;
      const plat = smoothstep(0.25, 0.45, fbm(nPlat, X * 0.8, Y * 0.8, 3)) * 0.08 * landness * mountains;

      mount[k] = m;
      e[k] = base + m + hills + plat;
    }
  }

  // Sea level by quantile so the water percentage is exactly controllable.
  // Measured before the rim is drowned: land that reached the edge comes on top of
  // `water`, so the land inside keeps the sea level and relief it would have without it.
  const sorted = Float32Array.from(e).sort();
  const q = Math.min(0.95, Math.max(0.02, params.water));
  const seaE = sorted[Math.floor(q * (sorted.length - 1))];
  const maxE = sorted[sorted.length - 1];
  for (let k = 0; k < g.n; k++) e[k] -= (1 - smoothstep(RIM_FADE[0], RIM_FADE[1], rim[k])) * 1.4;
  const minE = sorted[0];

  // relief: how high the land rises at all (0 flat lowlands .. 0.5 as ever .. 1 rugged)
  const hl = params.hills ?? 0.5;
  const relief = hl <= 0.5 ? 0.3 + hl * 1.4 : 1 + (hl - 0.5);
  const h = new Float32Array(g.n);
  const landRange = Math.max(1e-4, maxE - seaE);
  const seaRange = Math.max(1e-4, seaE - minE);
  for (let k = 0; k < g.n; k++) {
    const d = e[k] - seaE;
    if (d >= 0) {
      // Flatten lowlands, keep peaks sharp.
      const t = d / landRange;
      h[k] = 0.05 + Math.pow(t, 1.9) * MAX_HEIGHT * (0.6 + mountains * 0.6) * relief;
    } else {
      h[k] = -Math.pow(Math.min(1, -d / seaRange), 0.6) * MAX_DEPTH - 0.05;
    }
  }
  sinkBorder(g, h, seed);
  return { h, mount };
}

/**
 * Raises volcano cones on land. Returns volcano descriptors (world-space units
 * are applied later by the caller).
 */
export function placeVolcanoes(g, h, count, rng) {
  const volcanoes = [];
  if (count <= 0) return volcanoes;
  const { gw, gh, cellSize } = g;
  const minSpacing = Math.min(g.worldW, g.worldH) * 0.22;
  for (let attempt = 0; attempt < 600 && volcanoes.length < count; attempt++) {
    const i = Math.floor((0.12 + rng() * 0.76) * gw);
    const j = Math.floor((0.12 + rng() * 0.76) * gh);
    const k = j * gw + i;
    if (h[k] < 1.2) continue;
    const x = i * cellSize, z = j * cellSize;
    if (volcanoes.some((v) => Math.hypot(v.cx - x, v.cz - z) < minSpacing)) continue;
    const radius = 5 + rng() * 4; // world units
    const height = 5 + rng() * 5;
    volcanoes.push({ ci: i, cj: j, cx: x, cz: z, radius, height, craterR: radius * 0.22 });
  }
  for (const v of volcanoes) {
    const rc = Math.ceil((v.radius * 1.6) / cellSize);
    for (let dj = -rc; dj <= rc; dj++) {
      for (let di = -rc; di <= rc; di++) {
        const i = v.ci + di, j = v.cj + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const d = Math.hypot(di, dj) * cellSize / v.radius;
        if (d > 1.6) continue;
        const cone = Math.pow(Math.max(0, 1 - d / 1.6), 1.8) * v.height;
        const k = j * gw + i;
        h[k] = Math.max(h[k], h[k] * 0.4 + cone + 0.5);
      }
    }
  }
  return volcanoes;
}

export function carveCraters(g, h, volcanoes) {
  const { gw, gh, cellSize } = g;
  for (const v of volcanoes) {
    const k0 = v.cj * gw + v.ci;
    v.peak = h[k0];
    const rc = Math.ceil((v.craterR * 1.6) / cellSize);
    let rim = -Infinity;
    for (let dj = -rc; dj <= rc; dj++) {
      for (let di = -rc; di <= rc; di++) {
        const i = v.ci + di, j = v.cj + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        rim = Math.max(rim, h[j * gw + i]);
      }
    }
    v.rim = rim;
    v.lavaLevel = rim - 1.1;
    for (let dj = -rc; dj <= rc; dj++) {
      for (let di = -rc; di <= rc; di++) {
        const i = v.ci + di, j = v.cj + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const d = (Math.hypot(di, dj) * cellSize) / v.craterR;
        if (d > 1.6) continue;
        const k = j * gw + i;
        const bowl = rim - 1.6 * Math.max(0, 1 - d * d);
        const blend = smoothstep(1.0, 1.6, d);
        h[k] = h[k] * blend + Math.min(h[k], bowl) * (1 - blend);
        if (d < 1) h[k] = Math.min(h[k], bowl);
      }
    }
  }
}
