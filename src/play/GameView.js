import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Flag, CastleLevels } from '../generator/terrainTypes.js';
import { Army, HeroFigure, PathView, loadModelsFor, HERO_TYPES } from '../render/Heroes.js';
import { GATES } from '../generator/settlements.js';
import { SIDES, NEUTRAL_POOL } from '../game/data/sides.js';
import { GUARDIANS } from '../game/data/units.js';
import { HERO_CLASSES } from '../game/data/heroes.js';
import { SPELLS } from '../game/data/spells.js';
import { leaderOf, unitPower, unitStats, groupMover } from '../game/rules.js';
import { SpellFX } from '../render/SpellFX.js';
import { SignpostView } from '../render/Signposts.js';
import { GroundItemsView } from '../render/GroundItems.js';
import { createSpecials, specialFootprints, structureFootprints } from '../render/Structures.js';
import { Obstacles } from '../game/obstacles.js';
import { SPECIAL_TYPES } from '../game/specials.js';

// How the game state looks on the map. A stack in the field is drawn as a small formation
// of its leader and up to three more of its armies (a badge counts them all). A city is
// 2×2 tiles and each of its tiles holds a stack of its own: over that tile's corner of the
// castle it shows as a medallion token with the portrait of the stack's hero, or else its
// strongest army, in its side's colours, and a count. Enemy stacks show only where the
// viewer can see them (fog of war).
const MAX_FIGURES = 4;
const MARCH_SPEED = 1.62; // animation pace of a march (1 = the test bench's walking speed)
const CORNER = 0.62; // how far out from the keep a city tile's stack stands, in tiles on each axis (the courtyard corner)
const TOKEN_LIFT = 1.9; // a garrison token floats this high over its corner, above the walls
const TOKEN_PX = [22, 46]; // token diameter range (CSS px), scaled with the zoom so corners never overlap
const TOKEN_SLIDE = 5; // world units per second a token slides from corner to corner

export class GameView {
  constructor({ scene, camera, world, labelParent }) {
    this.scene = scene;
    this.camera = camera;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'game-view';
    scene.add(this.group);
    this.labels = new THREE.Group();
    (labelParent ?? scene).add(this.labels);
    this.path = new PathView(this.group);
    this.fx = new SpellFX(scene, { heightAt: (x, z) => this.heightAt(x, z) });
    this.models = {};
    this.stackViews = new Map(); // stack id -> { army, key, badge, t, city } (a garrison: { token, anchor, x, z } instead of army)
    this.tokenMarches = new Set(); // garrison tokens sliding between corners
    this.portraits = null; // set by the Controller; tokens show its portraits
    this.marching = new Set(); // armies being animated
    this.hidden = new Set(); // unit ids whose stacks are not drawn (being animated)
    this.endYaw = new Map(); // unit id -> heading its last march ended on
    this.auras = new Map(); // `${stackId}|${spell}` -> aura
    this.cityLabels = new Map();
    this.game = null;
    this.viewer = null; // player whose eyes we see through
    this.speed = 1;
    this.selectedStacks = new Set();
    this.selectedCity = null;
    this.hoverStack = null; // figure under the pointer
    this.hoverCity = null; // city under the pointer (no figure)
    this.signposts = new SignpostView(this.group);
    this.ground = new GroundItemsView(this.group); // what fallen heroes left
    this.cityRing = this._makeCityRing();
    this.cityHoverRing = this._makeCityRing(0.4);
    this.group.add(this.cityRing, this.cityHoverRing);
    this._vis = null;
  }

  // --- setup -----------------------------------------------------------------------------------
  /** Binds a game (after World.build(map)). Loads the models its sides can field. */
  async attach(game, onProgress = () => {}) {
    this.clear();
    this.game = game;
    const types = new Set();
    for (const p of game.s.players) {
      const side = SIDES[p.id];
      side.units.forEach((u) => types.add(u));
      side.allies.forEach((u) => types.add(u));
      side.mercs.forEach((u) => types.add(u));
      side.heroes.forEach((h) => types.add(HERO_CLASSES[h].model));
    }
    NEUTRAL_POOL.forEach((u) => types.add(u));
    for (const c of game.s.cities) c.prod.forEach((u) => types.add(u));
    for (const k of game.s.stacks) k.units.forEach((u) => types.add(u.type));
    // summons and ruin guardians load in the background
    const later = new Set([...Object.values(GUARDIANS).flat(), ...Object.values(SPELLS).flatMap((s) => (s.summon ?? []).map((x) => x[0]))]);
    const list = [...types].filter((t) => HERO_TYPES[t]);
    let done = 0;
    await Promise.all(list.map((t) => loadModelsFor([t]).then((m) => { Object.assign(this.models, m); onProgress(++done / list.length); })));
    loadModelsFor([...later].filter((t) => !this.models[t])).then((m) => Object.assign(this.models, m));
    this._buildCityLabels();
    this.signposts.build(game.signposts, { tileCenter: (t) => this.tileCenter(t), heightAt: this.heightAt, tileSize: this.map.grid.tileSize });
    this.signposts.clearTrees(this.world.parts?.vegetation);
    // special sites: no trees on their tiles
    this.signposts.clearTrees(this.world.parts?.vegetation, 1.75, game.specials.map((x) => new THREE.Vector3(x.x, 0, x.z)));
    this.refreshSpecials();
    this._riverLevels();
    this.world.glow.patch(this.group);
  }

  /** (Re)draws the special sites (owners' pennants, razed ones charred); armies walk around the standing ones. */
  refreshSpecials() {
    const g = this.game;
    if (!g) return;
    this.specialGroup?.traverse((o) => { if (o.isInstancedMesh) { o.material.dispose(); o.dispose(); } });
    this.specialGroup?.removeFromParent();
    const list = g.specials.map((x) => ({ model: SPECIAL_TYPES[x.type].model, x: x.x, z: x.z, y: this._siteGround(x.x, x.z), yaw: x.yaw, owner: g.siteOwner(x), razed: !!g.s.specials[x.i]?.razed }));
    this.specialGroup = createSpecials(list);
    if (this.specialGroup) this.group.add(this.specialGroup);
    this.world.glow.patch(this.specialGroup);
    // every standing site shows its azure lantern; the forges of smithies and weaponmasters blaze at night too
    this.world.glow.setExtra(list.filter((x) => !x.razed).flatMap((x) => [
      { x: x.x, z: x.z, r: 1.5, color: 'site', k: 0.55 },
      ...(/Smithy|Weaponmaster/.test(x.model) ? [{ x: x.x, z: x.z, r: 1.6, color: 'forge', k: 0.85 }] : []),
    ]));
    this.world.obstacles = new Obstacles([...structureFootprints(this.map), ...specialFootprints(list)]);
  }

  /** Where a site's base sits: the lowest ground under its footprint, so on a slope it digs
   * into the high side instead of hanging over the low one. */
  _siteGround(x, z) {
    const T = this.map.grid.tileSize;
    const c = this.heightAt(x, z);
    let y = c;
    // the models' bases reach about half a tile out, their corners three quarters
    for (const r of [0.25, 0.5, 0.72]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        y = Math.min(y, this.heightAt(x + Math.cos(a) * r * T, z + Math.sin(a) * r * T));
      }
    }
    return Math.max(y, c - 1.2); // on a cliff edge, don't bury the doors
  }

  /** Water level of the river on each tile (NaN: none), for boats on river voyages. */
  _riverLevels() {
    const g = this.map.grid, W = g.tilesW;
    const lv = (this.riverLevel = new Float32Array(W * g.tilesH).fill(NaN));
    const best = new Float32Array(W * g.tilesH).fill(Infinity);
    for (const r of this.map.rivers ?? []) {
      for (let i = 0; i < r.x.length; i++) {
        const t = this.tileAt(r.x[i], r.z[i]);
        if (t < 0) continue;
        const c = this.tileCenter(t), d = Math.hypot(c.x - r.x[i], c.z - r.z[i]);
        if (d < best[t]) { best[t] = d; lv[t] = r.s[i]; }
      }
    }
  }

  /** isSeaAt for an army on a voyage: afloat at sea and on the river tiles of its route. */
  _voyageSeaAt(river) {
    const f = (x, z) => { const t = this.tileAt(x, z); return t >= 0 && (this.game.move.isSea(t) || river.has(t)); };
    f.level = (x, z) => { const t = this.tileAt(x, z); return t >= 0 && river.has(t) && !this.game.move.isSea(t) ? Math.max(0, this.riverLevel?.[t] || 0) : 0; };
    return f;
  }

  /** Makes sure the models of `types` are loaded (summons, allies from ruins). */
  async ensureModels(types) {
    const missing = types.filter((t) => !this.models[t] && HERO_TYPES[t]);
    if (missing.length) Object.assign(this.models, await loadModelsFor(missing));
  }

  clear() {
    for (const v of this.stackViews.values()) this._disposeView(v);
    for (const a of this.marching) a.dispose();
    for (const m of this.tokenMarches) this._disposeView(m);
    this.tokenMarches.clear();
    for (const a of this.auras.values()) a.dispose();
    this.stackViews.clear(); this.marching.clear(); this.auras.clear(); this.endYaw.clear();
    this.world.glow.setArmies([]);
    this.world.glow.setMoving([]);
    for (const l of this.cityLabels.values()) { l.element.remove(); l.removeFromParent(); }
    this.cityLabels.clear();
    this.signposts.clear();
    this.ground.clear();
    this.specialGroup?.removeFromParent();
    this.specialGroup = null;
    this.path.clear();
    this.hidden.clear();
  }

  _disposeView(v) {
    v.army?.dispose();
    if (v.badge) { v.badge.element.remove(); v.badge.removeFromParent(); }
    if (v.token) { v.token.element.remove(); v.token.removeFromParent(); v.anchor.removeFromParent(); }
  }

  // --- geometry helpers ----------------------------------------------------------------------------
  get map() { return this.world.map; }
  tileCenter(t) {
    const g = this.map.grid, W = g.tilesW;
    return { x: ((t % W) + 0.5) * g.tileSize - g.worldW / 2, z: (((t / W) | 0) + 0.5) * g.tileSize - g.worldH / 2 };
  }
  tileAt(x, z) {
    const g = this.map.grid;
    const tx = Math.floor((x + g.worldW / 2) / g.tileSize), ty = Math.floor((z + g.worldH / 2) / g.tileSize);
    if (tx < 0 || ty < 0 || tx >= g.tilesW || ty >= g.tilesH) return -1;
    return ty * g.tilesW + tx;
  }
  heightAt = (x, z) => this.world.walkHeightAt(x, z);
  /** Where walkers in magic flight float: over the sea and land they could not walk. */
  liftAt = (x, z) => {
    const t = this.tileAt(x, z);
    return t >= 0 && (!!this.game?.move.isSea(t) || !this.game?.move.base.passable(t));
  };
  isSeaAt = (x, z) => {
    const t = this.tileAt(x, z);
    return t >= 0 && !!this.game?.move.isSea(t);
  };
  /** Where the stack on city tile t stands: in that tile's corner of the castle, facing the gate. */
  cityTileSpot(city, t) {
    const mc = this.map.cities[city.id];
    const gate = GATES.find((g) => g.name === mc.gate) ?? { dx: 0, dy: 1 };
    const c = this.tileCenter(t);
    // out in the courtyard corner of that tile, between the keep and the walls
    const d = CORNER * this.map.grid.tileSize;
    return { x: mc.x + Math.sign(c.x - mc.x) * d, z: mc.z + Math.sign(c.z - mc.z) * d, yaw: Math.atan2(gate.dx, gate.dy) };
  }
  worldPos(t) {
    const c = this.tileCenter(t);
    return new THREE.Vector3(c.x, this.heightAt(c.x, c.z), c.z);
  }

  // --- figures ------------------------------------------------------------------------------------
  /** Up to MAX_FIGURES armies to draw for a stack: its leader first, then its strongest of
   * other kinds; a stack that can't fly always shows a walker (it needs the ship). */
  pickFigures(units, max = MAX_FIGURES) {
    const lead = leaderOf(units);
    const out = [lead];
    const seen = new Set([lead.type]);
    const rest = units.filter((u) => u !== lead).sort((a, b) => unitPower(b) - unitPower(a));
    for (const u of rest) { if (out.length >= max) break; if (!seen.has(u.type)) { out.push(u); seen.add(u.type); } }
    for (const u of rest) { if (out.length >= Math.min(max, units.length)) break; if (!out.includes(u)) out.push(u); }
    const flies = units.every((u) => unitStats(u).fly);
    if (!flies && out.every((u) => unitStats(u).fly)) {
      const w = units.find((u) => !unitStats(u).fly);
      if (w) out[out.length - 1] = w;
    }
    return out.filter((u) => this.models[u.type]);
  }

  _makeArmy(units, owner, max = MAX_FIGURES) {
    const figs = this.pickFigures(units, max).map((u) => new HeroFigure(u.type, this.models[u.type], owner));
    if (!figs.length) return null;
    const army = new Army(figs, owner);
    this.group.add(army.group);
    this.world.glow.patch(army.group);
    return army;
  }

  _badge(n, owner, hero) {
    const div = document.createElement('div');
    div.className = 'stack-badge' + (hero ? ' hero' : '');
    div.style.setProperty('--c', owner >= 0 ? SIDES[owner].color : '#8a8a8a');
    div.textContent = n;
    const obj = new CSS2DObject(div);
    this.labels.add(obj);
    return obj;
  }

  /** A garrison's medallion: the portrait of `lead` in `owner`'s colours, with the stack's count. */
  _makeToken(lead, owner, count, hero) {
    const div = document.createElement('div');
    div.className = 'garrison' + (hero ? ' hero' : '');
    div.style.setProperty('--c', owner >= 0 ? SIDES[owner].color : '#8a8a8a');
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    const disc = document.createElement('div');
    disc.className = 'g-disc';
    disc.append(img);
    div.append(disc);
    if (count > 1) {
      const n = document.createElement('div');
      n.className = 'g-count';
      n.textContent = count;
      div.append(n);
    }
    const token = new CSS2DObject(div);
    token.userData.portrait = { img, type: lead.type, owner };
    this._setPortrait(token);
    this.labels.add(token);
    const anchor = new THREE.Object3D(); // where spell auras gather
    this.group.add(anchor);
    return { token, anchor };
  }

  _setPortrait(token) {
    const p = token.userData.portrait;
    const url = this.portraits?.url(p.type, p.owner);
    if (url && p.img.getAttribute('src') !== url) p.img.src = url;
  }

  /** Portraits finished rendering: tokens that showed a placeholder pick them up. */
  refreshPortraits() {
    for (const v of this.stackViews.values()) if (v.token) this._setPortrait(v.token);
    for (const m of this.tokenMarches) this._setPortrait(m.token);
  }

  _placeToken(v, x, z) {
    v.x = x; v.z = z;
    const y = this.heightAt(x, z) + TOKEN_LIFT;
    v.token.position.set(x, y, z);
    v.anchor.position.set(x, y - TOKEN_LIFT, z);
  }

  /** Token size from the zoom: a little less than the gap between two corners on screen. */
  _tokenSize(v, pxPerUnit) {
    const d = this.camera.position.distanceTo(v.token.position);
    const px = Math.round(Math.min(TOKEN_PX[1], Math.max(TOKEN_PX[0], ((2 * CORNER * this.map.grid.tileSize * pxPerUnit) / d) * 0.72)));
    if (px !== v.px) { v.px = px; v.token.element.style.setProperty('--s', `${px}px`); }
  }

  /** A city's name floats over the keep; where its back corners' tokens would show under
   * the name on screen, the name rises just clear of them. */
  _clearLabels() {
    const tops = new Map(); // city id -> [{ x, top, r }] on screen
    const p = this._p ??= new THREE.Vector3();
    for (const v of this.stackViews.values()) {
      if (!v.token || !v.px) continue;
      p.copy(v.token.position).project(this.camera);
      if (p.z > 1) continue;
      const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
      // the disc is lifted 62% of its size over the anchor (CSS), plus the hover/selected rise
      (tops.get(v.city) ?? tops.set(v.city, []).get(v.city)).push({ x, top: y - v.px * 1.2, r: v.px * 0.6 });
    }
    for (const [id, l] of this.cityLabels) {
      const list = tops.get(id);
      let lift = 0;
      if (list && l.element.style.display !== 'none') {
        p.copy(l.position).project(this.camera);
        const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
        const hw = l.element.offsetWidth / 2, hh = l.element.offsetHeight / 2;
        for (const t of list) if (Math.abs(t.x - x) < hw + t.r) lift = Math.max(lift, y + hh + 3 - t.top);
      }
      const want = lift > 0 ? `${-Math.ceil(lift)}px` : '';
      if (l.element.style.marginTop !== want) l.element.style.marginTop = want;
    }
  }

  // --- sync with the game state -----------------------------------------------------------------------
  /** Rebuilds what changed: stack views, garrisons, castles' owners, labels, auras. */
  sync() {
    const g = this.game;
    if (!g) return;
    const viewer = this.viewer;
    const vis = viewer != null && g.s.options.fogOfWar ? g.visible(viewer) : null;
    this._vis = vis;
    const hidden = this.hidden;
    const seen = new Set();
    for (const k of g.s.stacks) {
      if (k.units.some((u) => hidden.has(u.id))) continue;
      const city = g.cityAt(k.t);
      if (city) {
        // a garrison shows while any of its city is in view
        if (viewer != null && k.owner !== viewer && vis && !city.tiles.some((t) => vis[t])) continue;
      } else if (viewer != null && !g.canSee(viewer, k, vis)) continue;
      seen.add(k.id);
      const lead = city ? leaderOf(k.units) : null;
      const key = `${k.owner}|${k.t}|${city ? lead.id : this.pickFigures(k.units).map((u) => u.id).join(',')}|${k.units.length}`;
      const v = this.stackViews.get(k.id);
      if (v && v.key === key) continue;
      if (v) this._disposeView(v);
      if (city) {
        const view = { ...this._makeToken(lead, k.owner, k.units.length, !!lead.hero), key, t: k.t, stack: k.id, city: city.id };
        const spot = this.cityTileSpot(city, k.t);
        this._placeToken(view, spot.x, spot.z);
        this.stackViews.set(k.id, view);
        continue;
      }
      const army = this._makeArmy(k.units, k.owner);
      if (!army) continue;
      const c = this.tileCenter(k.t);
      // a group in magic flight that ran out of movement over water stays aloft
      if (!army.fly && this.liftAt(c.x, c.z) && groupMover(k.units).fly) army.liftAt = this.liftAt;
      // keep facing the way it last marched (a ship doesn't swing round when it stops)
      army.place(c.x, c.z, v?.army?.yaw ?? this.endYaw.get(k.units[0].id) ?? 0, this.heightAt, this.world.obstacles);
      const badge = k.units.length > 1 || k.units.some((u) => u.hero) ? this._badge(k.units.length, k.owner, k.units.some((u) => u.hero)) : null;
      this.stackViews.set(k.id, { army, key, badge, t: k.t, stack: k.id, city: null });
    }
    for (const [id, v] of this.stackViews) if (!seen.has(id)) { this._disposeView(v); this.stackViews.delete(id); }
    // every army in view glows in its side's colour; searched ruins dim
    this.world.glow.setArmies([...this.stackViews.entries()].map(([id, v]) => ({ x: v.army?.x ?? v.x, z: v.army?.z ?? v.z, owner: g.stack(id)?.owner ?? -1 })));
    this.world.glow.setExplored(g.s.sites.map((x) => x.explored));
    this.world.parts.siteFX?.userData.setExplored(g.s.sites.map((x) => x.explored));
    this._syncAuras();
    this.refreshGround();
    this._syncCityLabels();
    this._syncSelection();
  }

  /** Items fallen heroes left, where the viewer can see them: in a corner of the tile, clear of an army there. */
  refreshGround() {
    const g = this.game;
    if (!g) return;
    const vis = this._vis, T = this.map.grid.tileSize;
    this.ground.set(g.s.ground.filter((x) => !vis || vis[x.t]).map((x) => {
      const c = this.tileCenter(x.t);
      const px = c.x + 0.3 * T, pz = c.z + 0.3 * T;
      return { t: x.t, x: px, z: pz, y: this.heightAt(px, pz) };
    }));
  }

  /** The castles show their owners and levels (call after captures and building). */
  refreshCastles() {
    const g = this.game;
    for (const c of g.s.cities) {
      const mc = this.map.cities[c.id];
      mc.owner = c.owner;
      mc.level = c.level;
      mc.razed = c.razed;
      mc.capital = c.capital;
    }
    this.world.refreshCastles();
    this._syncCityLabels(true);
    this.refreshSpecials();
  }

  _buildCityLabels() {
    for (const c of this.game.s.cities) {
      const div = document.createElement('div');
      div.className = 'city-label';
      const mc = this.map.cities[c.id];
      const obj = new CSS2DObject(div);
      obj.position.set(mc.x, mc.y + 3.1, mc.z);
      this.labels.add(obj);
      this.cityLabels.set(c.id, obj);
    }
    this._syncCityLabels(true);
  }

  _syncCityLabels(force = false) {
    const g = this.game;
    const ex = this.viewer != null && g.s.options.hiddenMap ? g.explored(this.viewer) : null;
    for (const c of g.s.cities) {
      const l = this.cityLabels.get(c.id);
      if (!l) continue;
      const known = !ex || ex[c.tiles[0]];
      l.visible = !!known;
      const sig = `${c.owner}|${c.level}|${c.razed}|${c.capital}`;
      if (!force && l.userData.sig === sig) continue;
      l.userData.sig = sig;
      const color = c.owner >= 0 ? SIDES[c.owner].color : '#9a9a9a';
      l.element.className = 'city-label' + (c.capital ? ' capital' : '') + (c.razed ? ' razed' : '');
      l.element.innerHTML = `<span class="dot" style="background:${color}"></span>${c.capital ? '♛ ' : ''}${c.name}${c.razed ? ' <i>(razed)</i>' : `<span class="lvl">${'◆'.repeat(c.level)}</span>`}`;
      l.element.title = `${c.owner >= 0 ? SIDES[c.owner].name : 'Neutral'} · ${c.razed ? 'Razed' : CastleLevels[c.level].name}`;
    }
  }

  _syncAuras() {
    const g = this.game;
    const want = new Map();
    for (const [id, v] of this.stackViews) {
      const k = g.stack(id);
      if (!k) continue;
      for (const u of k.units) for (const sp of u.hero?.active ?? []) want.set(`${id}|${sp}`, { obj: v.army?.members[0].root ?? v.anchor, sp });
    }
    for (const [key, a] of this.auras) {
      const w = want.get(key);
      if (!w || a.obj !== w.obj) { a.dispose(); this.auras.delete(key); }
    }
    for (const [key, w] of want) {
      if (this.auras.has(key)) continue;
      try {
        const a = this.fx.aura(w.obj, w.sp, { heightAt: this.heightAt });
        a.obj = w.obj;
        this.auras.set(key, a);
      } catch (e) { /* unknown aura */ }
    }
  }

  // --- selection ---------------------------------------------------------------------------------------
  /** Rings the stacks `stackIds` (the selected group), and the city `cityId` when the whole garrison is meant. */
  select(stackIds = [], cityId = null) {
    this.selectedStacks = new Set(stackIds);
    this.selectedCity = cityId;
    this._syncSelection();
  }

  /** What a left click would pick: a figure (stack id) or else a city (city id). */
  setHover(stackId = null, cityId = null) {
    if (stackId === this.hoverStack && cityId === this.hoverCity) return;
    this.hoverStack = stackId;
    this.hoverCity = cityId;
    this._syncSelection();
  }

  _syncSelection() {
    for (const [id, v] of this.stackViews) {
      const sel = this.selectedStacks.has(id) ? true : id === this.hoverStack ? 'hover' : false;
      if (v.army) v.army.setSelected(sel);
      else {
        v.token.element.classList.toggle('selected', sel === true);
        v.token.element.classList.toggle('hover', sel === 'hover');
      }
    }
    const c = this.selectedCity != null ? this.game?.s.cities[this.selectedCity] : null;
    this._layCityRing(this.cityRing, c);
    const hc = this.hoverCity != null && this.hoverCity !== this.selectedCity ? this.game?.s.cities[this.hoverCity] : null;
    this._layCityRing(this.cityHoverRing, hc);
  }

  _layCityRing(ring, c) {
    ring.visible = !!c;
    if (!c) return;
    const mc = this.map.cities[c.id];
    // lay the ring on the ground around the walls
    const pos = ring.geometry.attributes.position;
    if (!ring.userData.base) ring.userData.base = pos.array.slice();
    const base = ring.userData.base;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      pos.setY(i, Math.max(0.02, this.world.heightAt(mc.x + x, mc.z + z)) + 0.1);
    }
    pos.needsUpdate = true;
    ring.geometry.computeBoundingSphere();
    ring.position.set(mc.x, 0, mc.z);
    ring.material.color.set(c.owner >= 0 ? SIDES[c.owner].color : '#aaaaaa').multiplyScalar(1.8);
  }

  _makeCityRing(opacity = 0.85) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.55, 2.85, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false, toneMapped: false }),
    );
    ring.renderOrder = 5;
    ring.visible = false;
    return ring;
  }

  // --- picking -------------------------------------------------------------------------------------------
  /** The stack whose figure is drawn under the pointer (in the field or in a castle corner): { stackId } | null. */
  pickFigure(clientX, clientY, dom) {
    const r = dom.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    let best = null, bd = 26;
    const test = (army, hit) => {
      for (const m of army.members) {
        if (!m.root.visible) continue;
        m.pickSegment(A, B);
        const a = A.project(this.camera), b = B.project(this.camera);
        if (a.z > 1 || b.z > 1) continue;
        const ax = (a.x * 0.5 + 0.5) * r.width, ay = (-a.y * 0.5 + 0.5) * r.height;
        const bx = (b.x * 0.5 + 0.5) * r.width, by = (-b.y * 0.5 + 0.5) * r.height;
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(px - ax - dx * t, py - ay - dy * t);
        if (d < bd) { bd = d; best = hit; }
      }
    };
    for (const [id, v] of this.stackViews) {
      if (v.army) { test(v.army, { stackId: id }); continue; }
      // a token: anywhere on its disc wins over a figure merely near the pointer
      const e = v.token.element.querySelector('.g-disc')?.getBoundingClientRect();
      if (!e || !e.width || v.token.element.style.display === 'none') continue;
      const d = Math.hypot(clientX - (e.left + e.width / 2), clientY - (e.top + e.height / 2)) - e.width / 2 - 3;
      if (d < 0 && d - 100 < bd) { bd = d - 100; best = { stackId: id }; }
    }
    return best;
  }

  // --- movement ------------------------------------------------------------------------------------------
  /** Route points over tile centres (bridges walked deck end to end), for Army.follow / PathView. */
  routePoints(tiles, costs = [], fly = false, afloat = null) {
    const pts = [];
    tiles.forEach((t, i) => {
      const c = this.tileCenter(t);
      const sea = !fly && (afloat ? !!afloat[i] : this.game.move.isSea(t));
      const bridge = !fly && !!(this.map.flags[t] & Flag.BRIDGE);
      const b = bridge && this.map.bridges.find((q) => Math.hypot(q.x - c.x, q.z - c.z) < this.map.grid.tileSize * 1.2);
      if (b) {
        const prev = pts[pts.length - 1] ?? c, L = b.length / 2;
        const ends = [[b.x - b.dirX * L, b.z - b.dirZ * L], [b.x + b.dirX * L, b.z + b.dirZ * L]];
        if (Math.hypot(ends[0][0] - prev.x, ends[0][1] - prev.z) > Math.hypot(ends[1][0] - prev.x, ends[1][1] - prev.z)) ends.reverse();
        for (const [x, z] of ends) pts.push({ x, z, sea, bridge, cost: costs[i] ?? 1, tile: t, i });
        return;
      }
      // the last stop in a city is its castle
      pts.push({ x: c.x, z: c.z, sea, bridge, cost: costs[i] ?? 1, tile: t, i });
    });
    return pts;
  }

  /**
   * Animates `units` (already moved in the game state) walking `steps` (tiles). Resolves when
   * they arrive. `follow(pos)` is called each frame with the army's position (camera follow).
   */
  animateMarch(units, owner, steps, { fly = false, follow = null, costs = [], afloat = null, onTile = null } = {}) {
    if (steps.length < 2) return Promise.resolve();
    for (const u of units) this.hidden.add(u.id);
    this.sync();
    // a move between tiles of one city stays in the courtyard: the stack's leader (as a
    // garrison is drawn) walks from corner to corner around the keep, through no walls
    const startCity = this.game.cityAt(steps[0]);
    if (startCity && steps.every((t) => this.game.cityAt(t) === startCity)) {
      // within one city the stack's token slides from corner to corner
      const lead = leaderOf(units);
      const m = { ...this._makeToken(lead, owner, units.length, !!lead.hero), pts: steps.map((t) => this.cityTileSpot(startCity, t)), i: 1, follow, units };
      this._placeToken(m, m.pts[0].x, m.pts[0].z);
      m.token.element.classList.add('moving');
      this.tokenMarches.add(m);
      return new Promise((resolve) => { m.done = resolve; });
    }
    const army = this._makeArmy(units, owner);
    if (!army) { for (const u of units) this.hidden.delete(u.id); this.sync(); return Promise.resolve(); }
    const pts = this.routePoints(steps, costs, fly, afloat);
    if (fly) army.liftAt = this.liftAt;
    // a river voyage: afloat on the river tiles of the route
    const river = new Set(fly || !afloat ? [] : steps.filter((t, i) => afloat[i] && !this.game.move.isSea(t)));
    if (river.size) army.isSeaAt = this._voyageSeaAt(river);
    // leave a city from the corner it stood in, stop in the corner of the tile it goes to
    if (startCity) { const s = this.cityTileSpot(startCity, steps[0]); pts[0] = { ...pts[0], x: s.x, z: s.z }; }
    const endCity = this.game.cityAt(steps[steps.length - 1]);
    if (endCity) { const s = this.cityTileSpot(endCity, steps[steps.length - 1]); pts[pts.length - 1] = { ...pts[pts.length - 1], x: s.x, z: s.z }; }
    return this._march(army, units, pts, follow, onTile, steps[0]);
  }

  _march(army, units, pts, follow, onTile, tile0) {
    const p0 = pts[0], p1 = pts[1];
    army.place(p0.x, p0.z, Math.atan2(p1.x - p0.x, p1.z - p0.z), this.heightAt, null);
    this.marching.add(army);
    army.followCb = follow;
    army.onTile = onTile;
    army.tileNow = tile0;
    return new Promise((resolve) => {
      army.follow(pts, () => {
        this.marching.delete(army);
        for (const u of units) this.endYaw.set(u.id, army.yaw);
        this.world.glow.setMoving([...this.marching].map((a) => ({ x: a.x, z: a.z, owner: a.owner })));
        army.dispose();
        for (const u of units) this.hidden.delete(u.id);
        this.sync();
        resolve();
      });
    });
  }

  // --- path preview ------------------------------------------------------------------------------------------
  showPlan(plan, { dim = false } = {}) {
    if (!plan) { this.path.clear(); return; }
    const pts = this.routePoints(plan.path.tiles, plan.path.costs, plan.mover.fly, plan.path.afloat);
    this.path.show(pts, pts.map((p) => plan.turns[p.i]), this.heightAt, { dim });
    if (plan.attack) {
      // the goal marker turns red over an enemy
      this.path.goal.material.color.setRGB(2.2, 0.35, 0.25);
    }
  }
  clearPlan() { this.path.clear(); }

  // --- frame -----------------------------------------------------------------------------------------------
  update(dt) {
    const obs = this.world.obstacles;
    const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    for (const v of this.stackViews.values()) {
      if (v.token) { this._tokenSize(v, pxPerUnit); continue; }
      v.army.update(dt, this.heightAt, this.isSeaAt, obs);
      if (v.badge) {
        const m = v.army.members[0].root.position;
        v.badge.position.set(v.army.x, m.y + 1.25 + (v.army.members[0].fly ? v.army.members[0].hover * 0.5 : 0), v.army.z);
      }
    }
    this._clearLabels();
    for (const m of this.tokenMarches) {
      this._tokenSize(m, pxPerUnit);
      const p = m.pts[m.i];
      const dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz), step = dt * this.speed * TOKEN_SLIDE;
      if (d > step) this._placeToken(m, m.x + (dx / d) * step, m.z + (dz / d) * step);
      else {
        this._placeToken(m, p.x, p.z);
        if (++m.i >= m.pts.length) {
          this.tokenMarches.delete(m);
          this._disposeView(m);
          for (const u of m.units) this.hidden.delete(u.id);
          this.sync();
          m.done();
          continue;
        }
      }
      m.follow?.(new THREE.Vector3(m.x, this.heightAt(m.x, m.z), m.z));
    }
    for (const a of this.marching) {
      a.update(dt * this.speed * MARCH_SPEED, this.heightAt, a.isSeaAt ?? this.isSeaAt, obs);
      a.followCb?.(new THREE.Vector3(a.x, this.heightAt(a.x, a.z), a.z));
      // what happens on a tile (a shrine's blessing ...) shows as the army gets there
      const t = this.tileAt(a.x, a.z);
      if (t !== a.tileNow && t >= 0) { a.tileNow = t; a.onTile?.(t); }
    }
    if (this.marching.size) this.world.glow.setMoving([...this.marching].map((a) => ({ x: a.x, z: a.z, owner: a.owner })));
    this.ground.update();
    this.fx.update(dt);
  }
}
