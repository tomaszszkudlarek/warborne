// Warlords III combat (manual, Appendix 1). Pure: takes armies, returns the outcome and an
// event log the battle screen plays back.
//
//  1. Poison / disease / paralysis / curse: each side's total n gives a 3n % chance per enemy.
//  2. Stack bonus per side: (leadership - their chaos) + (morale - their fear) + (fortify -
//     their siege), each term within -1..5, the total within -3..5.
//  3. Armies fight one pair at a time, weakest first. When an army first steps up it may use
//     acid (halve the foe's strength), lightning (halve its hits), assassination (kill it) and
//     missiles (n free shots, each a kill; 4-hit armies are immune), in that order; the same
//     skill on both sides offsets, warding reduces the foe's acid / lightning / assassination.
//     Terrain: armies with a move bonus for the battle's terrain (always the defender's
//     square) fight at +1 strength there; all-terrain armies anywhere rough.
//  4. Melee rounds: both roll 1..dice; a roll <= strength succeeds. One success against one
//     failure costs the loser a hit (plus trample against non-flyers). Medals roll a second,
//     smaller die and keep the better result.
import { unitStats, unitPower, heroEffects, strengthSources, unitName } from './rules.js';
import { UNITS } from './data/units.js';

export const DICE = 20;
export const TERRAIN_BONUS = 1; // strength of an army fighting on terrain it has a move bonus for
export const MEDAL_CHANCE = 0.18; // chance per surviving attacker of a won battle
export const MEDAL_DIE = [0, 30, 26, 22, 18];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sum = (parts) => parts.reduce((n, p) => n + p.n, 0);

/** Strength and hits the heroes of a stack give every army in it (items, spells): { str: [{ label, n }], hits }. */
export function groupBoosts(units) {
  const str = [];
  let hits = 0;
  for (const o of units) {
    if (!o.hero) continue;
    for (const fx of heroEffects(o)) {
      if (fx.grpStr) str.push({ label: `${fx.src} (${o.hero.name})`, n: fx.grpStr });
      hits += fx.grpHits ?? 0;
    }
  }
  return { str, hits };
}

/**
 * An army's battle strength before the stack bonus: its own strength (level, items, blessing,
 * training ...), its heroes' group strength, the terrain it fights on and banding.
 * `units`: its side; ctx: fight()'s (terrain). Returns { str, hits, parts: [{ label, n }] }
 * (parts only with `detail`).
 */
export function armyStrength(u, units, ctx = {}, group = groupBoosts(units), detail = true) {
  const s = unitStats(u);
  const parts = [];
  if (detail) {
    parts.push(...strengthSources(u));
    const own = sum(parts);
    if (own < s.str) parts.push({ label: 'Strength is at least 1', n: s.str - own });
  }
  let str = s.str;
  const add = (label, n) => { str += n; if (detail) parts.push({ label, n }); };
  for (const g of group.str) add(g.label, g.n);
  if (ctx.terrain && (s.bonus.has(ctx.terrain) || s.bonus.has('all'))) {
    add(`Fighting on ${ctx.terrain} (${s.bonus.has(ctx.terrain) ? 'its home terrain' : 'all-terrain army'})`, TERRAIN_BONUS);
  }
  // banding: +1 strength per other army of the same type, up to the bonus
  const b = s.ab.banding;
  if (b) {
    const n = Math.min(b, units.filter((o) => o !== u && o.type === u.type).length);
    if (n) add(`Banding (${n} more ${UNITS[u.type]?.name ?? u.type})`, n);
  }
  return { str, hits: s.hits + group.hits, parts, stats: s };
}

export const STACK_TERMS = [['leadership', 'chaos'], ['morale', 'fear'], ['fortify', 'siege']];
/** Who in a stack has ability k: [{ label, n }], plain armies of a type counted together.
 * `units`: armies, or fight()'s combatants (which carry their abilities). */
function abilitySources(units, k) {
  const out = new Map();
  for (const x of units) {
    const u = x.u ?? x;
    const n = (x.ab ?? unitStats(u).ab)[k] ?? 0;
    if (!n) continue;
    const key = u.hero ? `h${u.id}` : u.type;
    const e = out.get(key) ?? { name: unitName(u), count: 0, n: 0 };
    e.count++; e.n += n;
    out.set(key, e);
  }
  return [...out.values()].map((e) => ({ label: e.count > 1 ? `${e.name} ×${e.count}` : e.name, n: e.n }));
}

/**
 * The stack bonus of side `mine` fighting side `theirs` (manual, Appendix 1 step 2): each of
 * (my leadership - their chaos), (my morale - their fear), (my fortify + city walls - their
 * siege) within -1..5, the total within -3..5. Returns { total, raw, terms: [{ k, vs, mine,
 * theirs, walls, raw, n }] } where mine / theirs list who contributes ([{ label, n }]).
 */
export function stackBonus(mine, theirs, walls = 0) {
  const terms = STACK_TERMS.map(([k, vs]) => {
    const m = abilitySources(mine, k), t = abilitySources(theirs, vs);
    const w = k === 'fortify' ? walls : 0;
    const raw = sum(m) + w - sum(t);
    return { k, vs, mine: m, theirs: t, walls: w, raw, n: clamp(raw, -1, 5) };
  });
  const raw = terms.reduce((n, x) => n + x.n, 0);
  return { total: clamp(raw, -3, 5), raw, terms };
}

/** Battle strength after the stack bonus and the sea cap (1..20): { str, notes: [{ label, n }] }. */
function finalStrength(pre, bonus, sea, boat, flyer) {
  const notes = [];
  let str = Math.max(1, pre + bonus);
  if (sea && !flyer && str > (boat ?? 3)) { notes.push({ label: 'At sea: no stronger than its boat', n: (boat ?? 3) - str }); str = boat ?? 3; }
  const c = clamp(str, 1, 20);
  if (c !== str) notes.push({ label: c > str ? 'Strength is at least 1' : 'Strength is at most 20', n: c - str });
  return { str: c, notes };
}

/**
 * How strong army u of side `own` fights against side `foes`: { str, hits, parts, bonus
 * (stackBonus), notes }. ctx as fight()'s; `side` 'att' or 'def' (only defenders get the
 * city walls, ctx.fortify). The same arithmetic fight() uses, for the bonus tooltips.
 */
export function battleStrength(u, own, foes, ctx = {}, side = 'def') {
  const a = armyStrength(u, own, ctx);
  const bonus = stackBonus(own, foes, side === 'def' ? ctx.fortify ?? 0 : 0);
  const sea = side === 'att' ? ctx.attSea : ctx.defSea, boat = side === 'att' ? ctx.attBoat : ctx.defBoat;
  const f = finalStrength(a.str, bonus.total, sea, boat, unitStats(u).flyer);
  return { str: f.str, hits: a.hits, parts: a.parts, bonus, notes: f.notes };
}

/**
 * Fight `attackers` (units) against `defenders`.
 * ctx: { rng, dice, fortify: city defence of the defenders, terrain: bonus key of the defender's
 *        square (movement.terrainBonusAt), attSea / defSea: fighting from
 *        boats (strength capped at the side's boat), attBoat / defBoat: boat strengths,
 *        simulate: true for the combat advisor (no log, units untouched) }
 * Returns { winner: 'att' | 'def', attLost: [ids], defLost: [ids], log, medals: [ids],
 *           status: [{ id, effect }], bonus: { att, def } }
 */
export function fight(attackers, defenders, ctx = {}) {
  const rng = ctx.rng ?? Math.random;
  const dice = ctx.dice ?? DICE;
  const sim = !!ctx.simulate;
  const log = sim ? null : [];
  const push = (e) => log?.push(e);
  const roll = (n) => 1 + Math.floor(rng() * n);

  const make = (units, side) => {
    const group = groupBoosts(units);
    return units.map((u) => {
      const a = armyStrength(u, units, ctx, group, !sim), s = a.stats;
      return {
        u, side, id: u.id, type: u.type, hero: !!u.hero,
        str: a.str, hits: a.hits, ab: { ...s.ab }, flyer: s.flyer, parts: a.parts,
        medals: u.hero ? 0 : u.medals ?? 0, used: false, blessed: !!u.blessed,
        poisoned: !!u.poisoned, diseased: !!u.diseased, paralysed: !!u.paralysed, power: unitPower(u),
      };
    });
  };
  const A = make(attackers, 'att'), D = make(defenders, 'def');
  const total = (list, k) => list.reduce((n, c) => n + (c.ab[k] ?? 0), 0);

  // 1. lingering afflictions
  const status = [];
  const afflict = (from, to) => {
    for (const [k, flag] of [['poison', 'poisoned'], ['disease', 'diseased'], ['paralysis', 'paralysed'], ['curse', 'cursed']]) {
      const n = total(from, k);
      if (!n) continue;
      for (const c of to) {
        if (c.ab[k]) continue; // immune to its own kind
        if (k !== 'curse' && c.blessed) continue;
        if (k !== 'curse' && c[flag]) continue;
        if (rng() >= 0.03 * n) continue;
        const was = c.str;
        if (k === 'poison') c.str = Math.max(1, c.str - 1);
        if (k === 'disease') c.hits = Math.max(1, c.hits - 1);
        if (k === 'curse') { if (c.blessed) c.str = Math.max(1, c.str - 1); c.blessed = false; c.medals = 0; }
        if (c.str !== was && !sim) c.parts.push({ label: k === 'poison' ? 'Poisoned in this battle' : 'Cursed in this battle (blessing lost)', n: c.str - was });
        c[flag] = true;
        status.push({ id: c.id, effect: flag });
        push({ t: 'status', id: c.id, effect: flag });
      }
    }
  };
  afflict(A, D);
  afflict(D, A);

  // 2. stack bonuses; at sea armies fight no better than their boats (flyers fight normally)
  const sbAtt = stackBonus(A, D, 0), sbDef = stackBonus(D, A, ctx.fortify ?? 0);
  const bAtt = sbAtt.total, bDef = sbDef.total;
  const finish = (list, b, sea, boat) => {
    for (const c of list) {
      const f = finalStrength(c.str, b, sea, boat, c.flyer);
      c.str = f.str; c.hp = c.hits; c.notes = f.notes;
    }
  };
  finish(A, bAtt, ctx.attSea, ctx.attBoat);
  finish(D, bDef, ctx.defSea, ctx.defBoat);
  push({ t: 'start', bonus: { att: bAtt, def: bDef }, detail: { att: sbAtt, def: sbDef }, att: A.map(snap), def: D.map(snap) });

  // 3. fight order: weakest first, heroes last
  const order = (list) => [...list].sort((a, b) => (a.hero - b.hero) || (a.power - b.power) || (a.str - b.str));
  const qa = order(A), qd = order(D);
  const attLost = [], defLost = [];
  const kill = (c, how) => {
    c.hp = 0;
    (c.side === 'att' ? attLost : defLost).push(c.id);
    push({ t: 'die', id: c.id, how });
  };
  const rollFor = (c) => {
    const r = roll(dice);
    return c.medals ? Math.min(r, roll(MEDAL_DIE[Math.min(4, c.medals)])) : r;
  };

  const specials = (a, b) => {
    // each skill offsets the same skill of the foe; warding reduces acid, lightning and assassination
    const eff = (x, y, k) => Math.max(0, (x.used ? 0 : x.ab[k] ?? 0) - (y.used ? 0 : y.ab[k] ?? 0) - (k === 'missile' ? 0 : y.ab.warding ?? 0));
    for (const k of ['acid', 'lightning', 'assassin', 'missile']) {
      for (const [x, y] of [[a, b], [b, a]]) {
        if (x.hp <= 0 || y.hp <= 0) continue;
        const n = eff(x, y, k);
        if (!n) continue;
        if (k === 'missile') {
          if (y.hits >= 4) continue;
          for (let i = 0; i < n && y.hp > 0; i++) {
            const hit = rollFor(x) <= x.str && roll(dice) > y.str;
            push({ t: 'special', kind: 'missile', by: x.id, on: y.id, hit });
            if (hit) kill(y, 'missile');
          }
          continue;
        }
        if (rng() >= 0.1 * n) continue;
        if (k === 'assassin') { push({ t: 'special', kind: 'assassin', by: x.id, on: y.id, hit: true }); kill(y, 'assassin'); continue; }
        if (k === 'acid') {
          push({ t: 'special', kind: 'acid', by: x.id, on: y.id, hit: true });
          if (y.str <= 1) kill(y, 'acid'); else y.str = Math.floor(y.str / 2);
        } else {
          push({ t: 'special', kind: 'lightning', by: x.id, on: y.id, hit: true });
          if (y.hp <= 1) kill(y, 'lightning'); else { y.hp = Math.floor(y.hp / 2); push({ t: 'hit', id: y.id, hp: y.hp }); }
        }
      }
    }
    a.used = true; b.used = true;
  };

  let ia = 0, id = 0, rounds = 0;
  let a = qa[0], d = qd[0];
  if (a && d) push({ t: 'duel', a: a.id, d: d.id });
  let fresh = true;
  while (a && d && rounds < 5000) {
    if (fresh) { specials(a, d); fresh = false; }
    if (a.hp > 0 && d.hp > 0) {
      rounds++;
      const sa = rollFor(a) <= a.str, sd = rollFor(d) <= d.str;
      if (sa !== sd) {
        const [w, l] = sa ? [a, d] : [d, a];
        const dmg = 1 + (w.ab.trample && !l.flyer ? w.ab.trample : 0);
        l.hp = Math.max(0, l.hp - dmg);
        push({ t: 'hit', id: l.id, by: w.id, hp: l.hp, dmg });
        if (l.hp <= 0) kill(l, 'melee');
      }
    }
    if (a.hp <= 0) { a = qa[++ia]; fresh = true; }
    if (d.hp <= 0) { d = qd[++id]; fresh = true; }
    if (fresh && a && d) push({ t: 'duel', a: a.id, d: d.id });
  }
  const winner = a ? 'att' : 'def';
  push({ t: 'end', winner });

  // medals: surviving attackers of a battle with two or more armies a side
  const medals = [];
  if (winner === 'att' && A.length >= 2 && D.length >= 2) {
    for (const c of A) if (c.hp > 0 && !c.hero && c.medals < 4 && rng() < MEDAL_CHANCE) medals.push(c.id);
  }
  return { winner, attLost, defLost, log, medals, status, bonus: { att: bAtt, def: bDef } };
}

/**
 * A ruin search: the hero goes in alone and faces the guardians while the party waits outside
 * (Warlords style). Not a stack battle: the odds come from the hero's strength, hits, blessing
 * and level plus the strength of the army that came along (a hero alone is easy prey; one
 * backed by a strong army wins most ruins). Returns a fight()-shaped result whose log the
 * battle screen plays back, plus `chance`.
 */
export const RUIN_ODDS = [0, 0.90, 0.68, 0.40]; // a lone level-1 hero of strength 4, 2 hits, by danger
export const RUIN_ARMY = 0.012; // per strength point of each army waiting with the hero
export const RUIN_ARMY_MAX = 0.35;
export function ruinChance(hero, danger, group = []) {
  const s = unitStats(hero);
  const lv = hero.hero?.level ?? 1;
  const army = group.filter((u) => u !== hero && u.id !== hero.id).reduce((n, u) => n + unitStats(u).str, 0);
  return clamp(RUIN_ODDS[danger] + 0.05 * (s.str - 4) + 0.03 * (s.hits - 2) + 0.03 * (lv - 1)
    + Math.min(RUIN_ARMY_MAX, RUIN_ARMY * army), 0.1, 0.97);
}
export function ruinDuel(hero, guardians, danger, ctx = {}) {
  const rng = ctx.rng ?? Math.random;
  const chance = ruinChance(hero, danger, ctx.group ?? []);
  const won = rng() < chance;
  const log = [];
  const hs = unitStats(hero);
  const H = { id: hero.id, type: hero.type, hero: true, str: clamp(hs.str, 1, 20), hits: hs.hits, medals: 0 };
  const G = guardians.map((u) => { const s = unitStats(u); return { id: u.id, type: u.type, hero: false, str: s.str, hits: s.hits, medals: 0 }; });
  log.push({ t: 'start', bonus: { att: 0, def: 0 }, att: [H], def: G });
  // play the decided outcome back as blows: the loser is worn down, the winner bloodied
  let hp = H.hits;
  const falls = won ? G.length : Math.floor(rng() * G.length); // guardians slain before the hero falls
  const defLost = [];
  for (let i = 0; i < G.length && hp > 0; i++) {
    const g = G[i];
    log.push({ t: 'duel', a: H.id, d: g.id });
    let ghp = g.hits;
    const slay = i < falls;
    while (ghp > 0 && hp > 0) {
      // the side that must lose this pairing takes most blows; the other only now and then
      const heroHits = slay ? rng() < 0.7 : rng() < 0.3 && ghp > 1;
      if (heroHits) { ghp--; log.push({ t: 'hit', id: g.id, by: H.id, hp: ghp, dmg: 1 }); }
      else if (!slay || hp > 1) { hp--; log.push({ t: 'hit', id: H.id, by: g.id, hp, dmg: 1 }); }
    }
    if (ghp <= 0) { defLost.push(g.id); log.push({ t: 'die', id: g.id, how: 'melee' }); }
  }
  if (hp <= 0) log.push({ t: 'die', id: H.id, how: 'melee' });
  const winner = won ? 'att' : 'def';
  log.push({ t: 'end', winner });
  return { winner, attLost: won ? [] : [hero.id], defLost, log, medals: [], status: [], bonus: { att: 0, def: 0 }, chance };
}

const snap = (c) => ({ id: c.id, type: c.type, hero: c.hero, str: c.str, hits: c.hits, medals: c.medals, parts: c.parts, notes: c.notes });

/** A small seeded generator (mulberry32) for mock battles. */
function seeded(seed) {
  return () => {
    let a = (seed = (seed + 0x6d2b79f5) >>> 0);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Combat advisor: chance (0..1) the attackers win, from `n` simulated battles. The mock
 * battles use their own fixed-seed dice, so the same match-up always gets the same answer
 * (steady odds on screen, and computer players that replay a saved game the same way).
 */
export function odds(attackers, defenders, ctx = {}, n = 60) {
  const rng = seeded(0x5eed + n);
  let wins = 0;
  for (let i = 0; i < n; i++) if (fight(attackers, defenders, { ...ctx, simulate: true, rng }).winner === 'att') wins++;
  return wins / n;
}

/** Applies a battle's lasting results to the surviving armies (status effects and medals). */
export function applyAftermath(result, unitsById) {
  for (const { id, effect } of result.status) {
    const u = unitsById.get(id);
    if (!u) continue;
    if (effect === 'cursed') { u.blessed = false; u.medals = 0; } else u[effect] = true;
    if (effect === 'paralysed') u.mp = 0;
  }
  for (const id of result.medals) {
    const u = unitsById.get(id);
    if (u) u.medals = Math.min(4, (u.medals ?? 0) + 1);
  }
}

export const isUndead = (u) => !u.hero && !!UNITS[u.type]?.undead;
