import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PostFX } from './render/PostFX.js';
import { U } from './render/uniforms.js';
import { SpellFX, SPELL_FX } from './render/SpellFX.js';

// Standalone preview of the spell effects (spellfx.html): gentle grassy hills, a few
// placeholder army stacks, orbit camera and a button per spell. window.fxTest exposes
// hooks for headless capture (play, step, pause, setCamera, aura, night).

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.3, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 1, 0);

// --- terrain ------------------------------------------------------------------------------
const heightAt = (x, z) => 0.55 * Math.sin(x * 0.16 + 0.6) * Math.cos(z * 0.13) + 0.25 * Math.sin(x * 0.41 + z * 0.33) + 0.12 * Math.cos(z * 0.7 - x * 0.2);
{
  const g = new THREE.PlaneGeometry(160, 160, 220, 220);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, heightAt(x, z));
    const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    const n = 0.5 + 0.5 * Math.sin(x * 0.35 + Math.sin(z * 0.3) * 2) * Math.cos(z * 0.27);
    c.setRGB(0.15 + 0.05 * n + 0.03 * h, 0.27 + 0.08 * n + 0.05 * h, 0.08 + 0.03 * n);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
}

// --- placeholder army stacks ----------------------------------------------------------------
const capsule = new THREE.CapsuleGeometry(0.17, 0.52, 4, 10);
function makeStack(x, z, color) {
  const g = new THREE.Group();
  g.position.set(x, heightAt(x, z), z);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
  const offs = [[-0.35, -0.3], [0.35, -0.25], [0, 0.3], [-0.5, 0.4], [0.5, 0.45]];
  for (const [ox, oz] of offs) {
    const m = new THREE.Mesh(capsule, mat);
    m.position.set(ox, heightAt(x + ox, z + oz) - g.position.y + 0.43, oz);
    m.castShadow = true;
    g.add(m);
  }
  scene.add(g);
  return g;
}
const stack = makeStack(0, 0, 0xb03028);
const targetStack = makeStack(8, -4, 0x2850b0);
makeStack(-6, 5, 0x8a8a30);

// --- lighting -------------------------------------------------------------------------------
const sun = new THREE.DirectionalLight(0xfff0dd, 3.2);
sun.position.set(30, 45, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 150 });
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3020, 0.35);
scene.add(hemi);
scene.fog = new THREE.FogExp2(0xaabbcc, 0.004);

function setNight(on) {
  if (on) {
    sun.color.set(0x8aa0d0); sun.intensity = 0.9;
    hemi.intensity = 0.5; hemi.color.set(0x405070);
    scene.background = new THREE.Color(0x05070d);
    scene.fog.color.set(0x0a0e18);
    U.uSunColor.value.set(0x8aa0d0).multiplyScalar(0.9 / Math.PI);
    U.uAmbient.value.setRGB(0.05, 0.07, 0.12);
    U.uNight.value = 1;
  } else {
    sun.color.set(0xfff0dd); sun.intensity = 3.2;
    hemi.intensity = 0.35; hemi.color.set(0xbfd8ff);
    scene.background = new THREE.Color(0x9cb8d8);
    scene.fog.color.set(0xaabbcc);
    U.uSunColor.value.set(0xfff0dd).multiplyScalar(3.2 / Math.PI);
    U.uAmbient.value.setRGB(0.42, 0.5, 0.62);
    U.uNight.value = 0;
  }
}
setNight(false);

// --- effects ------------------------------------------------------------------------------
const post = new PostFX(renderer, scene, camera);
post.bloom.strength = 0.35;
const fx = new SpellFX(scene);

function setCamera(dist = 24, elevDeg = 50, azimDeg = 20, ty = 1) {
  const el = THREE.MathUtils.degToRad(elevDeg), az = THREE.MathUtils.degToRad(azimDeg);
  controls.target.set(0, ty, 0);
  camera.position.set(Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(controls.target);
  controls.update();
}
setCamera();

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// --- UI -----------------------------------------------------------------------------------
const status = document.getElementById('status');
const scaleEl = document.getElementById('scale');
const auraEl = document.getElementById('aura');
const repeatEl = document.getElementById('repeat');
let selected = 'heroism';
let aura = null;

function play(id, extra = {}) {
  selected = id;
  document.querySelectorAll('.spells button').forEach((b) => b.classList.toggle('sel', b.dataset.id === id));
  const pos = stack.position.clone();
  const t0 = performance.now();
  status.textContent = `${SPELL_FX[id].name} ...`;
  const p = fx.play(id, pos, {
    scale: Number(scaleEl.value),
    heightAt,
    target: targetStack.position.clone(),
    color: '#d03030',
    onSpawn: () => { status.textContent = `${SPELL_FX[id].name}: spawn at ${((performance.now() - t0) / 1000).toFixed(2)} s`; },
    ...extra,
  });
  p.then(() => {
    status.textContent += ` · done ${((performance.now() - t0) / 1000).toFixed(2)} s`;
    if (repeatEl.checked && selected === id) setTimeout(() => repeatEl.checked && play(id), 400);
  });
  if (auraEl.checked) setAura(id);
  return p;
}

function setAura(id) {
  aura?.dispose();
  aura = id ? fx.aura(stack, id, { heightAt }) : null;
}

const lists = document.getElementById('lists');
const groups = { buff: 'Buffs', curse: 'Curses', summon: 'Summons', utility: 'Utility' };
for (const [kind, title] of Object.entries(groups)) {
  const h = document.createElement('h2');
  h.textContent = title;
  lists.appendChild(h);
  const wrap = document.createElement('div');
  wrap.className = 'spells';
  for (const [id, s] of Object.entries(SPELL_FX)) {
    if (s.kind !== kind) continue;
    const b = document.createElement('button');
    b.textContent = s.name;
    b.dataset.id = id;
    b.style.setProperty('--c', s.color);
    b.onclick = () => play(id);
    wrap.appendChild(b);
  }
  lists.appendChild(wrap);
}
auraEl.onchange = () => setAura(auraEl.checked ? selected : null);
document.getElementById('night').onchange = (ev) => setNight(ev.target.checked);

// --- loop -----------------------------------------------------------------------------------
const clock = new THREE.Timer();
let paused = false;
function advance(dt) {
  U.uTime.value += dt;
  fx.update(dt);
  controls.update();
}
function frame() {
  requestAnimationFrame(frame);
  clock.update(); const dt = Math.min(clock.getDelta(), 0.1);
  if (paused) return;
  advance(dt);
  post.render(dt);
}
frame();

// Hooks for headless capture.
window.fxTest = {
  fx, renderer, camera, post, stack, targetStack, heightAt, SPELL_FX,
  play,
  setCamera,
  setAura,
  night: setNight,
  pause(on = true) { paused = on; },
  /** Advances the simulation by `sec` in fixed 1/60 steps, then renders one frame. */
  step(sec) {
    const n = Math.max(1, Math.round(sec * 60));
    for (let i = 0; i < n; i++) advance(sec / n);
    post.render(sec / n);
  },
  render() { post.render(1 / 60); },
  ready: true,
};
