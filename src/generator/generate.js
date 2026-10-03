import { subRng } from '../core/rng.js';
import { makeNoise2D, fbm } from '../core/noise.js';
import { defaultParams } from './params.js';
import {
  makeGrid, computeSlope, distanceField, boxBlur, rasterizePolyline, sampleBilinear,
  toWorldX, toWorldZ, toCellX, toCellZ,
} from './grid.js';
import { buildHeightmap, placeVolcanoes, carveCraters, sinkBorder, MAX_HEIGHT } from './heightmap.js';
import { erode, thermal } from './erosion.js';
import { digLakeBasins, priorityFlood, flowAccumulation, findLakes, extractRivers, carveRivers, traceLava } from './hydrology.js';
import { Biome, BiomeToTile, Tile, Flag } from './terrainTypes.js';
import { placeCities, flattenCities, buildRoads, buildBridgesAndRoadLines, landRegions, GATES } from './settlements.js';
import { placeSites, flattenSites } from './sites.js';
import { placePorts, flattenPorts, nearPort } from './ports.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Vegetation / prop kinds, in the order the renderer builds instanced meshes.
export const VEG_KINDS = ['pine', 'oak', 'snowPine', 'dead', 'bush', 'rock', 'reed', 'basalt'];

/**
 * Generates a complete map. Pure function of params: no DOM, no three.js, so it
 * runs in a worker and can be reused by game logic or a server.
 */
export function generateMap(userParams = {}, onProgress = () => {}) {
  const params = { ...defaultParams, ...userParams };
  const t0 = performance.now();
  const g = makeGrid(params);
  const { gw, gh, n, cellSize } = g;
  const seed = params.seed | 0;

  // 1. Elevation -----------------------------------------------------------
  onProgress('Raising continents', 0.02);
  const { h, mount } = buildHeightmap(g, params);

  onProgress('Igniting volcanoes', 0.14);
  const volcanoes = placeVolcanoes(g, h, params.volcanoes | 0, subRng(seed, 'volcano'));

  onProgress('Eroding mountains', 0.18);
  erode(g, h, params.erosion, subRng(seed, 'erosion'), (p) => onProgress('Eroding mountains', 0.18 + p * 0.3));
  thermal(g, h, 2, 1.8);
  carveCraters(g, h, volcanoes);
  sinkBorder(g, h, seed); // erosion may have silted the rim back up

  // 2. Climate ---------------------------------------------------------------
  onProgress('Shaping the climate', 0.5);
  const nT = makeNoise2D(subRng(seed, 'temp'));
  const nM = makeNoise2D(subRng(seed, 'moist'));
  const temp = new Float32Array(n);
  const moist = new Float32Array(n);
  for (let j = 0; j < gh; j++) {
    const v = j / (gh - 1);
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i, u = i / (gw - 1);
      const hn = Math.max(0, h[k]) / MAX_HEIGHT;
      temp[k] = clamp01(0.06 + v * 0.94 + params.temperature + fbm(nT, u * 3, v * 3, 3) * 0.12 - hn * 0.55);
      moist[k] = clamp01(0.5 + fbm(nM, u * 4 + 3, v * 4, 4) * 0.4 + params.moisture);
    }
  }

  // 3. Hydrology -----------------------------------------------------------
  onProgress('Filling lakes', 0.55);
  digLakeBasins(g, h, params.lakes, subRng(seed, 'lakes'));
  let flood = priorityFlood(g, h);
  const { lakeId, lakes } = findLakes(g, h, flood.filled, params.lakes);
  const rain = new Float32Array(n);
  for (let k = 0; k < n; k++) rain[k] = 0.35 + moist[k];
  const { recv, acc } = flowAccumulation(g, h, flood.filled, flood.order, rain);

  onProgress('Carving rivers', 0.62);
  const { rivers } = extractRivers(g, h, flood.filled, flood.order, recv, acc, lakeId, lakes, params);
  const rDist = carveRivers(g, h, rivers, lakeId);
  flood = null;

  // Lava flows (after the terrain has settled)
  const lavaFlows = traceLava(g, h, volcanoes, subRng(seed, 'lava'));

  // Moisture boost near water
  const seaDist = distanceField(g, (k) => h[k] < 0);
  const waterDist = distanceField(g, (k) => h[k] < 0 || lakeId[k] >= 0 || rDist[k] < 1);
  for (let k = 0; k < n; k++) {
    moist[k] = clamp01(moist[k] + 0.38 * Math.exp(-(waterDist[k] * cellSize) / 5));
  }

  // 4. Biomes ---------------------------------------------------------------
  onProgress('Painting biomes', 0.7);
  const slope = computeSlope(g, h);
  const nF = makeNoise2D(subRng(seed, 'forest'));
  const nS = makeNoise2D(subRng(seed, 'swamp'));
  const nV = makeNoise2D(subRng(seed, 'volcanic'));
  const iceT = 0.03 + params.ice * 0.4;
  const volcanicMask = new Float32Array(n);
  for (const v of volcanoes) {
    const R = v.radius * 2.1;
    const rc = Math.ceil((R * 1.3) / cellSize);
    for (let dj = -rc; dj <= rc; dj++) {
      for (let di = -rc; di <= rc; di++) {
        const i = v.ci + di, j = v.cj + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const d = (Math.hypot(di, dj) * cellSize) / R;
        const m = 1 - smoothstep(0.7, 1.05, d + fbm(nV, i * 0.08, j * 0.08, 3) * 0.3);
        const k = j * gw + i;
        volcanicMask[k] = Math.max(volcanicMask[k], m);
      }
    }
  }
  const biome = new Uint8Array(n);
  const forestN = new Float32Array(n);
  const mountainLine = 0.4 - params.mountains * 0.08;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const hk = h[k];
      forestN[k] = fbm(nF, i * 0.045, j * 0.045, 4);
      if (lakeId[k] >= 0) { biome[k] = Biome.LAKE; continue; }
      if (hk < 0) { biome[k] = Biome.OCEAN; continue; }
      const hn = hk / MAX_HEIGHT, s = slope[k], t = temp[k], m = moist[k];
      let b;
      if (volcanicMask[k] > 0.5) b = Biome.VOLCANIC;
      else if (hn > mountainLine || (s > 1.5 && hn > 0.22) || mount[k] > 0.3 && hn > mountainLine * 0.75) b = Biome.MOUNTAIN;
      else if (t < iceT) b = Biome.ICE;
      else if (
        m + fbm(nS, i * 0.06, j * 0.06, 3) * 0.35 - hn * 1.5 - s * 0.4 > 1.0 - params.swamps * 0.55 &&
        t > iceT + 0.08 && hn < 0.12
      ) b = Biome.SWAMP;
      else if (seaDist[k] * cellSize < 1.1 && hk < 0.55 && s < 0.7) b = Biome.BEACH;
      else if (hn > 0.24 || s > 0.95) b = Biome.HILLS;
      else if (m + forestN[k] * 0.35 > 1.02 - params.forests * 0.62) b = Biome.FOREST;
      else b = Biome.PLAINS;
      biome[k] = b;
    }
  }

  // 5. Tiles (game grid) ---------------------------------------------------
  onProgress('Surveying tiles', 0.76);
  const { tilesW: W, tilesH: H, detail } = g;
  const tiles = new Uint8Array(W * H);
  const flags = new Uint16Array(W * H);
  const tileH = new Float32Array(W * H);
  const counts = new Float32Array(10);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      counts.fill(0);
      let hs = 0, cnt = 0, river = false, lava = false, cold = 0;
      for (let dj = 0; dj <= detail; dj++) {
        for (let di = 0; di <= detail; di++) {
          const k = (ty * detail + dj) * gw + tx * detail + di;
          counts[biome[k]]++;
          hs += h[k]; cnt++;
          if (rDist[k] < 0.9 && di > 0 && dj > 0 && di < detail && dj < detail) river = true;
          if (temp[k] < iceT) cold++;
        }
      }
      const t = ty * W + tx;
      tileH[t] = hs / cnt;
      let type;
      const water = counts[Biome.OCEAN] + counts[Biome.LAKE];
      if (water > cnt * 0.5) {
        type = Tile.WATER;
        if (counts[Biome.LAKE] > counts[Biome.OCEAN]) flags[t] |= Flag.LAKE;
        if (cold > cnt * 0.5) flags[t] |= Flag.FROZEN;
      } else {
        counts[Biome.OCEAN] = counts[Biome.LAKE] = 0;
        counts[Biome.MOUNTAIN] *= 1.35;
        counts[Biome.VOLCANIC] *= 1.2;
        let best = Biome.PLAINS;
        for (let b = 2; b < 10; b++) if (counts[b] > counts[best]) best = b;
        type = BiomeToTile[best];
      }
      tiles[t] = type;
      if (river && type !== Tile.WATER) flags[t] |= Flag.RIVER;
    }
  }
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const t = ty * W + tx;
      if (tiles[t] === Tile.WATER) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && tiles[y * W + x] === Tile.WATER) flags[t] |= Flag.COAST;
      }
    }
  }

  // 6. Civilization ----------------------------------------------------------
  onProgress('Founding cities', 0.8);
  const civRng = subRng(seed, 'cities');
  const regions = landRegions(g, tiles);
  const cities = placeCities(g, tiles, flags, tileH, params, civRng, regions);
  flattenCities(g, h, cities);
  let roadPaths = [], bridges = [], roadLines = [];
  if (params.roads && cities.length > 1) {
    onProgress('Building roads & bridges', 0.83);
    roadPaths = buildRoads(g, tiles, flags, tileH, cities, subRng(seed, 'roads'), params.roadLoops ?? 0.45);
    ({ bridges, lines: roadLines } = buildBridgesAndRoadLines(g, h, flags, roadPaths, rivers, cities));
  }
  onProgress('Building harbours', 0.84);
  const ports = placePorts(g, tiles, flags, tileH, cities, params, subRng(seed, 'ports'), regions);
  flattenPorts(g, h, ports);
  onProgress('Raising ruins & shrines', 0.85);
  const sites = placeSites(g, tiles, flags, tileH, cities, params, subRng(seed, 'sites'), regions, volcanoes);
  flattenSites(g, h, sites);

  // 7. Texture splats ---------------------------------------------------------
  onProgress('Mixing splat maps', 0.87);
  // channels: 0 plains, 1 forest, 2 swamp, 3 sand, 4 ice, 5 volcanic, 6 rock
  const CH = 7;
  const w = new Float32Array(n * CH);
  for (let k = 0; k < n; k++) {
    const b = biome[k];
    const o = k * CH;
    switch (b) {
      case Biome.OCEAN: case Biome.LAKE: case Biome.BEACH: w[o + 3] = 1; break;
      case Biome.FOREST: w[o + 1] = 1; break;
      case Biome.SWAMP: w[o + 2] = 1; break;
      case Biome.ICE: w[o + 4] = 1; break;
      case Biome.VOLCANIC: w[o + 5] = 1; break;
      case Biome.MOUNTAIN: w[o] = 1; w[o + 6] = 1; break;
      case Biome.HILLS: w[o] = 1; w[o + 6] = 0.25; break;
      default: w[o] = 1;
    }
  }
  boxBlur(g, w, CH, 1, 2);

  const lava = new Float32Array(n);
  for (const v of volcanoes) {
    const rc = Math.ceil((v.craterR * 1.2) / cellSize);
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = v.ci + di, j = v.cj + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const k = j * gw + i;
      if (Math.hypot(di, dj) * cellSize > v.craterR * 1.1) continue;
      if (h[k] < v.lavaLevel + 0.3) lava[k] = Math.max(lava[k], smoothstep(v.lavaLevel + 0.3, v.lavaLevel - 0.1, h[k]));
    }
  }
  for (const f of lavaFlows) {
    rasterizePolyline(g, f.x, f.z, f.width + cellSize, (k, d, seg) => {
      const taper = 1 - (seg / f.x.length) * 0.6;
      lava[k] = Math.max(lava[k], 1 - smoothstep(f.width * taper * 0.4, f.width * taper, d));
    });
  }
  const road = new Float32Array(n);
  for (const line of roadLines) {
    const [X, Z] = chaikinPair(line.x, line.z);
    rasterizePolyline(g, X, Z, 0.5, (k, d) => {
      if (rDist[k] < 1.15) return;
      road[k] = Math.max(road[k], 1 - smoothstep(0.1, 0.36, d));
    });
  }
  for (const c of cities) {
    const ci = toCellX(g, c.x), cj = toCellZ(g, c.z);
    const rc = Math.ceil(2.4 / cellSize);
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = Math.round(ci) + di, j = Math.round(cj) + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const d = Math.hypot(i - ci, j - cj) * cellSize;
      const k = j * gw + i;
      road[k] = Math.max(road[k], 1 - smoothstep(1.5, 2.3, d));
    }
  }
  // trodden earth around ruins and shrines
  for (const s of sites) {
    const ci = toCellX(g, s.x), cj = toCellZ(g, s.z);
    const rc = Math.ceil(1.3 / cellSize);
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = Math.round(ci) + di, j = Math.round(cj) + dj;
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const d = Math.hypot(i - ci, j - cj) * cellSize;
      const k = j * gw + i;
      road[k] = Math.max(road[k], 0.55 * (1 - smoothstep(0.5, 1.2, d)));
    }
  }

  const splatA = new Uint8Array(n * 4); // plains, forest, swamp, sand
  const splatB = new Uint8Array(n * 4); // ice, volcanic, lava, road
  const climate = new Uint8Array(n * 4); // temperature, moisture, wetness, rock
  const to8 = (x) => Math.round(clamp01(x) * 255);
  for (let k = 0; k < n; k++) {
    const o = k * CH;
    splatA[k * 4] = to8(w[o]);
    splatA[k * 4 + 1] = to8(w[o + 1]);
    splatA[k * 4 + 2] = to8(w[o + 2]);
    splatA[k * 4 + 3] = to8(w[o + 3]);
    splatB[k * 4] = to8(w[o + 4]);
    splatB[k * 4 + 1] = to8(w[o + 5]);
    splatB[k * 4 + 2] = to8(lava[k]);
    splatB[k * 4 + 3] = to8(road[k]);
    climate[k * 4] = to8(temp[k]);
    climate[k * 4 + 1] = to8(moist[k]);
    const wet = Math.max(1 - smoothstep(1, 3.2, rDist[k]), 1 - smoothstep(0, 3, waterDist[k]) * 1.0);
    climate[k * 4 + 2] = to8(h[k] < 0 ? 1 : wet * 0.9);
    climate[k * 4 + 3] = to8(w[o + 6]);
  }
  for (let t = 0; t < W * H; t++) {
    const tx = t % W, ty = (t / W) | 0;
    const k = (ty * detail + (detail >> 1)) * gw + tx * detail + (detail >> 1);
    if (lava[k] > 0.5) flags[t] |= Flag.LAVA;
  }

  // 8. Vegetation & props ------------------------------------------------------
  onProgress('Planting forests', 0.92);
  const vegRng = subRng(seed, 'veg');
  const veg = VEG_KINDS.map(() => []);
  const cityNear = (x, z) => cities.some((c) => Math.hypot(c.x - x, c.z - z) < 2.6) || sites.some((s) => Math.hypot(s.x - x, s.z - z) < 1.9)
    || ports.some((p) => nearPort(p, x, z));
  const push = (kind, x, z, sMin, sMax) => {
    const y = sampleBilinear(g, h, toCellX(g, x), toCellZ(g, z));
    veg[kind].push(x, y - 0.04, z, sMin + vegRng() * (sMax - sMin), vegRng() * Math.PI * 2);
  };
  const K = Object.fromEntries(VEG_KINDS.map((v, i) => [v, i]));
  const densityScale = (cellSize / 0.4) ** 2; // keep density per world area constant
  for (let j = 1; j < gh - 1; j++) {
    for (let i = 1; i < gw - 1; i++) {
      const k = j * gw + i;
      if (h[k] < 0.08 || lava[k] > 0.1 || road[k] > 0.15) continue;
      const b = biome[k];
      const x = toWorldX(g, i + vegRng() - 0.5), z = toWorldZ(g, j + vegRng() - 0.5);
      const t = temp[k], s = slope[k], hn = h[k] / MAX_HEIGHT;
      const r = vegRng() / densityScale;
      const nearRiver = rDist[k] < 1.5;
      if (cityNear(x, z)) continue;
      if (!nearRiver && rDist[k] < 2.4 && b !== Biome.ICE && b !== Biome.VOLCANIC && t > iceT + 0.1) {
        if (r < 0.28) { push(K.reed, x, z, 0.6, 1.1); continue; }
      }
      if (nearRiver) continue;
      const clump = smoothstep(-0.25, 0.25, forestN[k]);
      switch (b) {
        case Biome.FOREST: {
          const dens = 0.35 + 0.6 * clump;
          if (r < dens) {
            const coldness = smoothstep(0.55, 0.3, t);
            if (vegRng() < 0.15 + coldness * 0.8) push(K.pine, x, z, 0.75, 1.35);
            else push(K.oak, x, z, 0.75, 1.3);
          } else if (r < dens + 0.08) push(K.bush, x, z, 0.5, 0.9);
          break;
        }
        case Biome.PLAINS:
          if (r < 0.018 * (0.5 + clump)) push(t < 0.4 ? K.pine : K.oak, x, z, 0.7, 1.2);
          else if (r < 0.06) push(K.bush, x, z, 0.4, 0.8);
          else if (r < 0.07) push(K.rock, x, z, 0.25, 0.5);
          break;
        case Biome.HILLS:
          if (r < 0.07) push(K.rock, x, z, 0.3, 0.8);
          else if (r < 0.14 * (0.4 + clump)) push(t < 0.45 ? K.pine : K.oak, x, z, 0.7, 1.15);
          else if (r < 0.2) push(K.bush, x, z, 0.4, 0.8);
          break;
        case Biome.MOUNTAIN:
          if (s < 1.6 && r < 0.07) push(K.rock, x, z, 0.4, 1.1);
          else if (hn < mountainLine * 1.25 && t > iceT + 0.05 && r < 0.14) push(t < iceT + 0.05 ? K.snowPine : K.pine, x, z, 0.65, 1.1);
          break;
        case Biome.SWAMP:
          if (r < 0.07) push(K.dead, x, z, 0.6, 1.1);
          else if (r < 0.14) push(K.oak, x, z, 0.7, 1.1);
          else if (r < 0.45) push(K.reed, x, z, 0.6, 1.2);
          break;
        case Biome.ICE:
          if (r < 0.06 * (0.3 + clump)) push(K.snowPine, x, z, 0.6, 1.1);
          else if (r < 0.08) push(K.rock, x, z, 0.3, 0.8);
          break;
        case Biome.VOLCANIC:
          if (r < 0.035) push(K.dead, x, z, 0.5, 1.0);
          else if (r < 0.13) push(K.basalt, x, z, 0.3, 0.9);
          break;
        case Biome.BEACH:
          if (r < 0.012) push(K.rock, x, z, 0.3, 0.7);
          break;
      }
    }
  }
  const vegetation = {};
  VEG_KINDS.forEach((name, i) => (vegetation[name] = new Float32Array(veg[i])));

  // 9. Output -----------------------------------------------------------------
  onProgress('Done', 1);
  const lakeLevel = new Float32Array(n).fill(NaN);
  for (const l of lakes) for (const c of l.cells) lakeLevel[c] = l.level;

  return {
    params,
    grid: g,
    heights: h,
    splatA, splatB, climate,
    lakeLevel,
    lakes: lakes.map((l) => ({ id: l.id, level: l.level, size: l.size })),
    rivers: rivers.map((r) => ({
      x: Float32Array.from(r.x), z: Float32Array.from(r.z), s: Float32Array.from(r.s), w: Float32Array.from(r.w),
      main: r.main, endsInSea: r.endsInSea,
    })),
    volcanoes: volcanoes.map((v) => ({
      x: toWorldX(g, v.ci), z: toWorldZ(g, v.cj), y: v.lavaLevel, radius: v.radius, craterR: v.craterR, rim: v.rim,
    })),
    cities: cities.map((c) => ({
      name: c.name, tx: c.tx, ty: c.ty, x: c.x, z: c.z, y: c.y, owner: c.owner, capital: !!c.capital, level: c.level, defense: c.defense,
      gate: GATES[c.gate].name, region: c.region,
    })),
    roads: roadPaths.map((p) => ({ from: p.from, to: p.to, tiles: p.tiles })),
    sites,
    ports,
    roadLines,
    bridges,
    tiles, flags, tileHeights: tileH,
    iceThreshold: iceT,
    vegetation,
    stats: { ms: Math.round(performance.now() - t0) },
  };
}

function chaikinPair(xs, zs) {
  let X = xs, Z = zs;
  for (let it = 0; it < 3; it++) {
    const nx = [X[0]], nz = [Z[0]];
    for (let p = 0; p < X.length - 1; p++) {
      nx.push(0.75 * X[p] + 0.25 * X[p + 1], 0.25 * X[p] + 0.75 * X[p + 1]);
      nz.push(0.75 * Z[p] + 0.25 * Z[p + 1], 0.25 * Z[p] + 0.75 * Z[p + 1]);
    }
    nx.push(X[X.length - 1]); nz.push(Z[Z.length - 1]);
    X = nx; Z = nz;
  }
  return [X, Z];
}
