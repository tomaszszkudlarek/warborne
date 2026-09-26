// Diplomacy (Warlords III game option): every pair of sides is at war, at peace or allied,
// and every side keeps a hate index (0 trust .. 100 frenzy) toward every other. Deeds move
// it: attacks, conquests, razing, breaking treaties, armies loitering near one's cities,
// being far too powerful; bribes (50 gp a point) and common enemies soften it; left alone
// it drifts back toward indifference. Sides at peace may not fight (attacking breaks the
// peace), allies pass through each other's armies, and allies left alone share the victory.
// Computer sides answer proposals at once and make their own: they like one enemy at a time.
// State lives in game.s.diplo (plain JSON, part of the save).
import { unitPower } from './rules.js';

export const STATUS = { war: 'war', peace: 'peace', allied: 'allied' };
export const STANDING = ['trust', 'friendship', 'uncertainty', 'dislike', 'disgust', 'anger', 'hatred', 'rage', 'frenzy'];
export const BRIBE_GOLD = 50; // gold per point of hate
const START_HATE = [18, 38];
const PEACE_BASE = 32, WAR_BASE = 55, ALLY_BASE = 14; // where hate drifts to, by status

/** The standing a hate index reads as: 'trust' .. 'frenzy'. */
export const standing = (hate) => STANDING[Math.max(0, Math.min(8, Math.floor(hate / 11.2)))];

const pair = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
const clamp = (x) => Math.max(0, Math.min(100, x));

export class Diplomacy {
  constructor(game) {
    this.g = game;
    const s = game.s;
    // saves from before diplomacy: everyone at war, the option off
    s.diplo ??= { status: {}, hate: {}, proposals: [], news: {}, since: {} };
    this.d = s.diplo;
  }

  get on() { return !!this.g.s.options.diplomacy; }

  /** Sets up a new game: every pair of sides at peace, with a middling, varied hate. */
  init() {
    const ps = this.g.s.players;
    for (const a of ps) for (const b of ps) {
      if (a.id === b.id) continue;
      if (a.id < b.id) { this.d.status[pair(a.id, b.id)] = this.on ? STATUS.peace : STATUS.war; this.d.since[pair(a.id, b.id)] = 1; }
      this.d.hate[`${a.id}>${b.id}`] = this.g.rint(START_HATE[0], START_HATE[1]);
    }
  }

  status(a, b) {
    if (a === b) return STATUS.allied;
    if (a < 0 || b < 0 || !this.on) return STATUS.war;
    return this.d.status[pair(a, b)] ?? STATUS.war;
  }
  atWar(a, b) { return a !== b && this.status(a, b) === STATUS.war; }
  allied(a, b) { return a !== b && this.status(a, b) === STATUS.allied; }
  /** How much side a hates side b (0..100). */
  hate(a, b) { return a < 0 || b < 0 ? 100 : this.d.hate[`${a}>${b}`] ?? 50; }
  addHate(a, b, n) {
    if (a < 0 || b < 0 || a === b) return;
    const k = `${a}>${b}`;
    this.d.hate[k] = clamp((this.d.hate[k] ?? 50) + n);
  }
  /** Sides player a is at war with (living players only). */
  enemies(a) { return this.g.s.players.filter((p) => p.alive && p.id !== a && this.atWar(a, p.id)).map((p) => p.id); }
  allies(a) { return this.g.s.players.filter((p) => p.alive && p.id !== a && this.allied(a, p.id)).map((p) => p.id); }

  _set(a, b, st) {
    const k = pair(a, b);
    if (this.d.status[k] === st) return;
    this.d.status[k] = st;
    this.d.since[k] = this.g.s.round;
    this.d.proposals = this.d.proposals.filter((p) => !(pair(p.from, p.to) === k));
    for (const pid of [a, b]) this._news(pid);
    this.g.emit('diplomacy', { a, b, status: st });
  }
  /** Flags a player's diplomacy indicator (something changed that concerns them). */
  _news(pid) { this.d.news[pid] = true; }
  seen(pid) { delete this.d.news[pid]; }
  hasNews(pid) { return !!this.d.news[pid]; }

  _name(pid) { return this.g.player(pid)?.name ?? 'Neutral'; }

  // --- deeds ------------------------------------------------------------------------------------
  /** a declares war on b. Breaking a peace or an alliance angers b and everyone watching. */
  declareWar(a, b, why = '') {
    if (!this.on || a < 0 || b < 0 || this.atWar(a, b)) return false;
    const was = this.status(a, b);
    const treachery = was === STATUS.allied ? 2 : 1;
    this.addHate(b, a, 22 * treachery);
    for (const p of this.g.s.players) if (p.id !== a && p.id !== b) this.addHate(p.id, a, 4 * treachery);
    this._set(a, b, STATUS.war);
    this.g.note(`${this._name(a)} declare war on ${this._name(b)}${was === STATUS.allied ? ', breaking their alliance' : ''}${why ? ` ${why}` : ''}!`, { player: a, kind: 'battle' });
    return true;
  }

  /** Fighting: the side attacked hates the attacker; attacking a side not at war declares war first. */
  onAttack(att, def) {
    if (att < 0 || def < 0) return;
    if (this.on && !this.atWar(att, def)) this.declareWar(att, def);
    this.addHate(def, att, 6);
    // the enemies of the defender warm to the attacker
    for (const p of this.g.s.players) if (p.id !== att && p.id !== def && this.atWar(p.id, def)) this.addHate(p.id, att, -1);
  }

  onCapture(taker, loser, raze) {
    if (taker < 0) return;
    if (loser >= 0) this.addHate(loser, taker, raze ? 25 : 14);
    // razing angers every computer player (Warlords III); conquest makes the neighbours wary
    for (const p of this.g.s.players) if (p.id !== taker && p.id !== loser) this.addHate(p.id, taker, raze ? 8 : 1);
  }

  /** A side razes a city of its own: everyone frowns on the burning. */
  onRazeOwn(pid) { for (const p of this.g.s.players) if (p.id !== pid) this.addHate(p.id, pid, 5); }

  /** Gold from a to b lowers b's hate of a by a point per 50 gp. Returns the points. */
  bribe(a, b, gold) {
    const pa = this.g.player(a), pb = this.g.player(b);
    gold = Math.floor(Math.min(gold, pa?.gold ?? 0) / BRIBE_GOLD) * BRIBE_GOLD;
    if (!pa || !pb || gold <= 0) return 0;
    pa.gold -= gold;
    pb.gold += gold;
    const pts = gold / BRIBE_GOLD;
    this.addHate(b, a, -pts);
    this._news(b);
    this.g.note(`${pa.name} send ${gold} gold to ${pb.name}.`, { player: a });
    return pts;
  }

  // --- proposals ------------------------------------------------------------------------------------
  /**
   * a proposes `kind` ('peace' | 'alliance') to b. A computer side answers at once; a human
   * answers at the start of their next turn. Returns { answer: 'accepted' | 'refused' |
   * 'pending', reason }.
   */
  propose(a, b, kind) {
    if (!this.on || a === b || a < 0 || b < 0) return { answer: 'refused', reason: 'Diplomacy is off.' };
    const st = this.status(a, b);
    if (kind === 'peace' && st !== STATUS.war) return { answer: 'refused', reason: 'You are not at war.' };
    if (kind === 'alliance' && st !== STATUS.peace) return { answer: 'refused', reason: st === STATUS.war ? 'Make peace first.' : 'You are allies already.' };
    const pb = this.g.player(b);
    if (!pb?.alive) return { answer: 'refused', reason: 'That side is gone.' };
    if (pb.human) {
      if (!this.d.proposals.some((p) => p.from === a && p.to === b && p.kind === kind)) this.d.proposals.push({ from: a, to: b, kind, round: this.g.s.round });
      this._news(b);
      return { answer: 'pending', reason: `${pb.name} will answer on their turn.` };
    }
    const { yes, reason } = this.aiConsiders(b, a, kind);
    if (yes) this.accept(b, a, kind);
    else {
      this.addHate(b, a, 1); // pestering
      this.g.note(`${pb.name} refuse ${kind === 'peace' ? 'peace' : 'an alliance'} with ${this._name(a)}.`, { player: b });
    }
    return { answer: yes ? 'accepted' : 'refused', reason };
  }

  /** b accepts a's proposal. */
  accept(b, a, kind) {
    this.d.proposals = this.d.proposals.filter((p) => !(p.from === a && p.to === b && p.kind === kind));
    const st = this.status(a, b);
    if (kind === 'peace' && st === STATUS.war) {
      this._set(a, b, STATUS.peace);
      this.addHate(b, a, -8); this.addHate(a, b, -8);
      this.g.note(`${this._name(a)} and ${this._name(b)} make peace.`, { player: a, kind: 'good' });
    } else if (kind === 'alliance' && st === STATUS.peace) {
      this._set(a, b, STATUS.allied);
      this.addHate(b, a, -10); this.addHate(a, b, -10);
      this.g.note(`${this._name(a)} and ${this._name(b)} swear an alliance.`, { player: a, kind: 'good' });
    }
    this.g._checkAlive?.();
  }

  decline(b, a, kind) {
    this.d.proposals = this.d.proposals.filter((p) => !(p.from === a && p.to === b && p.kind === kind));
    this.addHate(a, b, 3);
    this._news(a);
    this.g.note(`${this._name(b)} refuse ${kind === 'peace' ? 'peace' : 'an alliance'} with ${this._name(a)}.`, { player: b });
  }

  /** Proposals waiting for player pid's answer. */
  pendingFor(pid) { return this.d.proposals.filter((p) => p.to === pid && this.g.player(p.from)?.alive); }

  /** Would an alliance of a and b leave every living side allied (a shared victory)? */
  wouldEndGame(a, b) {
    const alive = this.g.s.players.filter((p) => p.alive).map((p) => p.id);
    const al = (x, y) => x === y || this.allied(x, y) || (x === a && y === b) || (x === b && y === a);
    return alive.every((x) => alive.every((y) => al(x, y)));
  }

  // --- strength -------------------------------------------------------------------------------------
  power(pid) {
    const g = this.g;
    return g.stacksOf(pid).reduce((n, k) => n + k.units.reduce((m, u) => m + unitPower(u), 0), 0) + g.citiesOf(pid).length * 6;
  }

  /** Would computer side `ai` accept `kind` from side `other`? { yes, reason } */
  aiConsiders(ai, other, kind) {
    const h = this.hate(ai, other);
    const mine = this.power(ai), theirs = this.power(other);
    const word = standing(h);
    if (kind === 'peace') {
      const losing = mine < theirs * 0.6;
      const winning = mine > theirs * 1.6;
      const others = this.enemies(ai).filter((e) => e !== other).length;
      if (h >= 80) return { yes: false, reason: `Their ${word} for you is too great.` };
      if (winning && !others) return { yes: false, reason: 'They are winning this war and mean to finish it.' };
      if (h < 50 || (losing && h < 80) || (others && h < 62)) return { yes: true, reason: losing ? 'The war goes badly for them.' : 'They have had enough of this war.' };
      return { yes: false, reason: `They feel ${word} toward you.` };
    }
    const common = this.enemies(ai).some((e) => this.atWar(other, e));
    if (this.wouldEndGame(ai, other)) return { yes: false, reason: 'They will not share the throne of Etheria — an alliance now would end the war.' };
    if (h > 28) return { yes: false, reason: `They feel ${word} toward you — too little trust for an alliance.` };
    if (theirs > mine * 2.5) return { yes: false, reason: 'You are too powerful to be trusted as an ally.' };
    if (!common && h > 14) return { yes: false, reason: 'You share no enemy.' };
    return { yes: true, reason: 'They welcome a friend against their enemies.' };
  }

  // --- the passing of days ----------------------------------------------------------------------------
  /** Once a round: hate drifts, the mighty are resented, loiterers near cities annoy. */
  newRound() {
    if (!this.on) return;
    const g = this.g;
    const alive = g.s.players.filter((p) => p.alive);
    if (alive.length < 2) return;
    const cities = new Map(alive.map((p) => [p.id, g.citiesOf(p.id).length]));
    const avg = [...cities.values()].reduce((a, b) => a + b, 0) / alive.length;
    for (const a of alive) {
      for (const b of alive) {
        if (a.id === b.id) continue;
        const st = this.status(a.id, b.id);
        const base = st === STATUS.war ? WAR_BASE : st === STATUS.allied ? ALLY_BASE : PEACE_BASE;
        const h = this.hate(a.id, b.id);
        if (h !== base) this.addHate(a.id, b.id, h > base ? -1 : 1);
        // too powerful
        if (cities.get(b.id) > Math.max(3, avg * 1.5)) this.addHate(a.id, b.id, 1);
        // enemies of my enemies
        if (st !== STATUS.war && this.enemies(a.id).some((e) => this.atWar(b.id, e))) this.addHate(a.id, b.id, -1);
      }
      // armies of others loitering near my cities
      const mine = g.citiesOf(a.id);
      const near = new Set();
      for (const k of g.s.stacks) {
        if (k.owner < 0 || k.owner === a.id || near.has(k.owner) || this.allied(a.id, k.owner) || g.cityAt(k.t)) continue;
        if (mine.some((c) => g.move.distance(k.t, c.t) <= 4)) near.add(k.owner);
      }
      for (const b of near) this.addHate(a.id, b, 2);
    }
  }

  /**
   * A computer side's diplomacy at the start of its turn: answer nothing (it answers at once),
   * seek peace where war goes badly or hate has cooled, pick a war when it has no enemy, and
   * court allies against a common foe.
   */
  aiTurn(ai) {
    if (!this.on) return;
    const g = this.g;
    const others = g.s.players.filter((p) => p.alive && p.id !== ai);
    if (!others.length) return;
    const mine = this.power(ai);
    const enemies = this.enemies(ai);
    // peace: with the enemies it no longer hates, or that are beating it (keep one war going)
    for (const e of enemies) {
      if (this.enemies(ai).length <= 1 && mine >= this.power(e) * 0.6) break;
      const since = this.d.since[pair(ai, e)] ?? 0;
      if (g.s.round - since < 6) continue;
      const h = this.hate(ai, e);
      const asked = (this.d.asked ??= {});
      if ((asked[`${ai}>${e}`] ?? -99) + 5 > g.s.round) continue; // not every day
      if (h < 45 || mine < this.power(e) * 0.5) {
        asked[`${ai}>${e}`] = g.s.round;
        if (!g.player(e).human || g.rand() < 0.5) this.propose(ai, e, 'peace');
      }
    }
    // war: a side with no enemy picks one, once the free land nearby has been taken or its
    // hate boils over (the most hated and weakest neighbour first)
    const nowEnemies = this.enemies(ai);
    const neutralsLeft = g.citiesOf(-1).some((c) => g.citiesOf(ai).some((m) => g.move.distance(m.t, c.t) <= 18));
    const cands = others.filter((p) => !this.allied(ai, p.id) || this.hate(ai, p.id) > 75).map((p) => {
      const h = this.hate(ai, p.id);
      const near = g.citiesOf(p.id).reduce((best, c) => Math.min(best, ...g.citiesOf(ai).map((m) => g.move.distance(m.t, c.t))), 999);
      const weak = mine / Math.max(1, this.power(p.id));
      return { p, h, score: h + Math.min(30, weak * 8) - near * 0.6 };
    }).filter((c) => !this.atWar(ai, c.p.id)).sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (best) {
      const bored = !nowEnemies.length && (g.s.round >= 12 || !neutralsLeft) && g.s.round >= 4;
      const furious = best.h >= 78 && nowEnemies.length < 2;
      if (bored || furious) this.declareWar(ai, best.p.id, furious ? `in a ${standing(best.h)}` : '');
    }
    // alliances against a shared enemy
    if (g.s.round % 3 === 0) {
      for (const p of others) {
        if (this.status(ai, p.id) !== STATUS.peace || this.hate(ai, p.id) > 20 || this.wouldEndGame(ai, p.id)) continue;
        if (!this.enemies(ai).some((e) => this.atWar(p.id, e))) continue;
        if (p.human) { if (!this.d.proposals.some((x) => x.from === ai && x.to === p.id)) this.propose(ai, p.id, 'alliance'); }
        else this.propose(ai, p.id, 'alliance');
        break;
      }
    }
  }
}
