// Diplomacy, victory conditions, surrender, razing, signposts, river voyages, timed vectoring
// and merchants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, VICTORY, HILL_DAYS, TIMED_DEFAULT_LIMIT, NEUTRAL_PROD_ROUND } from '../src/game/Game.js';
import { UNITS } from '../src/game/data/units.js';
import { standing, BRIBE_GOLD } from '../src/game/diplomacy.js';
import { makeSignposts } from '../src/game/signposts.js';
import { newGame, loadMap } from './helpers.js';

/** A free land tile next to tile t. */
const freeNear = (g, t, not = []) => g.move.neighbours(t).find((x) => g.move.isLand(x) && !g.cityAt(x) && !g.stackAt(x) && !not.includes(x));
/** Two free land tiles next to each other, near side pid's capital. */
function pairNear(g, pid) {
  const cap = g.citiesOf(pid).find((c) => c.capital);
  const a = freeNear(g, cap.tiles[3]);
  const b = freeNear(g, a, [a]);
  return [a, b];
}
/** Ends turns until it is side pid's turn again (a new round has begun). */
function nextRound(g) { const r = g.s.round; while (g.s.round === r && !g.s.over) g.endTurn(); }

// --- diplomacy ------------------------------------------------------------------------------------------------
test('with diplomacy every side starts at peace; without it everyone is at war', async () => {
  const g = await newGame('twin-realms.wlmap');
  const [a, b] = g.s.players;
  assert.equal(g.diplo.status(a.id, b.id), 'peace');
  assert.ok(!g.hostile(a.id, b.id));
  assert.ok(g.hostile(a.id, -1), 'neutrals are always fair game');
  const h = g.diplo.hate(b.id, a.id);
  assert.ok(h >= 0 && h <= 100 && standing(h));
  const off = await newGame('twin-realms.wlmap', { options: { diplomacy: false } });
  assert.equal(off.diplo.status(off.s.players[0].id, off.s.players[1].id), 'war');
});

test('attacking a side at peace declares war and makes it (and everyone) hate the attacker', async () => {
  const g = await newGame('twin-realms.wlmap');
  const [a, b, c] = g.s.players;
  const [ta, tb] = pairNear(g, a.id);
  const [mine] = g.addUnits(ta, a.id, [g.newUnit('knight'), g.newUnit('knight')]);
  g.addUnits(tb, b.id, [g.newUnit('goblin')]);
  const plan = g.plan(mine.units, ta, tb);
  assert.equal(plan.attack.treaty, 'peace', 'the plan warns of the treaty');
  const hb = g.diplo.hate(b.id, a.id), hc = g.diplo.hate(c.id, a.id);
  g.attack(mine, tb);
  assert.equal(g.diplo.status(a.id, b.id), 'war');
  assert.ok(g.diplo.hate(b.id, a.id) >= hb + 20, 'the victim is enraged');
  assert.ok(g.diplo.hate(c.id, a.id) > hc, 'the others remember the broken peace');
});

test('allies pass through each other\'s armies but cannot stop on them', async () => {
  const g = await newGame('twin-realms.wlmap');
  const [a, b] = g.s.players;
  g.diplo.accept(b.id, a.id, 'alliance'); // peace -> allied
  assert.equal(g.diplo.status(a.id, b.id), 'allied');
  // three free tiles in a row: me - ally - beyond
  let line = null;
  for (let t = 0; t < g.W * g.H && !line; t++) {
    const row = [t, t + 1, t + 2];
    if (t % g.W <= g.W - 3 && row.every((r) => g.move.base.land[r] <= 2 && !g.cityAt(r) && !g.stackAt(r))) line = row;
  }
  assert.ok(line);
  const [me] = g.addUnits(line[0], a.id, [g.newUnit('lightinfantry')]);
  g.addUnits(line[1], b.id, [g.newUnit('lightinfantry')]);
  assert.ok(!g.blockedFor(a.id).has(line[1]), 'allied stacks do not block');
  assert.equal(g.plan(me.units, line[0], line[1]).attack?.treaty, 'allied', 'moving onto an ally is an attack');
  g.diplo.declareWar(a.id, b.id);
  assert.ok(g.blockedFor(a.id).has(line[1]), 'enemy stacks block');
});

test('computer sides answer proposals: peace when the war goes badly, never an alliance that ends the game', async () => {
  const g = await newGame('small-skirmish.wlmap');
  const [a, b] = g.s.players; // a human, b computer
  g.diplo.declareWar(a.id, b.id);
  // b is crushed: a far stronger army
  const [ta] = pairNear(g, a.id);
  g.addUnits(ta, a.id, Array.from({ length: 8 }, () => g.newUnit('knight')));
  g.diplo.d.hate[`${b.id}>${a.id}`] = 60;
  const r = g.diplo.propose(a.id, b.id, 'peace');
  assert.equal(r.answer, 'accepted', r.reason);
  assert.equal(g.diplo.status(a.id, b.id), 'peace');
  g.diplo.d.hate[`${b.id}>${a.id}`] = 0;
  const al = g.diplo.propose(a.id, b.id, 'alliance');
  assert.equal(al.answer, 'refused', 'two sides left: an alliance would hand them a shared victory');
});

test('a proposal to a human waits for their answer', async () => {
  const g = await newGame('small-skirmish.wlmap', { humans: 2 });
  const [a, b] = g.s.players;
  g.diplo.declareWar(a.id, b.id);
  const r = g.diplo.propose(b.id, a.id, 'peace');
  assert.equal(r.answer, 'pending');
  assert.deepEqual(g.diplo.pendingFor(a.id).map((p) => p.kind), ['peace']);
  assert.ok(g.diplo.hasNews(a.id));
  g.diplo.accept(a.id, b.id, 'peace');
  assert.equal(g.diplo.status(a.id, b.id), 'peace');
  assert.equal(g.diplo.pendingFor(a.id).length, 0);
});

test('bribes: 50 gold per point of hate, and the gold changes hands', async () => {
  const g = await newGame('twin-realms.wlmap');
  const [a, b] = g.s.players;
  a.gold = 1000;
  const gb = b.gold, h = g.diplo.hate(b.id, a.id);
  const pts = g.diplo.bribe(a.id, b.id, 260);
  assert.equal(pts, 5);
  assert.equal(a.gold, 1000 - 5 * BRIBE_GOLD);
  assert.equal(b.gold, gb + 250);
  assert.equal(g.diplo.hate(b.id, a.id), Math.max(0, h - 5));
});

test('computer sides with nobody to fight pick a war sooner or later', async () => {
  const g = await newGame('twin-realms.wlmap', { humans: 0 });
  const { Commander } = await import('../src/game/commands.js');
  const { AIPlayer } = await import('../src/game/ai.js');
  const cmd = new Commander(g);
  while (g.s.round <= 20 && !g.s.over) { await new AIPlayer(cmd, g.currentId).play(); g.endTurn(); }
  const wars = g.s.players.filter((p) => g.diplo.enemies(p.id).length).length;
  assert.ok(wars >= 2 || g.s.over, 'wars have broken out');
});

// --- victory ----------------------------------------------------------------------------------------------------
test('victory points: a point per city and hero, plus the gold scale of Warlords III', async () => {
  const g = await newGame('twin-realms.wlmap');
  const p = g.s.players[0];
  const base = g.citiesOf(p.id).length + g.heroes(p.id).length;
  for (const [gold, pts] of [[0, 0], [250, 2], [500, 5], [999, 5], [1000, 6], [3500, 8]]) {
    p.gold = gold;
    assert.equal(g.victoryPoints(p.id) - base, pts, `${gold} gold`);
  }
});

test('the "most ..." conditions need a turn limit and are decided when it runs out', async () => {
  for (const v of Object.keys(VICTORY).filter((k) => VICTORY[k].timed)) {
    const g = await newGame('small-skirmish.wlmap', { humans: 0, options: { victory: v } });
    assert.equal(g.s.options.turnLimit, TIMED_DEFAULT_LIMIT);
  }
  const g = await newGame('small-skirmish.wlmap', { humans: 0, options: { victory: 'gold', turnLimit: 2 } });
  const [a, b] = g.s.players;
  let ev = null;
  g.on('gameOver', (e) => (ev = e));
  while (!g.s.over) { b.gold = 10; a.gold = 5000; g.endTurn(); }
  assert.equal(ev.reason, 'time');
  assert.deepEqual(g.s.winners, [a.id]);
});

test('King of the Hill: Utopia is rich and guarded; holding it ten days wins', async () => {
  const g = await newGame('twin-realms.wlmap', { humans: 0, options: { victory: 'hill' } });
  const u = g.s.cities[g.s.hill.city];
  assert.equal(u.name, 'Utopia');
  assert.equal(u.income, 100);
  assert.equal(u.owner, -1);
  assert.ok(g.unitsIn(u).length >= 6, 'stocked with neutral armies');
  const p = g.s.players[0];
  g.removeUnits(g.unitsIn(u).map((x) => x.id));
  u.owner = p.id;
  let ev = null;
  g.on('gameOver', (e) => (ev = e));
  for (let d = 0; d <= HILL_DAYS + 1 && !g.s.over; d++) { u.owner = p.id; nextRound(g); }
  assert.equal(ev?.reason, 'hill');
  assert.deepEqual(g.s.winners, [p.id]);
});

test('Fortress: holding every capital wins at once', async () => {
  const g = await newGame('twin-realms.wlmap', { humans: 0, options: { victory: 'fortress' } });
  const [a] = g.s.players;
  const caps = g.s.cities.filter((c) => c.capital);
  assert.ok(caps.length >= 2);
  let ev = null;
  g.on('gameOver', (e) => (ev = e));
  const last = caps.find((c) => c.owner !== a.id);
  for (const c of caps) if (c !== last) c.owner = a.id;
  for (const k of g.garrison(last)) g.removeUnits(k.units.map((x) => x.id));
  const t = freeNear(g, last.tiles[0]);
  const [k] = g.addUnits(t, a.id, [g.newUnit('knight')]);
  const out = g.attack(k, last.tiles[0]);
  assert.ok(out.won);
  g.captureCity(k, last, 'occupy');
  assert.equal(ev?.reason, 'fortress');
  assert.deepEqual(g.s.winners, [a.id]);
});

test('allies left alone share the victory', async () => {
  const g = await newGame('twin-realms.wlmap', { humans: 0 });
  const [a, b, ...rest] = g.s.players;
  g.diplo.accept(b.id, a.id, 'alliance');
  let ev = null;
  g.on('gameOver', (e) => (ev = e));
  for (const p of rest) { for (const c of g.citiesOf(p.id)) c.owner = a.id; g.removeUnits(g.stacksOf(p.id).flatMap((k) => k.units.map((u) => u.id))); }
  g._checkAlive();
  assert.equal(ev?.reason, 'allied');
  assert.deepEqual([...g.s.winners].sort(), [a.id, b.id].sort());
});

// --- surrender --------------------------------------------------------------------------------------------------
test('beaten computer sides offer to surrender; accepting hands over their cities and armies', async () => {
  const g = await newGame('twin-realms.wlmap', { options: { diplomacy: false } });
  const [me, ...foes] = g.s.players;
  g.s.round = 12;
  // strip the foes to one city each, and give me an army
  for (const f of foes) {
    const keep = g.citiesOf(f.id).find((c) => c.capital);
    for (const c of g.citiesOf(f.id)) if (c !== keep) c.owner = me.id;
    g.removeUnits(g.stacksOf(f.id).flatMap((k) => k.units.map((u) => u.id)).slice(1));
  }
  const [t] = pairNear(g, me.id);
  g.addUnits(t, me.id, Array.from({ length: 8 }, () => g.newUnit('knight')));
  const offer = g.surrenderOffer(me.id);
  assert.ok(offer?.all, 'every foe is beaten: they surrender together');
  assert.equal(g.surrenderOffer(me.id), null, 'not asked again at once');
  const theirCity = g.citiesOf(foes[0].id)[0];
  let ev = null;
  g.on('gameOver', (e) => (ev = e));
  g.acceptSurrender(me.id, offer.sides);
  assert.equal(theirCity.owner, me.id);
  assert.ok(foes.every((f) => !f.alive));
  assert.equal(ev?.reason, 'surrender');
});

// --- razing -----------------------------------------------------------------------------------------------------
test('a side may raze its own city at any time; the others frown on it', async () => {
  const g = await newGame('twin-realms.wlmap');
  const [a, b] = g.s.players;
  const c = g.citiesOf(a.id).find((x) => !x.capital) ?? g.citiesOf(a.id)[0];
  const inside = g.unitsIn(c).length;
  const h = g.diplo.hate(b.id, a.id);
  assert.ok(!g.canRaze(c, b.id), 'not someone else\'s city');
  assert.ok(g.razeCity(c, a.id));
  assert.ok(c.razed && c.owner === -1 && !c.producing);
  assert.equal(g.unitsIn(c).length, inside, 'the garrison stands in the ruins');
  assert.ok(g.diplo.hate(b.id, a.id) > h);
  assert.ok(!g.canRaze(c, a.id), 'ashes cannot burn twice');
});

// --- the map -------------------------------------------------------------------------------------------------------
test('signposts stand at road forks and name at least two cities with distances', async () => {
  for (const f of ['twin-realms.wlmap', 'eight-warlords.wlmap', 'classic-continent.wlmap']) {
    const map = await loadMap(f);
    const posts = makeSignposts(map);
    assert.ok(posts.length >= 3, f);
    for (const p of posts) {
      assert.ok(p.boards.length >= 2 && p.boards.length <= 3);
      assert.ok(!map.cities.some((c) => c.ty * map.grid.tilesW + c.tx === p.t), 'not in a city');
      for (const b of p.boards) assert.ok(b.dist > 0 && map.cities[b.city].name === b.name);
    }
  }
});

test('ships board at bridges: a voyage down the river to the sea, paid in full, never left midstream', async () => {
  const g = await newGame('eight-warlords.wlmap');
  const L = g.move.landings;
  assert.ok(L.length >= 1);
  for (const l of L) {
    const [k] = g.addUnits(l.t, g.currentId, [g.newUnit('lightinfantry')]);
    const r = g.moveUnits(k.units.map((u) => u.id), l.to);
    assert.equal(r.stack.t, l.to, 'sailed to the river mouth');
    assert.ok(g.move.isSea(r.stack.t));
    assert.ok(r.plan.path.afloat.slice(1).every(Boolean), 'afloat all the way');
    // back upstream to the bridge
    const r2 = g.moveUnits(r.stack.units.map((u) => u.id), l.t);
    assert.ok(r2.stack.t === l.t || r2.stack.t === l.to, 'lands at the bridge or waits at the mouth');
    g.removeUnits(r2.stack.units.map((u) => u.id));
  }
  // too little movement for the voyage: the group waits at the bridge
  const l = L[0];
  const [k] = g.addUnits(l.t, g.currentId, [g.newUnit('lightinfantry')]);
  k.units[0].mp = 1;
  const r = g.moveUnits([k.units[0].id], l.to);
  assert.equal(r.stack.t, l.t);
});

test('timed vectoring takes 2 to 5 turns by distance; plain vectoring always 2', async () => {
  const g = await newGame('eight-warlords.wlmap', { options: { timedVectoring: true } });
  const cs = g.s.cities;
  const turns = cs.flatMap((a) => cs.map((b) => g.vectorTurns(a, b)));
  assert.equal(Math.min(...turns), 2);
  assert.ok(Math.max(...turns) >= 4 && Math.max(...turns) <= 5);
  const plain = await newGame('eight-warlords.wlmap');
  assert.ok(plain.s.cities.every((a) => plain.vectorTurns(a, cs[0]) === 2));
  // a group vectored far arrives when promised
  const p = g.current;
  const [from, to] = g.citiesOf(p.id).length >= 2 ? g.citiesOf(p.id) : [g.citiesOf(p.id)[0], g.s.cities.find((c) => c.owner < 0)];
  to.owner = p.id;
  const k = g.garrison(from)[0];
  const n = g.vectorTurns(from, to);
  assert.ok(g.vectorUnits([k.units[0].id], to));
  assert.equal(g.s.pending.at(-1).round, g.s.round + n);
});

test('merchants sell magic items to a hero, dearer than they are worth', async () => {
  const g = await newGame('twin-realms.wlmap');
  const p = g.current;
  const hero = g.heroes(p.id)[0];
  p.gold = 5000;
  g.s.offers.push({ id: 999, kind: 'item', item: 'swordmight', cost: 160, city: null });
  const r = g.acceptOffer(999, hero.id);
  assert.equal(r.item, 'swordmight');
  assert.ok(hero.hero.items.includes('swordmight'));
  assert.equal(p.gold, 5000 - 160);
  // offers appear over a long game
  const h = await newGame('twin-realms.wlmap', { humans: 0 });
  let seen = 0;
  h.on('turnStart', () => { if (h.s.offers.some((o) => o.kind === 'item')) seen++; });
  for (let i = 0; i < 200; i++) { h.s.offers = []; h.endTurn(); if (h.s.over) break; }
  assert.ok(seen > 0, 'a merchant came by');
});

test('old saves (before diplomacy) load and play with everyone at war', async () => {
  const g = await newGame('twin-realms.wlmap');
  const s = JSON.parse(JSON.stringify(g.s));
  delete s.diplo; delete s.surrenderAsked; delete s.winners; delete s.hill;
  for (const k of ['victory', 'diplomacy', 'merchants', 'timedVectoring']) delete s.options[k];
  const map = await loadMap('twin-realms.wlmap');
  const g2 = new Game(map, s);
  assert.equal(g2.diplo.status(s.players[0].id, s.players[1].id), 'war');
  g2.endTurn();
  assert.equal(g2.surrenderOffer(s.players[0].id), null);
});

// --- special sites ----------------------------------------------------------------------------------------------
test('special sites: every map gets them near its cities, each type before any repeats', async () => {
  const { makeSpecialSites, SPECIAL_KINDS } = await import('../src/game/specials.js');
  for (const f of ['twin-realms.wlmap', 'eight-warlords.wlmap', 'small-skirmish.wlmap']) {
    const map = await loadMap(f);
    const xs = makeSpecialSites(map);
    assert.ok(xs.length >= Math.min(SPECIAL_KINDS.length, map.cities.length / 2), f);
    assert.equal(new Set(xs.slice(0, SPECIAL_KINDS.length).map((x) => x.type)).size, Math.min(SPECIAL_KINDS.length, xs.length));
    for (const x of xs) {
      const c = map.cities[x.city];
      const d = Math.max(Math.abs(x.tx - c.tx - 0.5), Math.abs(x.ty - c.ty - 0.5));
      assert.ok(d >= 2.5 && d <= 5.5, 'a few tiles out of its city');
      assert.ok(!map.sites.some((s) => s.tx === x.tx && s.ty === x.ty));
    }
    assert.deepEqual(makeSpecialSites(await loadMap(f)).map((x) => x.t), xs.map((x) => x.t), 'the same every time');
  }
});

test('sites serve their city: mine gold, barracks time, smithy and weaponmaster training', async () => {
  const g = await newGame('eight-warlords.wlmap');
  const by = (type) => g.specials.find((x) => x.type === type);
  const mine = by('mine'), city = g.s.cities[mine.city];
  assert.equal(g.cityIncome(city), city.income + 15);
  const bar = by('barracks'), bc = g.s.cities[bar.city];
  const { UNITS } = await import('../src/game/data/units.js');
  const slow = Object.keys(UNITS).find((t) => UNITS[t].time >= 3);
  assert.equal(g.prodTime(bc, slow), UNITS[slow].time - 1);
  assert.equal(g.prodTime(bc, 'archer'), 1, 'never below a turn');
  const sm = by('smithy'), sc = g.s.cities[sm.city];
  const u = g.newUnit('lightinfantry');
  const { unitStats } = await import('../src/game/rules.js');
  const before = unitStats(u).str;
  g._train(u, sc);
  assert.equal(unitStats(u).str, before + 1);
  // razed: no more
  g.s.specials[sm.i].razed = true;
  const v = g.newUnit('lightinfantry');
  g._train(v, sc);
  assert.equal(unitStats(v).str, before);
});

test('an army may burn a foe\'s site; its owner rebuilds it', async () => {
  const g = await newGame('eight-warlords.wlmap');
  const x = g.specials.find((s) => g.siteOwner(s) >= 0 && g.siteOwner(s) !== g.currentId);
  const owner = g.siteOwner(x), me = g.currentId;
  const [k] = g.addUnits(x.t, me, [g.newUnit('lightinfantry')]);
  assert.ok(g.canRazeSite(k));
  assert.ok(g.razeSite(k));
  assert.ok(g.special(x.t).razed);
  assert.equal(k.units[0].mp, 0, 'it takes the group\'s moves');
  assert.equal(g.diplo.status(me, owner), 'war', 'burning a neighbour\'s site is an act of war');
  assert.ok(!g.canRazeSite(k));
  g.player(owner).gold = 1000;
  assert.ok(!g.rebuildSite(x.i, me), 'only the city\'s owner rebuilds');
  assert.ok(g.rebuildSite(x.i, owner));
  assert.equal(g.player(owner).gold, 700);
  assert.ok(!g.special(x.t).razed);
});

// --- a fallen hero's items -------------------------------------------------------------------------------------------
test('a slain hero leaves its items on the ground; the victors or another hero take them up', async () => {
  const g = await newGame('twin-realms.wlmap');
  const me = g.current.id, foe = g.s.players.find((p) => p.id !== me).id;
  g.diplo.declareWar?.(me, foe);
  const [a, b] = pairNear(g, me);
  // a lone hero with a sword is overrun by a strong enemy group with a hero of its own
  const victim = g.newHero('warrior');
  victim.hero.items.push('swordmight');
  g.addUnits(b, foe, [victim]);
  const killer = g.newHero('warrior');
  g.addUnits(a, me, [killer, ...Array.from({ length: 7 }, () => g.newUnit('giant'))]);
  const k = g.stackAt(a);
  for (const u of k.units) u.mp = 99;
  let out = null;
  for (let i = 0; i < 20 && !out?.won; i++) { out = g.attack(g.stackAt(a) ?? g.stackAt(b), b); if (!g.stackAt(b) || g.stackAt(b).owner === me) break; }
  assert.ok(out.won, 'the giants win');
  assert.deepEqual(out.dropped, [{ hero: victim.id, items: ['swordmight'], t: b }]);
  assert.equal(victim.hero.items.length, 0);
  // the victors advanced into the square: their hero took the sword
  assert.ok(killer.hero.items.includes('swordmight'));
  assert.equal(g.groundAt(b), null);
  // a disbanded hero leaves its items too; another hero standing there picks them up
  const other = g.newHero('warrior');
  other.hero.items.push('swordmight');
  const c = freeNear(g, a, [b]);
  g.addUnits(c, me, [other, g.newHero('warrior')]);
  g.disband([other.id]);
  assert.deepEqual(g.groundAt(c).items, ['swordmight']);
  assert.ok(g.canPickUp(g.stackAt(c)));
  assert.deepEqual(g.pickUp(g.stackAt(c)), ['swordmight']);
  assert.equal(g.groundAt(c), null);
});

test('neutral cities start with one or two low troops and train more once day 10 is past', async () => {
  const g = await newGame('twin-realms.wlmap', { humans: 0 });
  const neutral = g.s.cities.filter((c) => c.owner < 0 && g.s.hill?.city !== c.id);
  assert.ok(neutral.length);
  const power = (t) => UNITS[t].str * UNITS[t].hits;
  for (const c of neutral) {
    const units = g.unitsIn(c);
    assert.ok(units.length >= 1 && units.length <= 2, `${c.name}: ${units.length}`);
    const two = [...c.prod].sort((a, b) => power(a) - power(b)).slice(0, 2);
    for (const u of units) assert.ok(two.includes(u.type), `${c.name}: ${u.type} is one of its lowest`);
  }
  const before = new Map(neutral.map((c) => [c.id, g.unitsIn(c).length]));
  while (g.s.round < NEUTRAL_PROD_ROUND) { for (const c of neutral) if (c.owner < 0) assert.equal(g.unitsIn(c).length <= before.get(c.id), true); g.endTurn(); }
  for (let i = 0; i < 8 * g.s.players.length; i++) g.endTurn();
  const grew = neutral.filter((c) => c.owner < 0 && g.unitsIn(c).length > before.get(c.id));
  assert.ok(grew.length > 0, 'neutral garrisons grow after day 10');
  for (const c of neutral) if (c.owner < 0) assert.ok(g.unitsIn(c).length <= 3 + c.level - 1);
});

test('a group with 1 MP left and only dearer ground around cannot act: the turn may end', async () => {
  const g = await newGame('twin-realms.wlmap');
  const me = g.current.id;
  const grid = g.move.base;
  // a free tile off the roads whose every neighbour costs 2 MP or more
  const t = g.map.tiles.findIndex((_, t) => grid.land[t] < Infinity && !g.cityAt(t) && !g.stackAt(t)
    && g.move.neighbours(t).every((n) => !g.stackAt(n) && !g.cityAt(n) && grid.land[n] >= 2));
  assert.ok(t >= 0);
  const u = g.newUnit('lightinfantry');
  g.addUnits(t, me, [u]);
  u.mp = 1;
  assert.equal(g.canAct([u]), false);
  u.mp = Math.min(...g.move.neighbours(t).map((n) => grid.land[n]).filter(Number.isFinite));
  assert.equal(g.canAct([u]), true);
  u.mp = 0;
  assert.equal(g.canAct([u]), false);
  // a group marches at the pace of its slowest: a fresh unit alongside a spent one is no move left
  const v = g.newUnit('lightinfantry');
  g.addUnits(t, me, [v]);
  v.mp = 10;
  assert.equal(g.canAct([u, v]), false);
  u.mp = 10;
  assert.equal(g.canAct([u, v]), true);
});
