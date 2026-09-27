// The game: state and rules of a Warlords III: Darklords Rising style campaign on a
// generated map. Pure data and logic (no three.js, no DOM), so AI, UI and tests share it.
// Everything in `this.s` is plain JSON: that is the save game.
//
// Turn structure: players act in order; at the start of a player's turn cities pay income,
// armies are paid (unpaid armies disband), mana flows, production advances and armies get
// their movement back. A round is one turn of every player = one day; the weather changes
// every WEATHER_DAYS days.
import { Flag, Tile, SiteTypes, CastleLevels } from '../generator/terrainTypes.js';
import { UNITS, GUARDIANS, BOATS } from './data/units.js';
import { HERO_CLASSES, HERO_NAMES } from './data/heroes.js';
import { SPELLS } from './data/spells.js';
import { ITEMS, ITEMS_BY_TIER } from './data/items.js';
import { SIDES, NEUTRAL_POOL } from './data/sides.js';
import { Movement, terrainBonusAt } from './movement.js';
import { chooseCapitals } from '../generator/settlements.js';
import { STACK_MAX, CITY_MAX, unitStats, stackEffects, maxMoves, groupMover, unitPower, upkeepOf, levelForXp, unitName, leaderOf } from './rules.js';
import { fight, applyAftermath, ruinDuel, DICE } from './combat.js';
import { Diplomacy } from './diplomacy.js';
import { makeSignposts } from './signposts.js';
import { makeSpecialSites, SPECIAL_TYPES, MOUNTED, REBUILD_SITE } from './specials.js';

export const WEATHER_DAYS = 3;
// random weather; Blizzard and Morning mist are left out (user's rule)
export const GAME_WEATHERS = ['Clear', 'Fair clouds', 'Overcast', 'Rain', 'Thunderstorm', 'Snowfall'];
const WEATHER_ODDS = [0.28, 0.26, 0.16, 0.14, 0.08, 0.08];
export const BUILD_COST = [0, 500, 1000]; // gold to raise a city from level l to l + 1
export const REBUILD_COST = 800;
export const HERO_NAME_MAX = 24;
export const RUIN_JOIN = 0.2; // share of ruins whose guardians join the hero instead of fighting
export const JOIN_MIN_STR = 5; // only guardians this strong ever offer to join (rats and bats just fight)
export const HERO_MAX = 6; // heroes a side may lead at once (hired heroes stop coming)
const QUEST_XP = { easy: 2, average: 7, hard: 14 };
export const HILL_DAYS = 10; // King of the Hill: days to hold Utopia
export const HILL_NAME = 'Utopia';
export const NEUTRAL_PROD_ROUND = 11; // neutral cities train troops once day 10 is past (user)
const NEUTRAL_MAX = { weak: 2, normal: 3, strong: 5 }; // their garrison stops growing here (+1 a castle level above 1)
/** The `n` weakest unit types of a production list. */
const weakest = (prod, n) => [...prod].sort((a, b) => UNITS[a].str * UNITS[a].hits - UNITS[b].str * UNITS[b].hits).slice(0, n);

/** Victory conditions (Warlords III and Darklords Rising). `timed`: decided when the turn limit runs out. */
export const VICTORY = {
  last: { name: 'Last Warlord Standing', desc: 'Destroy every other side (allies left alone share the victory).' },
  cities: { name: 'Most Cities', desc: 'Whoever holds the most cities when the turn limit runs out.', timed: true },
  points: { name: 'Most Victory Points', desc: 'One point per city and hero, plus points for gold, when the turn limit runs out.', timed: true },
  gold: { name: 'Most Money', desc: 'The richest treasury when the turn limit runs out.', timed: true },
  hill: { name: 'King of the Hill', desc: `Hold the city of ${HILL_NAME} for ${HILL_DAYS} days.` },
  fortress: { name: 'Fortress', desc: 'Capture every capital city.' },
};
export const TIMED_DEFAULT_LIMIT = 100;

export const DEFAULT_OPTIONS = {
  startGold: 300,
  neutrals: 'normal', // weak | normal | strong
  hiddenMap: true, // unexplored land is dark until your armies see it
  fogOfWar: true, // enemy armies outside your armies' view are hidden
  quests: true,
  mercenaries: true,
  heroOffers: true,
  dice: DICE,
  turnLimit: 0, // 0 = none
  victory: 'last', // a key of VICTORY
  diplomacy: true, // war, peace and alliances; off: everyone at war
  merchants: true, // merchants now and then offer magic items
  timedVectoring: false, // vectoring takes 2-5 turns by distance (off: always 2)
};

/** A new game on `map` (see generator). setup: { players: [{ side, human, ai }], options, mapName, mapFile, seed } */
export function newGameState(map, setup) {
  const opts = { ...DEFAULT_OPTIONS, ...(setup.options ?? {}) };
  if (!VICTORY[opts.victory]) opts.victory = 'last';
  if (VICTORY[opts.victory].timed && !opts.turnLimit) opts.turnLimit = TIMED_DEFAULT_LIMIT;
  const W = map.grid.tilesW, H = map.grid.tilesH;
  const s = {
    version: 1,
    map: { name: setup.mapName ?? map.meta?.name ?? 'Map', file: setup.mapFile ?? null, W, H },
    options: opts,
    round: 1,
    turn: 0, // index into order
    order: [],
    players: [],
    cities: [],
    stacks: [],
    sites: map.sites.map((site) => ({ explored: false, visited: [] })),
    ground: [], // items lying on the map: [{ t, items }]
    pending: [], // armies on the vectoring network: [{ owner, units, city, round }]
    offers: [], // hero and mercenary offers awaiting the current player
    quests: {}, // player id -> quest
    weather: { name: 'Fair clouds', round: 1 },
    log: [],
    nextId: 1,
    rng: (setup.seed ?? Date.now()) >>> 0,
    winner: null,
    winners: [],
    over: false,
    hill: null, // King of the Hill: { city, holder, since }
    surrenderAsked: {}, // side (or 'all') -> round a surrender was last offered
  };
  const active = setup.players.filter((p) => p.side >= 0);
  for (const p of active) {
    const side = SIDES[p.side];
    s.players.push({
      id: p.side, name: side.name, color: side.color, human: !!p.human, ai: p.ai ?? 'lord', alive: true,
      gold: opts.startGold, mana: 5, kills: 0, lost: 0, heroesHired: 0, explored: '', questWait: 0,
      stats: [], // per-round history for the reports: { round, cities, armies, gold }
    });
  }
  s.order = s.players.map((p) => p.id);
  const g = new Game(map, s);
  g._initCities();
  if (opts.victory === 'hill') g._initHill();
  g._initArmies();
  g.diplo.init();
  for (const p of s.players) g._explore(p.id);
  g.s.weather = { name: g._rollWeather(), round: 1 };
  g._startTurn();
  return g.s;
}

export class Game {
  /** `map`: the generated map; `state`: newGameState() or a loaded save. */
  constructor(map, state) {
    this.map = map;
    this.s = state;
    this.W = map.grid.tilesW;
    this.H = map.grid.tilesH;
    this.move = new Movement(map);
    this.listeners = new Map();
    state.surrenderAsked ??= {}; // saves from before surrender offers
    state.winners ??= state.winner != null ? [state.winner] : [];
    this.diplo = new Diplomacy(this);
    this.signposts = makeSignposts(map);
    this.specials = makeSpecialSites(map);
    state.specials ??= this.specials.map(() => ({ razed: false }));
    // a save from before the sites moved may hold fewer of them
    for (let i = state.specials.length; i < this.specials.length; i++) state.specials.push({ razed: false });
    this.specialAtTile = new Map(this.specials.map((x) => [x.t, x]));
    this._index();
  }

  // --- events ------------------------------------------------------------------------------
  on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, []); this.listeners.get(ev).push(fn); }
  emit(ev, data) { for (const fn of this.listeners.get(ev) ?? []) fn(data); }
  /** Adds a line to the event log (and tells the UI). */
  note(text, { player = this.currentId, t = -1, kind = 'info' } = {}) {
    const e = { round: this.s.round, player, text, t, kind };
    this.s.log.push(e);
    if (this.s.log.length > 400) this.s.log.shift();
    this.emit('log', e);
  }

  // --- random numbers (seeded, saved with the game) ----------------------------------------
  rand() {
    let a = (this.s.rng = (this.s.rng + 0x6d2b79f5) >>> 0);
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }
  rint(a, b) { return a + Math.floor(this.rand() * (b - a + 1)); }
  pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }

  // --- lookups --------------------------------------------------------------------------------
  _index() {
    this.cityAtTile = new Int16Array(this.W * this.H).fill(-1);
    for (const c of this.s.cities) for (const t of c.tiles) this.cityAtTile[t] = c.id;
    this.siteAtTile = new Map(this.map.sites.map((site, i) => [site.ty * this.W + site.tx, i]));
    this.portTiles = new Set(this.map.ports.map((p) => p.ty * this.W + p.tx));
  }
  get current() { return this.player(this.s.order[this.s.turn]); }
  get currentId() { return this.s.order[this.s.turn]; }
  player(id) { return this.s.players.find((p) => p.id === id); }
  tileXY(t) { return [t % this.W, (t / this.W) | 0]; }
  tile(x, y) { return y * this.W + x; }
  stack(id) { return this.s.stacks.find((k) => k.id === id); }
  stackAt(t) { return this.s.stacks.find((k) => k.t === t); }
  stacksOf(pid) { return this.s.stacks.filter((k) => k.owner === pid); }
  cityAt(t) { const i = this.cityAtTile[t]; return i >= 0 ? this.s.cities[i] : null; }
  citiesOf(pid) { return this.s.cities.filter((c) => c.owner === pid && !c.razed); }
  /** All stacks inside a city. */
  garrison(city) { return this.s.stacks.filter((k) => city.tiles.includes(k.t)); }
  unitsIn(city) { return this.garrison(city).flatMap((k) => k.units); }
  unit(id) {
    for (const k of this.s.stacks) { const u = k.units.find((x) => x.id === id); if (u) return u; }
    return null;
  }
  stackOfUnit(id) { return this.s.stacks.find((k) => k.units.some((u) => u.id === id)); }
  heroes(pid) { return this.stacksOf(pid).flatMap((k) => k.units.filter((u) => u.hero)); }
  isOwnedBy(t, pid) { const k = this.stackAt(t); if (k) return k.owner === pid; const c = this.cityAt(t); return c ? c.owner === pid : true; }
  site(t) { const i = this.siteAtTile.get(t); return i === undefined ? null : { i, ...this.map.sites[i], state: this.s.sites[i] }; }
  mapCity(c) { return this.map.cities[c.id]; }
  cityCenter(c) { const m = this.mapCity(c); return { x: m.x, z: m.z }; }

  // --- special sites ---------------------------------------------------------------------------
  /** The special site on tile t: { ...site, razed } or null. */
  special(t) { const x = this.specialAtTile.get(t); return x ? { ...x, razed: !!this.s.specials[x.i]?.razed } : null; }
  /** Standing sites serving a city. */
  sitesOf(city) { return this.specials.filter((x) => x.city === city.id && !this.s.specials[x.i]?.razed); }
  /** What a city's sites give: { gold, str, hits, move (mounted), view, time }. */
  siteBoons(city) {
    const b = { gold: 0, str: 0, hits: 0, move: 0, view: 0, time: 0 };
    if (city.razed) return b;
    for (const x of this.sitesOf(city)) { const T = SPECIAL_TYPES[x.type]; for (const k of Object.keys(b)) b[k] += T[k] ?? 0; }
    return b;
  }
  /** Gold a city pays a turn, its sites' included. */
  cityIncome(city) { return city.income + this.siteBoons(city).gold; }
  /** Turns to train `type` in a city (barracks take a turn off, never below one). */
  prodTime(city, type) { return Math.max(1, UNITS[type].time - this.siteBoons(city).time); }
  /** A new army of the city gets its sites' training. */
  _train(u, city) {
    const b = this.siteBoons(city);
    const t = {};
    if (b.str) t.str = b.str;
    if (b.hits) t.hits = b.hits;
    if (b.view) t.view = b.view;
    if (b.move && MOUNTED.has(u.type)) t.move = b.move;
    if (Object.keys(t).length) { u.trained = t; u.mp = maxMoves(u, [u]); }
  }
  /** Who a site serves: its city's owner (-1 for neutral or razed cities). */
  siteOwner(x) { const c = this.s.cities[x.city]; return c && !c.razed ? c.owner : -1; }
  /** Can the group on `stack` raze the site it stands on? Any army may, but not its own side's. */
  canRazeSite(stack) {
    const x = stack && this.special(stack.t);
    return !!x && !x.razed && this.siteOwner(x) !== stack.owner && stack.units.some((u) => u.mp > 0);
  }
  /** Burns the site under the stack (its moves are spent); its owner hates the burner. */
  razeSite(stack) {
    if (!this.canRazeSite(stack)) return false;
    const x = this.special(stack.t);
    const owner = this.siteOwner(x);
    this.s.specials[x.i].razed = true;
    for (const u of stack.units) u.mp = 0;
    if (owner >= 0) this.diplo.onAttack(stack.owner, owner);
    for (const p of this.s.players) if (p.id !== stack.owner && p.id !== owner) this.diplo.addHate(p.id, stack.owner, 2);
    this.note(`${this.player(stack.owner)?.name ?? 'Raiders'} burn the ${SPECIAL_TYPES[x.type].name} of ${this.s.cities[x.city].name}!`, { t: x.t, kind: 'battle', player: stack.owner });
    this.emit('siteChanged', x);
    return true;
  }
  /** The owner of a razed site's city rebuilds it. */
  rebuildSite(i, pid = this.currentId) {
    const x = this.specials[i], p = this.player(pid);
    if (!x || !this.s.specials[i].razed || this.siteOwner(x) !== pid || !p || p.gold < REBUILD_SITE) return false;
    p.gold -= REBUILD_SITE;
    this.s.specials[i].razed = false;
    this.note(`${p.name} rebuild the ${SPECIAL_TYPES[x.type].name} of ${this.s.cities[x.city].name}.`, { t: x.t, kind: 'good', player: pid });
    this.emit('siteChanged', x);
    return true;
  }

  // --- setup ----------------------------------------------------------------------------------
  _initCities() {
    const seats = this._seatSides();
    this.s.cities = this.map.cities.map((mc, id) => {
      const t0 = mc.ty * this.W + mc.tx;
      const owner = seats.get(id) ?? -1;
      const level = owner >= 0 ? 3 : mc.level; // a seat is a capital, walls and all
      const c = {
        id, name: mc.name, t: t0, tiles: [t0, t0 + 1, t0 + this.W, t0 + this.W + 1], owner, capital: owner >= 0,
        level, razed: false, income: 0, mana: 0, prod: [], producing: null, progress: 0, vector: null, port: 0,
      };
      c.income = (c.capital ? 30 : 12) + level * 5 + this.rint(0, 8);
      c.mana = c.capital ? 3 : level >= 3 ? 2 : 1;
      if (owner >= 0) {
        const side = SIDES[owner];
        c.prod = c.capital ? side.units.slice(0, 4) : side.units.slice(0, 2);
        c.producing = c.prod[0];
      } else {
        const pool = [...NEUTRAL_POOL];
        const n = 1 + (level >= 2 ? 1 : 0) + (this.rand() < 0.4 ? 1 : 0);
        for (let i = 0; i < n; i++) c.prod.push(pool.splice(Math.floor(this.rand() * pool.length), 1)[0]);
        c.prod.sort((a, b) => UNITS[a].str - UNITS[b].str);
      }
      return c;
    });
    this._index();
    // ports add 2 gold to their nearest city
    for (const p of this.map.ports) {
      const pt = p.ty * this.W + p.tx;
      const c = this._nearestCity(pt, () => true);
      if (c) { c.income += 2; c.port++; }
    }
  }

  /**
   * Which city each side starts in: map city index -> side. With every capital taken each side
   * keeps its own; with fewer sides than capitals they get the cities farthest apart by travel
   * (walking and sailing, capped by the straight line) — any city may become a capital then — a
   * side keeping its own capital when that is one of them.
   */
  _seatSides() {
    const players = this.s.players.map((p) => p.id);
    const caps = this.map.cities.map((mc, i) => i).filter((i) => this.map.cities[i].capital && this.map.cities[i].owner >= 0);
    const seats = new Map();
    let chosen = caps;
    if (players.length < caps.length) {
      const costFrom = (t) => { const r = this.move.reachable({ bonuses: [] }, t, Infinity); return (u) => r.get(u) ?? Infinity; };
      chosen = chooseCapitals(this.map.grid, this.map.tiles, this.map.flags, this.map.cities, players.length, costFrom);
    }
    const free = chosen.filter((i) => !players.includes(this.map.cities[i].owner));
    for (const i of chosen) if (players.includes(this.map.cities[i].owner)) seats.set(i, this.map.cities[i].owner);
    const unseated = players.filter((p) => ![...seats.values()].includes(p));
    for (const p of unseated) if (free.length) seats.set(free.splice(Math.floor(this.rand() * free.length), 1)[0], p);
    return seats;
  }

  /** King of the Hill: the free city nearest the middle of the map becomes Utopia — rich,
   * strongly walled and stocked with neutral armies (Darklords Rising). */
  _initHill() {
    const mid = this.tile(this.W >> 1, this.H >> 1);
    const free = this.s.cities.filter((c) => c.owner < 0);
    const c = (free.length ? free : this.s.cities.filter((x) => !x.capital)).reduce((a, b) => (this.move.distance(b.t, mid) < this.move.distance(a.t, mid) ? b : a));
    if (!this.s.cities.some((x) => x.name === HILL_NAME)) c.name = HILL_NAME;
    c.income = 100; c.mana = 10; c.level = 3; c.owner = -1; c.capital = false;
    this.s.hill = { city: c.id, holder: -1, since: 0 };
  }

  _nearestCity(t, filter) {
    let best = null, bd = Infinity;
    for (const c of this.s.cities) {
      if (!filter(c)) continue;
      const d = this.move.distance(t, c.t);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  newUnit(type, extra = {}) {
    const u = { id: this.s.nextId++, type, mp: UNITS[type]?.move ?? 16, medals: 0, blessed: false, poisoned: false, diseased: false, paralysed: false, ...extra };
    return u;
  }

  newHero(cls, level = 1) {
    const c = HERO_CLASSES[cls];
    const hero = { cls, name: this.randomHeroName(), level: 1, xp: 0, ap: 0, bought: [0], items: [], spells: [], active: [], quest: null };
    const a = c.levels[0].ability;
    if (a.spell) hero.spells.push(a.spell);
    const u = this.newUnit(c.model, { hero });
    if (level > 1) this.gainXp(u, c.levels[level - 1].xp, true);
    u.mp = maxMoves(u, [u]);
    return u;
  }

  _initArmies() {
    const o = this.s.options;
    for (const p of this.s.players) {
      const cap = this.s.cities.find((c) => c.owner === p.id && c.capital) ?? this.citiesOf(p.id)[0];
      if (!cap) continue;
      const side = SIDES[p.id];
      const hero = this.newHero(this.pick(side.heroes));
      // a human player names the hero that emerges in the capital at the start (as in Warlords)
      if (p.human) hero.hero.fresh = true;
      this.addUnits(cap.tiles[0], p.id, [hero]);
      this.addUnits(cap.tiles[1], p.id, [this.newUnit(side.units[0]), this.newUnit(side.units[0]), this.newUnit(side.units[1])]);
      for (const c of this.citiesOf(p.id)) if (c !== cap) this.addUnits(c.tiles[0], p.id, [this.newUnit(c.prod[0])]);
    }
    // neutral garrisons: at first one or two of the city's lowest troops, easy pickings
    // (user); they train more from NEUTRAL_PROD_ROUND on (_neutralProduction)
    const n = { weak: [1, 1], normal: [1, 2], strong: [2, 4] }[o.neutrals] ?? [1, 2];
    for (const c of this.s.cities) {
      if (c.owner >= 0) continue;
      const hill = this.s.hill?.city === c.id;
      const count = hill ? 6 : this.rint(n[0], n[1]) + (o.neutrals === 'strong' && c.level >= 3 ? 1 : 0);
      const units = [];
      for (let i = 0; i < count; i++) units.push(this.newUnit(hill ? this.pick([...NEUTRAL_POOL].sort((a, b) => UNITS[b].str * UNITS[b].hits - UNITS[a].str * UNITS[a].hits).slice(0, 4)) : o.neutrals === 'strong' ? this.pick(c.prod) : this.pick(weakest(c.prod, o.neutrals === 'weak' ? 1 : 2))));
      this.addUnits(c.tiles[0], -1, units);
    }
  }

  /** From NEUTRAL_PROD_ROUND on, neutral cities train their own troops, lowest ones first
   * (anything they can make later on), each at its training time, up to a small garrison. */
  _neutralProduction() {
    if (this.s.round < NEUTRAL_PROD_ROUND) return;
    const o = this.s.options;
    const late = this.s.round >= NEUTRAL_PROD_ROUND * 2.5;
    for (const c of this.s.cities) {
      if (c.owner >= 0 || c.razed || !c.prod.length || this.s.hill?.city === c.id) continue;
      const cap = NEUTRAL_MAX[o.neutrals] ?? NEUTRAL_MAX.normal;
      if (this.unitsIn(c).length >= cap + c.level - 1) continue;
      c.producing ??= this.pick(late ? c.prod : weakest(c.prod, 2));
      c.progress = (c.progress ?? 0) + 1;
      if (c.progress < this.prodTime(c, c.producing)) continue;
      this.addUnits(c.tiles[0], -1, [this.newUnit(c.producing)]);
      c.progress = 0;
      c.producing = null;
    }
  }

  /** Puts armies on tile t for `owner`, merging with its stack there (spilling over into
   * other tiles of a city when the stack is full). Returns the stacks touched. */
  addUnits(t, owner, units) {
    const city = this.cityAt(t);
    const tiles = city ? [t, ...city.tiles.filter((x) => x !== t)] : [t];
    const touched = new Set();
    let rest = [...units];
    for (const tt of tiles) {
      if (!rest.length) break;
      let k = this.stackAt(tt);
      if (k && k.owner !== owner) continue;
      if (!k) { k = { id: this.s.nextId++, owner, t: tt, units: [], path: null, defend: false, done: false }; this.s.stacks.push(k); }
      const room = STACK_MAX - k.units.length;
      k.units.push(...rest.slice(0, room));
      rest = rest.slice(room);
      touched.add(k);
    }
    if (rest.length && !city) {
      // spill onto a free neighbouring tile
      for (const nt of this.move.neighbours(t)) {
        if (!rest.length) break;
        if (!this.move.isLand(nt) || this.stackAt(nt) || this.cityAt(nt)) continue;
        const k = { id: this.s.nextId++, owner, t: nt, units: rest.splice(0, STACK_MAX), path: null, defend: false, done: false };
        this.s.stacks.push(k);
        touched.add(k);
      }
    }
    return [...touched];
  }

  removeUnits(ids) {
    const set = new Set(ids);
    for (const k of this.s.stacks) k.units = k.units.filter((u) => !set.has(u.id));
    this.s.stacks = this.s.stacks.filter((k) => k.units.length);
  }

  // --- turns -----------------------------------------------------------------------------------
  /** Start of the current player's turn. Returns a report for the UI. */
  _startTurn() {
    const p = this.current;
    const report = { income: 0, upkeep: 0, mana: 0, produced: [], disbanded: [], arrived: [], offers: [] };
    if (!p.alive) return report;
    const o = this.s.options;
    // income
    let income = 0, mana = 0;
    for (const c of this.citiesOf(p.id)) { income += this.cityIncome(c); mana += c.mana; }
    for (const k of this.stacksOf(p.id)) { const e = stackEffects(k.units); income += e.income; mana += e.mana; }
    p.gold += income;
    report.income = income;
    // spells in play cost mana every turn; they end when it runs out
    for (const k of this.stacksOf(p.id)) for (const u of k.units) {
      if (!u.hero) continue;
      for (const sp of [...u.hero.active]) {
        const up = SPELLS[sp].upkeep;
        if (p.mana + mana >= up) mana -= up;
        else { u.hero.active = u.hero.active.filter((x) => x !== sp); this.note(`${u.hero.name}'s ${SPELLS[sp].name} fades: no mana left.`, { t: k.t }); }
      }
    }
    p.mana = Math.max(0, Math.min(this.manaMax(p.id), p.mana + mana));
    report.mana = mana;
    // upkeep
    const upkeep = this.stacksOf(p.id).reduce((n, k) => n + k.units.reduce((m, u) => m + upkeepOf(u), 0), 0);
    p.gold -= upkeep;
    report.upkeep = upkeep;
    while (p.gold < 0) {
      const all = this.stacksOf(p.id).flatMap((k) => k.units.filter((u) => !u.hero).map((u) => ({ u, k })));
      if (!all.length) { p.gold = 0; break; }
      const { u, k } = all.reduce((a, b) => (upkeepOf(b.u) > upkeepOf(a.u) ? b : a));
      this.removeUnits([u.id]);
      p.gold += upkeepOf(u);
      report.disbanded.push(unitName(u));
      this.note(`Unpaid, the ${unitName(u)} deserts.`, { t: k.t, kind: 'bad' });
    }
    // production and vectoring
    for (const c of this.citiesOf(p.id)) {
      if (!c.producing) continue;
      c.progress++;
      if (c.progress < this.prodTime(c, c.producing)) continue;
      if (this.unitsIn(c).length >= CITY_MAX && !c.vector) continue; // full: hold it
      c.progress = 0;
      const u = this.newUnit(c.producing);
      if (this._blessedCity(c)) u.blessed = true;
      this._train(u, c);
      const target = c.vector != null ? this.s.cities[c.vector] : null;
      if (target && target.owner === p.id && !target.razed) {
        this.s.pending.push({ owner: p.id, units: [u], city: target.id, from: c.id, round: this.s.round + this.vectorTurns(c, target) });
      } else {
        this.addUnits(c.tiles[0], p.id, [u]);
        this.emit('produced', { city: c, unit: u });
      }
      report.produced.push({ city: c.name, unit: UNITS[u.type].name });
    }
    for (const v of [...this.s.pending]) {
      if (v.owner !== p.id || v.round > this.s.round) continue;
      this.s.pending = this.s.pending.filter((x) => x !== v);
      const c = this.s.cities[v.city];
      const dest = c.owner === p.id && !c.razed ? c : this.citiesOf(p.id)[0];
      if (!dest) continue;
      this.addUnits(dest.tiles[0], p.id, v.units);
      report.arrived.push({ city: dest.name, n: v.units.length });
    }
    // armies get their movement back
    for (const k of this.stacksOf(p.id)) {
      k.done = false;
      for (const u of k.units) {
        u.mp = u.paralysed ? 0 : maxMoves(u, k.units);
        u.paralysed = false;
      }
    }
    // offers: heroes and mercenaries
    this.s.offers = [];
    const nHeroes = this.heroes(p.id).length;
    // a hero offers service in one of the side's cities, only when the treasury can pay
    // (Warlords: "A hero in <city> offers to join you for N gold"); richer sides are courted more
    const cities = this.citiesOf(p.id);
    if (o.heroOffers && this.s.round > 1 && nHeroes < HERO_MAX && cities.length && this.rand() < 0.08 + Math.min(0.12, p.gold / 10000)) {
      const side = SIDES[p.id];
      const cls = this.pick(side.heroes);
      const level = this.rand() < 0.3 ? 2 : 1;
      let cost = 800 + (level - 1) * 150 + this.rint(0, 5) * 10;
      // some come with a retinue, now and then a powerful one (strongest ally: a lone dragon)
      let allies = [];
      if (this.rand() < 0.3) {
        const r = this.rand();
        const tier = r < 0.5 ? this.rint(0, 1) : r < 0.85 ? 2 : 3;
        const n = tier < 2 ? 2 : tier === 2 ? this.rint(1, 2) : 1;
        allies = Array(n).fill(side.allies[tier]);
        cost += tier < 2 ? 150 + tier * 50 : tier === 2 ? 150 + n * 100 : 400;
      }
      cost = Math.min(1400, cost);
      if (p.gold >= cost) this.s.offers.push({ id: this.s.nextId++, kind: 'hero', cls, level, cost, allies, city: this.pick(cities).id });
    }
    // a merchant with a magic item for sale (Warlords III option); greedy prices
    if (o.merchants && this.s.round > 3 && nHeroes && this.rand() < 0.07) {
      const r = this.rand();
      const tier = r < 0.6 ? 1 : r < 0.92 ? 2 : 3;
      const item = this.pick(ITEMS_BY_TIER[tier - 1]);
      const cost = Math.round((ITEMS[item].value * (1.3 + this.rand() * 0.4)) / 10) * 10;
      const city = cities.length ? this.pick(cities).id : null;
      if (p.gold >= cost) this.s.offers.push({ id: this.s.nextId++, kind: 'item', item, cost, city });
    }
    if (o.mercenaries && this.s.round > 2 && this.rand() < 0.07) {
      const type = this.pick(SIDES[p.id].mercs);
      // they only come to a lord who can pay: fewer of them if the treasury is thin, else none
      const price = (k) => Math.max(50, Math.round((UNITS[type].cost * 0.5 * k) / 10) * 10);
      let n = this.rint(1, 3);
      while (n > 0 && price(n) > p.gold) n--;
      if (n > 0) this.s.offers.push({ id: this.s.nextId++, kind: 'mercs', type, n, cost: price(n) });
    }
    report.offers = this.s.offers;
    if (p.questWait > 0) p.questWait--;
    this._explore(p.id);
    this._checkQuest(p.id);
    this.lastReport = report;
    this.emit('turnStart', { player: p, report });
    return report;
  }

  /** Ends the current player's turn and starts the next living player's. */
  endTurn() {
    const p = this.current;
    p.stats.push({ round: this.s.round, cities: this.citiesOf(p.id).length, armies: this.stacksOf(p.id).reduce((n, k) => n + k.units.length, 0), gold: p.gold });
    this.s.offers = [];
    for (let i = 0; i < this.s.order.length; i++) {
      this.s.turn++;
      if (this.s.turn >= this.s.order.length) {
        this.s.turn = 0;
        this.s.round++;
        this.diplo.newRound();
        this._neutralProduction();
        this._hillDay();
        if (this.s.over) return this.lastReport;
        if ((this.s.round - this.s.weather.round) >= WEATHER_DAYS) {
          this.s.weather = { name: this._rollWeather(this.s.weather.name), round: this.s.round };
          this.emit('weather', this.s.weather);
        }
        if (this.s.options.turnLimit && this.s.round > this.s.options.turnLimit) { this._timeUp(); return; }
      }
      if (this.current.alive) break;
    }
    this.emit('turnEnd', { player: p });
    return this._startTurn();
  }

  _rollWeather(prev) {
    for (let k = 0; k < 8; k++) {
      let r = this.rand(), i = 0;
      while (i < WEATHER_ODDS.length - 1 && r >= WEATHER_ODDS[i]) { r -= WEATHER_ODDS[i]; i++; }
      if (GAME_WEATHERS[i] !== prev) return GAME_WEATHERS[i];
    }
    return 'Clear';
  }

  manaMax(pid) {
    const cities = this.citiesOf(pid);
    return 20 + cities.reduce((n, c) => n + c.mana * 5, 0);
  }

  _blessedCity(c) {
    // armies built near a shrine are blessed (Appendix 5)
    return this.map.sites.some((site, i) => site.kind === 'shrine' && this.move.distance(site.ty * this.W + site.tx, c.t) <= 6);
  }

  // --- vision ---------------------------------------------------------------------------------
  /** Tiles the player sees now: a Uint8Array (1 = in view). */
  visible(pid) {
    const v = new Uint8Array(this.W * this.H);
    const mark = (t, r) => {
      const [x0, y0] = this.tileXY(t);
      for (let y = Math.max(0, y0 - r); y <= Math.min(this.H - 1, y0 + r); y++) {
        for (let x = Math.max(0, x0 - r); x <= Math.min(this.W - 1, x0 + r); x++) {
          if ((x - x0) ** 2 + (y - y0) ** 2 <= r * r + r) v[y * this.W + x] = 1;
        }
      }
    };
    for (const k of this.stacksOf(pid)) mark(k.t, 2 + Math.max(...k.units.map((u) => unitStats(u).view)));
    for (const c of this.citiesOf(pid)) mark(c.tiles[3], 4 + c.level);
    return v;
  }

  /** Explored tiles of a player (Uint8Array), decoded from the save string once. */
  explored(pid) {
    this._ex ??= new Map();
    if (!this._ex.has(pid)) {
      const a = new Uint8Array(this.W * this.H);
      const str = this.player(pid)?.explored;
      if (str) {
        const bin = atob(str);
        for (let i = 0; i < bin.length; i++) for (let b = 0; b < 8; b++) if (bin.charCodeAt(i) & (1 << b)) a[i * 8 + b] = 1;
      }
      this._ex.set(pid, a);
    }
    return this._ex.get(pid);
  }

  _explore(pid, extra = null) {
    const ex = this.explored(pid);
    const v = extra ?? this.visible(pid);
    let changed = false;
    for (let i = 0; i < v.length; i++) if (v[i] && !ex[i]) { ex[i] = 1; changed = true; }
    if (!changed) return;
    let bin = '';
    for (let i = 0; i < ex.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8; b++) if (ex[i + b]) byte |= 1 << b;
      bin += String.fromCharCode(byte);
    }
    this.player(pid).explored = btoa(bin);
    this.emit('explored', pid);
  }

  revealArea(pid, t, r) {
    const v = new Uint8Array(this.W * this.H);
    const [x0, y0] = this.tileXY(t);
    for (let y = Math.max(0, y0 - r); y <= Math.min(this.H - 1, y0 + r); y++) {
      for (let x = Math.max(0, x0 - r); x <= Math.min(this.W - 1, x0 + r); x++) v[y * this.W + x] = 1;
    }
    this._explore(pid, v);
  }

  /** Can player `pid` see stack k (fog of war, invisibility)? */
  canSee(pid, k, vis = null) {
    if (k.owner === pid) return true;
    if (stackEffects(k.units).invisible) return false;
    if (!this.s.options.fogOfWar) return true;
    return !!(vis ?? this.visible(pid))[k.t];
  }

  // --- movement ---------------------------------------------------------------------------------
  /** May sides a and b fight (at war, or either neutral)? */
  hostile(a, b) { return a !== b && this.diplo.atWar(a, b); }

  /** Tiles a group of `owner` may not enter: other sides' armies (allies' may be passed
   * through, not stopped on) and cities. */
  blockedFor(owner, except = null) {
    const b = new Set();
    for (const k of this.s.stacks) if (k.owner !== owner && k !== except && !this.diplo.allied(owner, k.owner)) b.add(k.t);
    for (const c of this.s.cities) if (c.owner !== owner && !c.razed) for (const t of c.tiles) b.add(t);
    return b;
  }

  /**
   * Can `units` (standing together, marching as one at the pace of the slowest) still act
   * this turn: afford a step onto some tile (beyond its own city's), or attack a foe next to
   * it? 1 MP left facing only hills and forest is not a move left.
   */
  canAct(units) {
    const k = units.length ? this.stackOfUnit(units[0].id) : null;
    const mp = Math.max(0, Math.min(...units.map((u) => u.mp)));
    if (!k || mp <= 0) return false;
    const blocked = this.blockedFor(k.owner);
    const home = this.cityAt(k.t);
    for (const t of this.move.reachable({ ...groupMover(units), mp }, k.t, mp, blocked).keys()) {
      if (t !== k.t && !home?.tiles.includes(t)) return true;
    }
    return this.move.neighbours(k.t).some((t) => {
      if (!blocked.has(t)) return false;
      const owner = this.stackAt(t)?.owner ?? this.cityAt(t)?.owner ?? -1;
      return this.hostile(k.owner, owner);
    });
  }

  /** Units of a stack (or a city garrison) given by id. */
  unitsById(ids) { return ids.map((id) => this.unit(id)).filter(Boolean); }

  /**
   * Plans the move of `units` (armies of one owner, standing together) to `goal`.
   * Returns null (no way) or { path, mover, turns: turn index per tile, attack: null |
   * { t, kind: 'stack' | 'city', owner } (the last tile is an enemy to fight) }.
   */
  plan(units, from, goal) {
    if (!units.length || from === goal) return null;
    const owner = this.stackOfUnit(units[0].id)?.owner;
    const mover = groupMover(units);
    const blocked = this.blockedFor(owner);
    const city = this.cityAt(goal);
    const enemyStack = this.stackAt(goal);
    let attack = null;
    if (enemyStack && enemyStack.owner !== owner) attack = { t: goal, kind: city ? 'city' : 'stack', owner: enemyStack.owner };
    else if (city && city.owner !== owner && !city.razed) attack = { t: goal, kind: 'city', owner: city.owner };
    // a side at peace or allied: attacking it breaks the treaty (the UI asks first)
    if (attack && !this.hostile(owner, attack.owner)) attack.treaty = this.diplo.status(owner, attack.owner);
    // full friendly stacks can be passed but not stopped on
    if (!attack) {
      const k = this.stackAt(goal);
      const moving = new Set(units.map((u) => u.id));
      const there = k ? k.units.filter((u) => !moving.has(u.id)).length : 0;
      const room = city && (city.owner === owner || city.razed) ? CITY_MAX - this.unitsIn(city).filter((u) => !moving.has(u.id)).length : STACK_MAX - there;
      if (room < units.length) return null;
      // standing at sea only with a ship under every walker: fine; standing on impassable land: no
      if (!mover.fly && !this.move.base.passable(goal)) return null;
    }
    // a city is attacked from whichever of its four tiles the route meets first
    const tcity = attack?.kind === 'city' ? this.cityAt(goal) : null;
    if (tcity) for (const t of tcity.tiles) blocked.delete(t);
    let path = this.move.findPath(mover, from, goal, blocked);
    if (!path) return null;
    if (tcity) {
      const i = path.tiles.findIndex((t) => tcity.tiles.includes(t));
      if (i > 0 && i < path.tiles.length - 1) {
        path = { tiles: path.tiles.slice(0, i + 1), costs: path.costs.slice(0, i + 1), total: path.costs.slice(1, i + 1).reduce((a, b) => a + b, 0) };
        attack.t = path.tiles[i];
      }
    }
    const turns = [];
    let turn = 0, left = mover.mp;
    const full = Math.min(...units.map((u) => maxMoves(u, units)));
    for (let i = 0; i < path.tiles.length; i++) {
      if (i > 0) {
        const c = path.costs[i];
        if (c > left + 1e-6) { turn++; left = full; }
        left -= c;
      }
      turns.push(turn);
    }
    return { path, mover, turns, attack };
  }

  /**
   * Moves `unitIds` (armies of the current player on one tile or in one city) along their
   * plan to `goal` as far as this turn's MP allow. Splits them off their stack, merges into
   * a friendly stack at the end, blesses at shrines and picks up items on the way.
   * Returns { stack, steps: [tiles walked, start first], arrived, attack (reached the foe and
   * may fight now), plan } or null.
   */
  moveUnits(unitIds, goal) {
    const units = this.unitsById(unitIds);
    if (!units.length) return null;
    const src = this.stackOfUnit(units[0].id);
    const from = src.t;
    const pl = this.plan(units, from, goal);
    if (!pl) return null;
    const { path, attack } = pl;
    const last = attack ? path.tiles.length - 2 : path.tiles.length - 1;
    let n = 0;
    let mp = Math.min(...units.map((u) => u.mp));
    const blocked = this.blockedFor(src.owner);
    while (n < last) {
      const c = path.costs[n + 1];
      if (c > mp + 1e-6) break;
      if (blocked.has(path.tiles[n + 1])) break;
      mp -= c;
      n++;
    }
    // never left midstream on a river voyage (paid in full when boarding): back to the bridge
    const midstream = (i) => path.afloat?.[i] && !this.move.isSea(path.tiles[i]);
    if (n < path.tiles.length - 1 && midstream(n)) while (n > 0 && midstream(n)) n--;
    // may not stop on a tile without room: step back to the last tile that has it
    const moving = new Set(unitIds);
    const roomAt = (t) => {
      if (t === from) return true;
      const city = this.cityAt(t);
      if (city) return (city.owner === src.owner || city.razed) && this.unitsIn(city).filter((u) => !moving.has(u.id)).length + units.length <= CITY_MAX;
      const k = this.stackAt(t);
      if (!pl.mover.fly && !this.move.base.passable(t)) return false;
      return !k || (k.owner === src.owner && k.units.length + units.length <= STACK_MAX);
    };
    while (n > 0 && !roomAt(path.tiles[n])) n--;
    if (n < path.tiles.length - 1) while (n > 0 && midstream(n)) n--;
    const steps = path.tiles.slice(0, n + 1);
    const spent = path.costs.slice(1, n + 1).reduce((a, b) => a + b, 0);
    for (const u of units) u.mp = Math.max(0, u.mp - spent);
    const end = steps[steps.length - 1];
    // split off, then land at the end
    let stack = src;
    if (!(units.length === src.units.length && src.units.every((u) => moving.has(u.id)))) {
      src.units = src.units.filter((u) => !moving.has(u.id));
      stack = { id: this.s.nextId++, owner: src.owner, t: from, units, path: null, defend: false, done: false };
      this.s.stacks.push(stack);
    }
    stack.defend = false;
    // a city garrison: gather the moving armies from every tile of the city into one group
    for (const k of [...this.s.stacks]) {
      if (k === stack) continue;
      const took = k.units.filter((u) => moving.has(u.id));
      if (!took.length) continue;
      k.units = k.units.filter((u) => !moving.has(u.id));
      stack.units.push(...took.filter((u) => !stack.units.includes(u)));
    }
    this.s.stacks = this.s.stacks.filter((k) => k.units.length);
    // shrines on the way bless; heroes pick up what lies on the ground
    for (const t of steps.slice(1)) this._pass(stack, t);
    stack.t = end;
    const arrived = !attack && end === goal;
    stack.path = arrived ? null : path.tiles.slice(n);
    let result = stack;
    if (end !== from) result = this._mergeAt(stack, end);
    // split off but could not take a step: outside a city it rejoins its group (one stack a tile)
    else if (stack !== src && !this.cityAt(from)) result = this._mergeAt(stack, from);
    this._explore(src.owner);
    const canAttack = !!attack && n === last && mp > 0;
    return { stack: result, steps, arrived, attack: canAttack ? attack : null, plan: pl, stoppedShort: !arrived && !canAttack };
  }

  /** A stack that ended its move on t joins the friendly stack there (inside a city, spilling across its tiles). */
  _mergeAt(stack, t) {
    const city = this.cityAt(t);
    const others = this.s.stacks.filter((k) => k !== stack && k.owner === stack.owner && (city ? city.tiles.includes(k.t) : k.t === t));
    if (!others.length) return stack;
    if (!city) {
      const k = others[0];
      if (k.units.length + stack.units.length <= STACK_MAX) {
        k.units.push(...stack.units);
        this.s.stacks = this.s.stacks.filter((x) => x !== stack);
        return k;
      }
      return stack;
    }
    // in a city every tile holds its own stack of up to eight
    const k = others.find((x) => x.t === t);
    if (k) {
      const room = STACK_MAX - k.units.length;
      if (room >= stack.units.length) { k.units.push(...stack.units); this.s.stacks = this.s.stacks.filter((x) => x !== stack); return k; }
      // move the whole group onto a free tile of the city if one is free
      const free = city.tiles.find((ct) => !this.stackAt(ct));
      if (free != null) stack.t = free;
      else {
        // squeeze: spread over the city
        const rest = stack.units;
        this.s.stacks = this.s.stacks.filter((x) => x !== stack);
        this.addUnits(t, stack.owner, rest);
        return this.stackAt(t);
      }
    }
    return stack;
  }

  _pass(stack, t) {
    const site = this.site(t);
    if (site?.kind === 'shrine') this._bless(stack, site);
    this._pickUp(stack, t);
    const q = this.s.quests[stack.owner];
    if (q && q.kind === 'visit' && q.t === t && stack.units.some((u) => u.id === q.hero)) this._questDone(stack.owner);
    if (q && q.kind === 'escort' && this.cityAt(t)?.id === q.city && stack.units.some((u) => u.id === q.hero)) this._questDone(stack.owner);
  }

  /** Items lying at tile t (a fallen hero's), or null. */
  groundAt(t) { return this.s.ground.find((x) => x.t === t) ?? null; }

  /** The stack's first hero takes up what lies at tile t. Returns the items taken, or null. */
  _pickUp(stack, t = stack.t) {
    const g = this.groundAt(t);
    const hero = stack.units.find((u) => u.hero);
    if (!g || !hero) return null;
    hero.hero.items.push(...g.items);
    this.note(`${hero.hero.name} picks up ${g.items.map((k) => ITEMS[k].name).join(', ')}.`, { t, kind: 'good', player: stack.owner });
    this.s.ground = this.s.ground.filter((x) => x !== g);
    this.emit('ground', { t });
    return g.items;
  }

  /** A hero of the stack stands where items lie (e.g. a comrade fell in the ruin there). */
  canPickUp(stack) { return !!stack && !!this.groundAt(stack.t) && stack.units.some((u) => u.hero); }
  pickUp(stack) { return this.canPickUp(stack) ? this._pickUp(stack) : null; }

  /** A hero fell at tile t: the items it carried stay on the ground there for another hero
   * to take up (Warlords). Returns { hero, items, t }, or null when it carried nothing. */
  _dropItems(hero, t, fell = true) {
    const items = hero.hero?.items ?? [];
    if (!items.length || t == null || t < 0) return null;
    hero.hero.items = [];
    const g = this.groundAt(t);
    if (g) g.items.push(...items); else this.s.ground.push({ t, items: [...items] });
    this.note(`The ${items.map((k) => ITEMS[k].name).join(', ')} of ${hero.hero.name} ${items.length === 1 ? 'lies' : 'lie'} ${fell ? 'where the hero fell' : 'on the ground, left behind'}.`, { t, kind: 'magic' });
    this.emit('ground', { t });
    return { hero: hero.id, items: [...items], t };
  }

  _bless(stack, site) {
    let n = 0;
    for (const u of stack.units) {
      if (u.blessed) continue;
      u.blessed = true; u.poisoned = false; u.diseased = false; u.paralysed = false;
      n++;
      if (u.hero) this.gainXp(u, 1);
    }
    if (n) {
      this.note(`The ${SiteTypes[site.type].name} blesses ${n} ${n === 1 ? 'army' : 'armies'} (+1 strength).`, { t: site.ty * this.W + site.tx, kind: 'good' });
      this.emit('bless', { stack, site });
    }
    if (site.type === 'obelisk') this.revealArea(stack.owner, site.ty * this.W + site.tx, 10);
  }

  // --- combat -----------------------------------------------------------------------------------
  /** Defenders of tile t: the whole city garrison, or the stack. */
  defendersAt(t) {
    const city = this.cityAt(t);
    if (city) return { units: this.unitsIn(city), city, owner: city.owner };
    const k = this.stackAt(t);
    return k ? { units: k.units, city: null, owner: k.owner, stack: k } : null;
  }

  battleContext(att, t) {
    const d = this.defendersAt(t);
    const boat = (pid) => (pid >= 0 ? BOATS[SIDES[pid].boat]?.str ?? 3 : 3);
    return {
      rng: () => this.rand(), dice: this.s.options.dice,
      fortify: d?.city ? CastleLevels[d.city.level]?.defense ?? 0 : 0,
      terrain: terrainBonusAt(this.map, t),
      attSea: this.move.isSea(att.t), defSea: this.move.isSea(t), attBoat: boat(att.owner), defBoat: boat(d?.owner ?? -1),
    };
  }

  /**
   * The group `stack` attacks tile t (adjacent). Fights, removes the dead, awards medals and
   * XP; a won city awaits the capture choice (captureCity). Returns
   * { result (combat.fight), att: units before, def: units before, city, won, captured }.
   */
  attack(stack, t) {
    const d = this.defendersAt(t);
    const target = d?.owner ?? this.cityAt(t)?.owner ?? -1;
    if (target !== stack.owner) this.diplo.onAttack(stack.owner, target);
    if (!d || !d.units.length) {
      // an empty enemy city: walk in
      const city = this.cityAt(t);
      if (city && city.owner !== stack.owner) return { result: null, att: stack.units, def: [], city, won: true, walkIn: true };
      return null;
    }
    const att = [...stack.units], def = [...d.units];
    const ctx = this.battleContext(stack, t);
    const result = fight(att, def, ctx);
    const byId = new Map([...att, ...def].map((u) => [u.id, u]));
    applyAftermath(result, byId);
    this.removeUnits([...result.attLost, ...result.defLost]);
    // fallen heroes leave their items where they fell (the victors advancing take them up)
    const dropped = [
      ...att.filter((u) => u.hero && result.attLost.includes(u.id)).map((u) => this._dropItems(u, stack.t)),
      ...def.filter((u) => u.hero && result.defLost.includes(u.id)).map((u) => this._dropItems(u, t)),
    ].filter(Boolean);
    const won = result.winner === 'att';
    const ap = this.player(stack.owner), dp = this.player(d.owner);
    if (ap) { ap.kills += result.defLost.length; ap.lost += result.attLost.length; }
    if (dp) { dp.kills += result.attLost.length; dp.lost += result.defLost.length; }
    // attacking costs what entering the defender's square would (Warlords); at sea, a sea step
    const enter = this.move.base.land[t];
    const cost = Number.isFinite(enter) ? enter : 2;
    for (const u of stack.units) u.mp = Math.max(0, u.mp - cost);
    // experience
    if (won) { for (const u of att) if (u.hero && !result.attLost.includes(u.id) && !d.city) this.gainXp(u, 1); }
    else for (const u of def) if (u.hero && !result.defLost.includes(u.id)) this.gainXp(u, 1);
    // quests: kills
    for (const [pid, lost] of [[stack.owner, result.defLost], [d.owner, result.attLost]]) {
      const q = this.s.quests[pid];
      if (q?.kind === 'kill') { q.done = (q.done ?? 0) + lost.length; if (q.done >= q.n) this._questDone(pid); }
    }
    const who = (pid) => (pid >= 0 ? this.player(pid)?.name ?? 'Neutral' : 'Neutral');
    const where = d.city ? d.city.name : 'the field';
    this.note(`${who(stack.owner)} ${won ? 'defeat' : 'are repulsed by'} ${who(d.owner)} at ${where} (${result.defLost.length} slain, ${result.attLost.length} lost).`, { t, kind: won ? 'battle' : 'bad', player: stack.owner });
    const out = { result, att, def, city: d.city, won, defender: d.owner, t, dropped };
    // the winners of a field battle advance into the square
    if (won && !d.city && this.stack(stack.id)) {
      const k = this.stack(stack.id);
      if (!this.stackAt(t)) { k.t = t; this._pass(k, t); }
    }
    this._checkAlive();
    this.emit('battle', out);
    return out;
  }

  /**
   * Takes a won city: 'occupy' | 'pillage' | 'sack' | 'raze'. The attacking stack moves in.
   * Returns { gold, city }.
   */
  captureCity(stack, city, choice = 'occupy') {
    const pid = stack.owner, p = this.player(pid);
    const prevOwner = city.owner;
    let gold = 0;
    const own = SIDES[pid].units;
    const foreign = city.prod.filter((u) => !own.includes(u));
    if (choice === 'raze' && this.s.hill?.city === city.id) choice = 'occupy'; // Utopia is not burnt
    this.diplo.onCapture(pid, prevOwner, choice === 'raze');
    if (choice === 'raze') {
      city.razed = true; city.owner = -1; city.prod = []; city.producing = null; city.vector = null;
      this.note(`${p.name} raze ${city.name} to the ground!`, { t: city.t, kind: 'battle' });
    } else {
      if (choice === 'pillage' && foreign.length) gold = foreign.reduce((n, k) => n + UNITS[k].cost, 0) * 0.5;
      if (choice === 'sack') gold = city.prod.reduce((n, k) => n + UNITS[k].cost, 0) * 0.6 + city.income * 4;
      gold = Math.round(gold);
      if (choice === 'pillage' || choice === 'sack') city.level = Math.max(1, city.level - (city.level > 1 ? 1 : 0));
      city.prod = choice === 'sack' ? [] : city.prod.filter((u) => own.includes(u));
      city.owner = pid;
      city.producing = city.prod[0] ?? null;
      city.progress = 0;
      city.vector = null;
      p.gold += gold;
      const verb = { occupy: 'occupy', pillage: 'pillage', sack: 'sack' }[choice];
      this.note(`${p.name} ${verb} ${city.name}${gold ? ` (+${gold} gold)` : ''}.`, { t: city.t, kind: 'battle' });
      // move in
      if (this.stack(stack.id)) {
        const k = this.stack(stack.id);
        k.t = city.tiles.find((t) => !this.stackAt(t)) ?? city.tiles[0];
        for (const u of k.units) if (u.hero) this.gainXp(u, 2);
        for (const t of city.tiles) this._pickUp(k, t); // what the fallen defenders left
      }
    }
    // quests
    for (const [qp, q] of Object.entries(this.s.quests)) {
      if (!q) continue;
      if (+qp === pid && q.kind === 'capture' && q.city === city.id && choice !== 'raze') this._questDone(pid);
      if (+qp === pid && q.kind === 'gold') { q.done = (q.done ?? 0) + gold; if (q.done >= q.n) this._questDone(pid); }
    }
    this.emit('captured', { city, owner: pid, prevOwner, choice, gold });
    this._explore(pid);
    this._checkAlive();
    this._checkFortress();
    return { gold, city, prevOwner };
  }

  /**
   * A side burns one of its own cities (Warlords III: raze any time — to deny it to an enemy).
   * Its armies stay in the ruins. Every other side frowns on it.
   */
  canRaze(city, pid = this.currentId) { return !!city && !city.razed && city.owner === pid && this.s.hill?.city !== city.id; }
  razeCity(city, pid = this.currentId) {
    if (!this.canRaze(city, pid)) return false;
    const p = this.player(pid);
    city.razed = true; city.owner = -1; city.prod = []; city.producing = null; city.progress = 0; city.vector = null;
    for (const c of this.s.cities) if (c.vector === city.id) c.vector = null;
    this.diplo.onRazeOwn(pid);
    this.note(`${p.name} put ${city.name} to the torch!`, { t: city.t, kind: 'battle', player: pid });
    this.emit('cityChanged', city);
    this.emit('razed', { city, owner: pid });
    this._checkAlive();
    return true;
  }

  _checkAlive() {
    for (const p of this.s.players) {
      if (!p.alive) continue;
      if (!this.citiesOf(p.id).length && !this.stacksOf(p.id).length) {
        p.alive = false;
        this.note(`${p.name} ${p.id === 6 ? 'are' : 'have been'} destroyed!`, { player: p.id, kind: 'battle' });
        this.emit('eliminated', p);
      }
    }
    if (this.s.over) return;
    const alive = this.s.players.filter((p) => p.alive);
    if (alive.length === 1) return this._win([alive[0].id], 'conquest');
    // allies left alone share the victory (Warlords III diplomacy)
    if (alive.length > 1 && alive.every((a) => alive.every((b) => a === b || this.diplo.allied(a.id, b.id)))) return this._win(alive.map((p) => p.id), 'allied');
    if (!alive.some((p) => p.human) && this.s.players.some((p) => p.human)) {
      const best = [...alive].sort((a, b) => this.score(b) - this.score(a))[0];
      this.s.over = true;
      this.s.winner = best?.id ?? null;
      this.s.winners = best ? [best.id] : [];
      this.emit('gameOver', { winner: best, winners: best ? [best] : [], humansLost: true, reason: 'conquest' });
    }
  }

  /** Ends the game: `pids` win (allies may share it). */
  _win(pids, reason) {
    if (this.s.over) return;
    this.s.over = true;
    this.s.winner = pids[0] ?? null;
    this.s.winners = [...pids];
    const winners = pids.map((id) => this.player(id));
    const text = {
      conquest: 'rule Etheria', allied: 'rule Etheria together', hill: `have held ${this.s.hill ? this.s.cities[this.s.hill.city].name : 'Utopia'} for ${HILL_DAYS} days`,
      fortress: 'hold every capital', surrender: 'accept the surrender of their foes', time: `lead when time runs out (${VICTORY[this.s.options.victory]?.name ?? ''})`,
    }[reason] ?? 'win';
    this.note(`${winners.map((p) => p.name).join(' and ')} ${text}!`, { player: pids[0], kind: 'good' });
    this.emit('gameOver', { winner: winners[0], winners, reason });
  }

  /** Victory points (Warlords III): a point per city and hero; gold 1 per 100 up to 500,
   * 1 more from 500 to 1000, then 1 per 1000 over 1000. */
  victoryPoints(pid) {
    const p = this.player(pid);
    const g = Math.max(0, p?.gold ?? 0);
    const gold = Math.min(5, Math.floor(g / 100)) + (g >= 1000 ? 1 : 0) + Math.max(0, Math.floor((g - 1000) / 1000));
    return this.citiesOf(pid).length + this.heroes(pid).length + gold;
  }

  /** The measure the chosen victory condition ranks sides by (Winners report, time limit). */
  score(p) {
    const v = this.s.options.victory;
    if (v === 'cities') return this.citiesOf(p.id).length * 1000 + this.victoryPoints(p.id);
    if (v === 'gold') return p.gold;
    if (v === 'hill' && this.s.hill && this.s.hill.holder === p.id) return 1e6 + (this.s.round - this.s.hill.since);
    if (v === 'fortress') return this.s.cities.filter((c) => c.capital && c.owner === p.id && !c.razed).length * 1000 + this.victoryPoints(p.id);
    return this.victoryPoints(p.id) * 10 + this.stacksOf(p.id).reduce((n, k) => n + k.units.length, 0) / 100;
  }

  _timeUp() {
    const best = this.s.players.filter((p) => p.alive).sort((a, b) => this.score(b) - this.score(a))[0];
    if (!best) { this.s.over = true; this.emit('gameOver', { winner: null, winners: [], reason: 'time' }); return; }
    this._win([best.id], 'time');
  }

  /** King of the Hill: at dawn, whoever holds Utopia counts toward victory. */
  _hillDay() {
    const hill = this.s.hill;
    if (!hill || this.s.options.victory !== 'hill') return;
    const c = this.s.cities[hill.city];
    const owner = c.razed ? -1 : c.owner;
    if (owner !== hill.holder) {
      hill.holder = owner;
      hill.since = this.s.round;
      if (owner >= 0) this.note(`${this.player(owner).name} seize ${c.name}! Hold it ${HILL_DAYS} days to win.`, { t: c.t, kind: 'battle', player: owner });
      return;
    }
    if (owner < 0) return;
    const left = this.hillDaysLeft();
    if (left <= 0) this._win([owner], 'hill');
    else this.note(`${this.player(owner).name} hold ${c.name}: ${left} day${left === 1 ? '' : 's'} to victory.`, { t: c.t, kind: 'battle', player: owner });
  }
  /** Days the holder of Utopia still needs (null: nobody holds it). */
  hillDaysLeft() {
    const hill = this.s.hill;
    if (!hill || hill.holder < 0) return null;
    return HILL_DAYS - (this.s.round - hill.since);
  }

  /** Fortress: the first side to hold every capital wins. */
  _checkFortress() {
    if (this.s.options.victory !== 'fortress' || this.s.over) return;
    const caps = this.s.cities.filter((c) => c.capital);
    if (caps.length < 2) return;
    const o = caps[0].owner;
    if (o >= 0 && caps.every((c) => c.owner === o && !c.razed)) this._win([o], 'fortress');
  }

  // --- surrender ------------------------------------------------------------------------------------
  /** Is computer side e beaten by human side pid (few cities, a fraction of the power)? */
  _beaten(e, pid) {
    const pc = this.citiesOf(pid).length, ec = this.citiesOf(e).length;
    return ec <= Math.max(2, Math.floor(pc / 4)) && this.diplo.power(e) * 3 < this.diplo.power(pid);
  }

  /**
   * Losing computer sides offer to surrender to a dominant human (Warlords): all together when
   * every foe left is beaten (accepting wins the game), else the weakest beaten foe alone.
   * Returns null or { sides: [ids], all }. Each side offers at most every 8 days.
   */
  surrenderOffer(pid) {
    const p = this.player(pid);
    if (!p?.human || !p.alive || this.s.over || this.s.round < 10) return null;
    const foes = this.s.players.filter((q) => q.alive && q.id !== pid && !this.diplo.allied(pid, q.id));
    if (!foes.length || foes.some((q) => q.human)) return null;
    const asked = this.s.surrenderAsked;
    const ready = (k) => (asked[k] ?? -99) + 8 <= this.s.round;
    // every foe beaten (at war or not): they give up together; one alone only when at war with pid
    const allBeaten = foes.every((q) => this._beaten(q.id, pid));
    const beaten = foes.filter((q) => this._beaten(q.id, pid) && this.diplo.atWar(pid, q.id));
    if (allBeaten && ready('all')) { asked.all = this.s.round; for (const q of foes) asked[q.id] = this.s.round; return { sides: foes.map((q) => q.id), all: true }; }
    const one = beaten.filter((q) => ready(q.id)).sort((a, b) => this.diplo.power(a.id) - this.diplo.power(b.id))[0];
    if (!one) return null;
    asked[one.id] = this.s.round;
    return { sides: [one.id], all: false };
  }

  /** pid accepts the surrender of `sides`: their cities and armies pass to pid. */
  acceptSurrender(pid, sides) {
    const p = this.player(pid);
    const own = SIDES[pid].units;
    for (const e of sides) {
      const q = this.player(e);
      if (!q?.alive) continue;
      for (const c of this.citiesOf(e)) {
        c.owner = pid;
        c.prod = c.prod.filter((u) => own.includes(u));
        c.producing = c.prod[0] ?? null; c.progress = 0; c.vector = null;
      }
      for (const k of this.stacksOf(e)) { k.owner = pid; k.path = null; for (const u of k.units) if (u.hero) u.hero.quest = null; }
      this.s.pending = this.s.pending.filter((v) => v.owner !== e);
      this.s.quests[e] = null;
      q.alive = false;
      this.note(`${q.name} surrender to ${p.name}; their cities and armies now serve ${p.name}.`, { player: e, kind: 'battle' });
      this.emit('eliminated', q);
    }
    this.emit('surrender', { pid, sides });
    const alive = this.s.players.filter((x) => x.alive);
    if (alive.every((x) => x.id === pid || this.diplo.allied(pid, x.id))) this._win(alive.map((x) => x.id), alive.length > 1 ? 'allied' : 'surrender');
    else { this._checkAlive(); this._checkFortress(); }
  }

  // --- heroes -----------------------------------------------------------------------------------
  gainXp(u, xp, silent = false) {
    const h = u.hero;
    if (!h) return;
    h.xp += xp;
    const lv = levelForXp(h.cls, h.xp);
    while (h.level < lv) {
      h.level++;
      h.ap += HERO_CLASSES[h.cls].levels[h.level - 1].ap;
      if (!silent) {
        this.note(`${h.name} rises to level ${h.level}: ${HERO_CLASSES[h.cls].levels[h.level - 1].title}!`, { t: this.stackOfUnit(u.id)?.t ?? -1, kind: 'good', player: this.stackOfUnit(u.id)?.owner });
        this.emit('levelUp', { unit: u });
      }
    }
    // AI heroes (and silently created ones) spend their points at once
    const owner = this.stackOfUnit(u.id)?.owner;
    if (silent || (owner != null && !this.player(owner)?.human)) this.autoSpend(u);
  }

  /** Whether the ability on level row `index` is open to the hero: spells from their level on,
   * attributes at any level (only their AP cost holds them back). */
  abilityOpen(u, index) {
    const l = HERO_CLASSES[u.hero.cls].levels[index];
    return !!l && (!l.ability.spell || index < u.hero.level);
  }

  /** Abilities a hero may buy now: [{ index, ability, cost }] (open, not bought). */
  buyable(u) {
    const h = u.hero, cls = HERO_CLASSES[h.cls];
    return cls.levels.map((l, i) => ({ index: i, ability: l.ability, cost: l.cost, title: l.title }))
      .filter((x) => this.abilityOpen(u, x.index) && !h.bought.includes(x.index));
  }

  buyAbility(u, index) {
    const h = u.hero, cls = HERO_CLASSES[h.cls];
    const l = cls.levels[index];
    if (!this.abilityOpen(u, index) || h.bought.includes(index) || h.ap < l.cost) return false;
    h.ap -= l.cost;
    h.bought.push(index);
    if (l.ability.spell && !h.spells.includes(l.ability.spell)) h.spells.push(l.ability.spell);
    const k = this.stackOfUnit(u.id);
    if (l.ability.stat === 'move' && k) u.mp += l.ability.n;
    return true;
  }

  autoSpend(u) {
    let again = true;
    while (again) {
      again = false;
      const opts = this.buyable(u).filter((x) => x.cost <= u.hero.ap).sort((a, b) => a.index - b.index);
      if (opts.length) again = this.buyAbility(u, opts[0].index);
    }
  }

  /** Takes an offer: a hero (and allies), mercenaries, or a merchant's item (for hero `heroId`,
   * else the side's most experienced hero). */
  acceptOffer(id, heroId = null) {
    const o = this.s.offers.find((x) => x.id === id);
    const p = this.current;
    if (!o || p.gold < o.cost) return null;
    if (o.kind === 'item') {
      const heroes = this.heroes(p.id);
      const hero = heroes.find((u) => u.id === heroId) ?? heroes.sort((a, b) => b.hero.xp - a.hero.xp)[0];
      if (!hero) return null;
      p.gold -= o.cost;
      this.s.offers = this.s.offers.filter((x) => x !== o);
      hero.hero.items.push(o.item);
      this.note(`${hero.hero.name} buys the ${ITEMS[o.item].name} from a merchant for ${o.cost} gold.`, { t: this.stackOfUnit(hero.id)?.t ?? -1, kind: 'good' });
      this.emit('bought', { hero, item: o.item });
      return { hero, item: o.item, units: [] };
    }
    const offered = o.city != null ? this.s.cities[o.city] : null;
    const city = (offered?.owner === p.id && !offered.razed ? offered : null)
      ?? this.s.cities.find((c) => c.owner === p.id && c.capital && !c.razed) ?? this.citiesOf(p.id)[0];
    if (!city) return null;
    p.gold -= o.cost;
    this.s.offers = this.s.offers.filter((x) => x !== o);
    let units;
    if (o.kind === 'hero') {
      const hero = this.newHero(o.cls, o.level);
      if (p.human) hero.hero.fresh = true;
      units = [hero, ...o.allies.map((a) => this.newUnit(a))];
      p.heroesHired++;
      this.note(`${hero.hero.name} the ${HERO_CLASSES[o.cls].name} joins ${p.name} at ${city.name}${o.allies.length ? `, bringing ${o.allies.length} ${UNITS[o.allies[0]].name}` : ''}.`, { t: city.t, kind: 'good' });
    } else {
      units = Array.from({ length: o.n }, () => this.newUnit(o.type));
      this.note(`${o.n} ${UNITS[o.type].name} hire on at ${city.name}.`, { t: city.t, kind: 'good' });
    }
    for (const u of units) u.mp = maxMoves(u, units);
    const stacks = this.addUnits(city.tiles[0], p.id, units);
    this.emit('joined', { city, units, stacks });
    return { city, units };
  }

  /** Heroes of player `pid` still waiting to be announced and named: [unit]. */
  freshHeroes(pid) { return this.heroes(pid).filter((u) => u.hero.fresh); }

  /** Names a hero (a new one is announced once: `fresh` is cleared). Empty names keep the old one. */
  renameHero(u, name) {
    if (!u?.hero) return false;
    const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, HERO_NAME_MAX);
    delete u.hero.fresh;
    if (!n || n === u.hero.name) return false;
    u.hero.name = n;
    return true;
  }

  /** A hero name not yet borne by any living hero. */
  randomHeroName() {
    const used = new Set(this.s.stacks.flatMap((k) => k.units.filter((u) => u.hero).map((u) => u.hero.name)));
    const names = HERO_NAMES.filter((n) => !used.has(n));
    return this.pick(names.length ? names : HERO_NAMES);
  }

  declineOffer(id) { this.s.offers = this.s.offers.filter((x) => x.id !== id); }

  // --- ruins --------------------------------------------------------------------------------------
  /** Can this stack search the ruin it stands on? */
  canSearch(stack) {
    const site = this.site(stack.t);
    return !!site && site.kind === 'ruin' && !site.state.explored && stack.units.some((u) => u.hero) && stack.owner === this.currentId;
  }

  /**
   * The stack's hero searches the ruin under it: the hero faces the guardians alone (or they join
   * the group); a won ruin yields gold, an item, allies, mana or a sage's gem.
   * Returns { guardians, battle (combat result + att/def), won, joined, reward: { kind, ... } }.
   */
  search(stack) {
    if (!this.canSearch(stack)) return null;
    const site = this.site(stack.t);
    const hero = stack.units.find((u) => u.hero);
    const p = this.player(stack.owner);
    const danger = site.danger ?? 1;
    const gtype = this.pick(GUARDIANS[danger]);
    const n = danger === 3 ? 1 : this.rint(1, danger);
    const guardians = Array.from({ length: n }, () => this.newUnit(gtype));
    const out = { guardians, site, hero, won: false, joined: false, reward: null };
    for (const u of stack.units) u.mp = 0;
    if (UNITS[gtype].str >= JOIN_MIN_STR && this.rand() < RUIN_JOIN) {
      // friendly monsters: the guardians would rather join the hero than fight
      out.won = true; out.joined = true;
      const room = STACK_MAX - stack.units.length;
      const allies = guardians.slice(0, room);
      if (allies.length) { for (const a of allies) a.mp = 0; stack.units.push(...allies); }
      else this.addUnits(stack.t, stack.owner, guardians);
      out.reward = { kind: 'allies', type: gtype, n: guardians.length };
    } else {
      // the hero goes in alone, backed by the group's strength; the group waits outside, safe
      const result = ruinDuel(hero, guardians, danger, { rng: () => this.rand(), group: stack.units });
      this.removeUnits(result.attLost);
      out.battle = { result, att: [hero], def: guardians, t: stack.t, attOwner: stack.owner };
      out.chance = result.chance;
      out.won = result.winner === 'att';
      if (!out.won) {
        this.note(`${hero.hero.name} is slain by the ${UNITS[gtype].name} of ${site.name}.`, { t: stack.t, kind: 'bad' });
        out.dropped = [this._dropItems(hero, stack.t)].filter(Boolean);
        this.emit('search', out);
        this._checkAlive();
        return out;
      }
      out.reward = this._ruinReward(stack, danger);
    }
    site.state.explored = true;
    const alive = this.unit(hero.id);
    if (alive) this.gainXp(alive, 3);
    const q = this.s.quests[stack.owner];
    if (q?.kind === 'ruin' && q.site === site.i) this._questDone(stack.owner);
    this.note(`${hero.hero.name} searches ${site.name}: ${describeReward(out.reward)}.`, { t: stack.t, kind: 'good' });
    this.emit('search', out);
    this._checkAlive();
    void p;
    return out;
  }

  _ruinReward(stack, danger) {
    const p = this.player(stack.owner);
    const hero = stack.units.find((u) => u.hero);
    const r = this.rand();
    if (r < 0.34) {
      const gold = this.rint(1, 4) * 100 * danger + this.rint(0, 9) * 10;
      p.gold += gold;
      return { kind: 'gold', gold };
    }
    if (r < 0.72) {
      const tier = Math.min(3, danger === 3 ? this.rint(2, 3) : this.rint(1, danger));
      const item = this.pick(ITEMS_BY_TIER[tier - 1]);
      if (hero) hero.hero.items.push(item);
      return { kind: 'item', item };
    }
    if (r < 0.86) {
      const side = SIDES[stack.owner];
      const type = side.allies[Math.min(3, this.rint(0, danger))];
      const n = type.includes('dragon') ? 1 : this.rint(1, 2);
      const allies = Array.from({ length: n }, () => this.newUnit(type, { mp: 0 }));
      const room = STACK_MAX - stack.units.length;
      stack.units.push(...allies.slice(0, room));
      if (allies.length > room) this.addUnits(stack.t, stack.owner, allies.slice(room));
      return { kind: 'allies', type, n };
    }
    if (r < 0.94) {
      p.mana += 5 * danger;
      const c = this._nearestCity(stack.t, (c) => c.owner === p.id);
      if (c) c.mana += 1;
      return { kind: 'mana', mana: 5 * danger };
    }
    const gold = 250 * danger;
    p.gold += gold;
    this.revealArea(p.id, stack.t, 12);
    return { kind: 'sage', gold };
  }

  // --- spells --------------------------------------------------------------------------------------
  /** Spells a hero may cast now: [{ id, spell, ok, why }]. */
  castable(u) {
    const p = this.player(this.stackOfUnit(u.id)?.owner);
    return u.hero.spells.map((id) => {
      const sp = SPELLS[id];
      const active = u.hero.active.includes(id);
      const ok = !active && p.mana >= sp.cost && (id !== 'teleport' || this.citiesOf(p.id).length > 0);
      return { id, spell: sp, ok, active, why: active ? 'in play' : p.mana < sp.cost ? 'not enough mana' : '' };
    });
  }

  /**
   * The hero casts spell `id`. `target`: city id for Teleport. Returns { spell, stack, summoned,
   * teleport: { from, to }, item, revealed } or null.
   */
  cast(u, id, target = null) {
    const sp = SPELLS[id];
    const stack = this.stackOfUnit(u.id);
    const p = this.player(stack.owner);
    if (!sp || !u.hero.spells.includes(id) || p.mana < sp.cost || u.hero.active.includes(id)) return null;
    p.mana -= sp.cost;
    const out = { spell: id, stack, hero: u, from: stack.t };
    if (sp.kind === 'buff' || sp.kind === 'curse') {
      u.hero.active.push(id);
      if (sp.fx.move) for (const x of stack.units) x.mp += sp.fx.move;
    } else if (sp.kind === 'summon') {
      const units = [];
      for (const [type, a, b] of sp.summon) {
        const n = this.rint(a, b);
        for (let i = 0; i < n; i++) units.push(this.newUnit(type));
      }
      for (const x of units) x.mp = 0;
      out.summoned = units;
      out.stacks = this.addUnits(stack.t, stack.owner, units);
    } else if (id === 'teleport') {
      const city = target != null ? this.s.cities[target] : this.citiesOf(p.id)[0];
      if (!city || city.owner !== p.id) { p.mana += sp.cost; return null; }
      const room = CITY_MAX - this.unitsIn(city).length;
      if (room < stack.units.length) { p.mana += sp.cost; return null; }
      out.teleport = { from: stack.t, to: city.id };
      const units = stack.units;
      this.s.stacks = this.s.stacks.filter((k) => k !== stack);
      const st = this.addUnits(city.tiles.find((t) => !this.stackAt(t)) ?? city.tiles[0], p.id, units);
      out.stack = st[0];
      out.to = out.stack.t;
    } else if (id === 'augury') {
      this.revealArea(p.id, stack.t, 14);
      out.revealed = true;
    } else if (id === 'summonitem') {
      const item = this.pick(ITEMS_BY_TIER[this.rand() < 0.7 ? 0 : 1]);
      u.hero.items.push(item);
      out.item = item;
    }
    this.note(`${u.hero.name} casts ${sp.name}${out.summoned ? `: ${out.summoned.length} ${UNITS[out.summoned[0]?.type]?.name ?? ''} answer the call` : ''}${out.item ? `: ${ITEMS[out.item].name} appears` : ''}.`, { t: stack.t, kind: 'magic' });
    this.emit('cast', out);
    return out;
  }

  cancelSpell(u, id) { u.hero.active = u.hero.active.filter((x) => x !== id); }

  // --- cities ----------------------------------------------------------------------------------------
  setProduction(city, type) {
    if (type && !city.prod.includes(type)) return false;
    if (city.producing !== type) city.progress = 0;
    city.producing = type;
    return true;
  }

  /** Types the city's owner could buy the capacity to produce there. */
  buyableProduction(city) {
    return SIDES[city.owner]?.units.filter((u) => !city.prod.includes(u)) ?? [];
  }

  buyProduction(city, type, replace = null) {
    const p = this.player(city.owner);
    const cost = UNITS[type].cost;
    if (!p || p.gold < cost || city.prod.includes(type)) return false;
    if (city.prod.length >= 4) {
      const r = replace ?? city.prod[0];
      city.prod = city.prod.filter((x) => x !== r);
      if (city.producing === r) city.producing = null;
    }
    p.gold -= cost;
    city.prod.push(type);
    city.producing = type;
    city.progress = 0;
    this.note(`${city.name} can now train ${UNITS[type].name}.`, { t: city.t });
    return true;
  }

  /** Gold to raise the city one level (engineers in its garrison cut the price). */
  buildCost(city) {
    const eng = Math.min(9, this.unitsIn(city).reduce((n, u) => n + (u.hero ? stackEffects([u]).engineer : 0), 0));
    const base = city.razed ? REBUILD_COST : BUILD_COST[city.level] ?? Infinity;
    return Math.round(base * (1 - eng / 10));
  }

  buildUp(city, pid = this.currentId) {
    const p = this.player(pid);
    const cost = this.buildCost(city);
    if (!p || p.gold < cost) return false;
    if (city.razed) {
      if (!this.garrison(city).some((k) => k.owner === pid)) return false;
      city.razed = false; city.owner = pid; city.level = 1; city.prod = SIDES[pid].units.slice(0, 1); city.producing = city.prod[0];
    } else {
      if (city.owner !== pid || city.level >= 3) return false;
      city.level++;
      city.income += 5;
    }
    p.gold -= cost;
    this.note(`${city.name} is raised to a ${CastleLevels[city.level].name}.`, { t: city.t, kind: 'good' });
    this.emit('cityChanged', city);
    return true;
  }

  setVector(city, target) { city.vector = target == null ? null : target.id; }

  /** Turns the vectoring network takes between two cities: two, or with timed vectoring
   * two to five by distance (a quarter of the map's breadth per extra turn). */
  vectorTurns(from, to) {
    if (!this.s.options.timedVectoring || !from || !to) return 2;
    const span = Math.max(this.W, this.H) / 4;
    return 2 + Math.min(3, Math.floor(this.move.distance(from.t, to.t) / span));
  }

  /** Sends armies along the vectoring network to a friendly city: they arrive in vectorTurns. */
  vectorUnits(unitIds, target) {
    const units = this.unitsById(unitIds);
    const k = this.stackOfUnit(unitIds[0]);
    const from = k ? this.cityAt(k.t) : null;
    if (!units.length || !k || target.owner !== k.owner || !from) return false;
    const turns = this.vectorTurns(from, target);
    this.removeUnits(unitIds);
    this.s.pending.push({ owner: k.owner, units, city: target.id, from: from.id, round: this.s.round + turns });
    this.note(`${units.length} ${units.length === 1 ? 'army sets' : 'armies set'} off for ${target.name} (${turns} turns).`, { t: k.t });
    return true;
  }

  /** Armies on the vectoring network bound for a city: [{ n, round, from }]. */
  incoming(city) { return this.s.pending.filter((v) => v.city === city.id).map((v) => ({ n: v.units.length, round: v.round, from: v.from })); }

  disband(unitIds) {
    const units = this.unitsById(unitIds);
    const t = this.stackOfUnit(unitIds[0])?.t;
    for (const u of units) if (u.hero) this._dropItems(u, t, false);
    this.removeUnits(unitIds);
    this._checkAlive();
    return units;
  }

  // --- quests ------------------------------------------------------------------------------------------
  /** A hero in one of its side's cities asks for a quest: 'easy' | 'average' | 'hard'. */
  getQuest(u, difficulty = 'easy') {
    const stack = this.stackOfUnit(u.id);
    const pid = stack.owner, p = this.player(pid);
    const city = this.cityAt(stack.t);
    if (!this.s.options.quests || !city || city.owner !== pid || this.s.quests[pid] || p.questWait > 0) return null;
    const allowed = { 1: ['easy'], 2: ['easy', 'average'], 3: ['easy', 'average', 'hard'] }[city.level];
    if (!allowed.includes(difficulty)) difficulty = allowed[allowed.length - 1];
    const far = { easy: 18, average: 30, hard: 999 }[difficulty];
    const near = (t) => this.move.distance(t, stack.t) <= far;
    const options = [];
    const ruins = this.map.sites.map((s, i) => ({ s, i })).filter(({ s, i }) => s.kind === 'ruin' && !this.s.sites[i].explored && near(s.ty * this.W + s.tx));
    if (ruins.length) { const r = this.pick(ruins); options.push({ kind: 'ruin', site: r.i, t: r.s.ty * this.W + r.s.tx, text: `Search ${r.s.name}` }); }
    const foes = this.s.cities.filter((c) => c.owner !== pid && !c.razed && near(c.t) && (difficulty !== 'easy' || c.owner < 0));
    if (foes.length) { const c = this.pick(foes); options.push({ kind: 'capture', city: c.id, t: c.t, text: `Capture ${c.name}` }); }
    const shrines = this.map.sites.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === 'shrine' && near(s.ty * this.W + s.tx));
    if (shrines.length && difficulty === 'easy') { const r = this.pick(shrines); options.push({ kind: 'visit', t: r.s.ty * this.W + r.s.tx, text: `Carry a gift to ${r.s.name}` }); }
    const owned = this.citiesOf(pid).filter((c) => c !== city);
    if (owned.length && difficulty === 'easy') { const c = owned.reduce((a, b) => (this.move.distance(b.t, stack.t) > this.move.distance(a.t, stack.t) ? b : a)); options.push({ kind: 'escort', city: c.id, t: c.t, text: `Escort a messenger to ${c.name}` }); }
    const n = { easy: 3, average: this.rint(10, 20), hard: this.rint(20, 40) }[difficulty];
    options.push({ kind: 'kill', n, text: `Slay ${n} enemy armies` });
    if (difficulty !== 'easy') { const g = difficulty === 'average' ? this.rint(6, 12) * 100 : this.rint(12, 20) * 100; options.push({ kind: 'gold', n: g, text: `Win ${g} gold by pillage or sack` }); }
    const q = { ...this.pick(options), hero: u.id, difficulty, round: this.s.round, done: 0 };
    this.s.quests[pid] = q;
    u.hero.quest = q.text;
    this.note(`${u.hero.name} accepts a quest: ${q.text}.`, { t: stack.t, kind: 'magic' });
    return q;
  }

  /** How far along `pid`'s quest is: { text, done, n (counted quests), dist (tiles to the goal), days }. */
  questProgress(pid) {
    const q = this.s.quests[pid];
    if (!q) return null;
    const u = this.unit(q.hero);
    const at = u ? this.stackOfUnit(u.id)?.t : null;
    const days = this.s.round - q.round;
    const out = { text: q.text, difficulty: q.difficulty, days, t: q.t ?? null, n: q.n ?? null, done: q.done ?? 0, dist: null };
    if (q.t != null && at != null) out.dist = this.move.distance(at, q.t);
    const where = q.t != null ? (this.cityAt(q.t)?.name ?? this.site(q.t)?.name) : null;
    if (q.kind === 'kill') out.status = `${out.done} of ${q.n} enemy armies slain`;
    else if (q.kind === 'gold') out.status = `${out.done} of ${q.n} gold won`;
    else if (q.kind === 'capture') {
      const c = this.s.cities[q.city];
      out.status = `${c.name} is held by ${c.owner < 0 ? 'neutrals' : this.player(c.owner).name}`;
    } else out.status = `Not yet ${q.kind === 'ruin' ? 'searched' : 'reached'}${where ? ` — ${where}` : ''}`;
    if (out.dist != null) out.status += ` · ${out.dist === 0 ? 'here' : `${out.dist} tiles away`}`;
    return out;
  }

  abandonQuest(pid) {
    const q = this.s.quests[pid];
    if (!q) return;
    const u = this.unit(q.hero);
    if (u) u.hero.quest = null;
    this.s.quests[pid] = null;
    this.player(pid).questWait = 2;
  }

  _checkQuest(pid) {
    const q = this.s.quests[pid];
    if (!q) return;
    const u = this.unit(q.hero);
    const gone = !u || (q.kind === 'ruin' && this.s.sites[q.site].explored) || (q.kind === 'capture' && this.s.cities[q.city].razed);
    if (gone) { this.note('A quest can no longer be completed.', { player: pid }); this.s.quests[pid] = null; if (u) u.hero.quest = null; }
  }

  _questDone(pid) {
    const q = this.s.quests[pid];
    if (!q) return;
    const u = this.unit(q.hero);
    this.s.quests[pid] = null;
    if (!u) return;
    u.hero.quest = null;
    const p = this.player(pid);
    const stack = this.stackOfUnit(u.id);
    this.gainXp(u, QUEST_XP[q.difficulty]);
    const r = this.rand();
    let reward;
    const dif = q.difficulty;
    if (r < 0.3) { const g = { easy: this.rint(100, 200), average: this.rint(500, 1000), hard: this.rint(1200, 2400) }[dif]; p.gold += g; reward = `${g} gold`; }
    else if (r < 0.6) { const item = this.pick(ITEMS_BY_TIER[{ easy: 0, average: this.rint(0, 1), hard: this.rint(1, 2) }[dif]]); u.hero.items.push(item); reward = ITEMS[item].name; }
    else if (r < 0.85) {
      const side = SIDES[pid];
      const type = side.allies[{ easy: 0, average: this.rint(0, 2), hard: this.rint(1, 3) }[dif]];
      const n = { easy: 1, average: this.rint(1, 4), hard: this.rint(4, 7) }[dif];
      const allies = Array.from({ length: n }, () => this.newUnit(type, { mp: 0 }));
      this.addUnits(stack.t, pid, allies);
      reward = `${n} ${UNITS[type].name}`;
    } else { const ap = { easy: 1, average: 1, hard: this.rint(2, 4) }[dif]; u.hero.ap += ap; reward = `${ap} ability point${ap > 1 ? 's' : ''}`; }
    this.note(`${u.hero.name} completes the quest "${q.text}" and is rewarded with ${reward}!`, { t: stack.t, kind: 'good', player: pid });
    this.emit('questDone', { unit: u, quest: q, reward });
  }
}

export function describeReward(r) {
  if (!r) return 'nothing';
  switch (r.kind) {
    case 'gold': return `${r.gold} gold pieces`;
    case 'item': return `the ${ITEMS[r.item].name}`;
    case 'allies': return `${r.n} ${UNITS[r.type].name} join the party`;
    case 'mana': return `a mana crystal (+${r.mana} mana)`;
    case 'sage': return `a sage reveals the land and gives a gem worth ${r.gold} gold`;
    default: return 'nothing';
  }
}

export { unitPower, leaderOf, unitName };
