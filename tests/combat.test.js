import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fight, odds, TERRAIN_BONUS, battleStrength } from '../src/game/combat.js';

let nextId = 1;
const unit = (type, extra = {}) => ({ id: nextId++, type, mp: 16, medals: 0, blessed: false, poisoned: false, diseased: false, paralysed: false, ...extra });
/** Deterministic rng (mulberry32). */
const seeded = (seed) => () => {
  let a = (seed = (seed + 0x6d2b79f5) >>> 0);
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
};
const winRate = (att, def, ctx = {}, n = 400) => {
  let w = 0;
  for (let i = 0; i < n; i++) if (fight(att(), def(), { ...ctx, rng: seeded(i + 1) }).winner === 'att') w++;
  return w / n;
};

test('a battle ends with exactly one side wiped out', () => {
  const att = [unit('heavyinfantry'), unit('archer')], def = [unit('lightinfantry'), unit('lightinfantry'), unit('pikeman')];
  const r = fight(att, def, { rng: seeded(3) });
  const lost = r.winner === 'att' ? r.defLost : r.attLost;
  const other = r.winner === 'att' ? def : att;
  assert.equal(lost.length, other.length, 'the loser loses every army');
  assert.equal(r.log.at(-1).t, 'end');
});

test('fight is deterministic for a given rng and simulate leaves the armies untouched', () => {
  const mk = () => [[unit('knight', { id: 1 }), unit('archer', { id: 2 })], [unit('orc', { id: 3 }), unit('troll', { id: 4 })]];
  const [a1, d1] = mk(), [a2, d2] = mk();
  const r1 = fight(a1, d1, { rng: seeded(11) }), r2 = fight(a2, d2, { rng: seeded(11) });
  assert.deepEqual([r1.winner, r1.attLost, r1.defLost], [r2.winner, r2.attLost, r2.defLost]);
  const [a3, d3] = mk();
  const before = JSON.stringify([a3, d3]);
  fight(a3, d3, { rng: seeded(5), simulate: true });
  assert.equal(JSON.stringify([a3, d3]), before);
});

test('stack bonus terms are clamped to -1..5 and the total to -3..5', () => {
  // leadership far beyond 5 on the attacker: still +5 at most
  const lords = Array.from({ length: 8 }, () => unit('archon')); // morale 3 each = 24
  const r = fight(lords, [unit('lightinfantry')], { rng: seeded(1) });
  assert.ok(r.bonus.att <= 5 && r.bonus.att >= -3);
  // a heavy siege against a big fortify can't take the defenders below -1 for that term
  const rams = Array.from({ length: 8 }, () => unit('siegeengine'));
  const r2 = fight(rams, [unit('lightinfantry')], { rng: seeded(2), fortify: 0 });
  assert.ok(r2.bonus.def >= -3);
});

test('walls help the defenders', () => {
  const att = () => [unit('heavyinfantry'), unit('heavyinfantry')], def = () => [unit('heavyinfantry'), unit('heavyinfantry')];
  const open = winRate(att, def, { fortify: 0 });
  const walled = winRate(att, def, { fortify: 3 });
  assert.ok(walled < open - 0.15, `attacking walls should be much harder (open ${open}, walled ${walled})`);
});

test('armies fight better on terrain they have a move bonus for (the defender\'s square)', () => {
  assert.equal(TERRAIN_BONUS, 1);
  // dwarves (hills bonus) defending hills vs. plains
  const att = () => [unit('heavyinfantry')], def = () => [unit('dwarf')];
  const onPlains = winRate(att, def, {});
  const onHills = winRate(att, def, { terrain: 'hills' });
  const inForest = winRate(att, def, { terrain: 'forest' });
  assert.ok(onHills < onPlains - 0.05, `dwarves hold hills better (plains ${onPlains}, hills ${onHills})`);
  assert.ok(Math.abs(inForest - onPlains) < 0.06, 'no bonus on terrain they are not suited to');
  // the start event shows the raised strength
  const r = fight([unit('heavyinfantry')], [unit('dwarf')], { rng: seeded(9), terrain: 'hills' });
  const plain = fight([unit('heavyinfantry')], [unit('dwarf')], { rng: seeded(9) });
  assert.equal(r.log[0].def[0].str, plain.log[0].def[0].str + 1);
});

test('missiles cannot kill armies with 4 or more hits', () => {
  for (let s = 1; s < 60; s++) {
    const r = fight([unit('archer'), unit('archer')], [unit('treant')], { rng: seeded(s) });
    assert.ok(!r.log.some((e) => e.t === 'die' && e.how === 'missile'), 'a 4-hit army was shot dead');
  }
});

test('the combat advisor agrees with lopsided battles', () => {
  const strong = Array.from({ length: 6 }, () => unit('knight'));
  assert.ok(odds(strong, [unit('goblin')], {}, 40) > 0.95);
  assert.ok(odds([unit('goblin')], strong, {}, 40) < 0.05);
});

test('medals only go to surviving attackers of a won battle, at most 4', () => {
  for (let s = 1; s < 80; s++) {
    const att = [unit('knight', { medals: 4 }), unit('knight'), unit('knight')];
    const r = fight(att, [unit('goblin'), unit('goblin')], { rng: seeded(s) });
    for (const id of r.medals) {
      assert.equal(r.winner, 'att');
      assert.ok(!r.attLost.includes(id));
      assert.notEqual(id, att[0].id, 'a 4-medal army gets no more');
    }
  }
});

test('the strength breakdown adds up to what the battle uses', () => {
  const hero = unit('paladin', { hero: { cls: 'paladin', name: 'Sir Test', level: 3, xp: 10, ap: 0, bought: [0, 1, 2], items: ['bannerlead'], spells: [], active: [] } });
  const att = [hero, ...Array.from({ length: 6 }, () => unit('elvencavalry', { blessed: true }))];
  const def = [unit('orc'), unit('orc', { blessed: true }), unit('pikeman')];
  const ctx = { rng: seeded(9), fortify: 2, terrain: 'forest' };
  const start = fight(att, def, ctx).log.find((e) => e.t === 'start');
  for (const [side, own, foes] of [['att', att, def], ['def', def, att]]) {
    for (const u of own) {
      const b = battleStrength(u, own, foes, ctx, side);
      const snap = start[side].find((x) => x.id === u.id);
      assert.equal(b.str, snap.str, `${u.type} strength`);
      assert.equal(b.bonus.total, start.bonus[side]);
      const parts = [...b.parts, ...b.notes].reduce((n, p) => n + p.n, 0);
      assert.equal(Math.max(1, parts + b.bonus.total), b.str, `${u.type} parts sum`);
    }
  }
  // elven cavalry: 5 + blessed 1 + forest 1 + stack bonus 5 (morale 6 + 1 = 7, capped at 5; leadership 1) = 12
  const cav = battleStrength(att[1], att, def, ctx, 'att');
  assert.equal(cav.str, 12);
  assert.deepEqual(cav.bonus.terms.map((t) => t.raw), [1, 7, 0]);
  assert.deepEqual(cav.bonus.terms.map((t) => t.n), [1, 5, 0]);
  assert.equal(cav.bonus.total, 5);
});
