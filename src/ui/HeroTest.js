import * as THREE from 'three';
import { Factions, Flag, TileInfo } from '../generator/terrainTypes.js';
import { MoveGrid, findPath, turnsAlong } from '../game/pathfinding.js';
import { ARMY_MAX, Army, HERO_TYPES, HeroFigure, PathView, getFigureScale, loadHeroModels, setFigureScale } from '../render/Heroes.js';

/**
 * Hero and army movement test bench for the map generator. Armies placed here live only in
 * the scene: they are not part of the generated map, its export or its seed, and
 * they're cleared whenever a new map is built.
 *
 *   Place -> click a tile puts down one hero or unit (an army of one); the army
 *   composer puts down up to ARMY_MAX of them as one army on one tile, hero in front.
 *   Click any member to select its army; hover shows the cheapest route (green = this
 *   turn, amber = later turns, blue = at sea) and clicking a tile marches there. An
 *   army spends movement points (MP) and stops when they run out; End turn refills MP
 *   and armies carry on along their routes. An army of flyers flies over anything.
 */
export class HeroTest {
  constructor({ scene, camera, renderer, world, gui }) {
    this.scene = scene;
    this.camera = camera;
    this.dom = renderer.domElement;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'hero-test';
    scene.add(this.group);
    this.path = new PathView(this.group);
    this.armies = [];
    this.selected = null;
    this.placing = null; // null, 'one' or 'army'
    this.models = null;
    this.grid = null;
    this.mouse = new THREE.Vector2(9, 9);
    this.mouseDirty = false;
    this.hoverTile = -1;
    this.hoverPath = null;
    this.raycaster = new THREE.Raycaster();
    this.counter = 0;

    this.opts = {
      type: 'paladin',
      owner: Factions[0].name,
      mp: 16,
      limitMp: true,
      place: () => this.setPlacing(this.placing === 'one' ? null : 'one'),
      endTurn: () => this.endTurn(),
      remove: () => this.removeSelected(),
      clear: () => this.clearHeroes(),
      scale: getFigureScale(),
    };
    const f = gui.addFolder('Heroes & armies (test only, not saved)');
    const types = Object.fromEntries(Object.entries(HERO_TYPES).map(([k, t]) => [t.name, k]));
    f.add(this.opts, 'scale', 0.3, 1.5, 0.05).name('Figure scale').onChange(setFigureScale);
    f.add(this.opts, 'type', types).name('Hero / unit');
    f.add(this.opts, 'owner', Factions.map((x) => x.name)).name('Owner');
    this.placeCtrl = f.add(this.opts, 'place').name('✚  Place (click map)');

    // army composer: up to ARMY_MAX slots, each a hero or unit type or empty
    const start = ['paladin', 'heavyinfantry', 'heavyinfantry', 'lightinfantry', 'lightinfantry', 'giant', 'catapult', 'archon'];
    this.army = { place: () => this.setPlacing(this.placing === 'army' ? null : 'army') };
    const af = f.addFolder(`Army composer (up to ${ARMY_MAX})`);
    const slotTypes = { '— empty —': '', ...types };
    for (let i = 0; i < ARMY_MAX; i++) {
      this.army[`s${i}`] = start[i] ?? '';
      af.add(this.army, `s${i}`, slotTypes).name(`Slot ${i + 1}`);
    }
    this.armyCtrl = af.add(this.army, 'place').name('✚  Place army (click map)');
    f.add(this.opts, 'mp', 4, 40, 1).name('Movement points').onChange(() => this.refreshPreview());
    f.add(this.opts, 'limitMp').name('Limit to MP per turn').onChange(() => this.refreshPreview());
    f.add(this.opts, 'endTurn').name('⏭  End turn (refill MP)');
    f.add(this.opts, 'remove').name('✖  Remove selected');
    f.add(this.opts, 'clear').name('Clear all armies');
    f.close();

    this.hud = document.createElement('div');
    this.hud.className = 'panel hero-hud';
    document.body.appendChild(this.hud);

    this._bindInput();
    loadHeroModels().then((m) => { this.models = m; this.renderHud(); });
  }

  /** New map: drop every test hero and rebuild the movement grid. */
  reset(map) {
    this.clearHeroes();
    this.grid = new MoveGrid(map);
    this.renderHud();
  }

  // --- helpers ---------------------------------------------------------------------------

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
  isSeaAt = (x, z) => {
    const t = this.tileAt(x, z);
    return t >= 0 && this.grid?.sea[t] === 1;
  };
  occupied(except) {
    return new Set(this.armies.filter((h) => h !== except).map((h) => h.tile));
  }
  armyAt(t) { return this.armies.find((h) => h.tile === t); }
  findPath(army, goal) {
    return findPath(this.grid, army.tile, goal, { blocked: this.occupied(army), fly: army.fly });
  }

  /** Route points for the army: tile centres (a flying army never takes ship);
   * `bridge` marks the tiles it crosses by bridge, walked over the deck end to end;
   * `i` is the point's index in path.tiles. */
  routePoints(path, army) {
    const pts = [];
    path.tiles.forEach((t, i) => {
      const c = this.tileCenter(t);
      const sea = !army?.fly && this.grid.sea[t] === 1;
      const bridge = !army?.fly && !!(this.map.flags[t] & Flag.BRIDGE);
      const b = bridge && this.map.bridges.find((q) => Math.hypot(q.x - c.x, q.z - c.z) < this.map.grid.tileSize * 1.2);
      if (b) {
        // over the deck, end to end, entering at the end nearer the previous point
        const prev = pts[pts.length - 1] ?? c, L = b.length / 2;
        const ends = [[b.x - b.dirX * L, b.z - b.dirZ * L], [b.x + b.dirX * L, b.z + b.dirZ * L]];
        if (Math.hypot(ends[0][0] - prev.x, ends[0][1] - prev.z) > Math.hypot(ends[1][0] - prev.x, ends[1][1] - prev.z)) ends.reverse();
        for (const [x, z] of ends) pts.push({ x, z, sea, bridge, cost: path.costs[i], tile: t, i });
        return;
      }
      pts.push({ x: c.x, z: c.z, sea, bridge, cost: path.costs[i], tile: t, i });
    });
    return pts;
  }

  // --- actions ---------------------------------------------------------------------------

  setPlacing(v) {
    this.placing = v;
    this.placeCtrl.name(v === 'one' ? '… click a tile (Esc cancels)' : '✚  Place (click map)');
    this.armyCtrl.name(v === 'army' ? '… click a tile (Esc cancels)' : '✚  Place army (click map)');
    this.dom.style.cursor = v ? 'copy' : '';
    this.renderHud();
  }

  /** Types placed by the current placing mode. */
  placingTypes() {
    if (this.placing === 'one') return [this.opts.type];
    return Array.from({ length: ARMY_MAX }, (_, i) => this.army[`s${i}`]).filter((t) => t && this.models?.[t]);
  }

  /** Can an army of `types` stand on tile t? Flyers may hover anywhere. */
  canStand(t, types) {
    return types.every((k) => HERO_TYPES[k].fly) || this.grid.land[t] < Infinity;
  }

  placeArmy(t, types) {
    if (!this.models || !this.grid || !types.length) return;
    if (!this.canStand(t, types) || this.armyAt(t)) return;
    const owner = Factions.findIndex((f) => f.name === this.opts.owner);
    const army = new Army(types.map((k) => new HeroFigure(k, this.models[k], owner)), owner);
    const lead = army.members[0];
    const n = ++this.counter;
    army.name = types.length === 1 ? `${HERO_TYPES[lead.type].name} ${n}`
      : lead.hero ? `${HERO_TYPES[lead.type].name}'s army ${n}` : `Army ${n}`;
    army.tile = t;
    army.mpMax = this.opts.mp;
    army.mp = this.opts.mp;
    army.plan = null; // remaining route beyond this turn
    const c = this.tileCenter(t);
    army.place(c.x, c.z, Math.atan2(this.camera.position.x - c.x, this.camera.position.z - c.z), this.heightAt, this.world.obstacles);
    this.group.add(army.group);
    this.armies.push(army);
    this.select(army);
  }

  /** "Paladin, 2× Heavy Infantry, Catapult" */
  composition(army) {
    const counts = new Map();
    for (const m of army.members) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    return [...counts].map(([k, c]) => (c > 1 ? `${c}× ` : '') + HERO_TYPES[k].name).join(', ');
  }

  select(hero) {
    this.selected?.setSelected(false);
    this.selected = hero;
    hero?.setSelected(true);
    this.hoverTile = -1;
    this.refreshPreview();
    this.renderHud();
  }

  removeSelected() {
    const h = this.selected;
    if (!h) return;
    this.select(null);
    h.dispose();
    this.armies = this.armies.filter((x) => x !== h);
    this.renderHud();
  }

  clearHeroes() {
    for (const h of this.armies) h.dispose();
    this.armies = [];
    this.selected = null;
    this.path.clear();
    this.setPlacing(null);
  }

  endTurn() {
    for (const h of this.armies) {
      h.mpMax = this.opts.mp;
      h.mp = h.mpMax;
    }
    // armies with a standing plan carry on
    for (const h of this.armies) if (h.plan && !h.moving) this.march(h, h.plan);
    this.refreshPreview();
    this.renderHud();
  }

  /** Plans the cheapest route for `army` to tile `goal` and sets off. */
  moveTo(hero, goal) {
    if (hero.moving || !this.grid) return;
    const path = this.findPath(hero, goal);
    if (!path) { this.flash('No route there'); return; }
    this.march(hero, path);
  }

  /** Walks as much of `path` as the hero's MP allow; keeps the rest as its plan. */
  march(hero, path) {
    const limit = this.opts.limitMp;
    let n = path.tiles.length - 1;
    if (limit) {
      const turns = turnsAlong(path, hero.mp, hero.mpMax);
      n = 0;
      while (n + 1 < path.tiles.length && turns[n + 1] === 0) n++;
    }
    // re-check that the tiles ahead are still free
    const blocked = this.occupied(hero);
    let k = 1;
    while (k <= n && !blocked.has(path.tiles[k])) k++;
    n = k - 1;
    if (n === 0) {
      hero.plan = path.tiles.length > 1 ? path : null;
      this.flash(limit && hero.mp < path.costs[1] ? 'Not enough movement points — End turn' : 'The way is blocked');
      this.refreshPreview();
      return;
    }
    const step = { tiles: path.tiles.slice(0, n + 1), costs: path.costs.slice(0, n + 1) };
    const spent = step.costs.reduce((a, b) => a + b, 0);
    if (n < path.tiles.length - 1) {
      const costs = [0, ...path.costs.slice(n + 1)];
      hero.plan = { tiles: path.tiles.slice(n), costs, total: costs.reduce((a, b) => a + b, 0) };
    } else hero.plan = null;
    const pts = this.routePoints(step, hero);
    // track the tile underfoot as the hero goes, so others path around it
    hero.follow(pts, () => {
      hero.tile = step.tiles[step.tiles.length - 1];
      this.refreshPreview();
      this.renderHud();
    });
    if (limit) hero.mp = Math.max(0, hero.mp - spent);
    hero.tile = step.tiles[step.tiles.length - 1];
    this.path.clear();
    this.renderHud();
  }

  // --- preview / HUD -----------------------------------------------------------------------

  refreshPreview() {
    this.hoverPath = null;
    const h = this.selected;
    if (!h || !this.grid || h.moving) { this.path.clear(); return; }
    const goal = this.hoverTile;
    let path = null, dim = false;
    if (goal >= 0 && goal !== h.tile && !this.placing) {
      path = this.findPath(h, goal);
      this.hoverPath = path;
    }
    if (!path && h.plan) { path = h.plan; dim = true; }
    if (!path) { this.path.clear(); this.renderHud(); return; }
    const turns = this.opts.limitMp ? turnsAlong(path, h.mp, h.mpMax) : path.tiles.map(() => 0);
    const pts = this.routePoints(path, h);
    this.path.show(pts, pts.map((p) => turns[p.i]), this.heightAt, { dim });
    this.renderHud();
  }

  flash(msg) {
    this.flashMsg = msg;
    this.flashUntil = performance.now() + 2200;
    this.renderHud();
  }

  renderHud() {
    const rows = [];
    if (!this.models) rows.push('<span class="dim">Loading hero and unit models…</span>');
    else if (this.placing === 'one') rows.push(`Click a tile to place a <b>${HERO_TYPES[this.opts.type].name}</b> · Shift keeps placing · Esc cancels`);
    else if (this.placing === 'army') {
      const types = this.placingTypes();
      rows.push(types.length ? `Click a tile to place an army of <b>${types.length}</b> · Shift keeps placing · Esc cancels`
        : '<span class="warn">The army composer is empty — pick some slots</span>');
    }
    const h = this.selected;
    if (h) {
      const tag = h.fly ? ' · flying' : this.grid?.sea[h.tile] ? ' · at sea' : '';
      const mp = this.opts.limitMp ? ` · MP <b>${fmt(h.mp)}</b>/${h.mpMax}` : '';
      rows.push(`<b>${h.name}</b> <span class="dim">(${Factions[h.owner]?.name ?? 'Neutral'})</span>${mp}${tag}`);
      if (h.members.length > 1) rows.push(`<span class="dim">${this.composition(h)}</span>`);
      const p = this.hoverPath;
      if (p && this.map) {
        const turns = this.opts.limitMp ? turnsAlong(p, h.mp, h.mpMax) : null;
        const nTurns = turns ? turns[turns.length - 1] + 1 : 1;
        const sea = !h.fly && p.tiles.some((t) => this.grid.sea[t]);
        const dest = TileInfo[this.map.tiles[p.tiles[p.tiles.length - 1]]].name;
        rows.push(`Route: <b>${fmt(p.total)} MP</b> · ${p.tiles.length - 1} tiles${turns ? ` · ${nTurns} turn${nTurns > 1 ? 's' : ''}` : ''}${sea ? ' · by sea' : ''} <span class="dim">→ ${dest}</span>`);
      } else if (this.hoverTile >= 0 && this.hoverTile !== h.tile && !h.moving) {
        rows.push('<span class="dim">No route there</span>');
      } else if (h.plan) {
        rows.push('<span class="dim">Route continues next turn</span>');
      } else if (!h.moving) {
        rows.push('<span class="dim">Hover a tile to see the route, click to march · Esc deselects</span>');
      }
    } else if (this.models && !this.placing && this.armies.length) {
      rows.push('<span class="dim">Click a hero or unit to select its army</span>');
    }
    if (this.flashMsg && performance.now() < this.flashUntil) rows.push(`<span class="warn">${this.flashMsg}</span>`);
    this.hud.innerHTML = rows.join('<br>');
    this.hud.classList.toggle('visible', rows.length > 0 && (!!this.placing || this.armies.length > 0 || !!this.flashMsg));
  }

  // --- input ---------------------------------------------------------------------------------

  _bindInput() {
    let down = null;
    this.dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved < 6 && quick) this.onClick(e);
    });
    this.dom.addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.mouseDirty = true;
    });
    this.dom.addEventListener('pointerleave', () => {
      this.hoverTile = -1;
      this.refreshPreview();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      if (this.placing) this.setPlacing(null);
      else this.select(null);
    });
  }

  pickTile(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.world.pick(this.raycaster.ray);
    if (!hit) return -1;
    const g = this.map.grid;
    if (hit.tx < 0 || hit.ty < 0 || hit.tx >= g.tilesW || hit.ty >= g.tilesH) return -1;
    return hit.ty * g.tilesW + hit.tx;
  }

  /** The army of the figure drawn under the cursor (screen-space, feet to head), if any. */
  pickHero(e) {
    const r = this.dom.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    let best = null, bd = 28;
    for (const army of this.armies) {
      for (const m of army.members) {
        if (!m.root.visible) continue;
        m.pickSegment(A, B);
        const a = A.project(this.camera), b = B.project(this.camera);
        const ax = (a.x * 0.5 + 0.5) * r.width, ay = (-a.y * 0.5 + 0.5) * r.height;
        const bx = (b.x * 0.5 + 0.5) * r.width, by = (-b.y * 0.5 + 0.5) * r.height;
        // distance to the feet-head segment
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(px - ax - dx * t, py - ay - dy * t);
        if (d < bd) { bd = d; best = army; }
      }
    }
    return best;
  }

  onClick(e) {
    if (!this.map || !this.grid) return;
    const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    if (this.placing) {
      const t = this.pickTile(ndc);
      if (t < 0) return;
      const types = this.placingTypes();
      if (!types.length) { this.flash('The army composer is empty'); return; }
      if (!this.canStand(t, types)) { this.flash('Only flyers can be placed off passable land'); return; }
      if (this.armyAt(t)) { this.flash('That tile is taken'); return; }
      this.placeArmy(t, types);
      if (!e.shiftKey) this.setPlacing(null);
      return;
    }
    const hero = this.pickHero(e);
    if (hero) {
      this.select(hero === this.selected ? null : hero);
      return;
    }
    const t = this.pickTile(ndc);
    if (t >= 0 && this.selected) this.moveTo(this.selected, t);
  }

  /** Called every frame. */
  update(dt) {
    if (this.mouseDirty && this.map && this.selected && !this.placing) {
      this.mouseDirty = false;
      const t = Math.abs(this.mouse.x) <= 1 ? this.pickTile(this.mouse) : -1;
      if (t !== this.hoverTile) {
        this.hoverTile = t;
        this.refreshPreview();
      }
    }
    for (const h of this.armies) h.update(dt, this.heightAt, this.isSeaAt, this.world.obstacles);
    if (this.flashMsg && performance.now() > this.flashUntil) {
      this.flashMsg = null;
      this.renderHud();
    }
  }
}

const fmt = (x) => (Math.round(x * 10) / 10).toString();
