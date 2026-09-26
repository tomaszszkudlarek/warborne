// Starting positions: every city can be reached from every capital, capitals sit far apart,
// and a game with fewer sides than capitals seats them on the cities farthest apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { newGameState, Game } from '../src/game/Game.js';
import { spreadOut, startGap } from '../src/generator/settlements.js';
import { nearPort } from '../src/generator/ports.js';
import { loadMap, sidesOf } from './helpers.js';

const MAPS = readdirSync(new URL('../maps/', import.meta.url)).filter((f) => f.endsWith('.wlmap'));

test('every city on every map can be reached from every capital by land or sea', async () => {
  for (const file of MAPS) {
    const map = await loadMap(file);
    const g = new Game(map, { cities: [] });
    const W = map.grid.tilesW;
    for (const cap of map.cities.filter((c) => c.capital)) {
      const reach = g.move.reachable({ bonuses: [] }, cap.ty * W + cap.tx, Infinity);
      const cut = map.cities.filter((c) => !reach.has(c.ty * W + c.tx)).map((c) => c.name);
      assert.deepEqual(cut, [], `${file}: ${cap.name} cannot reach ${cut.join(', ')}`);
    }
  }
});

test('no tree hides a harbour', async () => {
  for (const file of MAPS) {
    const map = await loadMap(file);
    for (const [kind, v] of Object.entries(map.vegetation)) {
      for (let i = 0; i < v.length; i += 5) assert.ok(!map.ports.some((p) => nearPort(p, v[i], v[i + 2])), `${file}: a ${kind} stands on a harbour`);
    }
  }
});

test('spreadOut keeps the chosen points as far apart as possible', () => {
  // points on a line: 0 1 2 3 10 — the two farthest are 0 and 10, three are 0, 3 (or 2), 10
  const xs = [0, 1, 2, 3, 10];
  const D = xs.map((a) => xs.map((b) => Math.abs(a - b)));
  assert.deepEqual(spreadOut(D, [0, 1, 2, 3, 4], 2), [0, 4]);
  assert.deepEqual(spreadOut(D, [0, 1, 2, 3, 4], 3), [0, 3, 4]);
});

test('fewer sides than capitals start on the cities farthest apart', async () => {
  const map = await loadMap('eight-warlords.wlmap');
  const W = map.grid.tilesW;
  const sides = sidesOf(map);
  const g0 = new Game(map, { cities: [] });
  const caps = map.cities.filter((c) => c.capital);
  const reach = new Map(map.cities.map((c) => [c, g0.move.reachable({ bonuses: [] }, c.ty * W + c.tx, Infinity)]));
  const gap = (a, b) => startGap(a, b, Math.min(reach.get(a).get(b.ty * W + b.tx) ?? Infinity, reach.get(b).get(a.ty * W + a.tx) ?? Infinity));
  const closest = (set) => Math.min(...set.flatMap((a, i) => set.slice(i + 1).map((b) => gap(a, b))));
  for (const n of [2, 3, 4]) {
    // the n sides whose own capitals are closest together
    let worst = null;
    for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) {
      if (!worst || gap(caps[i], caps[j]) < gap(worst[0], worst[1])) worst = [caps[i], caps[j]];
    }
    const chosen = [...worst, ...caps.filter((c) => !worst.includes(c))].slice(0, n).map((c) => c.owner);
    const players = chosen.map((side, i) => ({ side, human: i === 0, ai: 'lord' }));
    const s = newGameState(map, { players, seed: 3 });
    const starts = s.cities.filter((c) => c.capital);
    assert.equal(starts.length, n);
    assert.deepEqual(new Set(starts.map((c) => c.owner)), new Set(chosen), 'every side gets a capital');
    assert.ok(starts.every((c) => c.level === 3), 'a start is a full capital');
    const startCities = starts.map((c) => map.cities[c.id]);
    const bestCaps = Math.max(...combos(caps, n).map(closest));
    assert.ok(closest(startCities) >= bestCaps, `${n} sides start at least as far apart as the map's own capitals allow`);
    assert.ok(closest(startCities) > gap(...worst));
    // every side has its armies at home
    for (const c of starts) assert.ok(s.stacks.some((k) => k.owner === c.owner && c.tiles.includes(k.t)));
  }
  assert.equal(sides.length, 8);
});

function combos(arr, n) {
  if (!n) return [[]];
  return arr.flatMap((x, i) => combos(arr.slice(i + 1), n - 1).map((c) => [x, ...c]));
}
