// Special sites (Warlords III manual, "Sites"): mines, stables, smithies, weaponmasters,
// barracks and ranger's towers. Each serves the city nearest to it, for as long as that city
// stands: a mine adds gold to its income, the others improve every army the city trains.
// Any army standing on a site may raze it (a way to hurt a foe whose city it cannot take);
// the city's owner may rebuild it. Placed from the map itself (seeded by the map), so every
// map has them; their razed state lives in the save (game.s.specials).
import { Tile, Flag } from '../generator/terrainTypes.js';

export const SPECIAL_TYPES = {
  mine: { name: 'Gold Mine', model: 'Site_Mine', title: 'Mine of', text: '+15 gold a turn to', gold: 15, icon: '⛏', steep: 2, suit: { [Tile.HILLS]: 2, [Tile.PLAINS]: 0.6, [Tile.FOREST]: 0.5, [Tile.ICE]: 0.8 } },
  stables: { name: 'Stables', model: 'Site_Stables', title: 'Stables of', text: '+2 move to mounted armies trained in', move: 2, icon: '🐎', suit: { [Tile.PLAINS]: 2, [Tile.SHORE]: 0.8, [Tile.HILLS]: 0.5 } },
  smithy: { name: 'Smithy', model: 'Site_Smithy', title: 'Forge of', text: '+1 strength to armies trained in', str: 1, icon: '⚒', suit: { [Tile.PLAINS]: 1.5, [Tile.HILLS]: 1, [Tile.SHORE]: 0.8, [Tile.FOREST]: 0.5 } },
  weaponmaster: { name: 'Weaponmaster', model: 'Site_Weaponmaster', title: 'Hall of', text: '+1 hit point to armies trained in', hits: 1, icon: '⚔', suit: { [Tile.PLAINS]: 1.5, [Tile.HILLS]: 0.8, [Tile.SHORE]: 0.8 } },
  barracks: { name: 'Barracks', model: 'Site_Barracks', title: 'Barracks of', text: 'one turn less to train armies in', time: 1, icon: '🛡', suit: { [Tile.PLAINS]: 1.6, [Tile.HILLS]: 0.8, [Tile.FOREST]: 0.6, [Tile.SHORE]: 0.6 } },
  ranger: { name: "Ranger's Tower", model: 'Site_Ranger', title: 'Watch of', text: '+2 view to armies trained in', view: 2, icon: '🏹', steep: 1.5, suit: { [Tile.FOREST]: 1.8, [Tile.HILLS]: 1.4, [Tile.PLAINS]: 0.7, [Tile.ICE]: 0.8, [Tile.SWAMP]: 0.6 } },
};
export const SPECIAL_KINDS = Object.keys(SPECIAL_TYPES);
export const REBUILD_SITE = 300; // gold to rebuild a razed site
// armies that ride: stables speed them
export const MOUNTED = new Set(['elvencavalry', 'gnollcavalry', 'heavycavalry', 'lightcavalry', 'knight', 'knightlord', 'slayerknight', 'wolfrider', 'scout', 'centaur', 'reaver', 'nightmare', 'unicorn']);

const BLOCK = Flag.RIVER | Flag.ROAD | Flag.BRIDGE | Flag.CITY | Flag.LAVA | Flag.LAKE | Flag.PORT;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The special sites of a map: about two in three cities get one, 2–5 tiles out, on dry
 * level ground its type suits (a mine or a tower may take a steeper slope, `steep`), clear
 * of roads, rivers and other sites; every type is used before any repeats. [{ i, type, t, tx, ty, x, y, z, yaw, city }]
 */
export function makeSpecialSites(map) {
  if (map._specials) return map._specials;
  const g = map.grid, W = g.tilesW, H = g.tilesH;
  const rand = rng(((map.params?.seed ?? 1) * 2654435761) ^ 0x51735);
  const taken = new Set();
  const mark = (tx, ty, r) => { for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) taken.add(y * W + x); };
  for (const c of map.cities) mark(c.tx, c.ty, 2), mark(c.tx + 1, c.ty + 1, 2);
  for (const s of map.sites ?? []) mark(s.tx, s.ty, 2);
  for (const p of map.ports ?? []) mark(p.tx, p.ty, 1);
  const level = (t) => {
    const tx = t % W, ty = (t / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = (ty + dy) * W + tx + dx;
      if (map.tiles[n] === Tile.WATER || map.tiles[n] === Tile.MOUNTAINS || Math.abs((map.tileHeights?.[n] ?? 0) - (map.tileHeights?.[t] ?? 0)) > 1.2) return false;
    }
    return true;
  };
  // how far the ground rises and falls under a site's footprint (the models reach about
  // 0.9 tiles out): a building must not stand half inside a hillside
  const spread = (tx, ty) => {
    const hs = map.heights;
    if (!hs) return 0;
    const ci = (tx + 0.5) * g.tileSize / g.cellSize, cj = (ty + 0.5) * g.tileSize / g.cellSize, r = (g.tileSize * 0.9) / g.cellSize;
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.floor(cj - r); j <= Math.ceil(cj + r); j++) for (let i = Math.floor(ci - r); i <= Math.ceil(ci + r); i++) {
      if ((i - ci) ** 2 + (j - cj) ** 2 > r * r || i < 0 || j < 0 || i >= g.gw || j >= g.gh) continue;
      const h = hs[j * g.gw + i];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return hi - lo;
  };
  const order = [...map.cities.keys()].sort(() => rand() - 0.5);
  const want = Math.round(map.cities.length * 0.66);
  let bag = [];
  const out = [];
  for (const ci of order) {
    if (out.length >= want) break;
    const c = map.cities[ci];
    if (!bag.length) bag = [...SPECIAL_KINDS].sort(() => rand() - 0.5);
    // the type that best suits the land around this city, from those not yet used this round
    let best = null;
    for (const type of bag) {
      const suit = SPECIAL_TYPES[type].suit;
      for (let ty = c.ty - 5; ty <= c.ty + 6; ty++) for (let tx = c.tx - 5; tx <= c.tx + 6; tx++) {
        if (tx < 2 || ty < 2 || tx >= W - 2 || ty >= H - 2) continue;
        const t = ty * W + tx;
        const d = Math.max(Math.abs(tx - c.tx - 0.5), Math.abs(ty - c.ty - 0.5));
        if (d < 2.5 || d > 5.5 || taken.has(t) || map.flags[t] & BLOCK || !suit[map.tiles[t]] || !level(t)) continue;
        const sp = spread(tx, ty);
        if (sp > (SPECIAL_TYPES[type].steep ?? 1)) continue;
        const score = suit[map.tiles[t]] * (1 + rand() * 0.5) / (1 + Math.abs(d - 3.5) * 0.3) / (1 + sp * 2);
        if (!best || score > best.score) best = { type, t, tx, ty, score };
      }
    }
    if (!best) continue;
    bag = bag.filter((x) => x !== best.type);
    mark(best.tx, best.ty, 2);
    const x = (best.tx + 0.5) * g.tileSize - g.worldW / 2, z = (best.ty + 0.5) * g.tileSize - g.worldH / 2;
    // face the city
    const yaw = Math.atan2(c.x - x, c.z - z);
    out.push({ i: out.length, type: best.type, t: best.t, tx: best.tx, ty: best.ty, x, z, y: map.tileHeights?.[best.t] ?? 0, yaw, city: ci });
  }
  map._specials = out;
  return out;
}
