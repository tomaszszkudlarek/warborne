import * as THREE from 'three';
import { h, ask, toast } from './dom.js';
import { listMaps, loadMap, listSaves, getSave, deleteSave, readSaveFile } from './storage.js';
import { newGameState, DEFAULT_OPTIONS, VICTORY, TIMED_DEFAULT_LIMIT } from '../game/Game.js';
import { SIDES, AI_LEVELS } from '../game/data/sides.js';
import { TileInfo, Tile, Flag } from '../generator/terrainTypes.js';
import { music } from './music.js';

/** Map thumbnail: tiles coloured by terrain, cities as dots in their owners' colours. */
function thumbnail(map, px = 3) {
  const W = map.grid.tilesW, H = map.grid.tilesH;
  const c = document.createElement('canvas');
  c.width = W * px; c.height = H * px;
  const x = c.getContext('2d');
  for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
    const t = ty * W + tx;
    x.fillStyle = map.tiles[t] === Tile.WATER && map.flags[t] & Flag.FROZEN ? '#c9dbe6' : TileInfo[map.tiles[t]].color;
    if (map.flags[t] & Flag.ROAD) x.fillStyle = '#b09060';
    x.fillRect(tx * px, ty * px, px, px);
  }
  for (const city of map.cities) {
    x.fillStyle = city.owner >= 0 ? SIDES[city.owner].color : '#999';
    x.strokeStyle = '#000';
    x.fillRect(city.tx * px, city.ty * px, px * 2, px * 2);
    x.strokeRect(city.tx * px + 0.5, city.ty * px + 0.5, px * 2 - 1, px * 2 - 1);
  }
  return c;
}

/** A private copy of the parts of a map a game changes (castle owners and levels). */
const forGame = (map) => ({ ...map, cities: map.cities.map((c) => ({ ...c })) });

export class MainMenu {
  constructor(env) {
    Object.assign(this, env); // ctl, buildWorld, showLoading, hideLoading, assets, setView, camera, controls
    this.el = document.getElementById('menu');
    this.bgMap = null;
    this.angle = 0;
  }

  async boot() {
    this.showLoading('Loading castles, forests and bridges', 0.1);
    await this.assets;
    const maps = listMaps();
    if (maps.length) {
      this.showLoading('Unrolling the map', 0.6);
      try {
        const pick = maps[Math.floor(Math.random() * maps.length)];
        this.bgMap = forGame(await loadMap(pick.file));
        this.buildWorld(this.bgMap);
      } catch (e) { console.error(e); }
    }
    this.hideLoading();
    this.show();
  }

  /** Slow flight around the menu's background map. */
  updateCamera(dt) {
    const map = this.ctl.world.map;
    if (!map) return;
    this.angle += dt * 0.025;
    const g = map.grid;
    const r = Math.max(g.worldW, g.worldH) * 0.32;
    const tx = Math.cos(this.angle * 0.7) * g.worldW * 0.18, tz = Math.sin(this.angle * 0.9) * g.worldH * 0.15;
    const cx = tx + Math.cos(this.angle) * r, cz = tz + Math.sin(this.angle) * r;
    // rise and sink with the land under the view, eased the same whatever the frame rate
    // (the game's ground-following is off here: it fought this flight and shook it)
    const hAt = (x, z) => Math.max(0, this.ctl.world.heightAt(x, z));
    const want = hAt(tx, tz) * 0.6, floor = hAt(cx, cz) + 1.2;
    const k = 1 - Math.exp(-dt * 1.5);
    this.lift = this.lift == null ? want : this.lift + (want - this.lift) * k;
    this.controls.target.set(tx, this.lift, tz);
    this.camera.position.set(cx, Math.max(this.lift + r * 0.55, floor), cz);
    this.camera.lookAt(this.controls.target);
  }

  async show() {
    const token = (this.token = (this.token ?? 0) + 1);
    this.ctl.stop();
    this.ctl.fog.clear();
    this.setView('menu');
    this.lift = null; // the flight settles on this map's land afresh
    music.reset(); // the title screen (and leaving a game) plays the background
    const auto = await getSave('autosave').catch(() => null);
    if (token !== this.token) return; // a game started meanwhile
    this.el.classList.remove('hidden');
    this.el.innerHTML = '';
    const btn = (label, fn, cls = '') => h('button.btn' + cls, { onclick: fn }, label);
    this.el.append(
      h('div.shade'),
      h('div.title', h('h1', 'WARBORNE'), h('div.sub', 'Darklords Rise')),
      h('div.main.frame',
        btn('New Game', () => this.newGame(), '.primary'),
        auto ? btn([h('span', 'Continue'), h('small', `${auto.map} · day ${auto.round}`)], () => this.loadRecord(auto)) : null,
        btn('Load Game', () => this.loadGame()),
        btn('Map Forge ↗', () => window.open('forge.html', '_blank')),
        btn('How to play', () => this.help()),
      ),
      h('div.foot', `Maps are read from the project's maps/ folder (${listMaps().length} found). Make new ones with the Map Forge → “Save map for the game”, then drop the .wlmap file into maps/.`),
      h('div.ver', `v${__APP_VERSION__}`),
    );
  }

  hide() { this.token = (this.token ?? 0) + 1; this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  // --- new game ------------------------------------------------------------------------------------------
  async newGame() {
    const maps = listMaps();
    if (!maps.length) {
      await ask('No maps', 'The maps/ folder is empty. Open the Map Forge, generate a map, press “Save map for the game” and put the .wlmap file into the project\'s maps/ folder.');
      return;
    }
    this.el.innerHTML = '';
    const box = h('div.setup.frame');
    this.el.append(h('div.shade'), box);
    const state = { file: null, map: null, players: [], options: { ...DEFAULT_OPTIONS } };
    const mapsEl = h('div.maps');
    const sidesEl = h('div.sides');
    const info = h('div.dim', { style: { fontSize: '12.5px', margin: '6px 0' } });
    const startBtn = h('button.btn.primary.big', { disabled: true, onclick: () => this.start(state) }, 'Begin the conquest');
    box.append(
      h('h2', 'New Game'),
      h('h3', { style: { color: 'var(--gold)', margin: '4px 0 8px', fontFamily: 'Cinzel' } }, 'Choose a map'), mapsEl,
      h('h3', { style: { color: 'var(--gold)', margin: '16px 0 8px', fontFamily: 'Cinzel' } }, 'Sides'), info, sidesEl,
      h('h3', { style: { color: 'var(--gold)', margin: '16px 0 8px', fontFamily: 'Cinzel' } }, 'Options'), this._options(state.options),
      h('div.buttons', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '18px' } }, h('button.btn', { onclick: () => this.show() }, 'Back'), startBtn),
    );
    const cards = [];
    for (const m of maps) {
      const card = h('div.mapcard', h('div.dim', { style: { height: '90px', display: 'grid', placeItems: 'center' } }, 'Loading…'), h('div.n', m.file.replace('.wlmap', '')), h('div.m', ''));
      mapsEl.append(card);
      cards.push(card);
      loadMap(m.file).then((map) => {
        card.firstChild.replaceWith(thumbnail(map, 3));
        card.querySelector('.n').textContent = map.meta?.name ?? m.file;
        const sides = [...new Set(map.cities.filter((c) => c.capital).map((c) => c.owner))];
        card.querySelector('.m').textContent = `${map.grid.tilesW}×${map.grid.tilesH} · ${map.cities.length} cities · ${sides.length} sides · ${map.sites.length} ruins & shrines`;
        card.onclick = () => {
          cards.forEach((c) => c.classList.remove('sel'));
          card.classList.add('sel');
          state.file = m.file;
          state.map = map;
          state.players = sides.sort((a, b) => a - b).map((side, i) => ({ side, human: i === 0, ai: 'lord', off: false }));
          drawSides();
          startBtn.disabled = false;
          // show the chosen land behind the menu
          if (this.bgMap?.meta?.name !== map.meta?.name) { this.bgMap = forGame(map); this.buildWorld(this.bgMap); }
        };
        if (!state.file) card.onclick();
      }).catch((e) => { card.firstChild.textContent = 'Could not load'; console.error(e); });
    }
    const drawSides = () => {
      sidesEl.innerHTML = '';
      const n = state.players.length;
      info.textContent = `Each capital on the map belongs to a side — this map seats ${n} of the ${SIDES.length} sides${n < SIDES.length ? ' (for all eight, pick a map with eight capitals, or make one in the Map Forge with Factions 8)' : ''}. Set who plays each side; any number can be human (hot seat). Sides turned off leave their cities neutral.`;
      for (const p of state.players) {
        const s = SIDES[p.side];
        const sel = h('select', {
          onchange: (e) => { const v = e.target.value; p.off = v === 'off'; p.human = v === 'human'; if (!p.off && !p.human) p.ai = v; startBtn.disabled = state.players.filter((x) => !x.off).length < 2; },
        },
        h('option', { value: 'human', selected: p.human && !p.off }, 'Human'),
        Object.entries(AI_LEVELS).map(([k, l]) => h('option', { value: k, selected: !p.human && !p.off && p.ai === k }, `Computer — ${l.name}`)),
        h('option', { value: 'off', selected: p.off }, 'Off (neutral)'));
        sidesEl.append(h('div.siderow', h('div.crest', { vars: { '--c': s.color } }), h('div.nm', h('b', s.name), h('small', s.title)), sel));
      }
    };
  }

  _options(o) {
    const row = (label, input, title = null) => h('div.o', { title }, h('span', label), input);
    const chk = (k) => h('input', { type: 'checkbox', checked: o[k], onchange: (e) => (o[k] = e.target.checked) });
    const limit = h('input', { type: 'number', value: o.turnLimit, min: 0, max: 500, style: { width: '64px' }, onchange: (e) => (o.turnLimit = +e.target.value) });
    const vdesc = h('div.dim', { style: { gridColumn: '1 / -1', fontSize: '12px', marginTop: '-2px' } }, VICTORY[o.victory].desc);
    const victory = h('select', {
      onchange: (e) => {
        o.victory = e.target.value;
        vdesc.textContent = VICTORY[o.victory].desc + (VICTORY[o.victory].timed ? ' Needs a turn limit.' : '');
        // the "most ..." conditions are decided when time runs out
        if (VICTORY[o.victory].timed && !o.turnLimit) { o.turnLimit = TIMED_DEFAULT_LIMIT; limit.value = o.turnLimit; }
      },
    }, Object.entries(VICTORY).map(([k, v]) => h('option', { value: k, selected: o.victory === k }, v.name)));
    return h('div.opts',
      row('Victory', victory), vdesc,
      row('Starting gold', h('input', { type: 'number', value: o.startGold, min: 0, max: 5000, step: 50, style: { width: '80px' }, onchange: (e) => (o.startGold = +e.target.value) })),
      row('Neutral cities', h('select', { onchange: (e) => (o.neutrals = e.target.value) }, ['weak', 'normal', 'strong'].map((v) => h('option', { value: v, selected: o.neutrals === v }, v[0].toUpperCase() + v.slice(1))))),
      row('Hidden map', chk('hiddenMap')),
      row('Fog of war', chk('fogOfWar')),
      row('Quests', chk('quests')),
      row('Heroes offer service', chk('heroOffers')),
      row('Mercenaries', chk('mercenaries')),
      row('Combat dice (18-26)', h('input', { type: 'number', value: o.dice, min: 18, max: 26, style: { width: '64px' }, onchange: (e) => (o.dice = Math.max(18, Math.min(26, +e.target.value))) })),
      row('Turn limit (0 = none)', limit),
      row('Diplomacy', chk('diplomacy'), 'War, peace and alliances between the sides. Off: everyone is always at war.'),
      row('Merchants', chk('merchants'), 'Merchants now and then offer magic items for sale.'),
      row('Timed vectoring', chk('timedVectoring'), 'Vectored armies take 2–5 turns by distance (off: always 2).'),
      // viewing preferences (also under Menu → Options while playing)
      h('div', { style: { gridColumn: '1 / -1', display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '6px' } }, ...this.ctl.watchOptions()),
    );
  }

  async start(setup) {
    const active = setup.players.filter((p) => !p.off);
    if (active.length < 2) { toast('At least two sides must play.'); return; }
    if (!active.some((p) => p.human)) {
      const ok = await ask('No human player', 'Every side is played by the computer. Watch them fight it out?', [{ label: 'Watch', value: true, primary: true }, { label: 'Back', value: false }]);
      if (!ok) return;
    }
    this.hide();
    this.showLoading('Mustering the armies', 0.05);
    const map = forGame(setup.map);
    this.buildWorld(map);
    const state = newGameState(map, {
      players: active.map((p) => ({ side: p.side, human: p.human, ai: p.ai })),
      options: setup.options, mapName: map.meta?.name ?? setup.file, mapFile: setup.file, seed: (Math.random() * 2 ** 31) | 0,
    });
    await this._run(map, state);
  }

  async _run(map, state) {
    this.showLoading('Summoning heroes and armies', 0.1);
    this.setView('game');
    await this.ctl.start(map, state, (p) => this.showLoading('Summoning heroes and armies', 0.1 + p * 0.9));
    // a closer camera over the first player's capital
    const g = map.grid;
    const d = Math.min(46, Math.max(g.worldW, g.worldH) * 0.35);
    this.camera.position.set(this.controls.target.x, d * 0.9, this.controls.target.z + d * 0.75);
    this.hideLoading();
  }

  // --- loading ------------------------------------------------------------------------------------------
  async loadGame() {
    const saves = await listSaves().catch(() => []);
    const file = h('input', { type: 'file', accept: '.wlsave,application/json', style: { display: 'none' } });
    const r = await ask('Load Game', h('div.loadlist', { style: { minWidth: '480px', maxHeight: '55vh', overflow: 'auto' } },
      saves.length ? saves.map((s) => h('div.ll',
        h('div.n', h('b', s.name === 'autosave' ? 'Autosave' : s.name), h('div.dim', { style: { fontSize: '12px' } }, `${s.map} · day ${s.round} · ${new Date(s.date).toLocaleString()} · ${s.players.filter((p) => p.alive).map((p) => p.name).join(', ')}`)),
        h('button.btn.primary', { onclick: () => { document.querySelector('.dialog .close')?.click(); this.loadRecord(s); } }, 'Load'),
        h('button.btn', { title: 'Delete', onclick: (e) => { deleteSave(s.id); e.target.closest('.ll').remove(); } }, '🗑'),
      )) : h('div.dim', 'No saved games in this browser yet.'), file),
    [{ label: 'Open a save file…', value: 'file' }, { label: 'Close', value: null }]);
    if (r === 'file') {
      file.onchange = async () => {
        try { const state = await readSaveFile(file.files[0]); await this.loadState(state); } catch (e) { ask('Could not load', e.message); }
      };
      file.click();
    }
  }

  async loadRecord(rec) { await this.loadState(JSON.parse(rec.state)); }

  async loadState(state) {
    let base;
    try { base = await loadMap(state.map.file); } catch (e) {
      await ask('Map missing', `This game was played on “${state.map.name}” (${state.map.file}), which is no longer in the maps/ folder.`);
      return;
    }
    this.hide();
    this.showLoading('Unrolling the map', 0.05);
    const map = forGame(base);
    this.buildWorld(map);
    await this._run(map, state);
  }

  help() {
    ask('How to play', h('div', { style: { maxWidth: '640px', fontSize: '13.5px', lineHeight: 1.6 } },
      h('p', 'Conquer Etheria: take the cities of the other sides, or destroy their armies. Cities pay gold every turn and train armies; armies cost upkeep. Heroes lead your armies, search ruins, take quests, gain levels and cast spells.'),
      h('p', h('b', 'Mouse: '), 'left-click an army or a city garrison to select it (left-click anything else for information); hover a tile to see the route (green: this turn, amber: later turns, blue: by sea) and right-click to march there. Right-click an enemy to attack — the combat advisor shows your odds. Left-drag moves the map, right-drag turns the view, wheel zooms.'),
      h('p', h('b', 'Keys: '), 'N next group · M continue the route · L done · Z sentry · F search ruin · C cast · H hero · G whole stack · R reports · P diplomacy · Enter end turn · WASD / arrows pan · Q/E turn · Esc deselect / menu.'),
      h('p', h('b', 'Combat: '), 'armies fight one pair at a time, weakest first. Heroes, leadership, morale, walls (fortify) and special powers (missiles, poison, acid...) decide battles. Blessings at shrines add +1 strength.'),
      h('p', h('b', 'Cities: '), 'after winning a city choose Occupy, Pillage, Sack or Raze. Up to 32 armies can defend a city, eight per group. You may raze a city of your own at any time (🔥 in the city screen) to deny it to an enemy.'),
      h('p', h('b', 'Diplomacy (P): '), 'sides are at war, at peace or allied. Each computer side hates you more or less (trust … frenzy) for what you do: attacks, conquests, razing, armies near their cities, being too strong. Propose peace or an alliance, or bribe them (50 gold a point). Attacking a side at peace breaks the treaty. Beaten sides may offer to surrender.'),
      h('p', h('b', 'Travel: '), 'ships sail from ports and from bridges (down the river to the sea). Signposts at road forks name the cities down each road. Merchants sometimes offer magic items; vectoring sends armies between your cities (2 turns, or 2–5 with timed vectoring).'),
      h('p', h('b', 'Victory: '), 'last warlord standing, most cities / victory points / money at the turn limit, King of the Hill (hold Utopia ten days) or Fortress (take every capital) — chosen in the New Game options.'),
    ));
  }
}

export { THREE };
