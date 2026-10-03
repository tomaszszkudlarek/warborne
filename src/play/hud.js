import * as THREE from 'three';
import { Minimap } from '../ui/Minimap.js';
import { h } from './dom.js';
import { ICON, WEATHER_ICON } from './icons.js';
import { SIDES } from '../game/data/sides.js';
import { UNITS, BONUS_NAMES } from '../game/data/units.js';
import { HERO_CLASSES } from '../game/data/heroes.js';
import { ITEMS } from '../game/data/items.js';
import { TileInfo, Flag, CastleLevels, SiteTypes, Tile } from '../generator/terrainTypes.js';
import { unitStats, groupMover, unitName, typeName } from '../game/rules.js';
import { signpostLines } from '../game/signposts.js';
import { SPECIAL_TYPES } from '../game/specials.js';
import { standing } from '../game/diplomacy.js';
import { ruinChance } from '../game/combat.js';
import { hoverTip, mapStrengthHtml } from './strtip.js';

/** The strategic map with the game on it, drawn as pixel art (one block per tile): owners'
 * cities and armies in view as bold blocks in their side's colour, unexplored land dark. */
export class GameMinimap extends Minimap {
  constructor(container, onNavigate) {
    super(container, onNavigate);
    this.fog = document.createElement('canvas');
    this.game = null;
    this.viewer = null;
    this.fogKey = '';
  }

  setGame(game) { this.game = game; this.fogKey = ''; }

  /** The land at one pixel per tile, blown up without smoothing: rivers and roads are tiles too. */
  setMap(map) {
    this.map = map;
    const { tilesW: W, tilesH: H } = map.grid;
    const S = Math.max(3, Math.ceil(360 / W));
    this.scale = S;
    const px = document.createElement('canvas');
    px.width = W; px.height = H;
    const pc = px.getContext('2d');
    const img = pc.createImageData(W, H);
    const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
    const cache = new Map();
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const t = ty * W + tx, f = map.flags[t], tile = map.tiles[t];
        let color = TileInfo[tile].color;
        if (tile === Tile.WATER && f & Flag.FROZEN) color = '#c9dbe6';
        else if (f & Flag.LAVA) color = '#ff6a1a';
        else if (f & Flag.BRIDGE) color = '#b08a58';
        else if (f & Flag.RIVER && tile !== Tile.WATER) color = '#3b7fc4';
        else if (f & Flag.ROAD) color = '#a88458';
        if (!cache.has(color)) cache.set(color, rgb(color));
        const c = cache.get(color);
        // a faint checker gives the flat colours a hand-drawn grain
        const k = (tx + ty) & 1 ? 1.06 : 0.95;
        img.data.set([Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k), 255], t * 4);
      }
    }
    pc.putImageData(img, 0, 0);
    this.base.width = W * S; this.base.height = H * S;
    this.canvas.width = W * S; this.canvas.height = H * S;
    const c = this.base.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(px, 0, 0, W * S, H * S);
    // ruins and shrines: a small block each
    const g = map.grid;
    for (const site of map.sites) {
      const tx = Math.floor((site.x + g.worldW / 2) / g.tileSize), ty = Math.floor((site.z + g.worldH / 2) / g.tileSize);
      c.fillStyle = '#000';
      c.fillRect(tx * S - 1, ty * S - 1, S + 2, S + 2);
      c.fillStyle = site.kind === 'ruin' ? '#c9a46a' : '#9fe0ff';
      c.fillRect(tx * S, ty * S, S, S);
    }
  }

  _updateFog() {
    const g = this.game;
    if (!g || this.viewer == null || !g.s.options.hiddenMap) { this.fogReady = false; return; }
    const ex = g.explored(this.viewer);
    const key = g.player(this.viewer).explored;
    if (key === this.fogKey) return;
    this.fogKey = key;
    const W = g.W, H = g.H, S = this.scale;
    this.fog.width = W * S; this.fog.height = H * S;
    const c = this.fog.getContext('2d');
    c.clearRect(0, 0, W * S, H * S);
    c.fillStyle = '#07090c';
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!ex[y * W + x]) c.fillRect(x * S, y * S, S, S);
    this.fogReady = true;
  }

  draw(camera) {
    if (!this.map) return;
    const { ctx } = this;
    const g = this.game, S = this.scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0);
    if (g) {
      this._updateFog();
      if (this.fogReady) ctx.drawImage(this.fog, 0, 0);
      const ex = this.fogReady ? g.explored(this.viewer) : null;
      const vis = this.viewer != null && g.s.options.fogOfWar ? g.visible(this.viewer) : null;
      const block = (x, y, w, fill, edge = '#000') => {
        ctx.fillStyle = edge;
        ctx.fillRect(x - 1, y - 1, w + 2, w + 2);
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, w);
      };
      // cities: a bold block a tile wider than the castle all round, in the owner's colour
      for (const c of g.s.cities) {
        if (ex && !c.tiles.some((t) => ex[t])) continue;
        const [x, y] = g.tileXY(c.t);
        const fill = c.razed ? '#3a3530' : c.owner >= 0 ? SIDES[c.owner].color : '#9a9a9a';
        block((x - 1) * S + 1, (y - 1) * S + 1, 4 * S - 2, fill);
        // a light inner pip for a capital
        if (c.capital && !c.razed) { ctx.fillStyle = '#fff6d8'; ctx.fillRect((x + 1) * S - Math.ceil(S / 2), (y + 1) * S - Math.ceil(S / 2), 2 * Math.ceil(S / 2), 2 * Math.ceil(S / 2)); }
        // the victory condition's cities are ringed (Darklords Rising: "marked with a circle")
        const v = g.s.options.victory;
        if ((v === 'hill' && g.s.hill?.city === c.id) || (v === 'fortress' && c.capital)) {
          ctx.strokeStyle = v === 'hill' ? '#ffe27a' : '#fff';
          ctx.lineWidth = 2;
          ctx.strokeRect((x - 2) * S + 0.5, (y - 2) * S + 0.5, 6 * S - 1, 6 * S - 1);
        }
      }
      // armies in view: a block two tiles wide, the viewer's own edged in white
      for (const k of g.s.stacks) {
        if (g.cityAt(k.t)) continue;
        if (this.viewer != null && !g.canSee(this.viewer, k, vis)) continue;
        const [x, y] = g.tileXY(k.t);
        const w = Math.max(4, Math.round(S * 1.6));
        block(Math.round((x + 0.5) * S - w / 2), Math.round((y + 0.5) * S - w / 2), w, k.owner >= 0 ? SIDES[k.owner].color : '#9a9a9a', k.owner === this.viewer ? '#fff' : '#000');
      }
    }
    // camera footprint
    const gr = this.map.grid;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      const v = new THREE.Vector3(x, y, 0.5).unproject(camera);
      const dir = v.sub(camera.position).normalize();
      let t = dir.y < -0.01 ? -camera.position.y / dir.y : 400;
      t = Math.min(t, 400);
      const p = camera.position.clone().addScaledVector(dir, t);
      return [((p.x + gr.worldW / 2) / gr.tileSize) * S, ((p.z + gr.worldH / 2) / gr.tileSize) * S];
    });
    ctx.strokeStyle = 'rgba(255,245,210,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
}

const fmt = (x) => (Math.round(x * 10) / 10).toString();

/** Status marks of an army: medals, blessing, afflictions. */
export function marks(u) {
  const m = [];
  if (u.medals) m.push('🎖'.repeat(Math.min(u.medals, 2)));
  if (u.blessed) m.push('✚');
  if (u.poisoned) m.push('🟢');
  if (u.diseased) m.push('🔴');
  if (u.paralysed) m.push('⛔');
  return m.join('');
}

/** A portrait card for an army: strength shield, hit points heart, movement banner, marks. */
export function unitCard(u, owner, portraits, { sel = false, off = false, onclick = null, title = null, tip = null } = {}) {
  const s = unitStats(u);
  const color = owner >= 0 ? SIDES[owner].color : '#888';
  const el = h('div.card' + (sel ? '.sel' : '') + (off ? '.off' : '') + (u.hero ? '.hero' : ''), {
    vars: { '--c': color }, onclick,
    title: tip ? null : title ?? `${unitName(u)}${u.hero ? ` — ${typeName(u)} level ${u.hero.level}` : ''}\nStrength ${s.str} · Hits ${s.hits} · Move ${fmt(u.mp)}/${s.move}`,
  },
  h('img', { src: portraits.url(u.type, owner), draggable: 'false', 'data-type': u.type, 'data-owner': owner }),
  h('div.marks', marks(u)),
  u.hero ? h('div.lvl', `L${u.hero.level}`) : null,
  h('div.str', s.str), h('div.hits', s.hits), h('div.mp', Math.floor(u.mp)));
  return tip ? hoverTip(el, tip) : el;
}

export class Hud {
  constructor(ctl) {
    this.ctl = ctl;
    const $ = (id) => document.getElementById(id);
    this.top = $('topbar');
    this.side = $('sidepanel');
    this.tip = $('tip');
    this.minimap = new GameMinimap(this._frame('minimapBox'), (x, z) => ctl.lookAt(x, z));
    this.stackBox = this._frame('stackBox');
    this.actions = this._frame('actions');
    this.endBox = this._frame('endBox');
    this.infoBox = this._frame('infoBox');
    this.endBox.style.padding = '8px';
    this.endBtn = h('button#endTurn.btn.primary.big', { onclick: () => ctl.endTurnClicked() }, 'End Turn ⏎');
    this.endBox.append(this.endBtn);
    ctl.portraits.onReady(() => this._refreshImages());
  }

  _frame(id) {
    const el = h(`div#${id}.frame`);
    this.side.append(el);
    return el;
  }

  _refreshImages() {
    for (const img of document.querySelectorAll('img[data-type]')) {
      const url = this.ctl.portraits.url(img.dataset.type, Number(img.dataset.owner));
      if (img.src !== url) img.src = url;
    }
  }

  show(v) { for (const el of [this.top, this.side]) el.classList.toggle('hidden', !v); }

  // --- top bar ------------------------------------------------------------------------------------
  renderTop() {
    const c = this.ctl, g = c.game;
    if (!g) return;
    const me = g.player(c.viewer) ?? g.current;
    const cur = g.current;
    const income = g.citiesOf(me.id).reduce((n, x) => n + g.cityIncome(x), 0);
    const upkeep = g.stacksOf(me.id).reduce((n, k) => n + k.units.reduce((m, u) => m + (u.hero ? 0 : UNITS[u.type].upkeep), 0), 0);
    const w = c.weather.preset ?? g.s.weather.name;
    const hour = Math.floor(c.sky.timeOfDay), min = Math.floor((c.sky.timeOfDay % 1) * 60);
    this.top.innerHTML = '';
    this.top.append(...[
      h('div.side', h('div.crest', { vars: { '--c': me.color } }), me.name),
      h('div.day', `Day ${g.s.round}`, cur.id !== me.id ? h('span.dim', { style: { fontFamily: 'Inter', fontSize: '12px', marginLeft: '8px' } }, `· ${cur.name} ${cur.human ? '' : '(computer)'} moving…`) : null),
      h('div.stat', { title: 'Gold (income − upkeep per turn)', html: `${ICON.gold}<b>${me.gold}</b><span class="sub">+${income} −${upkeep}</span>` }),
      h('div.stat', { title: 'Mana (maximum)', html: `${ICON.mana}<b>${me.mana}</b><span class="sub">/ ${g.manaMax(me.id)}</span>` }),
      h('div.stat', { title: 'Cities', html: `${ICON.castle}<b>${g.citiesOf(me.id).length}</b>` }),
      h('div.stat', { title: `Weather — the skies change every 3 days; rain, storms and snow pass within two hours`, html: `${WEATHER_ICON[w] ?? ICON.cloud}<span>${w}</span>` }),
      h('div.stat.dim', `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`),
      g.s.hill && g.s.options.victory === 'hill' ? h('div.stat', { title: `King of the Hill: hold ${g.s.cities[g.s.hill.city].name} for ten days` },
        `👑 ${g.s.hill.holder >= 0 ? `${g.player(g.s.hill.holder).name.split(' ').pop()} ${g.hillDaysLeft()}d` : 'unheld'}`) : null,
      h('div.spacer'),
      g.diplo.on ? h('button.btn' + (g.diplo.hasNews(me.id) ? '.news' : ''), { onclick: () => c.openDiplomacy(), title: 'Diplomacy: war, peace, alliances (P)' }, '⚔️ Diplomacy') : null,
      h('button.btn', { onclick: () => c.openVectoring(), title: 'Vectoring: where each city sends its new armies (V)' }, '➶ Vectoring'),
      h('button.btn', { onclick: () => c.openReports() }, '📜 Reports'),
      h('button.btn', { onclick: () => c.toggleFullscreen(), title: document.fullscreenElement ? 'Leave full screen' : 'Full screen' }, document.fullscreenElement ? '🗗 Window' : '⛶ Full screen'),
      h('button.btn', { onclick: () => c.openGameMenu() }, '☰ Menu'),
    ].filter(Boolean));
  }

  // --- stack palette ------------------------------------------------------------------------------------
  renderStack() {
    const c = this.ctl, g = c.game, box = this.stackBox;
    box.innerHTML = '';
    const sel = c.sel;
    if (!g) return;
    if (!sel) {
      const p = g.current;
      const idle = c.human ? g.stacksOf(p.id).filter((k) => !k.done && !k.defend && !(k.path?.length > 1) && g.canAct(k.units)).length : 0;
      box.append(h('div.title', 'No army selected'),
        h('div.dim', { style: { fontSize: '12.5px', lineHeight: 1.5 } },
          c.human ? `${idle} group${idle === 1 ? '' : 's'} can still move. Click an army or a city garrison, or press N for the next one.`
            : 'The computer players are moving…'));
      this.renderActions();
      return;
    }
    const owner = sel.owner;
    const all = sel.units;
    const group = new Set(sel.group);
    const city = sel.city != null ? g.s.cities[sel.city] : null;
    const garrison = city ? g.unitsIn(city).length : 0;
    const title = city ? (sel.whole ? `${city.name} garrison` : `${city.name} · ${all.length === 1 ? unitName(all[0]) : `${all.length} armies`}`)
      : all.length === 1 ? unitName(all[0]) : `Army of ${all.length}`;
    const [tx, ty] = g.tileXY(sel.t);
    box.append(h('div.title', h('div.crest', { vars: { '--c': owner >= 0 ? SIDES[owner].color : '#888' }, style: { width: '16px', height: '19px' } }), title, h('span.where', `${TileInfo[g.map.tiles[sel.t]].name} · ${tx},${ty}`)));
    const mine = owner === c.viewer && c.human;
    const pal = h('div.palette');
    // strength tips: as defenders of this square (the whole garrison) and attacking with the group
    const defenders = g.defendersAt(sel.t)?.units ?? all;
    const attackers = all.filter((u) => group.has(u.id));
    const ctx = g.battleContext({ t: sel.t, owner }, sel.t);
    for (const u of all) {
      pal.append(unitCard(u, owner, c.portraits, {
        tip: () => mapStrengthHtml(u, defenders.includes(u) ? defenders : all, attackers, ctx),
        sel: group.has(u.id), off: !group.has(u.id),
        onclick: mine ? (e) => c.toggleGroup(u.id, e.shiftKey || e.detail === 2) : null,
      }));
    }
    box.append(pal);
    box.append(h('div.legend', h('span.k.str', '⛨'), 'strength', h('span.k.hits', '♥'), 'hits', h('span.k.mp', { vars: { '--c': owner >= 0 ? SIDES[owner].color : '#888' } }, '⚑'), 'moves left'));
    if (mine) {
      const units = all.filter((u) => group.has(u.id));
      if (units.length) {
        const mv = groupMover(units);
        const bon = mv.fly ? 'Flying' : mv.bonuses.map((b) => BONUS_NAMES[b]).join(', ') || 'none';
        box.append(h('div.groupline', h('span', 'Group move ', h('b', fmt(mv.mp))), h('span', 'Bonus ', h('b', bon))));
      }
      box.append(h('div.groupline', h('span.faint', 'Click a portrait to add or remove it from the group · double-click: only that one')));
      // a corner of a city shows only its own stack; say how to see the rest
      if (city && !sel.whole && garrison > all.length) box.append(h('div.groupline', h('span.faint', `${garrison - all.length} more in the other corners of ${city.name} — double-click the token (or G) for the whole garrison`)));
    }
    this.renderActions();
  }

  renderActions() {
    const c = this.ctl, g = c.game, box = this.actions;
    box.innerHTML = '';
    if (!g) return;
    const sel = c.sel;
    const human = c.human && !c.busy;
    const k = sel && sel.owner === c.viewer ? g.stack(sel.stack) : null;
    const units = sel ? sel.units.filter((u) => sel.group.includes(u.id)) : [];
    const hero = units.find((u) => u.hero) ?? sel?.units.find((u) => u.hero);
    const city = sel?.city != null ? g.s.cities[sel.city] : k ? g.cityAt(k.t) : null;
    const site = k ? g.site(k.t) : null;
    const b = (icon, label, fn, on = true, title = label, extra = '') => h('button.btn.icon' + extra, { onclick: fn, disabled: !(human && on), title }, icon, h('small', label));
    const myCity = city && city.owner === c.viewer;
    // a badge on the Hero button while the viewer's hero has ability points it could spend now
    const hr = hero && g.stackOfUnit(hero.id)?.owner === c.viewer ? hero.hero : null;
    const spendable = hr && hr.ap > 0 && g.buyable(hero).some((x) => hr.ap >= x.cost);
    const heroBtn = b('👤', 'Hero', () => c.openHero(hero), !!hero, spendable ? `Hero report, abilities and items (H) — ${hr.ap} ability point${hr.ap === 1 ? '' : 's'} to spend!` : 'Hero report, abilities and items (H)');
    if (spendable) heroBtn.append(h('span.badge', String(hr.ap)));
    box.append(
      b('⏭', 'Next', () => c.nextGroup(), true, 'Next group that can move (N)'),
      b('▶', 'Move', () => c.continueMove(), !!(k?.path && units.length), 'Continue along the planned route (M)'),
      b('⏹', 'Stop', () => c.cancelRoute(), !!(k?.path && units.length), 'Cancel the planned route — otherwise the group marches on by itself when the turn ends (X)'),
      b('✓', 'Done', () => c.leaveGroup(), !!sel, 'Done for this turn (L)'),
      b('🛡', 'Sentry', () => c.defendGroup(), !!sel, 'Sentry: skip in the Next loop until selected again (Z)'),
      b('🔍', 'Search', () => c.searchRuin(), !!(k && g.canSearch(k)), site?.kind === 'ruin' ? `Search ${site.name} (F)${hero && !site.state.explored ? ` — ${hero.hero.name} goes in alone, about ${Math.round(ruinChance(hero, site.danger ?? 1, k.units) * 100)}% to win (the army here adds to the odds)` : ''}` : 'Search a ruin (a hero must stand on it; the hero goes in alone, backed by the army with it)'),
      ...(g.groundAt(k?.t ?? -1) ? [b('🎒', 'Take', () => c.pickUpItems(), g.canPickUp(k), `Take up the ${g.groundAt(k.t).items.map((x) => ITEMS[x].name).join(', ')} lying here (a hero must be in the group) (T)`)] : []),
      b('✦', 'Cast', () => c.openCast(hero), !!(hero && hero.hero.spells.length), 'Cast a spell (C)'),
      heroBtn,
      b('🏰', 'City', () => c.openCity(city), !!city, 'City production and building'),
      b('❗', 'Quest', () => c.questAction(hero), !!(hero && (myCity || g.s.quests[c.viewer])), 'Get or show a quest'),
      b('➶', 'Vector', () => c.openVector(), !!(myCity && units.length), `Send the group to another of your cities (${g.s.options.timedVectoring ? '2–5' : 'two'} turns)`),
      b('🔥', 'Raze', () => c.razeHere(), !!((myCity && g.canRaze(city, c.viewer)) || (k && g.canRazeSite(k))), myCity ? 'Burn this city to the ground' : 'Burn the site the group stands on'),
      b('✖', 'Disband', () => c.disbandGroup(), !!(sel && units.length), 'Disband the group'),
      b('🔎', 'Center', () => c.centerOnSelection(), !!sel, 'Centre the view on the group'),
    );
    this.endBtn.disabled = !human;
  }

  // --- info log -----------------------------------------------------------------------------------------
  addLog(e) {
    const c = this.ctl, g = c.game;
    const col = e.player >= 0 ? SIDES[e.player]?.color : '#888';
    const el = h('div.ev.' + e.kind, { onclick: () => e.t >= 0 && c.lookAtTile(e.t), title: `Day ${e.round}` }, h('span.dot', { style: { background: col } }), e.text);
    this.infoBox.prepend(el);
    while (this.infoBox.childNodes.length > 80) this.infoBox.lastChild.remove();
    void g;
  }
  clearLog() { this.infoBox.innerHTML = ''; }

  /** " (at peace, friendship)" for another side, with diplomacy on. */
  _relation(owner) {
    const c = this.ctl, g = c.game;
    if (!g.diplo.on || owner < 0 || c.viewer == null || owner === c.viewer) return '';
    const st = g.diplo.status(c.viewer, owner);
    const p = g.player(owner);
    return ` <span class="${st === 'war' ? 'bad' : 'good'}">(${st === 'allied' ? 'allied' : st === 'peace' ? 'at peace' : 'at war'}${p.human ? '' : `, ${standing(g.diplo.hate(owner, c.viewer))}`})</span>`;
  }

  // --- hover tip ------------------------------------------------------------------------------------------
  showTip(t) {
    const c = this.ctl, g = c.game;
    if (!g || t < 0) { this.tip.classList.remove('visible'); return; }
    const ex = c.viewer != null && g.s.options.hiddenMap ? g.explored(c.viewer) : null;
    if (ex && !ex[t]) { this.tip.innerHTML = '<div class="t">Unexplored</div><div class="dim">Send an army to see what lies here.</div>'; this.tip.classList.add('visible'); return; }
    const [tx, ty] = g.tileXY(t);
    const f = g.map.flags[t];
    const info = TileInfo[g.map.tiles[t]];
    const rows = [];
    const city = g.cityAt(t);
    if (city) {
      const own = city.owner >= 0 ? SIDES[city.owner].name : 'Neutral';
      rows.push(`<div class="t">${city.capital ? '♛ ' : ''}${city.name}</div><div>${own}${this._relation(city.owner)} · ${city.razed ? 'razed' : CastleLevels[city.level].name}</div>`);
      if (g.s.hill?.city === city.id && g.s.options.victory === 'hill') rows.push('<div class="gold-t">👑 Hold it ten days to win the game</div>');
      if (city.owner === c.viewer) rows.push(`<div class="dim">Income ${g.cityIncome(city)} gold · ${city.mana} mana · ${city.producing ? `training ${UNITS[city.producing].name}` : 'no production'}</div>`);
      else if (city.owner !== c.viewer && !city.razed) rows.push(`<div class="dim">Defence +${CastleLevels[city.level].defense} · income ${g.cityIncome(city)}</div>`);
    }
    const site = g.site(t);
    if (site) {
      const st = SiteTypes[site.type];
      rows.push(`<div class="t">${site.kind === 'ruin' ? '☠' : '✦'} ${site.name}</div><div class="dim">${st.name}${site.kind === 'ruin' ? (site.state.explored ? ' · explored' : ` · danger ${'★'.repeat(site.danger)}`) : ` · blesses armies that visit`}</div>`);
    }
    if (f & Flag.PORT) rows.push('<div class="dim">⚓ Port — armies embark and land here</div>');
    if (g.move.links.has(t) && !g.move.isSea(t)) rows.push('<div class="dim">⛵ Bridge landing — boats sail the river down to the sea</div>');
    const sp = g.special(t);
    if (sp) {
      const T = SPECIAL_TYPES[sp.type], sc = g.s.cities[sp.city], so = g.siteOwner(sp);
      rows.push(`<div class="t">${T.icon} ${T.name}${sp.razed ? ' <i>(razed)</i>' : ''}</div><div class="dim">${sp.razed ? `Burnt — gave ${T.text}` : T.text} ${sc.name}${so >= 0 ? ` · ${SIDES[so].name}` : ''}</div>`);
    }
    const loot = c.seen(t) && g.groundAt(t);
    if (loot) rows.push(`<div class="t">🎒 A fallen hero's belongings</div><div class="dim">${loot.items.map((x) => ITEMS[x].name).join(', ')} — a hero who comes here takes them up</div>`);
    const post = g.signposts.find((p) => p.t === t);
    if (post) rows.push(`<div class="t">🪧 Signpost</div>${signpostLines(post).map((l) => `<div>${l}</div>`).join('')}`);
    const k = g.stackAt(t);
    const vis = c.viewer != null ? g.visible(c.viewer) : null;
    if (k && !city && (c.viewer == null || g.canSee(c.viewer, k, vis))) {
      const who = k.owner >= 0 ? SIDES[k.owner].name : 'Neutral';
      const hero = k.units.find((u) => u.hero);
      rows.push(`<div>${who}${this._relation(k.owner)}: ${k.units.length} ${k.units.length === 1 ? 'army' : 'armies'}${hero ? ` led by ${hero.hero.name} (${HERO_CLASSES[hero.hero.cls].name} L${hero.hero.level})` : ''}</div>`);
    }
    const tags = [];
    if (f & Flag.ROAD) tags.push('Road'); if (f & Flag.BRIDGE) tags.push('Bridge'); if (f & Flag.RIVER) tags.push('River'); if (f & Flag.LAVA) tags.push('Lava');
    const cost = g.move.base.land[t];
    rows.push(`<div class="dim">${info.name}${tags.length ? ' · ' + tags.join(', ') : ''} · ${cost < Infinity ? `move ${cost}` : g.move.isSea(t) ? 'sea' : 'impassable'} · ${tx},${ty}</div>`);
    const plan = c.hoverPlan;
    if (plan) {
      const turns = plan.turns[plan.turns.length - 1] + 1;
      if (plan.attack?.treaty) rows.push(`<div class="bad" style="margin-top:4px">⚠ Attacking breaks the ${plan.attack.treaty === 'allied' ? 'alliance' : 'peace'}: war is declared</div>`);
      rows.push(`<div class="${plan.attack ? 'bad' : 'good'}" style="margin-top:4px">${plan.attack ? '⚔ Attack · ' : ''}${fmt(plan.path.total)} MP · ${turns === 1 ? 'this turn' : `${turns} turns`}</div>`);
      if (plan.odds != null) rows.push(`<div class="gold-t">Combat advisor: ${Math.round(plan.odds * 10)} in 10 to win</div>`);
    }
    this.tip.innerHTML = rows.join('');
    this.tip.classList.add('visible');
  }
}
