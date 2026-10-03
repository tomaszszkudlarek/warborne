import * as THREE from 'three';
import { Game } from '../game/Game.js';
import { Commander } from '../game/commands.js';
import { AIPlayer } from '../game/ai.js';
import { odds } from '../game/combat.js';
import { STACK_MAX, unitPower, unitName } from '../game/rules.js';
import { SIDES } from '../game/data/sides.js';
import { UNITS } from '../game/data/units.js';
import { SPELLS } from '../game/data/spells.js';
import { HERO_CLASSES } from '../game/data/heroes.js';
import { ITEMS } from '../game/data/items.js';
import { GameView } from './GameView.js';
import { Hud } from './hud.js';
import { Portraits } from './portraits.js';
import { showBattle } from './battle.js';
import { h, ask, toast, banner, sleep, dialogOpen, closeTopDialog, closeAllDialogs, singular, withArticle } from './dom.js';
import { levelUpShow } from './levelup.js';
import {
  cityDialog, heroDialog, castDialog, teleportDialog, captureDialog, searchDialog, offersDialog,
  vectorDialog, vectoringDialog, reportsDialog, stackInfoDialog, gameOverDialog, heroEmergesDialog, proposalDialog, surrenderDialog,
  beginDialog, heroFallenDialog,
} from './dialogs.js';
import { standing } from '../game/diplomacy.js';
import { SPECIAL_TYPES } from '../game/specials.js';
import { saveGame, downloadSave } from './storage.js';
import { art } from './art.js';
import { Tile } from '../generator/terrainTypes.js';
import { music } from './music.js';

// Game day/night speed (game hours per real second) — user's setting.
export const DAY_SPEED = 0.03;
// Every game begins at dawn (hour on the sky clock) — user's setting.
export const GAME_DAWN = 6;
// How much faster other sides' armies march on screen than the player's (user: 30% slower than 2.6).
export const ENEMY_MARCH_SPEED = 1.82;
// End Turn ignores clicks this long (ms) after a turn opens or a group is handed back (double clicks, lag).
const END_TURN_GUARD = 800;
const CAPTURE_DELAY = 1000; // ms after the battle screen closes before a taken castle is announced (user)
// A click on a castle opens the city only this close to its middle (in tiles); elsewhere it takes the stack in that corner.
const CITY_CLICK = 0.42;
/** "Only near me": enemy marches within this many tiles of the viewer's armies or cities are shown (user). */
const NEAR_WATCH = 20;
// palette order: heroes first, then the strongest
const byRank = (units) => [...units].sort((a, b) => (b.hero ? 1 : 0) - (a.hero ? 1 : 0) || unitPower(b) - unitPower(a));
// Context cursors (SVG, drawn on a dark outline so they read on any ground).
const svgCursor = (body, x, y, fallback) => `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><g stroke='#1a0d06' stroke-width='1.2' stroke-linejoin='round'>${body}</g></svg>`,
)}") ${x} ${y}, ${fallback}`;
const CURSORS = {
  // a right click would attack this turn: crossed swords
  attack: svgCursor(
    `<path d='M4 3 L7 3 L22 18 L20 20 L5 6 Z' fill='#e8ecf2'/><path d='M28 3 L25 3 L10 18 L12 20 L27 6 Z' fill='#e8ecf2'/>`
    + `<path d='M17 21 L22 16 L24 18 L19 23 Z M15 21 L10 16 L8 18 L13 23 Z' fill='#d9a54a'/>`
    + `<path d='M21 22 L25 26 L27 24 L23 20 Z M11 22 L7 26 L5 24 L9 20 Z' fill='#7a3a1c'/>`
    + `<circle cx='26.5' cy='26.5' r='2' fill='#d9a54a'/><circle cx='5.5' cy='26.5' r='2' fill='#d9a54a'/>`, 16, 14, 'crosshair'),
  // a left click takes one of your armies: a gold arrow with a pennant
  select: svgCursor(
    `<path d='M3 2 L3 24 L9 18.5 L13 27 L17 25.2 L13 16.8 L20.5 16.5 Z' fill='#e9c46a'/>`
    + `<path d='M22 4 L22 15' fill='none' stroke-width='1.6'/><path d='M22.6 4.5 L30 7 L22.6 9.5 Z' fill='#b3261e'/>`, 3, 2, 'pointer'),
  // a left click opens a castle
  city: svgCursor(
    `<path d='M5 29 L5 11 L3 11 L3 6 L7 6 L7 8 L9 8 L9 6 L13 6 L13 11 L11 11 L11 14 L21 14 L21 11 L19 11 L19 6 L23 6 L23 8 L25 8 L25 6 L29 6 L29 11 L27 11 L27 29 Z' fill='#cdbb95'/>`
    + `<path d='M13 29 L13 22 A3 3 0 0 1 19 22 L19 29 Z' fill='#4a2a14'/><path d='M16 3 L16 12' fill='none'/><path d='M16.5 3.3 L22 5 L16.5 6.7 Z' fill='#e9c46a'/>`, 16, 17, 'pointer'),
  // a right click sends the group there: a banner planted at the goal
  move: svgCursor(
    `<path d='M6.5 30 L6.5 3' fill='none' stroke='#1a0d06' stroke-width='3.2'/><path d='M6.5 30 L6.5 3' fill='none' stroke='#d9a54a' stroke-width='1.4'/>`
    + `<path d='M7.5 4 L26 4 L22 9.5 L26 15 L7.5 15 Z' fill='#e9c46a'/><ellipse cx='6.5' cy='29.5' rx='4' ry='1.6' fill='#1a0d06' stroke='none' opacity='0.55'/>`, 6, 29, 'pointer'),
  // a click shows another side's army or city
  look: svgCursor(
    `<circle cx='12' cy='12' r='8.5' fill='rgba(233,196,106,0.25)' stroke-width='3.4'/><circle cx='12' cy='12' r='8.5' fill='none' stroke='#e9c46a' stroke-width='1.6'/>`
    + `<path d='M18.5 18.5 L28 28' stroke-width='5' stroke-linecap='round'/><path d='M18.5 18.5 L28 28' stroke='#8a5a2b' stroke-width='2.6' stroke-linecap='round'/>`, 12, 12, 'help'),
};

/**
 * Runs a game: the turn loop (human turns wait for End Turn, computer turns play out on the
 * map), input, camera, and every screen the game shows.
 */
export class Controller {
  constructor(env) {
    Object.assign(this, env); // renderer, scene, camera, controls, sky, weather, world, post, labelGroup
    this.game = null;
    this.portraits = new Portraits(this.renderer, () => this.view.models);
    this.view = new GameView({ scene: this.scene, camera: this.camera, world: this.world, labelParent: this.labelGroup });
    this.view.portraits = this.portraits;
    this.portraits.onReady(() => this.view.refreshPortraits());
    this.hud = new Hud(this);
    this.hud.show(false);
    this.sel = null;
    this.human = false; // a human is giving orders now
    this.busy = false; // an order is playing out
    this.viewer = null;
    this.hoverTile = -1;
    this.hoverPlan = null;
    this.mouse = new THREE.Vector2(9, 9);
    this.mouseDirty = false;
    this.raycaster = new THREE.Raycaster();
    this.camGoal = null;
    this.onQuit = null;
    // What the game reports while an order plays out (blessings, level-ups, the log, newly
    // seen land) waits for the 3D view to catch up: it shows as the marching army reaches
    // the tile, or once the march / battle / search on screen is over.
    this.fxHold = 0;
    this.fxQueue = []; // [{ t (tile, -1: when the step is over), fn }]
    this.hoverIcon = h('div#hovericon');
    document.body.append(this.hoverIcon);
    this._bindInput();
  }

  // --- game lifecycle -------------------------------------------------------------------------------
  /** Plays `state` on `map` (the world must be built from `map`). */
  async start(map, state, onProgress) {
    this.stop();
    const g = new Game(map, state);
    this.game = g;
    this.cmd = new Commander(g, this._hooks());
    g.on('log', (e) => this._later(e.t, () => this._onLog(e)));
    g.on('levelUp', ({ unit }) => { const level = unit.hero.level; this._later(-1, () => this._levelUp(unit, level)); });
    g.on('questDone', (e) => this._later(-1, () => this._questResult(e, true)));
    g.on('questFailed', (e) => this._later(-1, () => this._questResult(e, false)));
    g.on('weather', (w) => { this.weather.setClimate(w.name); this.hud.renderTop(); });
    g.on('gameOver', (ev) => { this.pendingGameOver = ev; });
    g.on('bless', ({ stack, site }) => { const t = site.ty * g.W + site.tx; this._later(t, () => { this._fx('bless', t); if (stack?.owner === this.viewer) music.sfx('bless'); }); });
    g.on('explored', () => this._later(-1, () => this.fog?.markDirty()));
    g.on('razed', () => { this.view.refreshCastles(); this.view.sync(); });
    g.on('siteChanged', () => this._later(-1, () => this.view.refreshSpecials()));
    g.on('surrender', () => { this.view.refreshCastles(); this.view.sync(); this.refresh(); });
    g.on('diplomacy', () => this.hud.renderTop());
    g.on('ground', () => this._later(-1, () => this.view.refreshGround?.()));
    this.view.viewer = this.firstHuman();
    this.viewer = this.view.viewer;
    await this.view.attach(g, onProgress);
    this.view.refreshCastles();
    this.hud.minimap.setMap(map);
    this.hud.minimap.setGame(g);
    this.hud.minimap.viewer = this.viewer;
    this.hud.clearLog();
    for (const e of g.s.log.slice(-30)) this.hud.addLog(e);
    this.weather.setClimate(g.s.weather.name);
    this.weather.onChange = () => this.hud.renderTop();
    this.weather.onStrike = () => { if (this.game && this.running) music.thunder(); };
    this.sky.daySpeed = DAY_SPEED;
    this.sky.timeOfDay = GAME_DAWN;
    music.newGame();
    this.fog?.setGame(g, this.viewer);
    this.view.sync();
    // compile every spell effect's shaders now, not on the first cast
    this.view.fx.prewarm?.(this.renderer, this.camera, this.post.composer.readBuffer).catch(() => {});
    this.hud.show(true);
    this.refresh();
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    this.endTurnResolve?.('stop');
    closeAllDialogs();
    this.view.clear();
    this.hud.show(false);
    this.sel = null;
    this.game = null;
    this.human = false;
    music.ambience('rain', 0);
    music.ambience('snow', 0);
  }

  firstHuman() {
    const g = this.game;
    const cur = g.current;
    if (cur.human) return cur.id;
    return g.s.players.find((p) => p.human && p.alive)?.id ?? g.s.players.find((p) => p.human)?.id ?? null;
  }

  async _loop() {
    const g = this.game;
    const humans = g.s.players.filter((p) => p.human);
    let first = true;
    while (this.running && this.game === g) {
      const p = g.current;
      if (g.s.over) break;
      // a computer side opens the game: nothing moves until the player sets out
      if (first && !p.human && this.viewer != null) {
        await beginDialog(this, p);
        if (!this.running || this.game !== g) return;
      }
      if (p.human) {
        await this._humanTurn(p, humans.length > 1, first);
      } else {
        await this._aiTurn(p);
      }
      first = false;
      if (!this.running || this.game !== g) return;
      if (this.pendingGameOver) break;
      g.endTurn();
      if (this.pendingGameOver) break;
    }
    if (this.running && this.game === g && (g.s.over || this.pendingGameOver)) {
      const ev = this.pendingGameOver ?? { winner: g.player(g.s.winner) };
      this.pendingGameOver = null;
      this.human = true;
      this.refresh();
      const winners = ev.winners?.length ? ev.winners : ev.winner ? [ev.winner] : [];
      music.gameOver(!ev.humansLost && winners.some((p) => g.player(p.id)?.human));
      const r = await gameOverDialog(this, ev);
      if (r === 'menu') this.onQuit?.();
    }
  }

  async _humanTurn(p, hotseat, first) {
    const g = this.game;
    this.viewer = p.id;
    this.view.viewer = p.id;
    this.hud.minimap.viewer = p.id;
    this.fog?.setGame(g, p.id);
    this.select(null);
    this.view.sync();
    this.refresh();
    if (hotseat) await this._passScreen(p);
    music.sfx('turn');
    saveGame(g.s, 'autosave').catch((e) => console.warn('autosave failed', e));
    // centre on the capital (or any army) at the start of the turn
    if (!first || !this._restoredCamera) {
      const cap = g.s.cities.find((c) => c.owner === p.id && c.capital) ?? g.citiesOf(p.id)[0];
      const k = g.stacksOf(p.id)[0];
      if (cap) this.lookAtTile(cap.tiles[3], first); else if (k) this.lookAtTile(k.t, first);
    }
    banner(`Day ${g.s.round}`, p.name);
    const rep = g.lastReport;
    if (rep && g.currentId === p.id) {
      const parts = [`+${rep.income} gold`, `−${rep.upkeep} upkeep`];
      if (rep.produced.length) parts.push(`${rep.produced.length} new ${rep.produced.length === 1 ? 'army' : 'armies'}`);
      const came = rep.arrived.reduce((n, a) => n + a.n, 0);
      if (came) parts.push(`${came} arrived by vectoring`);
      if (rep.disbanded.length) parts.push(`<span class="bad">${rep.disbanded.length} deserted</span>`);
      toast(parts.join(' · '));
    }
    this.human = true;
    this.refresh();
    await this._announceHeroes(p);
    if (g.s.offers.length) {
      await sleep(600);
      await offersDialog(this, g.s.offers);
      this.refresh();
    }
    await this._diplomacyTurn(p);
    if (this.game !== g || g.s.over) { this.endTurnResolve = null; this.human = false; return 'over'; }
    this._endGuardUntil = performance.now() + END_TURN_GUARD;
    const r = await new Promise((resolve) => { this.endTurnResolve = resolve; });
    this.endTurnResolve = null;
    this.human = false;
    this.select(null);
    this.view.clearPlan();
    return r;
  }

  /** Start of a human turn: proposals from other sides, surrender offers, the hill. */
  async _diplomacyTurn(p) {
    const g = this.game;
    if (g.diplo.on && g.diplo.hasNews(p.id)) toast('⚔️ Diplomatic news — open Diplomacy (P) to see where you stand.', '', 4000);
    for (const pr of g.diplo.pendingFor(p.id)) {
      const yes = await proposalDialog(this, pr);
      if (this.game !== g) return;
      if (yes) g.diplo.accept(p.id, pr.from, pr.kind); else g.diplo.decline(p.id, pr.from, pr.kind);
      this.refresh();
      if (g.s.over) return;
    }
    const sur = g.surrenderOffer(p.id);
    if (sur) {
      const yes = await surrenderDialog(this, sur);
      if (this.game !== g) return;
      if (yes) { g.acceptSurrender(p.id, sur.sides); await this.view.ensureModels(g.s.stacks.flatMap((k) => k.units.map((u) => u.type))); this.view.sync(); this.refresh(); }
      if (g.s.over) return;
    }
    const hill = g.s.hill;
    if (hill && g.s.options.victory === 'hill' && hill.holder >= 0) {
      const left = g.hillDaysLeft();
      const who = hill.holder === p.id ? 'You hold' : `${g.player(hill.holder).name} hold`;
      toast(`👑 ${who} ${g.s.cities[hill.city].name}: ${left} day${left === 1 ? '' : 's'} to victory.`, hill.holder === p.id ? 'good' : 'bad', 4500);
    }
  }

  /** New heroes of player p (the free one at the start of the game) are announced and named. */
  async _announceHeroes(p) {
    const g = this.game;
    for (const u of g.freshHeroes(p.id)) {
      const k = g.stackOfUnit(u.id);
      await sleep(400);
      await heroEmergesDialog(this, u, k ? g.cityAt(k.t) : null);
      if (this.game !== g) return;
    }
    this.refresh();
  }

  async _passScreen(p) {
    await new Promise((resolve) => {
      const el = h('div.passturn', h('div.box.frame',
        h('div.crest', { vars: { '--c': p.color }, style: { width: '60px', height: '70px', margin: '0 auto' } }),
        h('h1', { style: { color: p.color } }, p.name),
        h('div.dim', `Day ${this.game.s.round} — pass the controls to ${p.name}.`),
        h('button.btn.primary.big', { style: { marginTop: '18px' }, onclick: () => { el.remove(); resolve(); } }, 'Begin turn')));
      document.body.append(el);
    });
  }

  async _aiTurn(p) {
    const g = this.game;
    this.human = false;
    this.busy = true;
    this.refresh();
    const ai = new AIPlayer(this.cmd, p.id);
    this.fxHold++;
    try {
      await ai.play(() => !this.running || this.game !== g);
    } catch (e) {
      console.error('AI turn failed', e);
    }
    this.fxHold--;
    this._flushFx();
    this.busy = false;
    this.view.sync();
    this.refresh();
  }

  /** Lets the computer play the current human turn (console / automated tests). */
  async autoplay() {
    if (!this.human || this.busy) return;
    await this.order(() => new AIPlayer(this.cmd, this.viewer).play(() => !this.running));
  }

  async endTurnClicked() {
    // a second click of a double click (or one queued up while the machine lagged) must not end
    // the next turn too, nor skip a hand-back below: clicks too soon after the turn opens are dropped
    if (!this.human || this.busy || this._endingTurn || performance.now() < (this._endGuardUntil ?? 0)) return;
    this._endingTurn = true;
    this.hud.endBtn.disabled = true;
    try { await this._endTurn(); } finally {
      this._endingTurn = false;
      this.hud.endBtn.disabled = !this.human;
    }
  }

  async _endTurn() {
    // like Civilization: groups with a standing route march on before the turn ends
    const g = this.game;
    const back = await this.runOrders();
    if (this.game !== g || !this.human || g.s.over || this.pendingGameOver) return;
    if (back) {
      this._endGuardUntil = performance.now() + END_TURN_GUARD;
      // a group marched on its own and can still act, or would attack: the turn waits for the player
      this.selectStack(back.k.id);
      this.centerOnSelection();
      toast(back.attack
        ? 'A group on the march has reached its target and waits for your order to attack. End the turn again to leave it there.'
        : 'Groups on the march have arrived and can still move. Give them orders, or end the turn again.', '', 5000);
      return;
    }
    this.endTurnResolve?.('end');
  }

  /** Marches every group of the viewer that still has a route (set earlier, cancelled with Stop).
   * A group whose route would end in an attack this turn is not sent in: its route is dropped
   * and control comes back to the player. So it does when a group that marched still has
   * movement left once it has arrived (or was stopped on the way). Returns { k, attack } for
   * the first group handed back, or null when the turn may end. */
  async runOrders() {
    const g = this.game;
    const list = g.stacksOf(this.viewer).filter((k) => k.path?.length > 1 && !k.defend);
    if (!list.length) return null;
    let held = null;
    const marched = [];
    await this.order(async () => {
      this.select(null);
      for (const { id } of list) {
        const k = g.stack(id);
        if (!k?.path?.length || k.owner !== this.viewer) continue;
        const goal = k.path[k.path.length - 1];
        const plan = g.plan(k.units, k.t, goal);
        if (!plan) { k.path = null; continue; }
        if (this._stuck(k.units, plan)) continue;
        if (plan.attack && plan.turns[plan.turns.length - 1] === 0) {
          k.path = null;
          held ??= k;
          continue;
        }
        const ids = k.units.map((u) => u.id);
        await this.cmd.march(ids, goal);
        marched.push(ids);
        if (this.game !== g || g.s.over || this.pendingGameOver) return;
      }
      this.keepDeselected = true;
    });
    if (held && g.stack(held.id)) return { k: held, attack: true };
    // groups that marched and can still act: their route is done with, the player takes over
    for (const ids of marched) {
      const u = ids.map((id) => g.unit(id)).find(Boolean);
      const k = u && g.stackOfUnit(u.id);
      if (!k || k.owner !== this.viewer || k.done || k.defend) continue;
      if (k.path?.length > 1) {
        const next = g.plan(k.units, k.t, k.path[k.path.length - 1]);
        if (next && this._stuck(k.units, next)) continue; // out of movement, marches on next turn
      }
      if (!g.canAct(k.units)) continue; // 1 MP left and only dearer ground around: done for the turn
      k.path = null;
      held ??= k;
    }
    return held ? { k: held, attack: false } : null;
  }

  /** The group can't take the first step of the plan this turn (it marches at the pace of its slowest). */
  _stuck(units, plan) {
    return plan.path.tiles.length < 2 || (plan.turns[1] > 0 && units.some((u) => u.mp < plan.path.costs[1]));
  }

  /** Drops the standing route of the selected group. */
  cancelRoute() {
    const g = this.game;
    let any = false;
    for (const u of this.groupUnits()) { const k = g.stackOfUnit(u.id); if (k?.path) { k.path = null; any = true; } }
    if (any) toast('Route cancelled.');
    this._previewPlan();
    this.hud.renderStack();
  }

  // --- hooks: how orders look -----------------------------------------------------------------------------
  _hooks() {
    return {
      march: (move, unitIds) => this._animateMarch(move, unitIds),
      battle: (out) => this._showBattle(out),
      capture: (stack, city) => captureDialog(this, stack, city),
      captured: (out) => this._captured(out),
      searching: (out) => this._searchEncounter(out),
      search: (out) => this._searched(out),
      cast: (out) => this._cast(out),
    };
  }

  /** Is anything at tile t visible to the viewer? */
  seen(t) {
    const g = this.game;
    if (this.viewer == null || !g.s.options.fogOfWar) return true;
    return !!g.visible(this.viewer)[t];
  }

  async _animateMarch(move, unitIds) {
    try { await this._marchOnScreen(move, unitIds); } finally { this._flushFx(); }
  }

  async _marchOnScreen(move, unitIds) {
    const g = this.game;
    const units = g.unitsById(unitIds);
    if (!units.length) { this.view.sync(); return; }
    const owner = g.stackOfUnit(units[0].id)?.owner ?? move.stack.owner;
    const mine = owner === this.viewer;
    // an attack on the viewer's armies or castle always plays out, the camera on it, whatever the
    // watch options say (user); otherwise, with "Show enemy movements" off, others just appear where they went
    const onMe = !mine && this._attacksViewer(move);
    const visible = mine || onMe || this._watchEnemy(move.steps);
    if (!visible) { this.view.sync(); return; }
    this.view.speed = mine ? 1 : ENEMY_MARCH_SPEED; // other sides' marches play faster
    const fly = move.plan?.mover?.fly ?? false;
    const follow = (pos) => {
      if (!mine && !onMe && !this.followAI) return;
      this._camFollow(pos);
    };
    this.view.clearPlan();
    // footsteps while it marches (crunching over snow), waves while it sails (a flight goes silently)
    const afloat = move.plan?.path?.afloat;
    const sail = afloat?.some(Boolean) || move.steps.some((t) => g.move.isSea(t));
    const soundAt = (t) => (fly ? null : sail ? 'sail' : this.snowy(t) ? 'snowmarch' : 'march');
    let sound = soundAt(move.steps[1] ?? move.steps[0]);
    if (sound) music.loop(sound, true);
    const onTile = (t) => {
      this._flushFx(t);
      const next = soundAt(t);
      if (next === sound) return;
      if (sound) music.loop(sound, false);
      sound = next;
      if (sound) music.loop(sound, true);
    };
    try {
      await this.view.animateMarch(units, owner, move.steps, { fly, follow, costs: move.plan?.path?.costs, afloat, onTile });
    } finally { if (sound) music.loop(sound, false); }
    this.view.sync();
    this.refresh();
  }

  /** Does the march end in an attack on the viewer's armies or city? */
  _attacksViewer(move) {
    const g = this.game, t = move.attack?.t;
    if (t == null || this.viewer == null || !g.player(this.viewer)?.human) return false;
    return (g.defendersAt(t)?.owner ?? g.cityAt(t)?.owner) === this.viewer;
  }

  /** Does tile t lie under snow: an ice field, land cold enough for snow (as the terrain
   * shader draws it, Terrain.js), or land the snowfall has covered? */
  snowy(t) {
    const g = this.game, map = this.world.map;
    if (t == null || t < 0) return false;
    if (g.map.tiles[t] === Tile.ICE) return true;
    const gr = map.grid, c = this.view.tileCenter(t);
    if (!map.climate) return false;
    const i = Math.round((c.x + gr.worldW / 2) / gr.cellSize), j = Math.round((c.z + gr.worldH / 2) / gr.cellSize);
    const temp = map.climate[(j * gr.gw + i) * 4] / 255;
    return temp < (map.iceThreshold ?? 0) + 0.035 + (this.weather.state?.snowCover ?? 0) * 0.95;
  }

  async _showBattle(out) {
    try { await this._battleOnScreen(out); } finally { this._flushFx(); }
  }

  async _battleOnScreen(out) {
    const g = this.game;
    const attOwner = g.stackOfUnit(out.att.find((u) => g.unit(u.id))?.id)?.owner ?? out.attOwner ?? this._ownerOfUnits(out.att);
    const defOwner = out.defender ?? -1;
    const human = (attOwner != null && g.player(attOwner)?.human) || g.player(defOwner)?.human;
    if (!human) { this.view.sync(); return; }
    const t = out.t ?? out.city?.t;
    if (t != null) { this.lookAtTile(t); await sleep(500); }
    // a painted battlefield for the ground fought over, else a snapshot of the map
    const tt = t != null ? g.map.tiles[t] : Tile.PLAINS;
    const ground = out.ruin ? 'ruin' : out.city ? 'siege' : g.move.isSea(t) ? 'sea' : { [Tile.FOREST]: 'forest', [Tile.HILLS]: 'hills', [Tile.MOUNTAINS]: 'hills', [Tile.SWAMP]: 'swamp', [Tile.ICE]: 'snow', [Tile.VOLCANIC]: 'volcanic' }[tt] ?? 'plains';
    let bg = art.background(`battle-${ground}`);
    if (!bg) { this.post.render(0); bg = this.renderer.domElement.toDataURL('image/jpeg', 0.7); }
    const name = (o) => (o >= 0 ? SIDES[o].name : 'Neutrals');
    const where = out.ruin ? out.ruin.name : out.city ? out.city.name : 'the field';
    const viewerSide = attOwner === this.viewer ? 'att' : defOwner === this.viewer ? 'def' : null;
    await Promise.all([...out.att, ...out.def].map((u) => u.type)).then((types) => this.view.ensureModels(types));
    // give the portraits a moment to render
    for (let i = 0; i < 40 && this.portraits.queue.length; i++) await sleep(30);
    // a ruin's guardians fight to the hero's music (see _searched)
    if (out.ruin) music.hero(); else music.battle();
    await showBattle(out, {
      portraits: this.portraits, background: bg, title: out.ruin ? `The guardians of ${where}` : `Battle of ${where}`,
      attName: name(attOwner), defName: out.ruin ? 'Guardians' : name(defOwner), attOwner, defOwner: out.ruin ? -1 : defOwner, viewerSide, ruin: !!out.ruin,
    });
    this._battleEndAt = performance.now();
    if (!out.ruin) {
      const lost = new Set([...out.result.attLost, ...out.result.defLost]);
      const mine = viewerSide === 'att' ? out.att : viewerSide === 'def' ? out.def : [];
      const theirs = viewerSide === 'att' ? out.def : viewerSide === 'def' ? out.att : [];
      const fallen = mine.filter((u) => u.hero && lost.has(u.id));
      if (fallen.length) music.heroSlain(); else music.battleOver();
      this.view.sync();
      this.refresh();
      // a moment of respect for the viewer's fallen heroes; a word for the foe's
      const foe = viewerSide === 'att' ? defOwner : attOwner;
      const place = out.city ? `before the walls of ${out.city.name}` : 'on the field of battle';
      for (const u of fallen) {
        await heroFallenDialog(this, u, this.viewer, { where: place, slayer: foe >= 0 ? `the ${SIDES[foe].name}` : out.city ? 'the neutral garrison' : 'a neutral warband', items: out.dropped?.find((d) => d.hero === u.id)?.items ?? [] });
      }
      for (const u of theirs.filter((x) => x.hero && lost.has(x.id))) toast(`⚔️ ${u.hero.name}, hero of the ${name(foe)}, is slain ${place}.`, 'good', 4000);
      return;
    }
    this.view.sync();
    this.refresh();
  }

  _ownerOfUnits(units) {
    for (const u of units) { const k = this.game.stackOfUnit(u.id); if (k) return k.owner; }
    return this.game.currentId;
  }

  async _captured(out) {
    const g = this.game;
    const c = out.city;
    const mc = g.map.cities[c.id];
    const mine = out.stack?.owner === this.viewer;
    const lostMine = !mine && out.prevOwner === this.viewer && this.viewer != null;
    // the fanfare, the burst and the new banner come together, a second after the battle screen
    // closed (and a moment after the capture dialog)
    const fought = this._battleEndAt != null; // else an empty castle walked into
    if (mine || lostMine) {
      const since = this._battleEndAt != null ? performance.now() - this._battleEndAt : Infinity;
      const wait = since === Infinity ? 0 : Math.max(CAPTURE_DELAY - since, mine ? 400 : 0);
      if (wait > 0) await sleep(wait);
    }
    this._battleEndAt = null;
    if (this.game !== g) return;
    // an empty castle walked into has had no battle screen: show where it was lost
    if (lostMine && !fought) this.lookAtTile(c.t);
    this.view.refreshCastles();
    this.view.sync();
    if (this.seen(c.t) || mine) {
      this.view.fx.play('capture', new THREE.Vector3(mc.x, mc.y, mc.z), { color: SIDES[out.stack.owner]?.color, scale: 1.3 });
    }
    if (mine) music.sfx('captured');
    else if (lostMine) music.sfx('castleLost');
    if (mine) banner(out.choice === 'raze' ? `${c.name} razed` : `${c.name} taken`, out.gold ? `+${out.gold} gold` : '');
    else if (lostMine) banner(out.choice === 'raze' ? `${c.name} razed` : `${c.name} lost`, `to the ${SIDES[out.stack.owner]?.name ?? 'enemy'}`);
    this._flushFx();
    this.refresh();
    // a city taken whole opens its window, so its production can be set straight away
    if (mine && this.human && !c.razed && out.choice !== 'raze') {
      await sleep(900);
      if (this.game === g && c.owner === this.viewer) this.openCity(c);
    }
  }

  async _searched(out) {
    if (out.reward?.kind === 'allies') await this.view.ensureModels([out.reward.type]);
    this.view.sync();
    const k = this.game.stackOfUnit(out.hero.id);
    const owner = k?.owner ?? this.game.currentId;
    const mine = owner === this.viewer && this.human;
    if (mine) music.hero();
    try {
      // mourn only a hero who is really gone (guardians who join leave the hero standing)
      const fell = !out.won && !this.game.unit(out.hero.id);
      if (mine && !fell) await searchDialog(this, out);
      else if (mine) {
        music.heroSlain();
        await heroFallenDialog(this, out.hero, owner, { where: out.site.name, ruin: true, slayer: UNITS[out.guardians[0].type].name, items: out.dropped?.[0]?.items ?? [] });
      }
    } finally { this._flushFx(); }
    if (mine && this.game.unit(out.hero.id)) music.heroDone();
    this.refresh();
  }

  async _cast(out) {
    try { await this._castOnScreen(out); } finally { this._flushFx(); }
  }

  async _castOnScreen(out) {
    const g = this.game;
    const sp = SPELLS[out.spell];
    const visible = out.stack?.owner === this.viewer || this._watchEnemy([out.from]);
    if (out.summoned) await this.view.ensureModels(out.summoned.map((u) => u.type));
    if (!visible) { this.view.sync(); return; }
    const pos = this.view.worldPos(out.from);
    if (out.stack?.owner === this.viewer) this.lookAtTile(out.from);
    music.sfx('cast');
    if (sp.kind === 'summon') {
      for (const u of out.summoned) this.view.hidden.add(u.id);
      this.view.sync();
      await this.view.fx.play(out.spell, pos, { heightAt: this.view.heightAt, onSpawn: () => { for (const u of out.summoned) this.view.hidden.delete(u.id); this.view.sync(); } });
      for (const u of out.summoned) this.view.hidden.delete(u.id);
    } else if (out.teleport) {
      const to = this.view.worldPos(out.to);
      const ids = out.stack.units.map((u) => u.id);
      for (const id of ids) this.view.hidden.add(id);
      this.view.sync();
      await this.view.fx.play('teleport', pos, { target: to, heightAt: this.view.heightAt });
      for (const id of ids) this.view.hidden.delete(id);
      this.lookAtTile(out.to);
    } else {
      await this.view.fx.play(out.spell, pos, { heightAt: this.view.heightAt });
    }
    this.view.sync();
    this.refresh();
    void g;
  }

  _fx(id, t, opts = {}) {
    if (!this.game || !this.seen(t)) return;
    this.view.fx.play(id, this.view.worldPos(t), { heightAt: this.view.heightAt, ...opts });
  }
  _fxAtUnit(u, id) {
    const k = this.game?.stackOfUnit(u.id);
    if (k) this._fx(id, k.t);
  }

  /** Runs `fn` now, or — while an order plays out — once the view reaches tile t (-1: when the step is over). */
  _later(t, fn) {
    if (this.fxHold) this.fxQueue.push({ t, fn });
    else fn();
  }

  /** Runs what waited for tile t, or everything that waits (t null). */
  _flushFx(t = null) {
    if (!this.fxQueue.length) return;
    const run = t == null ? this.fxQueue : this.fxQueue.filter((e) => e.t === t && t >= 0);
    this.fxQueue = t == null ? [] : this.fxQueue.filter((e) => !run.includes(e));
    for (const e of run) { try { e.fn(); } catch (err) { console.error(err); } }
  }

  /** A hero rose a level: a burst of light on the map, and for the viewer's own heroes a banner. */
  _levelUp(unit, level) {
    const g = this.game;
    if (!g || !g.unit(unit.id)) return;
    this._fxAtUnit(unit, 'levelup');
    const k = g.stackOfUnit(unit.id);
    if (!k || k.owner !== this.viewer || !g.player(k.owner)?.human) return;
    const lv = HERO_CLASSES[unit.hero.cls].levels[level - 1];
    levelUpShow({ name: unit.hero.name, level, title: lv?.title ?? '', ap: lv?.ap ?? 0, cls: HERO_CLASSES[unit.hero.cls].name, portrait: this.portraits.url(unit.type, k.owner), color: SIDES[k.owner]?.color });
    this.refresh();
  }

  /** The viewer's quest is won or lost: a dialog that waits for the player, so the news is not missed. */
  _questResult(e, won) {
    if (e.player !== this.viewer || !this.game?.player(e.player)?.human) return;
    const name = e.unit?.hero.name ?? 'Your hero';
    if (won) music.sfx('bless');
    ask(won ? 'Quest completed!' : 'Quest failed',
      won ? `<b>${name}</b> completes the quest <b>${e.quest.text}</b> and is rewarded with <b>${e.reward}</b>.`
        : `The quest <b>${e.quest.text}</b> can no longer be completed: ${e.why}.`,
      [{ label: 'Continue', value: true, primary: true }], { cls: won ? 'quest-won' : 'quest-lost' });
    this.refresh();
  }

  _onLog(e) {
    const g = this.game;
    // other sides' events only when the viewer could see them
    if (e.player !== this.viewer && e.t >= 0 && !this.seen(e.t) && e.kind !== 'battle') return;
    this.hud.addLog(e);
    void g;
  }

  // --- selection ---------------------------------------------------------------------------------------------
  /** Current selection: { stack, city, owner, t, units (all there), group (ids that move) } */
  select(sel) {
    this.sel = sel;
    this._atk = null;
    const g = this.game;
    const stacks = sel && g ? [...new Set(sel.group.map((id) => g.stackOfUnit(id)?.id).filter((x) => x != null))] : [];
    // the ring round the castle when the group is not just one corner's stack
    this.view.select(stacks, sel?.city != null && stacks.length !== 1 ? sel.city : null);
    this.hoverPlan = null;
    this._previewPlan();
    this.hud.renderStack();
  }

  selectStack(id) {
    const g = this.game;
    const k = g.stack(id);
    if (!k) return this.select(null);
    const city = g.cityAt(k.t);
    if (city && city.owner === k.owner) return this.selectCity(city, k.units.map((u) => u.id));
    const group = k.units.filter((u) => !this.sel || this.sel.stack !== id || this.sel.group.includes(u.id)).map((u) => u.id);
    this.select({ stack: k.id, city: null, owner: k.owner, t: k.t, units: k.units, group: group.length ? group : k.units.map((u) => u.id) });
  }

  /** Selects armies in a city. The palette shows the castle corner(s) the group stands in —
   * the whole garrison only when `whole` (double click, G): a click on one corner's token must
   * not fill the panel with every army in the city (user). The group is `group`, else the
   * first stack with moves left. */
  selectCity(city, group = null, whole = false) {
    const g = this.game;
    const garrison = byRank(g.unitsIn(city));
    if (!garrison.length) { this.select(null); return; }
    const owner = g.stackOfUnit(garrison[0].id).owner;
    let ids = group?.length ? group : null;
    if (!ids) {
      const k = g.garrison(city).find((x) => x.owner === owner && x.units.some((u) => u.mp > 0)) ?? g.garrison(city).find((x) => x.owner === owner);
      ids = k.units.map((u) => u.id);
    }
    const k = g.stackOfUnit(ids[0]);
    // the stacks the group stands in (a group spills over two corners when one is near full)
    const units = whole ? garrison : byRank([...new Set(ids.map((id) => g.stackOfUnit(id)).filter(Boolean))].flatMap((x) => x.units));
    this.select({ stack: k.id, city: city.id, owner, t: k.t, units, group: ids, whole });
  }

  /** Re-reads the selection from the game state after it changed. */
  refreshSelection() {
    const s = this.sel, g = this.game;
    if (!s || !g) return;
    if (s.city != null) {
      const city = g.s.cities[s.city];
      const units = g.unitsIn(city);
      if (!units.length || g.stackOfUnit(units[0].id).owner !== s.owner) return this.select(null);
      return this.selectCity(city, s.group.filter((id) => units.some((u) => u.id === id)), s.whole);
    }
    const k = g.stack(s.stack) ?? (s.group.length ? g.stackOfUnit(s.group[0]) : null);
    if (!k || k.owner !== s.owner) return this.select(null);
    if (g.cityAt(k.t)) return this.selectCity(g.cityAt(k.t), s.group.filter((id) => g.unit(id)));
    const group = s.group.filter((id) => k.units.some((u) => u.id === id));
    this.select({ stack: k.id, city: null, owner: k.owner, t: k.t, units: k.units, group: group.length ? group : k.units.map((u) => u.id) });
  }

  toggleGroup(id, only = false) {
    const s = this.sel;
    if (!s) return;
    let group = only ? [id] : s.group.includes(id) ? s.group.filter((x) => x !== id) : [...s.group, id];
    if (group.length > STACK_MAX) { toast(`A group holds at most ${STACK_MAX} armies.`); group = group.slice(0, STACK_MAX); }
    if (!group.length) group = [id];
    const k = this.game.stackOfUnit(group[0]);
    this.select({ ...s, stack: k.id, t: k.t, group });
  }

  groupUnits() { return this.sel ? this.game.unitsById(this.sel.group) : []; }

  nextGroup() {
    const g = this.game;
    if (!this.human) return;
    // every stack on its own, the corners of a city too
    // groups on a route march by themselves when the turn ends
    const list = g.stacksOf(this.viewer).filter((k) => !k.done && !k.defend && !(k.path?.length > 1) && g.canAct(k.units));
    if (!list.length) { toast('Every group has moved. End the turn when ready.'); this.select(null); return; }
    const cur = this.sel ? list.findIndex((k) => k.id === this.sel.stack) : -1;
    this.selectStack(list[(cur + 1) % list.length].id);
    this.centerOnSelection();
  }

  leaveGroup() {
    const g = this.game;
    for (const u of this.groupUnits()) { const k = g.stackOfUnit(u.id); if (k) k.done = true; }
    this.nextGroup();
  }

  defendGroup() {
    const g = this.game;
    for (const u of this.groupUnits()) { const k = g.stackOfUnit(u.id); if (k) { k.defend = true; k.path = null; } }
    toast('Sentry: the group stays put until you select it again.');
    this.nextGroup();
  }

  // --- orders ---------------------------------------------------------------------------------------------------
  async order(fn) {
    if (!this.human || this.busy) return;
    this.busy = true;
    this.keepDeselected = false;
    this.hud.renderActions();
    this.fxHold++;
    try { await fn(); } catch (e) { console.error(e); toast(`Error: ${e.message}`, 'bad'); }
    this.fxHold--;
    this._flushFx();
    this.busy = false;
    if (this.keepDeselected) { this.keepDeselected = false; this.select(null); }
    this.refreshSelection();
    this.view.sync();
    this.refresh();
  }

  moveTo(t) {
    const s = this.sel;
    if (!s || s.owner !== this.viewer) return;
    const ids = [...s.group];
    const g = this.game;
    const plan = g.plan(this.groupUnits(), s.t, t);
    if (!plan) { toast('No route there.'); return; }
    if (this._stuck(this.groupUnits(), plan)) {
      // can't take a step this turn: remember the route (it marches on when the turn ends,
      // unless the group gets other orders first) and let go of the group
      const stacks = [...new Set(ids.map((id) => g.stackOfUnit(id)))].filter(Boolean);
      if (!stacks.every((k) => k.units.every((u) => ids.includes(u.id)))) {
        toast('Out of movement. Only a whole group can keep a route — select all of it.');
        return;
      }
      for (const k of stacks) { k.path = plan.path.tiles; k.defend = false; }
      toast('Out of movement — the group will march on when the turn ends.');
      this.select(null);
      return;
    }
    const tr = plan.attack?.treaty;
    if (tr && plan.attack.owner >= 0) return this._breakTreaty(plan.attack.owner, tr).then((yes) => { if (yes) return this._march(ids, t); });
    return this._march(ids, t);
  }

  /** Attacking a side at peace (or an ally) breaks the treaty: ask first. */
  async _breakTreaty(owner, treaty) {
    const g = this.game, them = g.player(owner);
    const h = g.diplo.hate(owner, this.viewer);
    const yes = await ask(treaty === 'allied' ? 'Betray an ally?' : 'Break the peace?',
      `You are ${treaty === 'allied' ? 'allied' : 'at peace'} with <b>${them.name}</b> (they feel ${standing(h)} toward you). Attacking them declares war${treaty === 'allied' ? ' and breaks your alliance' : ''} — they and every other side will remember it.`,
      [{ label: 'Declare war', value: true, danger: true }, { label: 'Hold back', value: false }]);
    if (yes) { g.diplo.declareWar(this.viewer, owner); this.refresh(); }
    return yes;
  }

  _march(ids, t) {
    const g = this.game;
    return this.order(async () => {
      for (const id of ids) { const k = g.stackOfUnit(id); if (k) k.defend = false; }
      const res = await this.cmd.march(ids, t);
      if (!res.move) { toast('No route there.'); return; }
      const now = ids.find((id) => g.unit(id));
      if (now != null) {
        const k = g.stackOfUnit(now);
        const city = g.cityAt(k.t);
        // stopped on the way with no movement left: the route is kept, the group let go
        const next = k.path?.length > 1 && g.plan(k.units, k.t, k.path[k.path.length - 1]);
        if (next && this._stuck(k.units, next) && !res.battle) { this.keepDeselected = true; return; }
        if (city && city.owner === k.owner) this.selectCity(city, ids.filter((id) => g.unit(id)));
        else this.selectStack(k.id);
        if (res.move.stoppedShort && res.move.plan.attack && !res.battle) toast('Out of movement before the attack — continue next turn.');
        // arrived on a ruin with a hero: offer the search
        if (g.canSearch(k) && res.move.arrived) {
          const site = g.site(k.t);
          const yes = await ask(site.name, `Your hero stands before <b>${site.name}</b> (danger ${'★'.repeat(site.danger)}). Search it? Your hero goes in alone; the group waits outside and its strength gives the hero heart.`, [{ label: 'Search', value: true, primary: true }, { label: 'Not now', value: false }]);
          if (yes) await this._search(k);
        }
        // spent: nothing more to order this turn, so let go of the group (a route it still
        // has is kept) and stop drawing paths to the pointer
        const left = g.unitsById(ids);
        if (left.length && !g.canAct(left)) this.keepDeselected = true;
      } else this.select(null);
    });
  }

  continueMove() {
    const s = this.sel;
    const k = s && this.game.stack(s.stack);
    if (!k?.path?.length) return;
    this.moveTo(k.path[k.path.length - 1]);
  }

  /** The selected group's hero takes up the items lying where it stands. */
  pickUpItems() {
    const g = this.game, k = this.sel && g.stack(this.sel.stack);
    if (!k || k.owner !== this.viewer || !this.human || this.busy || !g.canPickUp(k)) return;
    const items = g.pickUp(k);
    if (items) toast(`${k.units.find((u) => u.hero).hero.name} takes up the ${items.map((x) => ITEMS[x].name).join(', ')}.`, 'good');
    this.refresh();
  }

  searchRuin() {
    const k = this.sel && this.game.stack(this.sel.stack);
    if (!k || !this.game.canSearch(k)) return;
    this.order(() => this._search(k));
  }

  /** The hero goes into the ruin: suspense first — the hero's music, then the doors grind
   * open and "<hero> searches <ruin>…" — and only then is what waits inside decided and
   * named (_searchEncounter) before the fight is shown. */
  async _search(k) {
    const hero = k.units.find((u) => u.hero), site = this.game.site(k.t);
    music.hero();
    await sleep(1000);
    music.sfx('ruin');
    this._searchMsg = h('div#searchmsg', h('div.l1', `${hero.hero.name} searches ${site.name}…`));
    document.body.append(this._searchMsg);
    await sleep(2200);
    try { return await this.cmd.search(k); } finally { this._searchMsg?.remove(); this._searchMsg = null; }
  }

  /** "…and encounters a Red Dragon!" — a pause on what the hero found, then the fight. */
  async _searchEncounter(out) {
    const el = this._searchMsg;
    if (!el) return;
    const T = UNITS[out.guardians[0].type], n = out.guardians.length;
    const who = n > 1 ? `${n} ${T.name}` : withArticle(singular(T.name));
    el.append(h('div.l2' + (out.joined ? '.good' : ''), out.joined ? `…and meets ${who}, who would rather join than fight!` : `…and encounters ${who}!`));
    await sleep(2400);
    el.classList.add('out');
    await sleep(350);
  }

  async openCast(hero) {
    if (!hero) return;
    const id = await castDialog(this, hero);
    if (!id) return;
    let target = null;
    if (id === 'teleport') {
      target = await teleportDialog(this, hero);
      if (target == null) return;
    }
    this.order(() => this.cmd.cast(hero, id, target));
  }

  /** Burns a city of the viewer's to the ground (raze any time), after asking. */
  async razeCity(city) {
    const g = this.game;
    if (!city || !g.canRaze(city, this.viewer) || !this.human || this.busy) return false;
    const yes = await ask(`Raze ${city.name}?`, `Burn <b>${city.name}</b> to the ground? It stops paying ${g.cityIncome(city)} gold and training armies, nobody holds it, and rebuilding costs 800 gold. Every other side will think the worse of you.${city.capital ? ' <b>It is your capital.</b>' : ''}`,
      [{ label: 'Put it to the torch', value: true, danger: true }, { label: 'Spare it', value: false }]);
    if (!yes || !g.razeCity(city, this.viewer)) return false;
    const mc = g.map.cities[city.id];
    this.view.fx.play('capture', new THREE.Vector3(mc.x, mc.y, mc.z), { color: '#ff6a2a', scale: 1.3 });
    banner(`${city.name} razed`);
    this.refreshSelection();
    this.refresh();
    return true;
  }

  /** The selected group burns the enemy site it stands on, after asking. */
  async razeSite() {
    const g = this.game, k = this.sel && g.stack(this.sel.stack);
    if (!k || !g.canRazeSite(k) || !this.human || this.busy) return;
    const x = g.special(k.t), owner = g.siteOwner(x);
    const T = SPECIAL_TYPES[x.type];
    const yes = await ask(`Raze the ${T.name}?`, `Burn the ${T.name} that serves <b>${g.s.cities[x.city].name}</b>${owner >= 0 ? ` (${g.player(owner).name})` : ''}? It stops giving ${T.text.replace(/ (to|in)$/, '')} until rebuilt. The group spends its moves${owner >= 0 && !g.hostile(this.viewer, owner) ? `, and this <b>breaks your ${g.diplo.status(this.viewer, owner) === 'allied' ? 'alliance' : 'peace'}</b>` : ''}.`,
      [{ label: 'Burn it', value: true, danger: true }, { label: 'Leave it', value: false }]);
    if (!yes || !g.razeSite(k)) return;
    this._fx('capture', k.t, { color: '#ff6a2a' });
    this.refreshSelection();
    this.refresh();
  }

  /** Raze: a city of the viewer's selected, else the site under the group. */
  razeHere() {
    const g = this.game, s = this.sel;
    const city = s?.city != null ? g.s.cities[s.city] : null;
    if (city && g.canRaze(city, this.viewer)) return this.razeCity(city);
    return this.razeSite();
  }

  openDiplomacy() { if (this.game) { this.game.diplo.seen(this.viewer); reportsDialog(this, 'diplomacy').then(() => this.refresh()); this.hud.renderTop(); } }

  openHero(hero) { if (hero) heroDialog(this, hero).then(() => this.refresh()); }
  openCity(city) { if (city) cityDialog(this, city).then(() => this.refresh()); }
  openReports() { if (this.game) reportsDialog(this).then(() => this.refresh()); }
  openVectoring() { if (this.game) vectoringDialog(this).then(() => this.refresh()); }

  async openVector() {
    const s = this.sel, g = this.game;
    const city = s?.city != null ? g.s.cities[s.city] : null;
    if (!city) return;
    const to = await vectorDialog(this, city);
    if (!to) return;
    if (g.vectorUnits(s.group, to)) { this.select(null); this.view.sync(); this.refresh(); }
  }

  async questAction(hero) {
    const g = this.game;
    const q = g.s.quests[this.viewer];
    if (q) {
      const who = g.unit(q.hero);
      const r = await ask('Quest', `<b>${who?.hero.name ?? 'Your hero'}</b>: ${q.text}.<br><span class="dim">${g.questProgress(this.viewer).status}.</span>`,
        [{ label: 'Show on map', value: 'show', primary: true, disabled: q.t == null }, { label: 'Set aside', value: 'abandon', danger: true }, { label: 'Close', value: null }]);
      if (r === 'show') this.lookAtTile(q.t);
      if (r === 'abandon') { g.abandonQuest(this.viewer); toast('Quest set aside. No new quest for two turns.'); }
      return;
    }
    if (!hero) return;
    const k = g.stackOfUnit(hero.id);
    const city = g.cityAt(k.t);
    if (!city || city.owner !== this.viewer) { toast('Heroes get quests in their own cities.'); return; }
    if (g.player(this.viewer).questWait > 0) { toast('No quests are offered yet — wait a turn or two.'); return; }
    const levels = { 1: ['easy'], 2: ['easy', 'average'], 3: ['easy', 'average', 'hard'] }[city.level];
    const diff = await ask('Seek a quest', `The elders of ${city.name} have tasks for a hero. Harder quests pay better (${city.level < 3 ? 'larger cities offer harder quests' : 'all difficulties offered'}).`,
      [...levels.map((l) => ({ label: l[0].toUpperCase() + l.slice(1), value: l, primary: l === 'easy' })), { label: 'Cancel', value: null }]);
    if (!diff) return;
    const nq = g.getQuest(hero, diff);
    if (nq) { await ask('A quest!', `<b>${hero.hero.name}</b> is charged: <b>${nq.text}</b>.`); if (nq.t != null) this.lookAtTile(nq.t); }
    this.refresh();
  }

  async disbandGroup() {
    const units = this.groupUnits();
    if (!units.length) return;
    const yes = await ask('Disband', `Disband ${units.length === 1 ? unitName(units[0]) : `${units.length} armies`}? They leave your service for good.`, [{ label: 'Disband', value: true, danger: true }, { label: 'Keep them', value: false }]);
    if (!yes) return;
    this.game.disband(units.map((u) => u.id));
    this.select(null);
    this.view.sync();
    this.refresh();
  }

  async openGameMenu() {
    if (!this.game) return;
    const r = await ask('Menu', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '260px' } }), [
      { label: 'Save game', value: 'save', primary: true, disabled: !this.human },
      { label: 'Download save file', value: 'download' },
      { label: 'Options', value: 'options' },
      { label: 'Quit to main menu', value: 'quit', danger: true },
      { label: 'Resume', value: null },
    ]);
    if (r === 'save') {
      const name = prompt('Name this save', `${this.game.s.map.name} — day ${this.game.s.round}`);
      if (name) { await saveGame(this.game.s, name); toast('Game saved.'); }
    } else if (r === 'download') downloadSave(this.game.s);
    else if (r === 'options') this.openOptions();
    else if (r === 'quit') {
      const yes = await ask('Quit', 'Leave this game? Unsaved progress since the start of your turn (autosave) is lost.', [{ label: 'Quit', value: true, danger: true }, { label: 'Stay', value: false }]);
      if (yes) this.onQuit?.();
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
  }

  async openOptions() {
    const o = this.opts;
    await ask('Options', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '320px' } },
      ...this.watchOptions(),
      h('label.chk', h('input', { type: 'checkbox', checked: o.labels, onchange: (e) => { o.labels = e.target.checked; this._saveOpts(); this.applyOpts(); } }), 'Show city names'),
      h('label.chk', h('input', { type: 'checkbox', checked: o.shadows, onchange: (e) => { o.shadows = e.target.checked; this._saveOpts(); this.applyOpts(); } }), 'Shadows'),
      h('label.chk', h('input', { type: 'checkbox', checked: o.grid, onchange: (e) => { o.grid = e.target.checked; this._saveOpts(); this.applyOpts(); } }), 'Tile grid'),
      h('div.o', { style: { display: 'flex', gap: '8px', alignItems: 'center' }, title: 'Smooths jagged edges. Lower is faster.' }, 'Anti-aliasing', h('select', { onchange: (e) => { o.aa = +e.target.value; this._saveOpts(); this.applyOpts(); } },
        [[0, 'Off'], [2, '2×'], [4, '4×']].map(([v, t]) => h('option', { value: v, selected: o.aa === v }, t)))),
      h('div.o', { style: { display: 'flex', gap: '8px', alignItems: 'center' }, title: 'The 3D view\'s rendering resolution. Lower is faster but softer.' }, 'Resolution', h('select', { onchange: (e) => { o.resolution = +e.target.value; this._saveOpts(); this.applyOpts(); } },
        [[1, 'Full'], [0.75, '75%'], [0.5, '50%']].map(([v, t]) => h('option', { value: v, selected: o.resolution === v }, t)))),
      h('div.o', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, 'Bloom', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: o.bloom, oninput: (e) => { o.bloom = +e.target.value; this._saveOpts(); this.applyOpts(); } })),
      h('div.o', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, 'Music', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: o.music, oninput: (e) => { o.music = +e.target.value; this._saveOpts(); this.applyOpts(); } })),
      h('div.o', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, 'Sounds', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: o.sfx, oninput: (e) => { o.sfx = +e.target.value; this._saveOpts(); this.applyOpts(); } })),
    ), [{ label: 'Close', value: true, primary: true }]);
  }

  /** The checkboxes for watching the other sides (in-game Options and the new-game screen). */
  watchOptions() {
    const o = this.opts;
    const near = h('input', { type: 'checkbox', checked: !!o.enemiesNear, disabled: o.showEnemies === false, onchange: (e) => { o.enemiesNear = e.target.checked; this._saveOpts(); } });
    return [
      h('label.chk', { title: 'Off: enemy armies are not animated on the march — they just appear where they went, and the turn passes quicker.' }, h('input', { type: 'checkbox', checked: o.showEnemies !== false, onchange: (e) => { o.showEnemies = e.target.checked; near.disabled = !o.showEnemies; this._saveOpts(); } }), 'Show enemy movements'),
      h('label.chk', { style: { marginLeft: '22px' }, title: `Only the enemy marches that pass within ${NEAR_WATCH} tiles of your armies or cities are shown; the rest just appear where they went.` }, near, `Only near my armies & cities (${NEAR_WATCH} tiles)`),
      h('label.chk', { title: 'The camera chases the computer armies on the march.' }, h('input', { type: 'checkbox', checked: o.followAI, onchange: (e) => { o.followAI = e.target.checked; this.followAI = o.followAI; this._saveOpts(); } }), 'Camera follows enemy armies'),
    ];
  }

  /** Whether another side's doings on these tiles are shown: in view, and (with "only near me")
   * within NEAR_WATCH tiles of one of the viewer's armies or cities. */
  _watchEnemy(tiles) {
    const o = this.opts, g = this.game;
    if (o.showEnemies === false || !tiles.some((t) => this.seen(t))) return false;
    if (!o.enemiesNear || this.viewer == null) return true;
    const r2 = NEAR_WATCH * NEAR_WATCH;
    const mine = [...g.s.stacks.filter((k) => k.owner === this.viewer).map((k) => k.t), ...g.citiesOf(this.viewer).map((c) => c.t)].map((t) => g.tileXY(t));
    return tiles.some((t) => { const [x, y] = g.tileXY(t); return mine.some(([a, b]) => (a - x) ** 2 + (b - y) ** 2 <= r2); });
  }

  get opts() {
    if (!this._opts) {
      const saved = JSON.parse(localStorage.getItem('wl.opts') || '{}');
      if (!saved.aaV) { delete saved.aa; saved.aaV = 1; } // 2× became the default: forget the old saved 4×
      this._opts = { followAI: true, showEnemies: true, enemiesNear: false, labels: true, shadows: true, grid: false, bloom: 0.35, aa: 2, resolution: 1, music: 1, sfx: 1, ...saved };
    }
    return this._opts;
  }
  _saveOpts() { localStorage.setItem('wl.opts', JSON.stringify(this.opts)); }
  applyOpts() {
    const o = this.opts;
    this.followAI = o.followAI;
    this.labelGroup.visible = o.labels;
    this.view.labels.traverse((x) => { if (x.element?.classList.contains('city-label')) x.element.style.display = o.labels ? '' : 'none'; });
    this.sky.light.castShadow = o.shadows;
    this.U.uGrid.value = o.grid ? 1 : 0;
    this.post.bloom.strength = o.bloom;
    if (this.post.setQuality(o.aa, o.resolution)) dispatchEvent(new Event('resize'));
    music.setVolume(o.music);
    music.setSfxVolume(o.sfx);
  }

  // --- refresh ---------------------------------------------------------------------------------------------------
  refresh() {
    if (!this.game) return;
    this.hud.renderTop();
    this.hud.renderStack();
  }

  // --- camera ----------------------------------------------------------------------------------------------------
  lookAt(x, z, instant = false) {
    const y = Math.max(0, this.world.heightAt(x, z));
    if (instant) {
      const off = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.set(x, y, z);
      this.camera.position.copy(this.controls.target).add(off);
      this.camGoal = null;
    } else this.camGoal = new THREE.Vector3(x, y, z);
  }
  lookAtTile(t, instant = false) {
    const c = this.view.tileCenter(t);
    this.lookAt(c.x, c.z, instant);
  }
  centerOnSelection() { if (this.sel) this.lookAtTile(this.sel.t); }
  /** The player grabbed the camera: drop any pending glide and leave the view alone for a moment. */
  userCamera() {
    this.camGoal = null;
    this.userCamAt = performance.now();
  }
  _camFollow(pos) {
    // keep a marching army in view: steer the focus toward it when it nears the screen edge
    if (performance.now() - (this.userCamAt ?? -1e9) < 2500) return;
    const p = pos.clone().project(this.camera);
    if (Math.abs(p.x) > 0.55 || Math.abs(p.y) > 0.5 || p.z > 1) this.camGoal = pos.clone();
  }

  update(dt) {
    // rain and snow are heard while they fall on the game
    const w = this.game ? this.weather.state : null;
    music.ambience('rain', w ? w.rain / 0.7 : 0);
    music.ambience('snow', w ? w.snow / 0.85 : 0);
    if (this.camGoal) {
      const t = this.controls.target;
      // glide over the ground only: the frame loop settles the height, so a goal on raised
      // land would never be reached in 3D and would keep pulling the view back
      const d = this.camGoal.clone().sub(t).setY(0);
      const k = Math.min(1, dt * 4);
      if (d.length() < 0.05) this.camGoal = null;
      else { const step = d.multiplyScalar(k); t.add(step); this.camera.position.add(step); }
    }
    if (this.game) {
      if (this.mouseDirty) { this.mouseDirty = false; this._hover(); }
      else if ((this._frameN ?? 0) % 10 === 0) this._hoverPick(); // figures walk under a still pointer
      this.view.update(dt);
      this.portraits.update(2);
      this._frameN = (this._frameN ?? 0) + 1;
      if (this._frameN % 3 === 0) this.hud.minimap.draw(this.camera);
      if (this._frameN % 60 === 0) this.hud.renderTop();
    }
  }

  // --- input ---------------------------------------------------------------------------------------------------------
  _bindInput() {
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const b = down.b;
      down = null;
      if (moved > 6) return; // a drag moves the view
      if (b === 0) this._click(e);
      else if (b === 2) this._rightClick(e);
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.mouseClient = { x: e.clientX, y: e.clientY };
      this.mouseDirty = true;
    });
    dom.addEventListener('pointerleave', () => {
      this.hoverTile = -1; this.mouseClient = null;
      this.hud.showTip(-1); this.world.highlightTile(-1, -1);
      this._hoverPick();
    });
    addEventListener('keydown', (e) => this._key(e));
    document.addEventListener('fullscreenchange', () => this.refresh());
  }

  _pickTile(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.world.pick(this.raycaster.ray);
    this.pickPoint = null;
    if (!hit || !this.game) return -1;
    const g = this.game;
    if (hit.tx < 0 || hit.ty < 0 || hit.tx >= g.W || hit.ty >= g.H) return -1;
    this.pickPoint = hit.point;
    return hit.ty * g.W + hit.tx;
  }

  /** The city whose keep is under `point` (the middle of the castle; the corners belong to the stacks there). */
  _cityCentreAt(t, point) {
    const city = t >= 0 ? this.game?.cityAt(t) : null;
    if (!city || !point) return null;
    const mc = this.view.map.cities[city.id];
    return Math.hypot(point.x - mc.x, point.z - mc.z) <= CITY_CLICK * this.view.map.grid.tileSize ? city : null;
  }

  /** The stack drawn on tile t that a click at the pointer takes (a castle corner's too), if in view. */
  _stackShownAt(t) {
    const k = t >= 0 ? this.game?.stackAt(t) : null;
    return k && this.view.stackViews.has(k.id) ? k : null;
  }

  _hover() {
    if (dialogOpen()) { this._hoverPick(); return; }
    const t = Math.abs(this.mouse.x) <= 1 ? this._pickTile(this.mouse) : -1;
    this.hoverPoint = this.pickPoint;
    this._hoverPick(t);
    if (t === this.hoverTile) return;
    this.hoverTile = t;
    this._previewPlan();
    this.hud.showTip(t);
  }

  /** Shows what a left click at the pointer would take: a figure (ringed, with an army icon) or
   * else a city (ringed, with a castle icon). */
  _hoverPick(t = this.hoverTile) {
    const g = this.game, m = this.mouseClient, el = this.hoverIcon;
    const hit = g && m && !dialogOpen() && !document.getElementById('battle') ? this.view.pickFigure(m.x, m.y, this.renderer.domElement) : null;
    let k = hit?.stackId != null ? g.stack(hit.stackId) : null;
    // on a castle only its middle opens the city; a corner takes the stack standing there
    const city = !k && m && t >= 0 ? this._cityCentreAt(t, this.hoverPoint) : null;
    if (!k && !city && m && t >= 0 && g?.cityAt(t)) k = this._stackShownAt(t);
    this.view.setHover(k?.id ?? null, city?.id ?? null);
    this._cursor(k, city, t);
    let icon = null, text = '', cls = '';
    if (k) {
      const hero = k.units.find((u) => u.hero);
      const who = hero ? hero.hero.name : k.units.length === 1 ? unitName(k.units[0]) : `${k.units.length} armies`;
      if (k.owner === this.viewer) { icon = '⚔️'; text = `Select ${who}${hero && k.units.length > 1 ? ` +${k.units.length - 1}` : ''}`; cls = 'own'; }
      else { icon = '🔍'; text = k.owner >= 0 ? `${SIDES[k.owner].name}: ${who}` : `Neutral: ${who}`; cls = 'foe'; }
    } else if (city) {
      if (city.owner === this.viewer) { icon = '🏰'; text = `Open ${city.name}`; cls = 'own city'; }
      else { icon = '🏰'; text = `${city.name}${city.owner >= 0 ? ` (${SIDES[city.owner].name})` : city.razed ? ' (razed)' : ' (neutral)'}`; cls = 'foe city'; }
    }
    if (!icon) { el.style.display = 'none'; return; }
    el.className = cls;
    el.style.display = 'flex';
    el.style.transform = `translate(${m.x + 16}px, ${m.y + 18}px)`;
    if (el.dataset.text !== icon + text) {
      el.dataset.text = icon + text;
      el.replaceChildren(h('span.ic', icon), h('span.tx', text));
    }
  }

  _previewPlan() {
    const g = this.game, s = this.sel, t = this.hoverTile;
    this.hoverPlan = null;
    const moving = g && s && s.owner === this.viewer && this.human && !this.busy;
    // the tile under the pointer is outlined only while a group of yours is about to march
    if (moving && t >= 0) { const [x, y] = g.tileXY(t); this.world.highlightTile(x, y); } else this.world.highlightTile(-1, -1);
    if (!moving) {
      const k = s && g?.stack(s.stack);
      if (k?.path?.length > 1 && s.owner === this.viewer) {
        const plan = g.plan(this.groupUnits(), k.t, k.path[k.path.length - 1]);
        this.view.showPlan(plan, { dim: true });
      } else this.view.clearPlan();
      return;
    }
    const units = this.groupUnits();
    // another corner of the group's own city is somewhere to go too
    if (t >= 0 && t !== s.t && units.length) {
      const plan = g.plan(units, s.t, t);
      if (plan && plan.attack) {
        const d = g.defendersAt(plan.attack.t);
        if (d && d.units.length && (plan.turns[plan.turns.length - 1] === 0)) {
          plan.odds = odds(units, d.units, g.battleContext({ t: plan.path.tiles[plan.path.tiles.length - 2] ?? s.t, owner: s.owner }, plan.attack.t), 40);
        }
      }
      this.hoverPlan = plan;
      if (plan) { this.view.showPlan(plan); return; }
    }
    const k = g.stack(s.stack);
    if (k?.path?.length > 1) this.view.showPlan(g.plan(units, k.t, k.path[k.path.length - 1]), { dim: true });
    else this.view.clearPlan();
  }

  // Mouse: the left button selects (and drags the map), the right button marches the selected
  // group — or attacks — and shows information when nothing of yours is selected. A figure
  // under the pointer is what a left click takes (the stack in that castle corner too);
  // elsewhere on a city the click opens the city.
  _click(e) {
    const g = this.game;
    if (!g || dialogOpen()) return;
    const hit = this.view.pickFigure(e.clientX, e.clientY, this.renderer.domElement);
    const t = this._pickTile(this._ndc(e));
    // a second click on the same group soon after: the whole army there (the garrison too)
    const now = performance.now(), last = this.lastClick;
    this.lastClick = null;
    const own = (k) => {
      const key = g.cityAt(k.t)?.id != null ? `c${g.cityAt(k.t).id}` : `k${k.id}`;
      if (last && last.key === key && now - last.at < 400 && this.sel) this.selectAll();
      else { this.selectStack(k.id); this.lastClick = { key, at: now }; }
    };
    if (hit?.stackId != null) {
      const k = g.stack(hit.stackId);
      if (k.owner === this.viewer) return own(k);
      return this._info(k.t);
    }
    if (t < 0) { this.select(null); return; }
    if (g.cityAt(t)) {
      // only the middle of a castle opens the city; its corners are the stacks there
      if (this._cityCentreAt(t, this.pickPoint)) return this._info(t);
      const k = this._stackShownAt(t);
      if (k && k.owner === this.viewer) return own(k);
      if (k) return this._info(t);
      this.select(null);
      return;
    }
    const k = g.stackAt(t);
    if (k && k.owner === this.viewer) return own(k);
    if (k && g.canSee(this.viewer, k)) return this._info(t);
    this.select(null);
  }

  /** Every army at the selection's place joins the group: the whole stack, or in a city the
   * whole garrison shows and as much of it as a group holds joins (those with moves left first). */
  selectAll() {
    const s = this.sel, g = this.game;
    if (!s) return;
    const all = s.city != null ? byRank(g.unitsIn(g.s.cities[s.city])) : s.units;
    const units = [...all].sort((a, b) => (b.mp > 0 ? 1 : 0) - (a.mp > 0 ? 1 : 0));
    const group = units.slice(0, STACK_MAX).map((u) => u.id);
    const k = g.stackOfUnit(group[0]);
    this.select({ ...s, stack: k.id, t: k.t, units: all, group, whole: s.city != null });
    if (all.length > STACK_MAX) toast(`A group holds at most ${STACK_MAX} armies.`);
  }

  /** The pointer tells what a click does: swords where a right click attacks this turn, a banner
   * where it marches the group, an arrow on your own armies (left click selects), a castle on a
   * city's middle (left click opens it), a lens on other sides' armies and cities. */
  _cursor(k, city, t) {
    const g = this.game, s = this.sel;
    let cur = '';
    if (g && !this.busy && !dialogOpen()) {
      let plan = null;
      if (s && s.owner === this.viewer && this.human) {
        const to = k && k.owner !== this.viewer ? k.t : t;
        if (to >= 0 && to !== s.t) {
          const key = `${s.group.join(',')}|${s.t}|${to}`;
          if (this._atk?.key !== key) {
            const p = to === this.hoverTile && this.hoverPlan ? this.hoverPlan : g.plan(this.groupUnits(), s.t, to);
            this._atk = { key, plan: p ? { attack: !!p.attack && p.turns[p.turns.length - 1] === 0 } : null };
          }
          plan = this._atk.plan;
        }
      }
      if (plan?.attack) cur = CURSORS.attack;
      else if (k && k.owner === this.viewer) cur = CURSORS.select;
      else if (city && city.owner === this.viewer) cur = CURSORS.city;
      else if (plan) cur = CURSORS.move;
      else if (k || city) cur = CURSORS.look;
    }
    if (this.renderer.domElement.style.cursor !== cur) this.renderer.domElement.style.cursor = cur;
  }

  _rightClick(e) {
    const g = this.game;
    if (!g || dialogOpen()) return;
    const hit = this.view.pickFigure(e.clientX, e.clientY, this.renderer.domElement);
    const t = this._pickTile(this._ndc(e));
    const s = this.sel;
    if (this.human && s && s.owner === this.viewer) {
      if (this.busy) return;
      // a figure under the cursor is the target, unless it is the selection itself and the
      // pointer is on another tile (the ground right next to a castle)
      // (in a city: the corner clicked, where the group will stand)
      let target = hit?.stackId != null ? g.stack(hit.stackId)?.t : t;
      const own = (x) => x === s.t && this.groupUnits().every((u) => g.stackOfUnit(u.id)?.t === x);
      if (target != null && own(target) && t >= 0 && !own(t)) target = t;
      if (target == null || target < 0) return;
      if (own(target)) return s.city != null ? this.openCity(g.s.cities[s.city]) : undefined;
      return this.moveTo(target);
    }
    if (hit?.stackId != null) return this._info(g.stack(hit.stackId).t, true);
    if (t >= 0) this._info(t, true);
    else this.select(null);
  }

  _ndc(e) { return new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); }

  /** Information about what stands on tile t (other sides' armies show when in view). */
  _info(t, full = false) {
    const g = this.game;
    const city = g.cityAt(t);
    const vis = this.viewer != null ? g.visible(this.viewer) : null;
    if (city) {
      if (city.owner === this.viewer) return this.openCity(city);
      const units = g.unitsIn(city);
      if (units.length && (vis?.[city.t] || !g.s.options.fogOfWar)) return stackInfoDialog(this, units, city.owner, `${city.name} — ${units.length} defenders`);
      return this.openCity(city);
    }
    const k = g.stackAt(t);
    if (k && g.canSee(this.viewer, k, vis)) {
      if (k.owner === this.viewer && !full) return this.selectStack(k.id);
      const hero = k.units.find((u) => u.hero);
      return stackInfoDialog(this, k.units, k.owner, hero ? `${hero.hero.name}'s army` : `${k.units.length} ${k.units.length === 1 ? 'army' : 'armies'}`);
    }
  }

  _key(e) {
    if (!this.game) return;
    if (document.getElementById('battle')) return;
    const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    if (e.code === 'Escape') {
      if (closeTopDialog()) return;
      if (dialogOpen()) return; // a dialog that must be answered
      if (field) e.target.blur();
      // deselect; an order still playing out must not select its group again when it ends
      if (this.sel || this.busy) { this.keepDeselected = this.busy; this.select(null); return; }
      this.openGameMenu();
      return;
    }
    if (field) return;
    if (dialogOpen() || !this.human) return;
    const hero = this.groupUnits().find((u) => u.hero);
    switch (e.code) {
      case 'KeyN': case 'Tab': e.preventDefault(); this.nextGroup(); break;
      case 'KeyM': this.continueMove(); break;
      case 'KeyX': case 'Backspace': this.cancelRoute(); break;
      case 'KeyL': this.leaveGroup(); break;
      case 'KeyZ': if (this.sel) this.defendGroup(); break;
      case 'KeyF': if (!e.repeat) this.searchRuin(); break;
      case 'KeyT': if (!e.repeat) this.pickUpItems(); break;
      case 'KeyC': this.openCast(hero); break;
      case 'KeyH': this.openHero(hero ?? this.sel?.units.find((u) => u.hero)); break;
      case 'KeyG': this.selectAll(); break;
      case 'Enter': this.endTurnClicked(); break;
      case 'KeyR': this.openReports(); break;
      case 'KeyP': this.openDiplomacy(); break;
      case 'KeyV': this.openVectoring(); break;
      default: break;
    }
  }
}

export { UNITS, HERO_CLASSES };
