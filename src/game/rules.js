// Derived statistics of armies and stacks (pure data). An army ("unit") in the game state:
//   { id, type, mp, medals, blessed, poisoned, diseased, paralysed, hero?: HeroData }
// HeroData: { cls, name, level, xp, ap, bought: [level index...], items: [item key...],
//   spells: [spell id...] (known), active: [spell id...] (in play on its stack) }
import { UNITS } from './data/units.js';
import { HERO_CLASSES } from './data/heroes.js';
import { SPELLS } from './data/spells.js';
import { ITEMS } from './data/items.js';

export const STACK_MAX = 8;
export const CITY_MAX = 32;

const addAb = (into, ab, k = 1) => { for (const [a, n] of Object.entries(ab ?? {})) into[a] = (into[a] ?? 0) + n * k; };

/** Everything a hero carries and knows that has an effect: [{ str, hits, move, view, ab, ... }]. */
function heroEffects(u) {
  const h = u.hero, cls = HERO_CLASSES[h.cls], fx = [];
  for (const i of h.bought) {
    const a = cls.levels[i].ability;
    if (a.stat) fx.push({ [a.stat]: a.n });
    else if (a.ab) fx.push({ ab: { [a.ab]: a.n } });
    else if (a.bonus) fx.push({ bonus: a.bonus });
    else if (a.fly) fx.push({ fly: true });
    else if (a.speed) fx.push({ speed: true });
    else if (a.invisible) fx.push({ invisible: true });
    else if (a.income) fx.push({ income: a.income });
    else if (a.engineer) fx.push({ engineer: a.engineer });
  }
  for (const k of h.items) if (ITEMS[k]) fx.push(ITEMS[k].fx);
  for (const s of h.active) if (SPELLS[s]?.fx) fx.push(SPELLS[s].fx);
  return fx;
}

/** Unit name for display. */
export const unitName = (u) => (u.hero ? u.hero.name : UNITS[u.type]?.name ?? u.type);
/** Type name: "Paladin" / "Heavy Infantry". */
export const typeName = (u) => (u.hero ? HERO_CLASSES[u.hero.cls].name : UNITS[u.type]?.name ?? u.type);

/**
 * Base statistics of one army before stack effects:
 * { str, hits, move, view, ab: {...}, bonus: Set, fly, flyer (flies by nature) }.
 */
export function unitStats(u) {
  let s;
  if (u.hero) {
    const c = HERO_CLASSES[u.hero.cls];
    s = { str: c.str, hits: c.hits, move: c.move, view: c.view, ab: {}, bonus: new Set(), fly: false };
    for (const fx of heroEffects(u)) {
      s.str += fx.str ?? 0; s.hits += fx.hits ?? 0; s.view += fx.view ?? 0;
      addAb(s.ab, fx.ab);
      if (fx.bonus) s.bonus.add(fx.bonus);
      if (fx.fly) s.fly = true;
    }
    // hero-only move points from levels and items (group move from spells is a stack effect)
    for (const i of u.hero.bought) {
      const a = c.levels[i].ability;
      if (a.stat === 'move') s.move += a.n;
    }
    for (const k of u.hero.items) s.move += ITEMS[k]?.fx.move ?? 0;
  } else {
    const t = UNITS[u.type];
    s = { str: t.str, hits: t.hits, move: t.move, view: t.view, ab: { ...t.ab }, bonus: new Set(), fly: t.bonus === 'fly' };
    if (t.bonus && t.bonus !== 'fly') s.bonus.add(t.bonus);
  }
  s.flyer = s.fly;
  // trained in a city served by a smithy, weaponmaster, stables or ranger's tower (specials.js)
  if (u.trained) { s.str += u.trained.str ?? 0; s.hits += u.trained.hits ?? 0; s.move += u.trained.move ?? 0; s.view += u.trained.view ?? 0; }
  if (u.blessed) s.str += 1;
  if (u.poisoned) s.str -= 1;
  if (u.diseased) s.hits -= 1;
  if (u.paralysed) s.move -= 5;
  s.str = Math.max(1, s.str);
  s.hits = Math.max(1, s.hits);
  s.move = Math.max(1, s.move);
  return s;
}

/**
 * Effects a stack's heroes spread over the whole stack (items, spells, abilities):
 * { grpStr, grpHits, move, fly, invisible, speed, income, engineer, mana, ab: stack abilities }.
 * Combat abilities of plain armies (morale, fear ...) are counted in combat, not here.
 */
export function stackEffects(units) {
  const e = { grpStr: 0, grpHits: 0, move: 0, fly: false, invisible: false, speed: false, income: 0, engineer: 0, mana: 0, ab: {} };
  for (const u of units) {
    if (!u.hero) continue;
    for (const fx of heroEffects(u)) {
      e.grpStr += fx.grpStr ?? 0;
      e.grpHits += fx.grpHits ?? 0;
      e.income += fx.income ?? 0;
      e.engineer += fx.engineer ?? 0;
      e.mana += fx.mana ?? 0;
      if (fx.invisible) e.invisible = true;
      if (fx.speed) e.speed = true;
    }
    // group move from spells in play (Haste, Phantom Steed ...), group flight from the Flight spell
    for (const s of u.hero.active) {
      const fx = SPELLS[s]?.fx;
      if (!fx) continue;
      e.move += fx.move ?? 0;
      if (fx.fly) e.fly = true;
    }
    for (const k of u.hero.items) if (ITEMS[k]?.fx.fly) e.fly = true;
  }
  return e;
}

/** Full movement allowance of an army in `units` (its stack): base move + group bonuses. */
export function maxMoves(u, units) {
  const s = unitStats(u), e = stackEffects(units);
  const m = s.move + e.move;
  return e.speed ? m * 2 : m;
}

/**
 * How a group moves: { bonuses: [...], fly, mp } — flies when every member flies (or a
 * Flight spell / Wings of Flight covers it); pays the reduced cost of any member's terrain
 * bonus; moves as far as its slowest member's remaining MP.
 */
export function groupMover(units) {
  const e = stackEffects(units);
  const stats = units.map(unitStats);
  const fly = e.fly || stats.every((s) => s.fly);
  const bonuses = [...new Set(stats.flatMap((s) => [...s.bonus]))];
  const mp = Math.min(...units.map((u) => u.mp));
  return { bonuses, fly, mp };
}

/** Combat worth of an army (for display order, AI and the strongest-unit pick). */
export function unitPower(u) {
  const s = unitStats(u);
  let p = s.str * (1 + 0.55 * (s.hits - 1));
  const ab = s.ab;
  p += (ab.missile ?? 0) * 0.8 + (ab.assassin ?? 0) * 0.6 + (ab.acid ?? 0) * 0.5 + (ab.lightning ?? 0) * 0.5;
  p += ((ab.morale ?? 0) + (ab.fear ?? 0) + (ab.chaos ?? 0) + (ab.leadership ?? 0)) * 0.7;
  if (u.hero) p += 2 + u.hero.level;
  return p;
}

/** The army shown for a stack: its hero, else its strongest army. */
export function leaderOf(units) {
  const heroes = units.filter((u) => u.hero);
  const pool = heroes.length ? heroes : units;
  return pool.reduce((a, b) => (unitPower(b) > unitPower(a) ? b : a), pool[0]);
}

/** Upkeep in gold per turn (heroes are paid by their own deeds: no upkeep). */
export const upkeepOf = (u) => (u.hero ? 0 : UNITS[u.type]?.upkeep ?? 0);

/** Hero level for an XP total. */
export function levelForXp(cls, xp) {
  const lv = HERO_CLASSES[cls].levels;
  let l = 1;
  for (let i = 0; i < lv.length; i++) if (xp >= lv[i].xp) l = i + 1;
  return l;
}
