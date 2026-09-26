// Computer players. Each turn: diplomacy (peace where war goes badly, a new war when idle,
// allies against a common foe), take good offers, set production, spend on city walls, send
// heroes to ruins and quests, cast spells before battle, then move every stack toward the
// most rewarding target it can beat (the combat advisor runs mock battles), leaving a
// garrison in each city. A side far stronger than its foe accepts worse odds and wears it
// down; stacks with nothing better to do mass in the city nearest the enemy. The AI sees
// the whole map (it does not use fog of war).
import { UNITS } from './data/units.js';
import { SPELLS } from './data/spells.js';
import { SIDES, AI_LEVELS } from './data/sides.js';
import { unitPower, unitStats, groupMover, STACK_MAX } from './rules.js';
import { odds, ruinChance } from './combat.js';
import { CastleLevels } from '../generator/terrainTypes.js';

const power = (units) => units.reduce((n, u) => n + unitPower(u), 0);

export class AIPlayer {
  /** cmd: a Commander on the game (its hooks animate what the AI does). */
  constructor(cmd, pid) {
    this.cmd = cmd;
    this.g = cmd.game;
    this.pid = pid;
  }

  get level() { return AI_LEVELS[this.g.player(this.pid).ai] ?? AI_LEVELS.lord; }

  async play(shouldStop = () => false) {
    const g = this.g, pid = this.pid, p = g.player(pid);
    // difficulty: Warlords get a gold bonus, Knights a malus
    if (this.level.gold !== 1) p.gold = Math.round(p.gold + (this.level.gold - 1) * g.citiesOf(pid).reduce((n, c) => n + g.cityIncome(c), 0));
    g.diplo.aiTurn(pid);
    this.offers();
    this.economy();
    const stacks = [...g.stacksOf(pid)].sort((a, b) => power(b.units) - power(a.units));
    const done = new Set();
    for (const k0 of stacks) {
      if (shouldStop() || g.s.over) return;
      const k = g.stack(k0.id);
      if (!k || done.has(k.id)) continue;
      done.add(k.id);
      try { await this.actStack(k); } catch (e) { console.error('AI stack error', e); }
    }
    // a second pass for stacks formed or still able to move
    for (const k0 of [...g.stacksOf(pid)]) {
      if (shouldStop() || g.s.over) return;
      const k = g.stack(k0.id);
      if (!k || done.has(k.id) || !k.units.every((u) => u.mp > 2)) continue;
      done.add(k.id);
      try { await this.actStack(k); } catch (e) { console.error('AI stack error', e); }
    }
  }

  offers() {
    const g = this.g, p = g.player(this.pid);
    for (const o of [...g.s.offers]) {
      const reserve = o.kind === 'hero' ? 80 : o.kind === 'item' ? 500 : 250;
      if (p.gold >= o.cost + reserve) g.acceptOffer(o.id);
      else g.declineOffer(o.id);
    }
  }

  economy() {
    const g = this.g, pid = this.pid, p = g.player(pid);
    const cities = g.citiesOf(pid);
    const income = cities.reduce((n, c) => n + g.cityIncome(c), 0);
    const upkeep = g.stacksOf(pid).reduce((n, k) => n + k.units.reduce((m, u) => m + (u.hero ? 0 : UNITS[u.type].upkeep), 0), 0);
    let margin = income - upkeep + p.gold / 12;
    for (const c of cities) {
      // buy production where there is none (or only weak troops) and we can afford it
      if (!c.prod.length || (p.gold > 1200 && c.prod.length < 3)) {
        const buy = g.buyableProduction(c).filter((t) => UNITS[t].cost <= p.gold * 0.6).sort((a, b) => UNITS[b].str - UNITS[a].str)[0];
        if (buy) g.buyProduction(c, buy);
      }
      if (!c.prod.length) continue;
      // best troop we can keep paying for
      const opts = c.prod.map((t) => ({ t, u: UNITS[t] })).filter((o) => o.u.upkeep <= Math.max(1, margin * 0.5));
      const pickT = (opts.length ? opts : c.prod.map((t) => ({ t, u: UNITS[t] })).sort((a, b) => a.u.upkeep - b.u.upkeep).slice(0, 1))
        .sort((a, b) => (b.u.str * b.u.hits) / b.u.time - (a.u.str * a.u.hits) / a.u.time)[0];
      if (margin < -5 && p.gold < 100) { g.setProduction(c, null); continue; }
      if (c.producing !== pickT.t && c.progress === 0) g.setProduction(c, pickT.t);
      else if (!c.producing) g.setProduction(c, pickT.t);
      margin -= pickT.u.upkeep / pickT.u.time;
    }
    // burnt sites of our cities are rebuilt when the treasury allows
    for (const x of g.specials) if (g.s.specials[x.i].razed && g.siteOwner(x) === pid && p.gold > 700) g.rebuildSite(x.i, pid);
    // walls for the capital and threatened cities
    for (const c of cities) {
      if (c.level < 3 && p.gold > g.buildCost(c) + 700 && (c.capital || this.threat(c) > 0)) g.buildUp(c, pid);
    }
  }

  /** Enemy power within 4 tiles of a city. */
  threat(city) {
    const g = this.g;
    return g.s.stacks.filter((k) => k.owner >= 0 && g.hostile(this.pid, k.owner) && g.move.distance(k.t, city.t) <= 5).reduce((n, k) => n + power(k.units), 0);
  }

  /** How many armies a city keeps at home. */
  keepIn(city) {
    const t = this.threat(city);
    return (city.capital ? 2 : 1) + (t > 20 ? 2 : t > 8 ? 1 : 0);
  }

  async actStack(k) {
    const g = this.g, pid = this.pid;
    const city = g.cityAt(k.t);
    let movers = [...k.units];
    // leave a garrison: the weakest non-heroes stay (all armies in the city count)
    if (city && city.owner === pid) {
      const all = g.unitsIn(city);
      const keep = this.keepIn(city);
      const others = all.filter((u) => !movers.includes(u));
      const need = Math.max(0, keep - others.filter((u) => !u.hero).length);
      const stay = movers.filter((u) => !u.hero).sort((a, b) => unitPower(a) - unitPower(b)).slice(0, need);
      movers = movers.filter((u) => !stay.includes(u));
      // gather the whole free garrison of the city into one group
      if (movers.length) {
        const extra = others.filter((u) => !u.hero || true).filter((u) => u.mp > 0);
        const freeOthers = extra.sort((a, b) => unitPower(b) - unitPower(a)).slice(0, Math.max(0, others.filter((u) => !u.hero).length - keep));
        movers = [...movers, ...freeOthers].slice(0, STACK_MAX);
      }
    }
    movers = movers.filter((u) => u.mp > 0);
    if (!movers.length) return;
    const hero = movers.find((u) => u.hero);

    // heroes: quests and ruins
    if (hero && city?.owner === pid && !g.s.quests[pid] && g.s.options.quests) {
      g.getQuest(hero, hero.hero.level >= 4 ? 'average' : 'easy');
    }
    if (hero && g.canPickUp(k)) g.pickUp(k);
    if (hero && g.canSearch(k)) { await this.cmd.search(k); return; }

    const target = this.chooseTarget(movers, k);
    if (!target) return;
    // spells before a fight
    if (hero && target.fight) await this.castBuffs(hero);
    const ids = movers.filter((u) => g.unit(u.id)).map((u) => u.id);
    if (!ids.length) return;
    const res = await this.cmd.march(ids, target.t, { capture: this.captureChoice(target) });
    const now = res.stack && g.stack(res.stack.id);
    // arrived on a ruin with a hero: search at once if it still can
    if (now && target.kind === 'ruin' && now.t === target.t && g.canSearch(now)) await this.cmd.search(now);
    if (now && target.kind === 'site' && now.t === target.t && g.canRazeSite(now)) g.razeSite(now);
  }

  captureChoice(target) {
    const g = this.g, p = g.player(this.pid);
    if (!target.city) return 'occupy';
    // poor and far from home: sack; otherwise keep it whole
    return p.gold < 60 && !target.city.capital && target.city.level === 1 ? 'pillage' : 'occupy';
  }

  async castBuffs(hero) {
    const g = this.g, p = g.player(this.pid);
    const opts = g.castable(hero).filter((x) => x.ok && x.id !== 'teleport' && x.id !== 'augury' && x.id !== 'dig');
    for (const o of opts.sort((a, b) => b.spell.cost - a.spell.cost)) {
      if (p.mana < o.spell.cost + 3) continue;
      if (o.spell.kind === 'summon') {
        const k = g.stackOfUnit(hero.id);
        if (k.units.length > 5) continue;
      }
      await this.cmd.cast(hero, o.id);
      if (p.mana < 8) break;
    }
  }

  /**
   * The best target for a group: { t, kind, city?, fight, score } — enemy and neutral cities,
   * enemy stacks, ruins (heroes), shrines, or a friendly city to gather in.
   */
  chooseTarget(units, k) {
    const g = this.g, pid = this.pid;
    const mover = groupMover(units);
    const full = Math.max(8, Math.min(...units.map((u) => unitStats(u).move)));
    const aggr = this.level.aggression;
    const cands = [];
    const turnsTo = (t) => Math.max(0, g.move.distance(k.t, t) * 2.2 - mover.mp) / full;
    const v = g.s.options.victory;
    for (const c of g.s.cities) {
      if (c.owner === pid || c.razed || !g.hostile(pid, c.owner)) continue;
      const d = g.move.distance(k.t, c.t);
      if (d > 45) continue;
      const def = g.unitsIn(c);
      // the victory condition's prizes: Utopia, every capital
      const prize = (v === 'hill' && g.s.hill?.city === c.id ? 260 : 0) + (v === 'fortress' && c.capital ? 160 : 0);
      cands.push({ t: c.tiles.reduce((a, b) => (g.move.distance(k.t, b) < g.move.distance(k.t, a) ? b : a)), kind: 'city', city: c, def, fight: true,
        value: 60 + Math.min(80, g.cityIncome(c)) * 2 + (c.capital ? 60 : 0) + (c.owner >= 0 ? 20 : 0) + c.level * 10 + prize });
    }
    for (const s of g.s.stacks) {
      if (s.owner === pid || g.cityAt(s.t) || !g.hostile(pid, s.owner)) continue;
      if (g.move.distance(k.t, s.t) > 20) continue;
      cands.push({ t: s.t, kind: 'stack', def: s.units, fight: true, value: 15 + power(s.units) * 1.5 });
    }
    const hero = units.find((u) => u.hero);
    if (hero) {
      g.map.sites.forEach((site, i) => {
        const t = site.ty * g.W + site.tx;
        if (site.kind === 'ruin' && !g.s.sites[i].explored && !g.stackAt(t)) {
          // the hero goes in alone, backed by the strength of the group it brings
          if (ruinChance(hero, site.danger ?? 1, units) >= 0.6) cands.push({ t, kind: 'ruin', fight: false, value: 70 + 35 * (site.danger ?? 1) });
        }
      });
      const q = g.s.quests[pid];
      if (q && q.hero === hero.id && q.t != null && q.kind !== 'capture') cands.push({ t: q.t, kind: 'quest', fight: false, value: 120 });
      // items a fallen hero left on the ground
      for (const x of g.s.ground) {
        const there = g.stackAt(x.t);
        if ((there && there.owner !== pid) || g.move.distance(k.t, x.t) > 15) continue;
        cands.push({ t: x.t, kind: 'items', fight: false, value: 60 + 20 * x.items.length });
      }
    }
    // enemy sites nearby: burn them (the foe loses gold or better recruits)
    for (const x of g.specials) {
      const o = g.siteOwner(x);
      if (o < 0 || o === pid || !g.hostile(pid, o) || g.s.specials[x.i].razed || g.stackAt(x.t) || g.move.distance(k.t, x.t) > 12) continue;
      cands.push({ t: x.t, kind: 'site', fight: false, value: 28 + (x.type === 'mine' ? 20 : 0) });
    }
    // shrines bless unblessed armies
    if (units.some((u) => !u.blessed)) {
      g.map.sites.forEach((site) => {
        const t = site.ty * g.W + site.tx;
        if (site.kind === 'shrine' && !g.stackAt(t) && g.move.distance(k.t, t) < 10) cands.push({ t, kind: 'shrine', fight: false, value: 25 * units.filter((u) => !u.blessed).length / units.length });
      });
    }
    // attrition: a side that vastly outnumbers another accepts worse odds and wears it down
    const sidePower = (pid) => g.s.stacks.filter((x) => x.owner === pid).reduce((n, x) => n + power(x.units), 0);
    const mine = sidePower(pid);
    const ratioCache = new Map();
    const ratio = (owner) => {
      if (owner < 0) return 3;
      if (!ratioCache.has(owner)) ratioCache.set(owner, mine / Math.max(1, sidePower(owner)));
      return ratioCache.get(owner);
    };
    // score
    let best = null;
    const scored = cands.map((c) => ({ ...c, turns: turnsTo(c.t) })).sort((a, b) => b.value / (1 + b.turns) - a.value / (1 + a.turns)).slice(0, 10);
    for (const c of scored) {
      let win = 1;
      if (c.fight) {
        if (c.def.length) {
          const ctx = g.battleContext({ t: k.t, owner: pid }, c.t);
          win = odds(units, c.def, ctx, 30);
        }
        const owner = c.city ? c.city.owner : c.def[0] ? g.stackOfUnit(c.def[0].id)?.owner ?? -1 : -1;
        const r = ratio(owner);
        let need = c.kind === 'city' ? 0.72 - 0.2 * (aggr - 0.6) : 0.62;
        if (r > 4) need -= 0.45; else if (r > 2.5) need -= 0.3; else if (r > 1.6) need -= 0.12;
        need = Math.max(0.2, need);
        if (win < need) continue;
      }
      const score = (c.value * win) / (1 + c.turns * 1.2);
      if (!best || score > best.score) best = { ...c, score, win };
    }
    if (best) {
      const pl = g.plan(units, k.t, best.t);
      if (pl) return best;
    }
    // nothing worth it: gather in the nearest own city (unless already in one)
    const here = g.cityAt(k.t);
    const staging = (g.s.options.victory === 'hill' || g.s.options.victory === 'fortress') && units.length >= 3;
    if (here && here.owner === pid && !staging) return null;
    // gather near the prize of the victory condition (Utopia, the capitals), else nearby
    const prizes = v === 'hill' && g.s.hill ? [g.s.cities[g.s.hill.city]].filter((c) => c.owner !== pid)
      : v === 'fortress' ? g.s.cities.filter((c) => c.capital && c.owner !== pid && !c.razed) : [];
    const toPrize = (c) => Math.min(...prizes.map((x) => g.move.distance(c.t, x.t)));
    const room = g.citiesOf(pid).filter((c) => g.unitsIn(c).length + units.length <= 32);
    const stage = prizes.length ? room.filter((c) => toPrize(c) <= 22).sort((a, b) => toPrize(a) - toPrize(b))[0] : null;
    const home = (stage && stage !== here ? stage : null)
      ?? room.sort((a, b) => g.move.distance(k.t, a.t) - g.move.distance(k.t, b.t))[0];
    if (!home || (here && here.owner === pid && (home === here || !stage))) return null;
    return { t: home.tiles[0], kind: 'home', fight: false, score: 0 };
  }
}

export { CastleLevels, SIDES, SPELLS };
