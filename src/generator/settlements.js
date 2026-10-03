import { MinHeap } from '../core/heap.js';
import { Tile, Flag, Factions, CastleLevels, CASTLE_LEVEL_ODDS } from './terrainTypes.js';
import { toCellX, toCellZ, sampleBilinear } from './grid.js';
import { shuffle } from '../core/rng.js';

const CITY_OK = new Set([Tile.PLAINS, Tile.HILLS, Tile.FOREST, Tile.ICE, Tile.SHORE]);

export const NAME_A = ['Ald', 'Bel', 'Cor', 'Dun', 'Eld', 'Fal', 'Gor', 'Har', 'Ith', 'Kar', 'Lor', 'Mar', 'Nor', 'Os', 'Pel', 'Qua', 'Ral', 'Sar', 'Tor', 'Ul', 'Val', 'Wyn', 'Zan', 'Mor', 'Thal', 'Bri', 'Cael', 'Dra'];
export const NAME_B = ['heim', 'gard', 'dor', 'mere', 'wick', 'ford', 'hold', 'rast', 'mont', 'burg', 'vale', 'crest', 'moor', 'haven', 'keep', 'stead', 'thal', 'grim', 'lin', 'mar'];

/**
 * Chooses 2×2-tile city sites spread across habitable land. `region` comes from
 * landRegions(). Every city must be reachable: its land region holds another
 * city (walk there) or touches the sea (sail there), and at least one castle
 * side opens onto passable ground for the gate.
 */
export function placeCities(g, tiles, flags, tileH, params, rng, region) {
  const { tilesW: W, tilesH: H } = g;
  const count = params.cities | 0;
  if (count <= 0) return [];
  const riverNear = new Float32Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      let near = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const x = tx + dx, y = ty + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const f = flags[y * W + x];
          if (f & (Flag.RIVER | Flag.COAST | Flag.LAKE)) near = 1;
        }
      }
      riverNear[ty * W + tx] = near;
    }
  }
  const cands = [];
  for (let ty = 2; ty < H - 3; ty++) {
    for (let tx = 2; tx < W - 3; tx++) {
      let ok = true, plains = 0, hmin = Infinity, hmax = -Infinity;
      for (let dy = 0; dy < 2 && ok; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const t = (ty + dy) * W + tx + dx;
          if (!CITY_OK.has(tiles[t]) || flags[t] & (Flag.RIVER | Flag.LAKE)) { ok = false; break; }
          if (tiles[t] === Tile.PLAINS) plains++;
          hmin = Math.min(hmin, tileH[t]); hmax = Math.max(hmax, tileH[t]);
        }
      }
      if (!ok || hmax - hmin > 2.2) continue;
      if (![0, 1, 2, 3].some((gate) => gateTiles(W, { tx, ty, gate }).out.every((t) => TILE_COST[tiles[t]] !== Infinity))) continue;
      cands.push({ tx, ty, region: region[ty * W + tx], score: plains * 0.6 + riverNear[ty * W + tx] * 1.2 + rng() * 2 });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const coastal = new Set();
  for (let t = 0; t < W * H; t++) if (region[t] >= 0 && flags[t] & Flag.COAST) coastal.add(region[t]);
  // spacing: spread by count, but never closer than citySpacing tiles when it is set (strategic
  // depth: neighbours a turn or two apart, like the original's maps)
  const spacing = params.citySpacing ?? 0;
  let minD = Math.max(spacing, Math.sqrt((W * H) / count) * 0.62);
  const floorD = spacing ? spacing * 0.85 : 4;
  // A castle's walls block walking; don't let one sit on an isthmus and cut its land in two.
  const walled = (x, y, c) => x >= c.tx && x <= c.tx + 1 && y >= c.ty && y <= c.ty + 1;
  const seen = new Int32Array(W * H).fill(-1);
  const splitsLand = (c, id) => {
    const ring = [];
    for (let k = 0; k < 2; k++) {
      ring.push([c.tx + k, c.ty - 1], [c.tx + k, c.ty + 2], [c.tx - 1, c.ty + k], [c.tx + 2, c.ty + k]);
    }
    const open = ring.map(([x, y]) => y * W + x).filter((t) => TILE_COST[tiles[t]] !== Infinity);
    if (open.length < 2) return false;
    const left = new Set(open);
    const stack = [open[0]];
    seen[open[0]] = id;
    left.delete(open[0]);
    while (stack.length && left.size) {
      const t = stack.pop();
      const x = t % W, y = (t / W) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || walled(nx, ny, c)) continue;
        const n = ny * W + nx;
        if (seen[n] === id || TILE_COST[tiles[n]] === Infinity) continue;
        seen[n] = id;
        left.delete(n);
        stack.push(n);
      }
    }
    return left.size > 0;
  };
  cands.forEach((c, i) => (c.id = i));
  const splitCache = new Map();
  // Greedy spread; a city stranded alone in a landlocked pocket bans that pocket and we pick again.
  const banned = new Set();
  let cities;
  for (let pass = 0; pass < 14; pass++) {
    cities = [];
    for (const c of cands) {
      if (cities.length >= count) break;
      if (banned.has(c.region)) continue;
      if (cities.some((o) => Math.hypot(o.tx - c.tx, o.ty - c.ty) < minD)) continue;
      if (!splitCache.has(c.id)) splitCache.set(c.id, splitsLand(c, c.id));
      if (splitCache.get(c.id)) continue;
      cities.push({ tx: c.tx, ty: c.ty, region: c.region });
    }
    const stranded = cities.filter((c) => !coastal.has(c.region) && !cities.some((o) => o !== c && o.region === c.region));
    // too few fit (many cities on little land): pack them closer, never nearer than the floor
    if (!stranded.length && cities.length < count && minD > floorD) { minD = Math.max(floorD, minD * 0.85); continue; }
    if (!stranded.length) break;
    for (const c of stranded) banned.add(c.region);
  }

  // Capitals: as far apart by travel as the map allows (see chooseCapitals).
  const nFactions = Math.min(params.factions | 0, Factions.length, cities.length);
  const order = shuffle(rng, Factions.map((_, i) => i));
  cities.forEach((c) => (c.owner = -1));
  if (nFactions > 0) {
    chooseCapitals(g, tiles, flags, cities, nFactions).forEach((i, k) => { cities[i].owner = order[k]; cities[i].capital = true; });
  }
  const usedNames = new Set();
  for (const c of cities) {
    let name;
    do {
      name = NAME_A[Math.floor(rng() * NAME_A.length)] + NAME_B[Math.floor(rng() * NAME_B.length)];
    } while (usedNames.has(name) && usedNames.size < 400);
    usedNames.add(name);
    c.name = name;
    c.x = (c.tx + 1) * g.tileSize - g.worldW / 2;
    c.z = (c.ty + 1) * g.tileSize - g.worldH / 2;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) flags[(c.ty + dy) * W + c.tx + dx] |= Flag.CITY;
  }
  // Fortification level (drawn after names so names stay stable per seed).
  for (const c of cities) {
    if (c.capital) c.level = 3;
    else {
      const r = rng();
      c.level = r < CASTLE_LEVEL_ODDS[0] ? 1 : r < CASTLE_LEVEL_ODDS[0] + CASTLE_LEVEL_ODDS[1] ? 2 : 3;
    }
    c.defense = CastleLevels[c.level].defense;
  }
  chooseGates(g, tiles, flags, cities);
  return cities;
}

// Travel between cities for choosing capitals: walking costs TILE_COST, a sea tile 1,
// and every boarding or landing EMBARK (ports aren't placed yet, so any coast will do).
const SEA_STEP = 1, EMBARK = 6;

/** Travel cost from tile `start` to every tile (Infinity: unreachable). */
function travelCosts(g, tiles, flags, start) {
  const { tilesW: W, tilesH: H } = g;
  const sea = (t) => tiles[t] === Tile.WATER && !(flags[t] & (Flag.LAKE | Flag.FROZEN));
  const cost = new Float64Array(W * H).fill(Infinity);
  const heap = new MinHeap(1024);
  cost[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    const d = heap.peekKey(), t = heap.pop();
    if (d > cost[t]) continue;
    const x = t % W, y = (t / W) | 0, tSea = sea(t);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx, nSea = sea(n);
      const step = nSea ? SEA_STEP + (tSea ? 0 : EMBARK) : TILE_COST[tiles[n]] + (tSea ? EMBARK : 0);
      if (!(d + step < cost[n])) continue;
      cost[n] = d + step;
      heap.push(cost[n], n);
    }
  }
  return cost;
}

/**
 * Picks `n` capital cities (indices into `cities`) as far from each other as travel allows:
 * the smallest travel cost between any two capitals is maximised (then the sum), so no side
 * starts on another's doorstep. A city alone on its island is left out when the others leave
 * nearly as much room, so no side starts marooned with nothing to take but the sea. `costFrom(tile)` returns
 * a tile -> travel cost function; by default any coast serves as a harbour.
 */
export function chooseCapitals(g, tiles, flags, cities, n, costFrom = null) {
  const { tilesW: W } = g;
  // costFrom(tile) -> (tile -> cost); saved maps pass the game's own movement (ports and all)
  const from = costFrom ?? ((t) => { const c = travelCosts(g, tiles, flags, t); return (u) => c[u]; });
  const costs = cities.map((c) => from(c.ty * W + c.tx));
  const D = cities.map((a, i) => cities.map((b, j) => startGap(a, b, Math.min(costs[i](b.ty * W + b.tx), costs[j](a.ty * W + a.tx)))));
  const idx = cities.map((_, i) => i);
  const shared = idx.filter((i) => cities.some((o, j) => j !== i && o.region === cities[i].region));
  const any = spreadOut(D, idx, n);
  if (shared.length < n || shared.length === idx.length) return any;
  // islands of their own are fine on island maps: only skip them when that costs little room
  const safe = spreadOut(D, shared, n);
  return minPair(D, safe) >= 0.75 * minPair(D, any) ? safe : any;
}

// A long detour (round a mountain wall, or no way at all) doesn't make two sides that look
// out over the same strait far apart: the gap counts at most CROW times the straight line.
const CROW = 2;

/** How far apart two starts are for spreading capitals: travel cost, capped by the straight line. */
export function startGap(a, b, travel) {
  return Math.min(travel, CROW * Math.hypot(a.tx - b.tx, a.ty - b.ty));
}

const minPair = (D, set) => {
  let m = Infinity;
  for (let a = 0; a < set.length; a++) for (let b = a + 1; b < set.length; b++) m = Math.min(m, D[set[a]][set[b]]);
  return m;
};

/**
 * The `n` of `cands` that are farthest apart under the distance matrix `D`: largest smallest
 * pairwise distance, then largest sum. Exhaustive for small choices, else farthest-point
 * sampling from every start followed by swap improvement.
 */
export function spreadOut(D, cands, n) {
  if (n >= cands.length) return cands.slice(0, n);
  const score = (set) => {
    let min = Infinity, sum = 0;
    for (let a = 0; a < set.length; a++) for (let b = a + 1; b < set.length; b++) {
      const d = Math.min(D[set[a]][set[b]], 1e6); // unreachable counts as very far
      min = Math.min(min, d); sum += d;
    }
    return min * 1e7 + sum;
  };
  let best = null, bestS = -Infinity;
  const consider = (set) => { const s = score(set); if (s > bestS) { bestS = s; best = set.slice(); } };
  const combos = (() => { let c = 1; for (let k = 0; k < n; k++) c = (c * (cands.length - k)) / (k + 1); return c; })();
  if (combos <= 20000) {
    const pick = [];
    const rec = (from) => {
      if (pick.length === n) return consider(pick);
      for (let i = from; i <= cands.length - (n - pick.length); i++) { pick.push(cands[i]); rec(i + 1); pick.pop(); }
    };
    rec(0);
    return best;
  }
  for (const first of cands) {
    const set = [first];
    while (set.length < n) {
      let far = -1, farD = -1;
      for (const c of cands) {
        if (set.includes(c)) continue;
        const d = Math.min(...set.map((o) => Math.min(D[o][c], 1e6)));
        if (d > farD) { farD = d; far = c; }
      }
      set.push(far);
    }
    // swap members for outsiders while that helps
    for (let improved = true; improved;) {
      improved = false;
      const cur = score(set);
      for (let k = 0; k < n && !improved; k++) {
        for (const c of cands) {
          if (set.includes(c)) continue;
          const old = set[k];
          set[k] = c;
          if (score(set) > cur) { improved = true; break; }
          set[k] = old;
        }
      }
    }
    consider(set);
  }
  return best;
}

const TILE_COST = {
  [Tile.PLAINS]: 1, [Tile.SHORE]: 1.1, [Tile.FOREST]: 1.9, [Tile.HILLS]: 2.6,
  [Tile.SWAMP]: 4, [Tile.ICE]: 2.2, [Tile.VOLCANIC]: 5, [Tile.MOUNTAINS]: Infinity, [Tile.WATER]: Infinity,
};

/** Gate sides, clockwise from north. dx/dy are tile steps (+y = south = +z). */
export const GATES = [
  { name: 'N', dx: 0, dy: -1 }, { name: 'E', dx: 1, dy: 0 },
  { name: 'S', dx: 0, dy: 1 }, { name: 'W', dx: -1, dy: 0 },
];

/** The two tiles just outside a city's gate, and the two city tiles behind it. */
export function gateTiles(W, c) {
  const { dx, dy } = GATES[c.gate];
  const out = [], inner = [];
  for (let k = 0; k < 2; k++) {
    // inner tiles are the city's edge row/column on the gate side
    const ix = dx ? c.tx + (dx > 0 ? 1 : 0) : c.tx + k;
    const iy = dy ? c.ty + (dy > 0 ? 1 : 0) : c.ty + k;
    inner.push(iy * W + ix);
    out.push((iy + dy) * W + ix + dx);
  }
  return { out, inner };
}

/**
 * Labels land regions: 4-connected tiles a land unit can walk (matches the road
 * A*, which forbids corner-cutting). Cities on different regions (islands) are
 * never linked by road. Returns a region id per tile, -1 for water/mountains.
 */
export function landRegions(g, tiles) {
  const { tilesW: W, tilesH: H } = g;
  const region = new Int32Array(W * H).fill(-1);
  const stack = [];
  let id = 0;
  for (let t0 = 0; t0 < W * H; t0++) {
    if (region[t0] >= 0 || TILE_COST[tiles[t0]] === Infinity) continue;
    region[t0] = id;
    stack.push(t0);
    while (stack.length) {
      const t = stack.pop();
      const x = t % W, y = (t / W) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (region[n] >= 0 || TILE_COST[tiles[n]] === Infinity) continue;
        region[n] = id;
        stack.push(n);
      }
    }
    id++;
  }
  return region;
}

/**
 * Castles sit square to the tile grid, so each gate faces one of four sides.
 * Each side is scored by the walking distance (around city walls) from its gate
 * tiles to the nearest other city, so the gate opens onto the way roads will
 * actually leave. A city alone on its island faces the map centre. Gate tiles
 * on water, mountains or another city count against a side.
 */
function chooseGates(g, tiles, flags, cities) {
  const { tilesW: W, tilesH: H } = g;
  const walk = (t) => TILE_COST[tiles[t]] !== Infinity && !(flags[t] & Flag.CITY);
  const dist = new Int32Array(W * H);
  const queue = new Int32Array(W * H);
  // BFS steps from the gate tiles to a tile beside another city's footprint.
  const stepsToCity = (c, out) => {
    dist.fill(-1);
    let head = 0, tail = 0;
    for (const t of out) if (walk(t) && dist[t] < 0) { dist[t] = 0; queue[tail++] = t; }
    while (head < tail) {
      const t = queue[head++];
      const x = t % W, y = (t / W) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (flags[n] & Flag.CITY && (nx < c.tx || nx > c.tx + 1 || ny < c.ty || ny > c.ty + 1)) return dist[t];
        if (dist[n] >= 0 || !walk(n)) continue;
        dist[n] = dist[t] + 1;
        queue[tail++] = n;
      }
    }
    return Infinity;
  };
  for (const c of cities) {
    const dirX = W / 2 - (c.tx + 1), dirY = H / 2 - (c.ty + 1);
    const len = Math.hypot(dirX, dirY) || 1;
    let bestSide = 2, bestScore = -Infinity;
    for (let s = 0; s < 4; s++) {
      c.gate = s;
      const { out } = gateTiles(W, c);
      const steps = stepsToCity(c, out);
      // nearer by road wins; with no city reachable, lean toward the map centre
      let score = steps < Infinity ? 100 - steps : (GATES[s].dx * dirX + GATES[s].dy * dirY) / len - 200;
      for (const t of out) {
        if (!walk(t)) score -= 20;
        else if (flags[t] & (Flag.RIVER | Flag.LAKE)) score -= 3;
      }
      if (!out.some(walk)) score -= 1000;
      if (score > bestScore) { bestScore = score; bestSide = s; }
    }
    c.gate = bestSide;
  }
}

/** Levels the ground under each city. */
export function flattenCities(g, h, cities) {
  const { gw, gh, cellSize } = g;
  for (const c of cities) {
    const ci = toCellX(g, c.x), cj = toCellZ(g, c.z);
    const r0 = 2.0, r1 = 3.6;
    const rc = Math.ceil(r1 / cellSize);
    const inner = [];
    for (let dj = -rc; dj <= rc; dj++) {
      for (let di = -rc; di <= rc; di++) {
        const i = Math.round(ci) + di, j = Math.round(cj) + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        if (Math.hypot(di, dj) * cellSize <= r0) inner.push(h[j * gw + i]);
      }
    }
    inner.sort((a, b) => a - b);
    const target = Math.max(0.35, inner[Math.floor(inner.length / 2)] || 0.35);
    c.y = target;
    for (let dj = -rc; dj <= rc; dj++) {
      for (let di = -rc; di <= rc; di++) {
        const i = Math.round(ci) + di, j = Math.round(cj) + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const d = Math.hypot(i - ci, j - cj) * cellSize;
        if (d > r1) continue;
        const t = Math.min(1, Math.max(0, (d - r0) / (r1 - r0)));
        const s = t * t * (3 - 2 * t);
        const k = j * gw + i;
        h[k] = target + (h[k] - target) * s;
      }
    }
  }
}

/**
 * Connects cities with a road network: minimum spanning tree plus a few extra
 * links, each routed with A* over the tile grid. Rivers can be crossed only by
 * building a bridge, which is expensive, so roads converge on shared crossings.
 * Roads run gate to gate and never through a city's footprint; cities on
 * separate land regions (islands) are not linked.
 */
export function buildRoads(g, tiles, flags, tileH, cities, rng, loops = 0.45) {
  const { tilesW: W, tilesH: H } = g;
  const nT = W * H;
  const roadTiles = new Uint8Array(nT);
  const paths = [];
  if (cities.length < 2) return paths;

  // MST (Prim) over city centres
  const n = cities.length;
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity), parent = new Array(n).fill(-1);
  best[0] = 0;
  const edges = [];
  const dist = (a, b) => cities[a].region !== cities[b].region ? Infinity
    : Math.hypot(cities[a].tx - cities[b].tx, cities[a].ty - cities[b].ty);
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || best[v] < best[u])) u = v;
    inTree[u] = true;
    if (parent[u] >= 0) edges.push([parent[u], u]);
    for (let v = 0; v < n; v++) {
      if (!inTree[v] && dist(u, v) < best[v]) { best[v] = dist(u, v); parent[v] = u; }
    }
  }
  // extra links for loops
  const has = (a, b) => edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (let a = 0; a < n; a++) {
    const near = [...Array(n).keys()].filter((b) => b !== a).sort((x, y) => dist(a, x) - dist(a, y));
    const b = near[1];
    if (b !== undefined && !has(a, b) && rng() < loops && dist(a, b) < Math.max(W, H) * 0.35) edges.push([a, b]);
  }
  edges.sort((e1, e2) => dist(...e1) - dist(...e2));

  const isRiver = (t) => (flags[t] & Flag.RIVER) !== 0;
  const passable = (t) => TILE_COST[tiles[t]] !== Infinity && !(flags[t] & Flag.CITY);

  const g2 = new Float64Array(nT);
  const came = new Int32Array(nT);
  const closed = new Uint8Array(nT);
  for (const [a, b] of edges) {
    const gA = gateTiles(W, cities[a]), gB = gateTiles(W, cities[b]);
    g2.fill(Infinity); came.fill(-1); closed.fill(0);
    const heap = new MinHeap(1024);
    for (const t of gA.out) {
      if (!passable(t)) continue;
      g2[t] = 0;
      heap.push(0, t);
    }
    const goalX = cities[b].tx + 0.5 + GATES[cities[b].gate].dx * 1.5;
    const goalY = cities[b].ty + 0.5 + GATES[cities[b].gate].dy * 1.5;
    let found = -1;
    while (heap.size) {
      const c = heap.pop();
      if (closed[c]) continue;
      closed[c] = 1;
      const cx = c % W, cy = (c / W) | 0;
      if (gB.out.includes(c)) { found = c; break; }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const t = y * W + x;
          if (closed[t] || !passable(t)) continue;
          const diag = dx && dy;
          if (diag) {
            // no corner-cutting past rivers, obstacles or city walls
            const o1 = cy * W + x, o2 = y * W + cx;
            if (!passable(o1) || !passable(o2) || isRiver(o1) || isRiver(o2) || isRiver(t)) continue;
          }
          let cost = TILE_COST[tiles[t]];
          if (roadTiles[t]) cost *= 0.3;
          if (isRiver(t)) cost += roadTiles[t] ? 1 : isRiver(c) ? 60 : 14;
          cost += Math.abs(tileH[t] - tileH[c]) * 1.2;
          cost *= diag ? Math.SQRT2 : 1;
          const ng = g2[c] + cost;
          if (ng < g2[t]) {
            g2[t] = ng;
            came[t] = c;
            heap.push(ng + Math.hypot(x - goalX, y - goalY) * 0.3, t);
          }
        }
      }
    }
    if (found < 0) continue;
    const path = [];
    for (let c = found; c >= 0; c = came[c]) path.push(c);
    path.reverse();
    // step in through each gate: the city tile behind the first/last gate tile
    path.unshift(gA.inner[gA.out.indexOf(path[0])]);
    path.push(gB.inner[gB.out.indexOf(path[path.length - 1])]);
    for (const t of path) roadTiles[t] = 1;
    paths.push({ from: a, to: b, tiles: path });
  }
  for (let t = 0; t < nT; t++) if (roadTiles[t]) flags[t] |= Flag.ROAD;
  return paths;
}

/**
 * Places bridges where roads cross rivers, oriented perpendicular to the flow,
 * and builds smoothed world-space road polylines that pass over them.
 */
export function buildBridgesAndRoadLines(g, h, flags, paths, rivers, cities) {
  const { tilesW: W, tileSize } = g;
  const tileCenter = (t) => [((t % W) + 0.5) * tileSize - g.worldW / 2, (((t / W) | 0) + 0.5) * tileSize - g.worldH / 2];

  // Flow direction at sample p: the chord over `reach` of arc length either way. Rivers
  // are traced cell by cell, so even smoothed their neighbouring samples zig-zag up to
  // 45 degrees off the course, which turned bridges along the stream.
  const flowDir = (r, p, reach = tileSize * 0.75) => {
    let a = p, c = p, la = 0, lc = 0;
    while (a > 0 && la < reach) { la += Math.hypot(r.x[a] - r.x[a - 1], r.z[a] - r.z[a - 1]); a--; }
    while (c < r.x.length - 1 && lc < reach) { lc += Math.hypot(r.x[c + 1] - r.x[c], r.z[c + 1] - r.z[c]); c++; }
    return [r.x[c] - r.x[a], r.z[c] - r.z[a]];
  };

  // Spatial index of river samples per tile.
  const riverPts = new Map();
  for (const r of rivers) {
    for (let p = 1; p < r.x.length - 1; p++) {
      const tx = Math.floor((r.x[p] + g.worldW / 2) / tileSize);
      const ty = Math.floor((r.z[p] + g.worldH / 2) / tileSize);
      const key = ty * W + tx;
      if (!riverPts.has(key)) riverPts.set(key, []);
      const [dx, dz] = flowDir(r, p);
      riverPts.get(key).push({ x: r.x[p], z: r.z[p], s: r.s[p], w: r.w[p], dx, dz });
    }
  }
  const nearestRiverPt = (t) => {
    const [cx, cz] = tileCenter(t);
    let best = null, bd = Infinity;
    const tx = t % W, ty = (t / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = riverPts.get((ty + dy) * W + tx + dx);
        if (!list) continue;
        for (const p of list) {
          const d = Math.hypot(p.x - cx, p.z - cz);
          if (d < bd) { bd = d; best = p; }
        }
      }
    }
    return bd < tileSize * 1.2 ? best : null;
  };
  const groundAt = (x, z) => sampleBilinear(g, h, toCellX(g, x), toCellZ(g, z));

  const bridges = [];
  const lines = [];
  for (const path of paths) {
    const pts = [];
    const cityA = cities[path.from], cityB = cities[path.to];
    // Straight out through the gate: centre, gateway, midway between the gate tiles.
    const gatePts = (c) => {
      const { dx, dy } = GATES[c.gate];
      return [[c.x, c.z], [c.x + dx * tileSize, c.z + dy * tileSize], [c.x + dx * tileSize * 1.5, c.z + dy * tileSize * 1.5]];
    };
    const outA = gateTiles(W, cityA).out, outB = gateTiles(W, cityB).out;
    pts.push(...gatePts(cityA));
    for (let p = 0; p < path.tiles.length; p++) {
      const t = path.tiles[p];
      if (flags[t] & Flag.CITY) continue;
      // gate tiles are already covered by the straight gate segment
      if (!(flags[t] & Flag.RIVER) && (p === 1 && outA.includes(t) || p === path.tiles.length - 2 && outB.includes(t))) continue;
      if (flags[t] & Flag.RIVER) {
        const rp = nearestRiverPt(t);
        if (rp) {
          const l = Math.hypot(rp.dx, rp.dz) || 1;
          let px = -rp.dz / l, pz = rp.dx / l; // perpendicular to flow
          // align with road travel direction
          const prev = pts[pts.length - 1];
          if ((rp.x - prev[0]) * px + (rp.z - prev[1]) * pz < 0) { px = -px; pz = -pz; }
          const length = rp.w + 1.7;
          const ax = rp.x - px * length / 2, az = rp.z - pz * length / 2;
          const bx = rp.x + px * length / 2, bz = rp.z + pz * length / 2;
          let bridge = bridges.find((b) => Math.hypot(b.x - rp.x, b.z - rp.z) < 2.5);
          if (!bridge) {
            bridge = {
              x: rp.x, z: rp.z, dirX: px, dirZ: pz, length, width: 0.8,
              water: rp.s, hA: groundAt(ax, az), hB: groundAt(bx, bz),
            };
            bridges.push(bridge);
            flags[t] |= Flag.BRIDGE;
          }
          // route the road over the bridge deck (respecting its orientation)
          const sgn = (bridge.dirX * px + bridge.dirZ * pz) >= 0 ? 1 : -1;
          const L2 = bridge.length / 2;
          pts.push([bridge.x - bridge.dirX * L2 * sgn, bridge.z - bridge.dirZ * L2 * sgn]);
          pts.push([bridge.x + bridge.dirX * L2 * sgn, bridge.z + bridge.dirZ * L2 * sgn]);
          continue;
        }
      }
      pts.push(tileCenter(t));
    }
    pts.push(...gatePts(cityB).reverse());
    lines.push({ x: pts.map((p) => p[0]), z: pts.map((p) => p[1]) });
  }
  return { bridges, lines };
}
