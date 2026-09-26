// Game movement: Warlords-scale movement point costs on the generated map, with the
// terrain move bonuses of Warlords III (a group pays its best member's reduced cost),
// flying, and ships from ports and bridges (a river voyage from a bridge down to the sea,
// or up from the river mouth to the bridge). Grids plug into pathfinding.js findPath / reachable.
import { Tile, Flag } from '../generator/terrainTypes.js';
import { findPath as astar, reachable as reach } from './pathfinding.js';

// MP to enter a tile. Units move 12-50 MP a turn (Appendix 8), so a plain costs 2.
export const COSTS = {
  [Tile.PLAINS]: 2, [Tile.SHORE]: 2, [Tile.FOREST]: 4, [Tile.HILLS]: 4, [Tile.ICE]: 4,
  [Tile.SWAMP]: 6, [Tile.VOLCANIC]: 6, [Tile.MOUNTAINS]: Infinity, [Tile.WATER]: Infinity,
};
export const RULES = { road: 1, ford: 4, sea: 2, embark: 2, fly: 2, diagonal: 1 };
// a river voyage costs embarking plus half a point a tile, never more than the slowest army's
// whole turn (10 MP), so any group can make it in one go
export const VOYAGE_MAX = 10;
// terrain a move bonus makes as easy as open ground
const BONUS_TILES = {
  forest: [Tile.FOREST],
  hills: [Tile.HILLS],
  marsh: [Tile.SWAMP],
  snow: [Tile.ICE],
  all: [Tile.FOREST, Tile.HILLS, Tile.SWAMP, Tile.ICE, Tile.VOLCANIC],
};

/** The terrain bonus a battle on tile t favours ('forest' | 'hills' | 'marsh' | 'snow'), or null.
 * Cities, roads and open ground favour no one. */
export function terrainBonusAt(map, t) {
  if (map.flags[t] & Flag.CITY) return null;
  for (const [k, tiles] of Object.entries(BONUS_TILES)) if (k !== 'all' && tiles.includes(map.tiles[t])) return k;
  return null;
}

const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Per-tile MP costs for one map and one set of move bonuses. Interface of pathfinding.MoveGrid. */
export class GameGrid {
  constructor(map, bonuses = []) {
    const { tilesW: W, tilesH: H } = map.grid;
    this.W = W; this.H = H;
    this.rules = RULES;
    this.land = new Float32Array(W * H);
    this.sea = new Uint8Array(W * H);
    this.port = new Uint8Array(W * H);
    const easy = new Set(bonuses.flatMap((b) => BONUS_TILES[b] ?? []));
    const allTerrain = bonuses.includes('all');
    for (let t = 0; t < W * H; t++) {
      const type = map.tiles[t], f = map.flags[t];
      if (type === Tile.WATER) {
        this.land[t] = Infinity;
        this.sea[t] = f & (Flag.LAKE | Flag.FROZEN) ? 0 : 1;
        continue;
      }
      let c = easy.has(type) ? 2 : COSTS[type];
      if (allTerrain && type === Tile.MOUNTAINS) c = 6; // all-terrain armies climb mountains
      if (f & Flag.LAVA) c = Infinity;
      else if (f & (Flag.ROAD | Flag.BRIDGE | Flag.CITY)) c = Math.min(c, RULES.road);
      else if (f & Flag.RIVER) c += easy.size ? RULES.ford / 2 : RULES.ford;
      this.land[t] = c;
      if (f & Flag.PORT) this.port[t] = 1;
    }
    this.minStep = RULES.road;
  }

  tile(tx, ty) { return ty * this.W + tx; }
  xy(t) { return [t % this.W, (t / this.W) | 0]; }
  passable(t) { return this.sea[t] === 1 || this.land[t] < Infinity; }
  flyCost() { return RULES.fly; }

  stepCost(a, b, dx, dy) {
    const aSea = this.sea[a] === 1, bSea = this.sea[b] === 1;
    const diag = dx !== 0 && dy !== 0;
    if (!aSea && !bSea) {
      const c = this.land[b];
      if (c === Infinity) return Infinity;
      if (diag && (this.land[a + dx] === Infinity || this.land[a + dy * this.W] === Infinity)) return Infinity;
      return c;
    }
    if (aSea && bSea) {
      if (diag && (!this.sea[a + dx] || !this.sea[a + dy * this.W])) return Infinity;
      return RULES.sea;
    }
    if (diag) return Infinity;
    if (aSea) return this.port[b] ? this.land[b] + RULES.embark : Infinity; // landing
    return this.port[a] ? RULES.sea + RULES.embark : Infinity; // boarding
  }
}

/** Movement grids of one map, one per combination of move bonuses, built on demand. */
export class Movement {
  constructor(map) {
    this.map = map;
    this.W = map.grid.tilesW;
    this.H = map.grid.tilesH;
    this.grids = new Map();
    this.links = new Map();
    this.base = this.grid([]);
    this.links = riverVoyages(map, this.base);
    this.base.links = this.links;
  }

  grid(bonuses) {
    const key = [...new Set(bonuses)].sort().join(',');
    if (!this.grids.has(key)) {
      const g = new GameGrid(this.map, key ? key.split(',') : []);
      g.links = this.links;
      this.grids.set(key, g);
    }
    return this.grids.get(key);
  }

  /** Bridges where ships put in: [{ t, to (the sea tile at the river mouth) }]. */
  get landings() { return [...this.links.entries()].filter(([t]) => !this.isSea(t)).map(([t, ls]) => ({ t, to: ls[0].to })); }

  /**
   * Cheapest path for a group. `mover`: { bonuses: [], fly }. `blocked`: Set of tiles it may not
   * enter (enemy armies and cities, full friendly stacks); the goal itself may be blocked
   * (an attack): the path then ends on it and the caller stops one tile short.
   */
  findPath(mover, start, goal, blocked = null) {
    const grid = this.grid(mover.bonuses);
    let bl = blocked;
    if (bl?.has(goal)) { bl = new Set(bl); bl.delete(goal); }
    return astar(grid, start, goal, { blocked: bl, fly: mover.fly });
  }

  reachable(mover, start, budget, blocked = null) {
    return reach(this.grid(mover.bonuses), start, budget, { blocked, fly: mover.fly });
  }

  neighbours(t) {
    const x = t % this.W, y = (t / this.W) | 0, out = [];
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < this.W && ny < this.H) out.push(ny * this.W + nx);
    }
    return out;
  }

  isSea(t) { return this.base.sea[t] === 1; }
  isLand(t) { return this.base.land[t] < Infinity; }
  distance(a, b) {
    const ax = a % this.W, ay = (a / this.W) | 0, bx = b % this.W, by = (b / this.W) | 0;
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  }
}

/**
 * River voyages: from each bridge whose river runs to the sea, the tiles a ship follows
 * downstream to the first open sea tile, both ways. tile -> [{ to, tiles, costs, cost }];
 * the whole cost is paid on the first step, so a voyage is never broken off midstream.
 */
export function riverVoyages(map, grid) {
  const links = new Map();
  const W = map.grid.tilesW, H = map.grid.tilesH, g = map.grid;
  const tileOf = (x, z) => {
    const tx = Math.floor((x + g.worldW / 2) / g.tileSize), ty = Math.floor((z + g.worldH / 2) / g.tileSize);
    return tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : ty * W + tx;
  };
  const add = (from, to, tiles) => {
    const cost = Math.min(VOYAGE_MAX, RULES.embark + Math.ceil((tiles.length - 1) / 2));
    const L = { to, tiles, costs: tiles.map((_, i) => (i === 1 ? cost : 0)), cost };
    if (!links.has(from)) links.set(from, []);
    links.get(from).push(L);
  };
  for (let b = 0; b < W * H; b++) {
    if (!(map.flags[b] & Flag.BRIDGE) || grid.land[b] === Infinity) continue;
    const cx = ((b % W) + 0.5) * g.tileSize - g.worldW / 2, cz = (((b / W) | 0) + 0.5) * g.tileSize - g.worldH / 2;
    // the river under the bridge, and where along it the bridge stands
    let best = null, bd = g.tileSize;
    for (const r of map.rivers ?? []) {
      if (!r.endsInSea) continue;
      const n = r.x.length ?? Object.keys(r.x).length;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(r.x[i] - cx, r.z[i] - cz);
        if (d < bd) { bd = d; best = { r, i, n }; }
      }
    }
    if (!best) continue;
    const tiles = [b];
    let ok = false;
    for (let i = best.i; i < best.n; i++) {
      const t = tileOf(best.r.x[i], best.r.z[i]);
      if (t < 0) break;
      if (t === tiles[tiles.length - 1]) continue;
      if (map.flags[t] & Flag.CITY) break;
      tiles.push(t);
      if (grid.sea[t] === 1) { ok = true; break; }
    }
    if (!ok || tiles.length < 3) continue;
    add(b, tiles[tiles.length - 1], tiles);
    add(tiles[tiles.length - 1], b, [...tiles].reverse());
  }
  return links;
}
