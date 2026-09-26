// Unit movement over the tile grid: travel costs, cheapest paths (A*), reach within
// a movement budget and splitting a route into turns. Pure data, no three.js, so
// game logic, AI and a server can share it.
import { MinHeap } from '../core/heap.js';
import { Tile, TileInfo, Flag } from '../generator/terrainTypes.js';

/**
 * Movement rules. Costs are movement points (MP) spent to *enter* a tile.
 * Land tiles cost TileInfo[type].moveCost (plains 1, forest/hills/ice 2, swamp/volcanic 3;
 * water and mountains are impassable). Units board ships only at ports and land only
 * at ports; at sea every tile costs `sea`. Flying armies (`fly` option of findPath /
 * reachable) cross anything, mountains, lava and sea alike, at `fly` per tile.
 */
export const MoveRules = {
  road: 0.5, // roads, bridges and city streets, whatever the terrain underneath
  ford: 2, // extra MP to wade across a river where there is no bridge
  sea: 1, // one sea tile under sail
  embark: 1, // extra MP to board or leave a ship at a port
  diagonal: 1, // cost factor of a diagonal step (Warlords rules: same as a straight one)
  fly: 1, // one tile on the wing, over any ground or water
};

const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Per-tile travel data for one map. Build once per map and share. */
export class MoveGrid {
  constructor(map, rules = MoveRules) {
    const { tilesW: W, tilesH: H } = map.grid;
    this.W = W;
    this.H = H;
    this.rules = { ...MoveRules, ...rules };
    this.land = new Float32Array(W * H); // MP to enter by land; Infinity = impassable
    this.sea = new Uint8Array(W * H); // 1 = open sea a ship can sail
    this.port = new Uint8Array(W * H);
    const r = this.rules;
    for (let t = 0; t < W * H; t++) {
      const type = map.tiles[t], f = map.flags[t];
      if (type === Tile.WATER) {
        this.land[t] = Infinity;
        this.sea[t] = f & (Flag.LAKE | Flag.FROZEN) ? 0 : 1;
        continue;
      }
      let c = TileInfo[type].moveCost;
      if (f & Flag.LAVA) c = Infinity;
      else if (f & (Flag.ROAD | Flag.BRIDGE | Flag.CITY)) c = Math.min(c, r.road);
      else if (f & Flag.RIVER) c += r.ford;
      this.land[t] = c;
      if (f & Flag.PORT) this.port[t] = 1;
    }
    // cheapest possible step, for an admissible A* heuristic
    this.minStep = Math.min(r.road, r.sea, ...TileInfo.map((i) => i.moveCost)) * Math.min(1, r.diagonal);
  }

  tile(tx, ty) { return ty * this.W + tx; }
  xy(t) { return [t % this.W, (t / this.W) | 0]; }
  /** Can a unit stand here (land it can walk, or sea it can sail)? */
  passable(t) { return this.sea[t] === 1 || this.land[t] < Infinity; }

  /** MP of a flying step: the same over any tile. */
  flyCost(dx, dy) { return dx !== 0 && dy !== 0 ? this.rules.fly * this.rules.diagonal : this.rules.fly; }

  /**
   * MP to step from tile a to its neighbour b, or Infinity. Diagonal steps may not
   * cut a corner past impassable ground (or past land, for ships); boarding and
   * landing happen only at ports, in straight steps.
   */
  stepCost(a, b, dx, dy) {
    const r = this.rules;
    const aSea = this.sea[a] === 1, bSea = this.sea[b] === 1;
    const diag = dx !== 0 && dy !== 0;
    let c;
    if (!aSea && !bSea) {
      c = this.land[b];
      if (c === Infinity) return Infinity;
      if (diag && (this.land[a + dx] === Infinity || this.land[a + dy * this.W] === Infinity)) return Infinity;
    } else if (aSea && bSea) {
      if (diag && (!this.sea[a + dx] || !this.sea[a + dy * this.W])) return Infinity;
      c = r.sea;
    } else {
      if (diag) return Infinity;
      if (aSea) { // landing
        if (!this.port[b]) return Infinity;
        c = this.land[b] + r.embark;
      } else { // boarding
        if (!this.port[a]) return Infinity;
        c = r.sea + r.embark;
      }
    }
    return diag ? c * r.diagonal : c;
  }
}

/**
 * Cheapest route from tile `start` to tile `goal` (A*). `blocked` (Set of tiles)
 * can't be entered, e.g. tiles held by other units; `fly` routes a flying army. Among equally cheap routes
 * the geometrically shortest wins, so paths don't zig-zag.
 * Returns { tiles: [start, ..., goal], costs: MP to enter each tile (costs[0] = 0),
 * total } or null when the goal can't be reached.
 */
export function findPath(grid, start, goal, { blocked = null, fly = false } = {}) {
  const { W, H } = grid;
  // river voyages (grid.links: tile -> [{ to, tiles, costs, cost }]) — ships from bridges
  const links = fly ? null : grid.links;
  if (start === goal || !(fly || grid.passable(goal)) || blocked?.has(goal)) return null;
  const cost = fly ? (a, b, dx, dy) => grid.flyCost(dx, dy) : (a, b, dx, dy) => grid.stepCost(a, b, dx, dy);
  const n = W * H;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const via = links ? new Map() : null; // tile -> the voyage that reached it
  const closed = new Uint8Array(n);
  const heap = new MinHeap(256);
  const TIE = 1e-3; // per unit of step length, far below any real cost difference
  const [gx, gy] = grid.xy(goal);
  const h = (x, y) => {
    const ddx = Math.abs(x - gx), ddy = Math.abs(y - gy);
    const cheb = Math.max(ddx, ddy), octile = cheb + (Math.SQRT2 - 1) * Math.min(ddx, ddy);
    return cheb * grid.minStep + octile * TIE;
  };
  g[start] = 0;
  heap.push(h(...grid.xy(start)), start);
  while (heap.size) {
    const c = heap.pop();
    if (closed[c]) continue;
    if (c === goal) break;
    closed[c] = 1;
    const cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const t = y * W + x;
      if (closed[t] || blocked?.has(t)) continue;
      const step = cost(c, t, dx, dy);
      if (step === Infinity) continue;
      const ng = g[c] + step + (dx && dy ? Math.SQRT2 : 1) * TIE;
      if (ng < g[t]) {
        g[t] = ng;
        came[t] = c;
        via?.delete(t);
        heap.push(ng + h(x, y), t);
      }
    }
    for (const L of links?.get(c) ?? []) {
      const t = L.to;
      if (closed[t] || blocked?.has(t) || (blocked && L.tiles.some((x) => blocked.has(x)))) continue;
      const ng = g[c] + L.cost + L.tiles.length * TIE;
      if (ng < g[t]) {
        g[t] = ng;
        came[t] = c;
        via.set(t, L);
        heap.push(ng + h(...grid.xy(t)), t);
      }
    }
  }
  if (came[goal] < 0) return null;
  const nodes = [];
  for (let t = goal; t >= 0; t = came[t]) nodes.push(t);
  nodes.reverse();
  const tiles = [start], costs = [0], afloat = [grid.sea[start] === 1];
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    const L = via?.get(nodes[i]);
    if (L) {
      // a voyage: every tile of the river on the way, afloat but for the landing
      for (let j = 1; j < L.tiles.length; j++) { tiles.push(L.tiles[j]); costs.push(L.costs[j]); afloat.push(j < L.tiles.length - 1 || grid.sea[L.tiles[j]] === 1); }
      total += L.cost;
      continue;
    }
    const [ax, ay] = grid.xy(nodes[i - 1]), [bx, by] = grid.xy(nodes[i]);
    const c = cost(nodes[i - 1], nodes[i], bx - ax, by - ay);
    tiles.push(nodes[i]);
    costs.push(c);
    afloat.push(!fly && grid.sea[nodes[i]] === 1);
    total += c;
  }
  return { tiles, costs, total, afloat };
}

/** Every tile reachable from `start` with `budget` MP: Map(tile -> MP spent). */
export function reachable(grid, start, budget, { blocked = null, fly = false } = {}) {
  const { W, H } = grid;
  const best = new Map([[start, 0]]);
  const heap = new MinHeap(256);
  heap.push(0, start);
  while (heap.size) {
    const spent = heap.peekKey();
    const c = heap.pop();
    if (spent > best.get(c)) continue;
    const cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const t = y * W + x;
      if (blocked?.has(t)) continue;
      const s = spent + (fly ? grid.flyCost(dx, dy) : grid.stepCost(c, t, dx, dy));
      if (s > budget || s >= (best.get(t) ?? Infinity)) continue;
      best.set(t, s);
      heap.push(s, t);
    }
    if (!fly) for (const L of grid.links?.get(c) ?? []) {
      const s = spent + L.cost;
      if (s > budget || s >= (best.get(L.to) ?? Infinity) || L.tiles.some((x) => blocked?.has(x))) continue;
      best.set(L.to, s);
      heap.push(s, L.to);
    }
  }
  return best;
}

/**
 * Splits a path into turns. A unit with `mpLeft` this turn and `mpMax` per turn
 * stops before a step it can't afford and continues next turn (a step dearer than
 * a whole turn is taken with a full turn's MP). Returns the turn (0 = this turn)
 * in which each tile of path.tiles is reached.
 */
export function turnsAlong(path, mpLeft, mpMax) {
  const turn = [0];
  let t = 0, left = mpLeft;
  for (let i = 1; i < path.tiles.length; i++) {
    const c = path.costs[i];
    if (c > left + 1e-6) { t++; left = mpMax; }
    left = Math.max(0, left - c);
    turn.push(t);
  }
  return turn;
}
