import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, WEATHER_DAYS, GAME_WEATHERS, HERO_NAME_MAX, HERO_MAX } from '../src/game/Game.js';
import { STACK_MAX, CITY_MAX, unitPower } from '../src/game/rules.js';
import { SIDES } from '../src/game/data/sides.js';
import { HERO_NAMES } from '../src/game/data/heroes.js';
import { UNITS } from '../src/game/data/units.js';
import { Factions } from '../src/generator/terrainTypes.js';
import { newGame, loadMap, sidesOf, allUnits } from './helpers.js';

// --- setup -------------------------------------------------------------------------------------------------
test('there are eight sides, and a map can seat all eight', async () => {
  assert.equal(SIDES.length, 8);
  assert.equal(Factions.length, 8);
  const map = await loadMap('eight-warlords.wlmap');
  assert.deepEqual(sidesOf(map), [0, 1, 2, 3, 4, 5, 6, 7]);
  const g = await newGame('eight-warlords.wlmap', { humans: 2 });
  assert.equal(g.s.players.length, 8);
  assert.equal(new Set(g.s.players.map((p) => p.color)).size, 8, 'every side has its own colour');
  for (const p of g.s.players) {
    const caps = g.citiesOf(p.id).filter((c) => c.capital);
    assert.equal(caps.length, 1, `${p.name} starts with one capital`);
    assert.equal(g.heroes(p.id).length, 1, `${p.name} starts with one hero`);
  }
});

test('each side starts with one free hero in its capital; a human names theirs', async () => {
  const g = await newGame('small-skirmish.wlmap', { humans: 1 });
  const [human, ai] = g.s.players;
  assert.ok(human.human && !ai.human);
  const [hh] = g.heroes(human.id);
  const cap = g.s.cities.find((c) => c.owner === human.id && c.capital);
  assert.ok(cap.tiles.includes(g.stackOfUnit(hh.id).t), 'the hero stands in the capital');
  assert.deepEqual(g.freshHeroes(human.id), [hh], 'the human hero awaits a name');
  assert.deepEqual(g.freshHeroes(ai.id), [], 'computer heroes are not announced');
  assert.ok(HERO_NAMES.includes(hh.hero.name));
});

test('renaming a hero: trims, caps the length, ignores empty names, clears the announcement', async () => {
  const g = await newGame();
  const [u] = g.heroes(g.currentId);
  const old = u.hero.name;
  assert.equal(g.renameHero(u, '   '), false);
  assert.equal(u.hero.name, old, 'an empty name keeps the old one');
  assert.equal(u.hero.fresh, undefined, 'answered: not asked again');
  assert.equal(g.renameHero(u, '  Lord   Tomasz  the Bold '), true);
  assert.equal(u.hero.name, 'Lord Tomasz the Bold');
  g.renameHero(u, 'X'.repeat(80));
  assert.equal(u.hero.name.length, HERO_NAME_MAX);
  assert.equal(g.renameHero({ id: 1, type: 'archer' }, 'Nobody'), false, 'only heroes have names');
  // the name survives a save
  const g2 = new Game(g.map, JSON.parse(JSON.stringify(g.s)));
  assert.equal(g2.heroes(g2.currentId)[0].hero.name, 'X'.repeat(HERO_NAME_MAX));
});

test('new heroes get names no living hero bears', async () => {
  const g = await newGame('eight-warlords.wlmap');
  const names = g.s.stacks.flatMap((k) => k.units.filter((u) => u.hero).map((u) => u.hero.name));
  assert.equal(new Set(names).size, names.length);
  for (let i = 0; i < 30; i++) assert.ok(!names.includes(g.randomHeroName()));
});

// --- offers ------------------------------------------------------------------------------------------------
test('heroes only offer service when the side can pay, in one of its own cities', async () => {
  const g = await newGame('classic-continent.wlmap', { humans: 1, seed: 3 });
  let offers = 0;
  for (let i = 0; i < 400; i++) {
    const p = g.current;
    p.gold = i % 2 ? 0 : 5000;
    g.s.round = 5;
    g._startTurn();
    for (const o of g.s.offers.filter((x) => x.kind === 'hero')) {
      offers++;
      assert.ok(p.gold >= o.cost, 'a hero never asks more than the treasury holds');
      assert.equal(g.s.cities[o.city].owner, p.id, 'the offer comes from one of the side\'s cities');
    }
  }
  assert.ok(offers > 10, `offers do come (${offers})`);
});

test('a hired hero arrives in the city of the offer and a human names them', async () => {
  const g = await newGame('classic-continent.wlmap', { humans: 1, seed: 4 });
  const p = g.current;
  assert.ok(p.human);
  g.renameHero(g.heroes(p.id)[0], 'First');
  const city = g.citiesOf(p.id)[0];
  p.gold = 1000;
  g.s.offers = [{ id: 999, kind: 'hero', cls: SIDES[p.id].heroes[0], level: 1, cost: 400, allies: [], city: city.id }];
  const r = g.acceptOffer(999);
  assert.equal(r.city, city);
  assert.equal(p.gold, 600);
  const hero = r.units[0];
  assert.ok(city.tiles.includes(g.stackOfUnit(hero.id).t));
  assert.deepEqual(g.freshHeroes(p.id), [hero]);
  // an offer can't be taken twice or without the gold
  assert.equal(g.acceptOffer(999), null);
  g.s.offers = [{ id: 1000, kind: 'hero', cls: SIDES[p.id].heroes[0], level: 1, cost: 5000, allies: [], city: city.id }];
  assert.equal(g.acceptOffer(1000), null);
  assert.ok(HERO_MAX >= 4);
});

// --- turns ---------------------------------------------------------------------------------------------------
test('turns go round every living side; a round is a day; weather holds three days', async () => {
  const g = await newGame('twin-realms.wlmap', { humans: 0 });
  const n = g.s.players.length;
  const seen = [];
  const weather = [];
  for (let i = 0; i < n * 12; i++) {
    seen.push(g.currentId);
    if (g.s.turn === 0) weather.push([g.s.round, g.s.weather.name, g.s.weather.round]);
    g.endTurn();
  }
  assert.deepEqual(seen.slice(0, n), g.s.order);
  assert.equal(g.s.round, 13);
  for (const [round, name, since] of weather) {
    assert.ok(GAME_WEATHERS.includes(name), `${name} is an allowed weather`);
    assert.ok(round - since < WEATHER_DAYS, 'weather changes every three days');
  }
  // eliminated sides are skipped
  const dead = g.s.players[1];
  dead.alive = false;
  for (let i = 0; i < n * 2; i++) { assert.notEqual(g.currentId, dead.id); g.endTurn(); }
});

test('cities pay income, armies cost upkeep, unpaid armies desert', async () => {
  const g = await newGame();
  const p = g.current;
  // skip to this side's next turn with an empty treasury and a big army
  p.gold = 0;
  const cap = g.citiesOf(p.id).find((c) => c.capital);
  g.addUnits(cap.tiles[2], p.id, Array.from({ length: 8 }, () => g.newUnit('knight')));
  for (const c of g.citiesOf(p.id)) c.income = 1;
  const before = allUnits(g).filter(({ k }) => k.owner === p.id).length;
  do g.endTurn(); while (g.currentId !== p.id);
  const rep = g.lastReport;
  assert.ok(rep.upkeep > rep.income);
  assert.ok(rep.disbanded.length > 0, 'someone deserts');
  assert.ok(p.gold >= 0);
  assert.equal(allUnits(g).filter(({ k }) => k.owner === p.id).length, before - rep.disbanded.length + rep.produced.length);
  assert.ok(g.heroes(p.id).length === 1, 'heroes never desert');
});

test('cities train their army type after its production time', async () => {
  const g = await newGame();
  const p = g.current;
  const c = g.citiesOf(p.id)[0];
  const type = c.producing;
  const t = UNITS[type].time;
  const count = () => g.unitsIn(c).filter((u) => u.type === type).length;
  const n0 = count();
  p.gold = 99999;
  for (let i = 0; i < t; i++) { do g.endTurn(); while (g.currentId !== p.id); }
  assert.equal(count(), n0 + 1);
});

// --- movement and battles ----------------------------------------------------------------------------------------
test('a group can\'t stop where more than eight would stand', async () => {
  const g = await newGame();
  const p = g.current;
  const cap = g.citiesOf(p.id).find((c) => c.capital);
  // find an open tile next to the capital
  const t = g.move.neighbours(cap.tiles[3]).find((x) => g.move.isLand(x) && !g.cityAt(x) && !g.stackAt(x));
  g.addUnits(t, p.id, Array.from({ length: 6 }, () => g.newUnit('lightinfantry')));
  const k = g.stackAt(cap.tiles[1]);
  const ids = k.units.map((u) => u.id);
  assert.ok(ids.length >= 3);
  assert.equal(g.plan(g.unitsById(ids), k.t, t), null, '6 + 3 > 8');
  assert.ok(g.plan(g.unitsById(ids.slice(0, 2)), k.t, t), '6 + 2 fits');
  assert.equal(STACK_MAX, 8);
  assert.equal(CITY_MAX, 32);
});

test('attacking costs the movement of entering the defender\'s square', async () => {
  const g = await newGame();
  const p = g.current;
  const cap = g.citiesOf(p.id).find((c) => c.capital);
  const free = g.move.neighbours(cap.tiles[3]).filter((x) => g.move.isLand(x) && !g.cityAt(x) && !g.stackAt(x));
  const [a, b] = free.filter((x) => g.move.neighbours(free[0]).includes(x) || x === free[0]);
  assert.ok(a != null && b != null);
  const [mine] = g.addUnits(a, p.id, [g.newUnit('knight'), g.newUnit('knight'), g.newUnit('knight')]);
  g.addUnits(b, g.s.players[1].id, [g.newUnit('goblin')]);
  for (const u of mine.units) u.mp = 20;
  const out = g.attack(mine, b);
  assert.ok(out.won);
  const enter = g.move.base.land[b];
  for (const u of g.stack(mine.id).units) assert.equal(u.mp, 20 - enter);
  assert.equal(g.stack(mine.id).t, b, 'the winners advance into the square');
});

test('taking a city: occupy keeps it, raze leaves ruins nobody owns', async () => {
  for (const choice of ['occupy', 'pillage', 'sack', 'raze']) {
    const g = await newGame();
    const p = g.current;
    const target = g.s.cities.find((c) => c.owner === -1);
    for (const k of g.garrison(target)) g.removeUnits(k.units.map((u) => u.id));
    const t = g.move.neighbours(target.tiles[0]).find((x) => g.move.isLand(x) && !g.cityAt(x) && !g.stackAt(x));
    const [k] = g.addUnits(t, p.id, [g.newUnit('knight')]);
    const out = g.attack(k, target.tiles[0]);
    assert.ok(out.won && out.walkIn, 'an empty city is walked into');
    const gold = p.gold;
    const r = g.captureCity(k, target, choice);
    if (choice === 'raze') {
      assert.ok(target.razed);
      assert.equal(target.owner, -1);
      assert.ok(!g.citiesOf(-1).includes(target), 'razed cities are nobody\'s');
    } else {
      assert.equal(target.owner, p.id);
      assert.equal(p.gold, gold + r.gold);
      assert.ok(target.tiles.includes(g.stack(k.id).t), 'the attackers move in');
    }
  }
});

test('a side with no cities and no armies is out; the last one standing wins', async () => {
  const g = await newGame('small-skirmish.wlmap', { humans: 0 });
  const [a, b] = g.s.players;
  let over = null;
  g.on('gameOver', (e) => (over = e));
  for (const c of g.citiesOf(b.id)) c.owner = a.id;
  g.removeUnits(g.stacksOf(b.id).flatMap((k) => k.units.map((u) => u.id)));
  g._checkAlive();
  assert.equal(b.alive, false);
  assert.ok(g.s.over);
  assert.equal(g.s.winner, a.id);
  assert.equal(over.winner, a);
});

// --- whole games -------------------------------------------------------------------------------------------------
test('saves are plain JSON and games continue identically after loading', async () => {
  const { Commander } = await import('../src/game/commands.js');
  const { AIPlayer } = await import('../src/game/ai.js');
  const g = await newGame('small-skirmish.wlmap', { humans: 0, seed: 21 });
  const play = async (game, turns) => { const cmd = new Commander(game); for (let i = 0; i < turns && !game.s.over; i++) { await new AIPlayer(cmd, game.currentId).play(); game.endTurn(); } };
  await play(g, 6);
  const saved = JSON.stringify(g.s);
  const a = new Game(g.map, JSON.parse(saved)), b = new Game(g.map, JSON.parse(saved));
  await play(a, 8); await play(b, 8);
  assert.equal(JSON.stringify(a.s), JSON.stringify(b.s), 'same seed, same game');
});

/** Things that must hold in every state of every game. */
function checkInvariants(g, where) {
  const ids = new Set();
  for (const k of g.s.stacks) {
    assert.ok(k.units.length > 0, `${where}: empty stack`);
    const city = g.cityAt(k.t);
    assert.ok(k.units.length <= STACK_MAX, `${where}: stack of ${k.units.length}`);
    if (!city) assert.ok(g.s.stacks.filter((x) => x.t === k.t).length === 1, `${where}: two stacks on one tile`);
    for (const u of k.units) {
      assert.ok(!ids.has(u.id), `${where}: army ${u.id} in two places`);
      ids.add(u.id);
      assert.ok(u.hero || UNITS[u.type], `${where}: unknown army type ${u.type}`);
      assert.ok(Number.isFinite(u.mp) && u.mp >= 0, `${where}: mp ${u.mp}`);
    }
  }
  for (const c of g.s.cities) {
    const owners = new Set(g.garrison(c).map((k) => k.owner));
    assert.ok(owners.size <= 1, `${where}: two sides inside ${c.name}`);
    assert.ok(g.unitsIn(c).length <= CITY_MAX, `${where}: ${g.unitsIn(c).length} armies in ${c.name}`);
    if (owners.size && !c.razed) assert.equal([...owners][0], c.owner, `${where}: ${c.name} held by a stranger`);
  }
  for (const p of g.s.players) assert.ok(p.gold >= 0 && Number.isFinite(p.gold), `${where}: gold ${p.gold}`);
  assert.ok(ids.size < g.s.nextId);
}

test('eight computer warlords play 60 days on the eight-side map without breaking a rule', async () => {
  const { Commander } = await import('../src/game/commands.js');
  const { AIPlayer } = await import('../src/game/ai.js');
  const g = await newGame('eight-warlords.wlmap', { humans: 0, seed: 5 });
  const cmd = new Commander(g);
  let battles = 0;
  g.on('battle', () => battles++);
  while (!g.s.over && g.s.round <= 60) {
    await new AIPlayer(cmd, g.currentId).play();
    checkInvariants(g, `day ${g.s.round} ${g.current.name}`);
    g.endTurn();
  }
  assert.ok(battles > 20, `the sides fight (${battles} battles)`);
  assert.ok(g.s.players.filter((p) => !p.alive).length >= 2, 'some sides fall');
  assert.ok(unitPower(g.s.stacks[0].units[0]) > 0);
});

test('every map in maps/ starts a game and survives 25 days of computer play', async () => {
  const { readdirSync } = await import('node:fs');
  const { Commander } = await import('../src/game/commands.js');
  const { AIPlayer } = await import('../src/game/ai.js');
  const files = readdirSync(new URL('../maps/', import.meta.url)).filter((f) => f.endsWith('.wlmap'));
  assert.ok(files.length >= 1);
  for (const f of files) {
    const g = await newGame(f, { humans: 0, seed: 9 });
    assert.ok(g.s.players.length >= 2, `${f} seats two or more sides`);
    const cmd = new Commander(g);
    while (!g.s.over && g.s.round <= 25) { await new AIPlayer(cmd, g.currentId).play(); g.endTurn(); }
    checkInvariants(g, f);
  }
});

test('a ruin is searched by the hero alone, backed by the army\'s strength; the group waits outside', async () => {
  const { ruinChance } = await import('../src/game/combat.js');
  let wins = 0, tries = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = await newGame('small-skirmish.wlmap', { humans: 1, seed });
    const pid = g.currentId;
    const k = g.stacksOf(pid).find((x) => x.units.some((u) => u.hero));
    const ri = g.map.sites.findIndex((s) => s.kind === 'ruin' && (s.danger ?? 1) === 1);
    if (!k || ri < 0) continue;
    const site = g.map.sites[ri];
    const t = site.ty * g.W + site.tx;
    const hero = k.units.find((u) => u.hero);
    const others = [g.newUnit(Object.keys(UNITS)[0]), g.newUnit(Object.keys(UNITS)[0])];
    for (const s of g.s.stacks.filter((x) => x.t === t)) g.s.stacks.splice(g.s.stacks.indexOf(s), 1);
    k.units = k.units.filter((u) => u === hero);
    g.addUnits(t, pid, [hero, ...others]);
    g.s.stacks = g.s.stacks.filter((x) => x !== k);
    const stack = g.stackAt(t);
    assert.ok(ruinChance(hero, 1, stack.units) > ruinChance(hero, 1), 'the army with the hero improves the odds');
    assert.ok(ruinChance(hero, 3) < 0.5, 'a lone fresh hero is likely to die in a dangerous ruin');
    const out = g.search(stack);
    tries++;
    if (out.won) wins++;
    if (out.battle) assert.deepEqual(out.battle.att.map((u) => u.id), [hero.id], 'only the hero fights');
    for (const u of others) assert.ok(g.unit(u.id), 'the waiting group is never harmed');
    assert.equal(!!g.unit(hero.id), out.won);
  }
  assert.ok(tries >= 20);
  assert.ok(wins / tries > 0.5, `fresh heroes with a small army win most danger-1 ruins (${wins}/${tries})`);
});
