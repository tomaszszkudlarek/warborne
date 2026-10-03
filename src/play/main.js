// Warborne: Darklords Rise — the game. Boots the renderer and the world, shows the main menu and runs games.
// The map generator is a separate page (forge.html); the game plays the maps in maps/.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import './game.css';

import { U } from '../render/uniforms.js';
import { SkySystem } from '../render/Sky.js';
import { WeatherSystem } from '../render/Weather.js';
import { World } from '../render/World.js';
import { loadAssets } from '../render/Assets.js';
import { PostFX } from '../render/PostFX.js';
import { Controller, DAY_SPEED } from './Controller.js';
import { MainMenu } from './menu.js';
import { music } from './music.js';
import { FogOfWar } from './fog.js';
import { setFigureScale } from '../render/Heroes.js';

// armies read better a little larger on the game map than in the generator's test bench
setFigureScale(0.9);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// redrawn every other frame (see frame()): only the slow sun and marching armies change it
renderer.shadowMap.autoUpdate = false;
document.getElementById('app').appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.className = 'labels';
document.getElementById('app').appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.3, 3000);
camera.position.set(0, 60, 60);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.zoomToCursor = true;
controls.minDistance = 6;
controls.maxDistance = 170;
controls.maxPolarAngle = 1.3;
controls.minPolarAngle = 0.15;

const sky = new SkySystem(renderer, scene);
const weather = new WeatherSystem(scene, sky);
const world = new World(scene);
const post = new PostFX(renderer, scene, camera);
post.setSize(innerWidth, innerHeight);
weather.heightAt = (x, z) => world.heightAt(x, z);
weather.autoCycle = false;
sky.daySpeed = DAY_SPEED;
const fog = new FogOfWar(renderer, scene, camera, post, world);

const labelGroup = new THREE.Group();
scene.add(labelGroup);

const ctl = new Controller({ renderer, scene, camera, controls, sky, weather, world, post, labelGroup, U, fog });
// only a real drag takes the camera from a glide (the turn's look at the capital): OrbitControls
// starts on any press or wheel turn, so a click or a zoom would cancel it
{
  let press = null;
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', (e) => { press = { x: e.clientX, y: e.clientY }; });
  addEventListener('pointerup', () => { press = null; });
  dom.addEventListener('pointermove', (e) => {
    if (press && e.buttons && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) ctl.userCamera();
  });
}
ctl.applyOpts();

// --- loading screen -----------------------------------------------------------------------------------
const loading = document.getElementById('loading');
const loadStage = document.getElementById('loadStage');
const loadBar = document.getElementById('loadBar');
export function showLoading(stage, p = null) {
  loading.classList.remove('gone');
  loadStage.textContent = stage;
  if (p != null) loadBar.style.width = `${Math.round(p * 100)}%`;
}
export function hideLoading() { loading.classList.add('gone'); }

/** Builds the 3D world for a map and frames the whole of it. */
function buildWorld(map) {
  world.build(map);
  const g = map.grid;
  sky.fitShadowToMap(g.worldW, g.worldH);
  weather.mapExtent.set(g.worldW, g.worldH);
  fog.setMap(map);
}

const menu = new MainMenu({
  ctl, buildWorld, showLoading, hideLoading, assets: loadAssets(),
  setView(mode) {
    // 'menu': a slow flight over the map; 'game': the player's camera
    viewMode = mode;
    controls.enabled = mode === 'game';
  },
  camera, controls,
});
let viewMode = 'menu';
ctl.onQuit = () => menu.show();

// --- keyboard camera --------------------------------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => { if (!(e.target instanceof HTMLInputElement)) keys.add(e.code); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function keyboardPan(dt) {
  if (!keys.size || viewMode !== 'game') return;
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();
  const speed = camera.position.distanceTo(controls.target) * 0.9 * dt;
  const move = new THREE.Vector3();
  if (keys.has('ArrowUp') || keys.has('KeyW')) move.add(fwd);
  if (keys.has('ArrowDown') || keys.has('KeyS')) move.sub(fwd);
  if (keys.has('ArrowRight') || keys.has('KeyD')) move.add(right);
  if (keys.has('ArrowLeft') || keys.has('KeyA')) move.sub(right);
  if (move.lengthSq() || keys.has('KeyQ') || keys.has('KeyE')) ctl.userCamera();
  if (move.lengthSq()) { move.normalize().multiplyScalar(speed); camera.position.add(move); controls.target.add(move); }
  const rot = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
  if (rot) {
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(camera.up, rot * dt * 1.2);
    camera.position.copy(controls.target).add(off);
  }
}

// --- resize / loop ------------------------------------------------------------------------------------------
function pointScale() {
  const hgt = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  return hgt / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
  weather.setPointScale(pointScale());
  world.parts.volcanoFX?.userData.setPointScale(pointScale());
  world.parts.siteFX?.userData.setPointScale(pointScale());
}
addEventListener('resize', onResize);

let last = performance.now(), frameNo = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frameNo++;
  U.uTime.value += dt;
  if (viewMode === 'menu') menu.updateCamera(dt); // the menu's flight owns the camera
  else { keyboardPan(dt); controls.update(); }
  if (world.map && viewMode !== 'menu') {
    const g = world.map.grid;
    const tx = THREE.MathUtils.clamp(controls.target.x, -g.worldW / 2, g.worldW / 2);
    const tz = THREE.MathUtils.clamp(controls.target.z, -g.worldH / 2, g.worldH / 2);
    camera.position.x += tx - controls.target.x; camera.position.z += tz - controls.target.z;
    controls.target.x = tx; controls.target.z = tz;
    const groundT = Math.max(0, world.heightAt(tx, tz));
    const ty = controls.target.y + (groundT * 0.6 - controls.target.y) * Math.min(1, dt * 3);
    camera.position.y += ty - controls.target.y;
    controls.target.y = ty;
    const minY = Math.max(0, world.heightAt(camera.position.x, camera.position.z)) + 1.2;
    if (camera.position.y < minY) camera.position.y = minY;
    if (frameNo % 2 === 0) { world.parts.volcanoFX?.userData.setPointScale(pointScale()); world.parts.siteFX?.userData.setPointScale(pointScale()); }
  }
  camera.getWorldDirection(fwd);
  const viewDist = camera.position.distanceTo(controls.target);
  sky.focusShadow(controls.target, viewDist, fwd);
  sky.fogViewDist = viewMode === 'menu' ? null : viewDist;
  weather.update(dt, camera, controls.target);
  sky.update(dt);
  ctl.update(dt);
  fog.update();
  // the shadow map keeps the light matrix it was drawn with, so a skipped frame stays aligned
  if (frameNo % 2 === 0) renderer.shadowMap.needsUpdate = true;
  world.update(U.uTime.value, camera, controls.target, innerHeight);
  post.render(dt);
  labelRenderer.render(scene, camera);
}

onResize();
requestAnimationFrame(frame);
menu.boot();

// console / test hook: warlords.quickStart('small-skirmish.wlmap') starts a game with the first side human
async function quickStart(file, players = null, options = {}) {
  const { loadMap } = await import('./storage.js');
  const { DEFAULT_OPTIONS } = await import('../game/Game.js');
  const base = await loadMap(file);
  const sides = [...new Set(base.cities.filter((c) => c.capital).map((c) => c.owner))].sort((a, b) => a - b);
  await menu.start({ file, map: base, players: players ?? sides.map((side, i) => ({ side, human: i === 0, ai: 'lord', off: false })), options: { ...DEFAULT_OPTIONS, ...options } });
}
window.warlords = { THREE, scene, camera, controls, sky, weather, world, post, ctl, menu, U, music, quickStart };
