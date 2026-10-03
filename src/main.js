import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import GUI from 'lil-gui';
import './style.css';

import { defaultParams, presets, shapes } from './generator/params.js';
import { TileInfo, Flag, Factions, CastleLevels, SiteTypes } from './generator/terrainTypes.js';
import { U } from './render/uniforms.js';
import { SkySystem } from './render/Sky.js';
import { WeatherSystem, WEATHER_PRESETS } from './render/Weather.js';
import { World } from './render/World.js';
import { loadAssets } from './render/Assets.js';
import { PostFX } from './render/PostFX.js';
import { Minimap } from './ui/Minimap.js';
import { HeroTest } from './ui/HeroTest.js';
import { encodeMap, MAP_FILE_EXT } from './core/mapfile.js';

// --- renderer / scene ----------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.className = 'labels';
app.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.3, 3000);
camera.position.set(0, 90, 95);

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.zoomToCursor = true;
controls.minDistance = 5;
controls.maxDistance = 260;
controls.maxPolarAngle = 1.38;
controls.minPolarAngle = 0.12;

const sky = new SkySystem(renderer, scene);
const weather = new WeatherSystem(scene, sky);
const world = new World(scene);
const post = new PostFX(renderer, scene, camera);
post.setSize(window.innerWidth, window.innerHeight);
weather.heightAt = (x, z) => world.heightAt(x, z);

const labelGroup = new THREE.Group();
scene.add(labelGroup);

// --- HUD ------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const loading = $('loading'), loadStage = $('load-stage'), loadBar = $('load-bar');
const tileInfo = $('tile-info'), mapInfo = $('map-info');
const minimap = new Minimap($('minimap-wrap'), (x, z) => {
  const off = camera.position.clone().sub(controls.target);
  controls.target.set(x, Math.max(0, world.heightAt(x, z)), z);
  camera.position.copy(controls.target).add(off);
});

// --- parameters -----------------------------------------------------------------------
const P = { ...defaultParams };
const V = {
  preset: 'Classic Continent',
  timeOfDay: sky.timeOfDay,
  daySpeed: 0,
  sunAzimuth: sky.azimuth,
  sunHeight: sky.maxElevation,
  weather: weather.preset,
  autoWeather: false,
  wind: 1,
  windDir: 23,
  cloudLayer: true,
  grid: false,
  labels: true,
  vegetation: true,
  structures: true,
  bloom: 0.35,
  exposure: 1.0,
  tiltShift: false,
  shadows: true,
};

// --- generation (web worker) ------------------------------------------------------
let worker = null, busy = false, genId = 0, firstBuild = true, lastSize = '';
const assetsReady = loadAssets();
function makeWorker() {
  const w = new Worker(new URL('./generator/worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const msg = e.data;
    if (msg.id !== genId) return;
    if (msg.type === 'progress') {
      loadStage.textContent = msg.stage;
      loadBar.style.width = `${Math.round(msg.progress * 100)}%`;
    } else if (msg.type === 'done') {
      busy = false;
      // models load in parallel with the first generation; later builds find them ready
      assetsReady.then(() => { if (msg.id === genId) onMap(msg.map); });
    } else if (msg.type === 'error') {
      busy = false;
      loadStage.textContent = `Generation failed: ${msg.message}`;
      console.error(msg.stack);
    }
  };
  return w;
}
function generate() {
  if (busy && worker) { worker.terminate(); worker = null; }
  worker ??= makeWorker();
  busy = true;
  genId++;
  loading.classList.add('visible');
  loadStage.textContent = 'Preparing';
  loadBar.style.width = '0%';
  worker.postMessage({ id: genId, params: { ...P } });
}
let regenTimer = 0;
const regenerateSoon = () => { clearTimeout(regenTimer); regenTimer = setTimeout(generate, 250); };

function onMap(map) {
  const t0 = performance.now();
  world.build(map);
  const g = map.grid;
  sky.fitShadowToMap(g.worldW, g.worldH);
  weather.mapExtent.set(g.worldW, g.worldH);
  minimap.setMap(map);
  heroTest.reset(map);
  buildLabels(map);
  applyVisibility();
  const size = `${g.worldW}x${g.worldH}`;
  if (firstBuild || size !== lastSize) {
    const d = Math.max(g.worldW, g.worldH * 1.3) * 0.62;
    controls.target.set(0, 0, 4);
    camera.position.set(0, d * 0.85, d * 0.75);
    firstBuild = false;
    lastSize = size;
  }
  const buildMs = Math.round(performance.now() - t0);
  const nBridges = map.bridges.length;
  const nRuins = map.sites.filter((s) => s.kind === 'ruin').length, nShrines = map.sites.length - nRuins;
  mapInfo.innerHTML = `
    <b>Seed ${map.params.seed}</b> · ${g.tilesW}×${g.tilesH} tiles · ${map.params.shape}<br>
    ${map.cities.length} cities · ${map.rivers.filter((r) => r.main).length} rivers · ${map.lakes.length} lakes ·
    ${nBridges} bridge${nBridges === 1 ? '' : 's'} · ${map.volcanoes.length} volcano${map.volcanoes.length === 1 ? '' : 'es'} ·
    ${nRuins} ruin${nRuins === 1 ? '' : 's'} · ${nShrines} shrine${nShrines === 1 ? '' : 's'} ·
    ${map.ports.length} port${map.ports.length === 1 ? '' : 's'}<br>
    <span class="dim">generated in ${map.stats.ms} ms · built in ${buildMs} ms</span>`;
  loading.classList.remove('visible');
}

function buildLabels(map) {
  for (const l of [...labelGroup.children]) { l.element.remove(); labelGroup.remove(l); }
  for (const c of map.cities) {
    const div = document.createElement('div');
    div.className = 'city-label' + (c.capital ? ' capital' : '');
    const color = c.owner >= 0 ? Factions[c.owner].color : '#9a9a9a';
    div.innerHTML = `<span class="dot" style="background:${color}"></span>${c.capital ? '♛ ' : ''}${c.name}`;
    div.title = c.owner >= 0 ? Factions[c.owner].name : 'Neutral';
    const obj = new CSS2DObject(div);
    obj.position.set(c.x, c.y + (c.capital ? 3.4 : 2.7), c.z);
    labelGroup.add(obj);
  }
}

function applyVisibility() {
  world.setVisible('vegetation', V.vegetation);
  world.setVisible('grass', V.vegetation);
  world.setVisible('castles', V.structures);
  world.setVisible('bridges', V.structures);
  world.setVisible('sites', V.structures);
  world.setVisible('ports', V.structures);
  labelGroup.visible = V.labels;
  labelRenderer.domElement.style.display = V.labels ? '' : 'none';
}

// --- GUI -----------------------------------------------------------------------------
const gui = new GUI({ title: 'Map Forge', width: 300 });
gui.add(V, 'preset', Object.keys(presets)).name('Preset').onChange((name) => {
  Object.assign(P, defaultParams, presets[name], { seed: P.seed });
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  generate();
});
const fMap = gui.addFolder('World');
fMap.add(P, 'seed', 0, 999999, 1).name('Seed').onFinishChange(regenerateSoon);
fMap.add({ roll: () => { P.seed = Math.floor(Math.random() * 999999); fMap.controllers[0].updateDisplay(); generate(); } }, 'roll').name('🎲  New seed');
fMap.add(P, 'shape', shapes).name('Shape').onChange(regenerateSoon);
fMap.add(P, 'tilesW', 32, 160, 1).name('Width (tiles)').onFinishChange(regenerateSoon);
fMap.add(P, 'tilesH', 24, 120, 1).name('Height (tiles)').onFinishChange(regenerateSoon);
fMap.add(P, 'detail', 3, 8, 1).name('Detail').onFinishChange(regenerateSoon);
fMap.add(P, 'water', 0.05, 0.8, 0.01).name('Water %').onFinishChange(regenerateSoon);
fMap.add(P, 'landScale', 0.4, 2, 0.05).name('Landmass scale').onFinishChange(regenerateSoon);
const fTer = gui.addFolder('Terrain');
fTer.add(P, 'mountains', 0, 1, 0.01).name('Mountains').onFinishChange(regenerateSoon);
fTer.add(P, 'hills', 0, 1, 0.01).name('Hills (relief)').onFinishChange(regenerateSoon);
fTer.add(P, 'roughness', 0, 1, 0.01).name('Roughness').onFinishChange(regenerateSoon);
fTer.add(P, 'erosion', 0, 1, 0.01).name('Erosion').onFinishChange(regenerateSoon);
fTer.add(P, 'volcanoes', 0, 8, 1).name('Volcanoes').onFinishChange(regenerateSoon);
const fCli = gui.addFolder('Climate & Biomes');
fCli.add(P, 'temperature', -0.5, 0.5, 0.01).name('Temperature').onFinishChange(regenerateSoon);
fCli.add(P, 'moisture', -0.5, 0.5, 0.01).name('Moisture').onFinishChange(regenerateSoon);
fCli.add(P, 'forests', 0, 1, 0.01).name('Forests').onFinishChange(regenerateSoon);
fCli.add(P, 'swamps', 0, 1, 0.01).name('Swamps').onFinishChange(regenerateSoon);
fCli.add(P, 'ice', 0, 1, 0.01).name('Polar ice').onFinishChange(regenerateSoon);
const fWat = gui.addFolder('Rivers & Lakes');
fWat.add(P, 'rivers', 0, 1, 0.01).name('River density').onFinishChange(regenerateSoon);
fWat.add(P, 'maxRivers', 0, 40, 1).name('Max river systems').onFinishChange(regenerateSoon);
fWat.add(P, 'riverWidth', 0.5, 2, 0.05).name('River width').onFinishChange(regenerateSoon);
fWat.add(P, 'lakes', 0, 1, 0.01).name('Lakes').onFinishChange(regenerateSoon);
const fRealm = gui.addFolder('Realm');
fRealm.add(P, 'cities', 0, 80, 1).name('Cities').onFinishChange(regenerateSoon);
fRealm.add(P, 'citySpacing', 0, 24, 1).name('Min. city spacing (tiles)').onFinishChange(regenerateSoon);
fRealm.add(P, 'factions', 0, 8, 1).name('Factions').onFinishChange(regenerateSoon);
fRealm.add(P, 'roads').name('Roads & bridges').onChange(regenerateSoon);
fRealm.add(P, 'roadLoops', 0, 1, 0.05).name('Road loops').onFinishChange(regenerateSoon);
fRealm.add(P, 'ruins', 0, 60, 1).name('Ruins').onFinishChange(regenerateSoon);
fRealm.add(P, 'shrines', 0, 50, 1).name('Shrines').onFinishChange(regenerateSoon);
fRealm.add(P, 'ports', 0, 30, 1).name('Ports (min. 1 per island)').onFinishChange(regenerateSoon);
[fTer, fCli, fWat, fRealm].forEach((f) => f.close());
gui.add({ gen: generate }, 'gen').name('⚒  Regenerate');
gui.add({ save: saveForGame }, 'save').name('💾  Save map for the game (.wlmap)');
gui.add({ exp: exportMap }, 'exp').name('⤓  Export map (JSON)');
gui.add({ shot: screenshot }, 'shot').name('📷  Screenshot');

const fSky = gui.addFolder('Sun & Sky');
fSky.add(V, 'timeOfDay', 0, 24, 0.01).name('Time of day').listen().onChange((v) => (sky.timeOfDay = v));
fSky.add(V, 'daySpeed', 0, 2, 0.01).name('Day cycle speed').onChange((v) => (sky.daySpeed = v));
fSky.add(V, 'sunAzimuth', 0, 360, 1).name('Sun azimuth').onChange((v) => (sky.azimuth = v));
fSky.add(V, 'sunHeight', 15, 85, 1).name('Sun max height').onChange((v) => (sky.maxElevation = v));
const fWx = gui.addFolder('Weather');
fWx.add(V, 'weather', Object.keys(WEATHER_PRESETS)).name('Weather').listen().onChange((v) => weather.setPreset(v));
fWx.add(V, 'autoWeather').name('Changing weather').onChange((v) => (weather.autoCycle = v));
fWx.add(V, 'wind', 0, 2.5, 0.01).name('Wind strength').onChange((v) => (weather.windScale = v));
fWx.add(V, 'windDir', 0, 360, 1).name('Wind direction').onChange((v) => (weather.windAngle = THREE.MathUtils.degToRad(v)));
fWx.add(V, 'cloudLayer').name('Low cloud layer').onChange((v) => (weather.cloudLayerEnabled = v));
weather.onAutoChange = (name) => (V.weather = name);
const fDisp = gui.addFolder('Display');
fDisp.add(V, 'grid').name('Tile grid').onChange((v) => (U.uGrid.value = v ? 1 : 0));
fDisp.add(V, 'labels').name('City names').onChange(applyVisibility);
fDisp.add(V, 'vegetation').name('Vegetation').onChange(applyVisibility);
fDisp.add(V, 'structures').name('Castles, bridges, sites & ports').onChange(applyVisibility);
fDisp.add(V, 'bloom', 0, 1.5, 0.01).name('Bloom').onChange((v) => (post.bloom.strength = v));
fDisp.add(V, 'exposure', 0.3, 2, 0.01).name('Exposure').onChange((v) => (renderer.toneMappingExposure = v));
fDisp.add(V, 'tiltShift').name('Tilt-shift (miniature)').onChange((v) => post.setTiltShift(v));
fDisp.add(V, 'shadows').name('Shadows').onChange((v) => (sky.light.castShadow = v));
[fSky, fWx, fDisp].forEach((f) => f.close());
fWx.open();

// Hero movement test bench: heroes live only in the scene, never in the map or its export.
const heroTest = new HeroTest({ scene, camera, renderer, world, gui });

// --- export / screenshot -----------------------------------------------------------------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportMap() {
  const m = world.map;
  if (!m) return;
  const g = m.grid;
  const data = {
    format: 'warlords-map/1',
    params: m.params,
    width: g.tilesW,
    height: g.tilesH,
    tileTypes: TileInfo.map((t) => t.name),
    flags: Object.fromEntries(Object.entries(Flag)),
    tiles: Array.from(m.tiles),
    tileFlags: Array.from(m.flags),
    tileHeights: Array.from(m.tileHeights, (h) => Math.round(h * 100) / 100),
    castleLevels: CastleLevels.filter(Boolean),
    cities: m.cities.map((c) => ({
      name: c.name, x: c.tx, y: c.ty, owner: c.owner >= 0 ? Factions[c.owner].name : null, capital: c.capital,
      level: c.level, defense: c.defense, gate: c.gate, island: c.region,
    })),
    roads: m.roads.map((r) => r.tiles.map((t) => [t % g.tilesW, Math.floor(t / g.tilesW)])),
    sites: m.sites.map((s) => ({
      name: s.name, kind: s.kind, type: s.type, typeName: SiteTypes[s.type].name, x: s.tx, y: s.ty,
      ...(s.kind === 'ruin' ? { danger: s.danger } : { boon: SiteTypes[s.type].boon }),
    })),
    // a port's pier faces `dir`; ships sail from its sea tile (seaX, seaY) within one body of `sea`
    ports: m.ports.map((p) => ({ name: p.name, x: p.tx, y: p.ty, dir: p.dir, seaX: p.seaTx, seaY: p.seaTy, sea: p.sea, island: p.region })),
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `warlords-map-${m.params.seed}.json`);
}
/** The whole generated map as a .wlmap file; put it in the project's maps/ folder to play it. */
async function saveForGame() {
  const m = world.map;
  if (!m) return;
  const name = prompt('Map name', `${V.preset} ${m.params.seed}`);
  if (!name) return;
  const bytes = await encodeMap(m, { name, preset: V.preset });
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + MAP_FILE_EXT;
  download(new Blob([bytes], { type: 'application/octet-stream' }), file);
}
function screenshot() {
  post.render(0);
  renderer.domElement.toBlob((b) => b && download(b, `warlords-${P.seed}.png`), 'image/png');
}

// --- input -----------------------------------------------------------------------------------
const mouse = new THREE.Vector2(9, 9);
let mouseDirty = false;
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  mouseDirty = true;
});
renderer.domElement.addEventListener('pointerleave', () => { mouse.set(9, 9); world.highlightTile(-1, -1); tileInfo.classList.remove('visible'); });
const keys = new Set();
window.addEventListener('keydown', (e) => { if (!(e.target instanceof HTMLInputElement)) keys.add(e.code); });
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const raycaster = new THREE.Raycaster();
function updateHover() {
  if (!mouseDirty || !world.map || Math.abs(mouse.x) > 1) return;
  mouseDirty = false;
  raycaster.setFromCamera(mouse, camera);
  const hit = world.pick(raycaster.ray);
  if (!hit) { world.highlightTile(-1, -1); tileInfo.classList.remove('visible'); return; }
  const m = world.map, W = m.grid.tilesW;
  const t = hit.ty * W + hit.tx;
  world.highlightTile(hit.tx, hit.ty);
  const f = m.flags[t];
  const tags = [];
  if (f & Flag.RIVER) tags.push('River');
  if (f & Flag.BRIDGE) tags.push('Bridge');
  if (f & Flag.ROAD) tags.push('Road');
  if (f & Flag.COAST) tags.push('Coast');
  if (f & Flag.LAKE) tags.push('Lake');
  if (f & Flag.FROZEN) tags.push('Frozen');
  if (f & Flag.RUIN) tags.push('Ruin');
  if (f & Flag.SHRINE) tags.push('Shrine');
  if (f & Flag.PORT) tags.push('Port');
  if (f & Flag.LAVA) tags.push('Lava');
  const info = TileInfo[m.tiles[t]];
  let city = '';
  if (f & Flag.CITY) {
    const c = m.cities.find((c) => hit.tx >= c.tx && hit.tx <= c.tx + 1 && hit.ty >= c.ty && hit.ty <= c.ty + 1);
    if (c) {
      const lvl = CastleLevels[c.level];
      city = `<div class="city">${c.capital ? '♛ ' : ''}${c.name} — ${c.owner >= 0 ? Factions[c.owner].name : 'Neutral'}</div>
        <div class="dim">${lvl.name} (level ${lvl.level}) · defense +${lvl.defense}</div>`;
    }
  }
  let site = '';
  if (f & (Flag.RUIN | Flag.SHRINE)) {
    const s = m.sites.find((s) => s.tx === hit.tx && s.ty === hit.ty);
    if (s) {
      const st = SiteTypes[s.type];
      site = s.kind === 'ruin'
        ? `<div class="city">☠ ${s.name}</div><div class="dim">${st.name} · danger ${'★'.repeat(s.danger)}${'☆'.repeat(3 - s.danger)}</div>`
        : `<div class="city">✦ ${s.name}</div><div class="dim">${st.name} · ${st.boon}</div>`;
    }
  }
  if (f & Flag.PORT) {
    const p = m.ports.find((p) => p.tx === hit.tx && p.ty === hit.ty);
    if (p) site += `<div class="city">⚓ ${p.name}</div><div class="dim">Harbour · armies embark and land here</div>`;
  }
  tileInfo.innerHTML = `
    <div class="tile-title"><span class="swatch" style="background:${info.color}"></span>${info.name}</div>
    ${city}${site}
    <div class="dim">Tile ${hit.tx}, ${hit.ty} · elevation ${m.tileHeights[t].toFixed(1)}${info.moveCost !== Infinity ? ` · move ${info.moveCost}` : ' · impassable'}</div>
    ${tags.length ? `<div class="tags">${tags.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}`;
  tileInfo.classList.add('visible');
}

const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function keyboardPan(dt) {
  if (!keys.size) return;
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();
  const dist = camera.position.distanceTo(controls.target);
  const speed = dist * 0.9 * dt;
  const move = new THREE.Vector3();
  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
  if (move.lengthSq()) {
    move.normalize().multiplyScalar(speed);
    camera.position.add(move);
    controls.target.add(move);
  }
  const rot = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
  if (rot) {
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(camera.up, rot * dt * 1.2);
    camera.position.copy(controls.target).add(off);
  }
}

// --- sun glare occlusion ------------------------------------------------------------------
const sunNdc = new THREE.Vector3();
let flareVis = 0;
function updateFlare(dt) {
  let target = 0;
  const sd = sky.sunDir;
  camera.getWorldDirection(fwd);
  if (sd.y > -0.02 && fwd.dot(sd) > 0.2) {
    sunNdc.copy(camera.position).addScaledVector(sd, 1000).project(camera);
    if (sunNdc.z < 1 && Math.abs(sunNdc.x) < 1.3 && Math.abs(sunNdc.y) < 1.3) {
      target = 1;
      // occluded by terrain?
      const p = new THREE.Vector3();
      for (let t = 1; t < 300; t += 1.5) {
        p.copy(camera.position).addScaledVector(sd, t);
        if (p.y > 20) break;
        if (p.y < world.heightAt(p.x, p.z)) { target = 0; break; }
      }
      target *= (1 - sky.overcast) * (1 - U.uCloudCover.value * 0.55);
      target *= 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y)), 0.9, 1.3);
      target *= THREE.MathUtils.smoothstep(sd.y, -0.02, 0.06);
      post.flare.uniforms.uSunPos.value.set(sunNdc.x * 0.5 + 0.5, sunNdc.y * 0.5 + 0.5);
      post.flare.uniforms.uColor.value.copy(sky.light.color);
    }
  }
  flareVis += (target - flareVis) * Math.min(1, dt * 8);
  post.flare.uniforms.uVisible.value = flareVis * 0.8;
}

// --- loop ----------------------------------------------------------------------------------
function pointScale() {
  const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  return h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  post.setSize(w, h);
  const ps = pointScale();
  weather.setPointScale(ps);
  world.parts.volcanoFX?.userData.setPointScale(ps);
}
window.addEventListener('resize', onResize);

let last = performance.now(), frameNo = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frameNo++;
  U.uTime.value += dt;

  keyboardPan(dt);
  controls.update();
  // keep the camera above ground and the focus on the board
  if (world.map) {
    const g = world.map.grid;
    const tx = THREE.MathUtils.clamp(controls.target.x, -g.worldW / 2, g.worldW / 2);
    const tz = THREE.MathUtils.clamp(controls.target.z, -g.worldH / 2, g.worldH / 2);
    const dx = tx - controls.target.x, dz = tz - controls.target.z;
    controls.target.x = tx; controls.target.z = tz;
    camera.position.x += dx; camera.position.z += dz;
    const groundT = Math.max(0, world.heightAt(tx, tz));
    const ty = controls.target.y + (groundT * 0.6 - controls.target.y) * Math.min(1, dt * 3);
    camera.position.y += ty - controls.target.y;
    controls.target.y = ty;
    const minY = Math.max(0, world.heightAt(camera.position.x, camera.position.z)) + 1.2;
    if (camera.position.y < minY) camera.position.y = minY;
    if (frameNo % 2 === 0) world.parts.volcanoFX?.userData.setPointScale(pointScale());
  }

  camera.getWorldDirection(fwd);
  sky.focusShadow(controls.target, camera.position.distanceTo(controls.target), fwd);
  weather.update(dt, camera, controls.target);
  sky.update(dt);
  V.timeOfDay = sky.timeOfDay;
  world.update(U.uTime.value, camera, controls.target);
  heroTest.update(dt);
  updateHover();
  updateFlare(dt);

  post.render(dt);
  if (V.labels) labelRenderer.render(scene, camera);
  if (frameNo % 3 === 0) minimap.draw(camera);
}

onResize();
generate();
requestAnimationFrame(frame);

// Handy for tinkering from the dev console.
window.forge = { THREE, post, scene, camera, controls, sky, weather, world, params: P, view: V, generate, U, heroTest };
