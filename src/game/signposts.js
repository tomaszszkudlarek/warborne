// Signposts: wooden fingerposts where roads fork (and a little way out of cities on long
// roads), each board naming the nearest city down its branch and the leagues (road tiles) to
// it. Derived from the map's road network, so every map has them without storing them.
// Returns [{ t, boards: [{ city, name, dist, dx, dy, dir }], side: [dx, dy] }] — (dx, dy) the
// branch's first step from t; `side` the free neighbour the post stands toward.
import { Flag } from '../generator/terrainTypes.js';

const DIRS = { '0,-1': 'N', '1,-1': 'NE', '1,0': 'E', '1,1': 'SE', '0,1': 'S', '-1,1': 'SW', '-1,0': 'W', '-1,-1': 'NW' };
export const ARROW = { N: '↑', NE: '↗', E: '→', SE: '↘', S: '↓', SW: '↙', W: '←', NW: '↖' };
const MIN_GAP = 6; // tiles between posts
const CITY_GAP = 3; // tiles a post keeps from a city

export function makeSignposts(map) {
  if (map._signposts) return map._signposts;
  const W = map.grid.tilesW;
  const roads = map.roads ?? [];
  const xy = (t) => [t % W, (t / W) | 0];
  const cityTiles = map.cities.map((c) => c.ty * W + c.tx);
  const nearCity = (t) => {
    const [x, y] = xy(t);
    return map.cities.some((c) => Math.max(Math.abs(c.tx + 0.5 - x), Math.abs(c.ty + 0.5 - y)) <= CITY_GAP + 0.5);
  };
  const usable = (t) => !(map.flags[t] & (Flag.CITY | Flag.BRIDGE | Flag.PORT)) && !nearCity(t);
  // every road step through each tile: the neighbour it leads to, and where that way ends
  const ways = new Map(); // t -> Map(neighbour -> { city, dist })
  const addWay = (t, n, city, dist) => {
    if (!ways.has(t)) ways.set(t, new Map());
    const m = ways.get(t);
    const cur = m.get(n);
    if (!cur || dist < cur.dist) m.set(n, { city, dist });
  };
  for (const r of roads) {
    const T = r.tiles;
    for (let i = 0; i < T.length; i++) {
      if (i + 1 < T.length) addWay(T[i], T[i + 1], r.to, T.length - 1 - i);
      if (i > 0) addWay(T[i], T[i - 1], r.from, i);
    }
  }
  const board = (t, n, w) => {
    const [x, y] = xy(t), [nx, ny] = xy(n);
    const dx = Math.sign(nx - x), dy = Math.sign(ny - y);
    // the compass word points at the city itself, the board along the road
    const [cx, cy] = xy(cityTiles[w.city]);
    const ang = Math.atan2(cy + 0.5 - y, cx + 0.5 - x);
    const oct = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
    const dir = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][oct];
    return { city: w.city, name: map.cities[w.city].name, dist: w.dist, dx, dy, dir };
  };
  const posts = [];
  const far = (t) => posts.every((p) => {
    const [a, b] = xy(p.t), [c, d] = xy(t);
    return Math.max(Math.abs(a - c), Math.abs(b - d)) >= MIN_GAP;
  });
  const place = (t, boards) => {
    // one board per destination, nearest first, at most three
    const seen = new Set();
    boards = boards.sort((a, b) => a.dist - b.dist).filter((b) => (seen.has(b.city) ? false : seen.add(b.city))).slice(0, 3);
    if (boards.length < 2) return;
    const [x, y] = xy(t);
    const road = new Set(ways.get(t)?.keys() ?? []);
    let side = [1, 1];
    for (const [k] of Object.entries(DIRS)) {
      const [dx, dy] = k.split(',').map(Number);
      if (dx && dy) continue;
      if (!road.has((y + dy) * W + x + dx)) { side = [dx, dy]; break; }
    }
    posts.push({ t, boards, side });
  };
  // forks: three or more ways out of a tile
  const forks = [...ways.entries()].filter(([t, m]) => m.size >= 3 && usable(t)).sort((a, b) => b[1].size - a[1].size || a[0] - b[0]);
  for (const [t, m] of forks) if (far(t)) place(t, [...m.entries()].map(([n, w]) => board(t, n, w)));
  // long roads: a post a few tiles out of each end
  for (const r of roads) {
    const T = r.tiles;
    if (T.length < 11) continue;
    for (const i of [CITY_GAP + 1, T.length - 2 - CITY_GAP]) {
      const t = T[i];
      if (!usable(t) || !far(t)) continue;
      place(t, [board(t, T[i + 1], { city: r.to, dist: T.length - 1 - i }), board(t, T[i - 1], { city: r.from, dist: i })]);
    }
  }
  map._signposts = posts;
  return posts;
}

/** A post's boards as text lines: "↗ Dunmoor — 9 leagues". */
export const signpostLines = (post) => post.boards.map((b) => `${ARROW[b.dir]} ${b.name} — ${b.dist} league${b.dist === 1 ? '' : 's'}`);

export { DIRS };
