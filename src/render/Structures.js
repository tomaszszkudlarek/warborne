import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Factions, NEUTRAL_COLOR, SiteTypes } from '../generator/terrainTypes.js';
import { GATES } from '../generator/settlements.js';
import { mulberry32 } from '../core/rng.js';
import { assets, BRIDGE_MODELS } from './Assets.js';
import { U } from './uniforms.js';

function colorize(geo, color, shadeBottom = 0.75) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  const c = new THREE.Color(color);
  const pos = g.attributes.position;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = shadeBottom + (1 - shadeBottom) * ((pos.getY(i) - min.y) / Math.max(1e-3, max.y - min.y));
    col[i * 3] = c.r * t; col[i * 3 + 1] = c.g * t; col[i * 3 + 2] = c.b * t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

// --- bridges ---------------------------------------------------------------------

function bridgeGeometry(b) {
  const L = b.length, W = b.width;
  const midGround = (b.hA + b.hB) / 2;
  const rise = Math.max(0.2, b.water + 0.75 - midGround);
  const deck = (t) => b.hA + (b.hB - b.hA) * t + rise * Math.sin(Math.PI * t) + 0.05;
  const abut = 0.85 / L;
  const inner = 1 - 2 * abut;
  const arches = Math.max(1, Math.round((L - 1.7) / 2.4));
  const bottom = (t) => {
    if (t <= abut || t >= 1 - abut) return Math.min(b.hA, b.hB) - 0.9;
    const u = ((t - abut) / inner) * arches;
    const local = u - Math.floor(u);
    const top = deck(t) - 0.2;
    const base = b.water - 0.6;
    return base + (top - base) * Math.pow(Math.sin(Math.PI * local), 0.45);
  };
  const N = 48;
  const shape = new THREE.Shape();
  shape.moveTo(-L / 2, deck(0));
  for (let i = 1; i <= N; i++) shape.lineTo(-L / 2 + (L * i) / N, deck(i / N));
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    // sample right at pier edges to keep them crisp
    shape.lineTo(-L / 2 + L * t, bottom(Math.min(1, Math.max(0, t))));
  }
  const body = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false, curveSegments: 1 });
  body.translate(0, 0, -W / 2);

  const wall = new THREE.Shape();
  wall.moveTo(-L / 2, deck(0));
  for (let i = 1; i <= N; i++) wall.lineTo(-L / 2 + (L * i) / N, deck(i / N) + 0.02);
  for (let i = N; i >= 0; i--) wall.lineTo(-L / 2 + (L * i) / N, deck(i / N) + 0.2);
  const pA = new THREE.ExtrudeGeometry(wall, { depth: 0.08, bevelEnabled: false, curveSegments: 1 });
  const pB = pA.clone();
  pA.translate(0, 0, W / 2 - 0.08);
  pB.translate(0, 0, -W / 2);

  const merged = mergeGeometries([colorize(body, 0x8f8576, 0.55), colorize(pA, 0xa89e8e, 0.9), colorize(pB, 0xa89e8e, 0.9)]);
  merged.rotateY(Math.atan2(-b.dirZ, b.dirX));
  merged.translate(b.x, 0, b.z);
  return merged;
}

/** Procedural fallback used when bridges.glb is unavailable. */
function createProceduralBridges(map) {
  const geo = mergeGeometries(map.bridges.map(bridgeGeometry));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'bridges';
  return mesh;
}

// Nominal span of each bridge model along X (tools/blender/build_bridges.py) and
// the height of its deck ends above the water.
const BRIDGE_NOMINAL = { Bridge_Wood: 2.6, Bridge_Stone_1: 3.0, Bridge_Stone_3: 4.6 };
const BRIDGE_END_DECK = 0.3;

/** Streams get a timber trestle, rivers a single stone arch, wide rivers three arches. */
function bridgeModel(b) {
  const riverWidth = b.length - 1.7;
  if (riverWidth < 1.05) return 'Bridge_Wood';
  return b.length < 3.9 ? 'Bridge_Stone_1' : 'Bridge_Stone_3';
}

// Deck crown height above the water per model (build_bridges.py); the deck is
// END_DECK at both ends and rises toward the middle.
const BRIDGE_CROWN = { Bridge_Wood: 0.44, Bridge_Stone_1: 0.78, Bridge_Stone_3: 0.86 };
const bridgeBase = (b) => Math.max(b.water, Math.max(b.hA, b.hB) + 0.03 - BRIDGE_END_DECK);

/**
 * Height of the bridge deck walkers stand on at (x, z), or null when (x, z) is not
 * on a bridge. The model is stretched along its span, so the deck profile is too.
 */
export function bridgeDeckAt(map, x, z) {
  for (const b of map.bridges) {
    const dx = x - b.x, dz = z - b.z;
    const along = dx * b.dirX + dz * b.dirZ;
    const across = -dx * b.dirZ + dz * b.dirX;
    const L = b.length * 1.03;
    if (Math.abs(along) > L / 2 || Math.abs(across) > 0.45) continue;
    const name = bridgeModel(b);
    const u = (2 * along) / L;
    const crown = BRIDGE_CROWN[name];
    const p = name === 'Bridge_Wood' ? 1 - u * u : Math.pow(Math.max(0, 1 - u * u), 0.8);
    return bridgeBase(b) + BRIDGE_END_DECK + (crown - BRIDGE_END_DECK) * p;
  }
  return null;
}

export function createBridges(map) {
  if (!map.bridges.length) return null;
  const models = assets.bridges;
  if (!models || !BRIDGE_MODELS.every((n) => models[n])) return createProceduralBridges(map);
  const byModel = new Map();
  for (const b of map.bridges) {
    const name = bridgeModel(b);
    if (!byModel.has(name)) byModel.set(name, []);
    byModel.get(name).push(b);
  }
  const group = new THREE.Group();
  group.name = 'bridges';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (const [name, list] of byModel) {
    for (const part of models[name]) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material.clone(), list.length);
      list.forEach((b, k) => {
        // lift the deck to meet high banks; piers reach far enough down to stay buried
        const y = bridgeBase(b);
        p.set(b.x, y, b.z);
        q.setFromAxisAngle(up, Math.atan2(-b.dirZ, b.dirX));
        s.set((b.length * 1.03) / BRIDGE_NOMINAL[name], 1, 1);
        mesh.setMatrixAt(k, m4.compose(p, q, s));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `bridge-${name}`;
      group.add(mesh);
    }
  }
  return group;
}

// --- ruins & shrines ----------------------------------------------------------------

/** Runes, crystals and flames: the baked colour becomes emission with a slow per-site pulse. */
function makeGlowMaterial(src) {
  const mat = src.clone();
  mat.emissive = new THREE.Color(1, 1, 1);
  mat.emissiveMap = mat.map;
  mat.emissiveIntensity = 1.5;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vGlowPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlowPhase = 0.0;
        #ifdef USE_INSTANCING
          vGlowPhase = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying float vGlowPhase;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float pulse = 0.78 + 0.22 * sin(uTime * 1.9 + vGlowPhase) + 0.08 * sin(uTime * 7.3 + vGlowPhase * 3.1);
        totalEmissiveRadiance *= pulse;`);
  };
  mat.customProgramCacheKey = () => 'site-glow';
  return mat;
}

export function createSites(map) {
  const models = assets.sites;
  if (!map.sites?.length) return null;
  if (!models) {
    console.warn('sites.glb missing; ruins and shrines are not drawn.');
    return null;
  }
  const byModel = new Map();
  for (const site of map.sites) {
    const name = SiteTypes[site.type].model;
    if (!models[name]) continue;
    if (!byModel.has(name)) byModel.set(name, []);
    byModel.get(name).push(site);
  }
  const group = new THREE.Group();
  group.name = 'sites';
  // a touch larger than the 1-tile footprint they were modelled for, so they read as landmarks
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1.15, 1.15, 1.15);
  const up = new THREE.Vector3(0, 1, 0);
  for (const [name, list] of byModel) {
    for (const part of models[name]) {
      const mat = part.role === 'glow' ? makeGlowMaterial(part.material) : part.material.clone();
      const mesh = new THREE.InstancedMesh(part.geometry, mat, list.length);
      list.forEach((site, k) => {
        p.set(site.x, site.y - 0.02, site.z);
        q.setFromAxisAngle(up, site.yaw);
        mesh.setMatrixAt(k, m4.compose(p, q, s));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = part.role !== 'glow';
      mesh.receiveShadow = true;
      mesh.name = `site-${name}-${part.role}`;
      group.add(mesh);
    }
  }
  return group;
}

// --- ports ------------------------------------------------------------------------

/** Harbours: quay on the coastal tile, pier over the sea tile it faces. */
export function createPorts(map) {
  const models = assets.ports;
  if (!map.ports?.length) return null;
  if (!models?.Port) {
    console.warn('ports.glb missing; ports are not drawn.');
    return null;
  }
  const group = new THREE.Group();
  group.name = 'ports';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  for (const part of models.Port) {
    const mat = part.role === 'glow' ? makeGlowMaterial(part.material) : part.material.clone();
    const mesh = new THREE.InstancedMesh(part.geometry, mat, map.ports.length);
    map.ports.forEach((port, k) => {
      p.set(port.x, port.y, port.z);
      q.setFromAxisAngle(up, port.yaw);
      mesh.setMatrixAt(k, m4.compose(p, q, s));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = part.role !== 'glow';
    mesh.receiveShadow = true;
    mesh.name = `port-${part.role}`;
    group.add(mesh);
  }
  return group;
}

/** The boat (a ports.glb object name, the cog by default) one unit sails in at sea;
 * null without the model. */
// boats modelled facing backwards: turned about to sail bow first
const BOAT_REVERSED = new Set(['Boat_Greatship', 'Boat_WaterElemental']);

export function createShip(boat = 'Ship') {
  const name = assets.ports?.[boat] ? boat : 'Ship';
  const parts = assets.ports?.[name];
  if (!parts) return null;
  const group = new THREE.Group();
  const hull = new THREE.Group();
  if (BOAT_REVERSED.has(name)) hull.rotation.y = Math.PI;
  group.add(hull);
  for (const part of parts) {
    const mesh = new THREE.Mesh(part.geometry, part.role === 'glow' ? makeGlowMaterial(part.material) : part.material);
    mesh.castShadow = part.role !== 'glow';
    mesh.receiveShadow = true;
    hull.add(mesh);
  }
  return group;
}

// --- castles ----------------------------------------------------------------------

function castleGeometry(city, rng) {
  const stone = city.owner >= 0 ? 0xb3aa98 : 0x9a958c;
  const dark = 0x6e675c;
  const roofColor = city.owner >= 0 ? Factions[city.owner].color : NEUTRAL_COLOR;
  const parts = [];
  const add = (geo, color, x, y, z, shade) => {
    geo.translate(x, y, z);
    parts.push(colorize(geo, color, shade));
  };
  const size = city.capital ? 1.55 : 1.35;
  const wallH = city.capital ? 0.62 : 0.5;
  // plinth
  add(new THREE.CylinderGeometry(size * 1.35, size * 1.5, 0.5, 8), 0x7d7466, 0, -0.2, 0, 0.5);
  // curtain walls with crenellations
  for (let s = 0; s < 4; s++) {
    const horiz = s % 2 === 0;
    const off = (s < 2 ? 1 : -1) * size;
    const w = new THREE.BoxGeometry(horiz ? size * 2 : 0.2, wallH, horiz ? 0.2 : size * 2);
    add(w, stone, horiz ? 0 : off, wallH / 2, horiz ? off : 0, 0.7);
    for (let c = -3; c <= 3; c++) {
      const m = new THREE.BoxGeometry(0.12, 0.1, 0.12);
      const along = (c / 3.5) * size;
      add(m, stone, horiz ? along : off, wallH + 0.05, horiz ? off : along, 0.9);
    }
  }
  // gatehouse
  add(new THREE.BoxGeometry(0.55, wallH + 0.25, 0.35), stone, 0, (wallH + 0.25) / 2, size, 0.7);
  add(new THREE.BoxGeometry(0.28, 0.32, 0.37), 0x2b2520, 0, 0.16, size + 0.01, 1);
  // corner towers
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const th = wallH + 0.55;
    add(new THREE.CylinderGeometry(0.26, 0.3, th, 10), stone, sx * size, th / 2, sz * size, 0.65);
    add(new THREE.ConeGeometry(0.34, 0.5, 10), roofColor, sx * size, th + 0.25, sz * size, 0.75);
  }
  // houses inside
  const houses = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < houses; i++) {
    const hx = (rng() - 0.5) * size * 1.3, hz = (rng() - 0.5) * size * 1.3;
    if (Math.abs(hx) < 0.55 && Math.abs(hz) < 0.55) continue;
    const hw = 0.22 + rng() * 0.12, hh = 0.18 + rng() * 0.1;
    add(new THREE.BoxGeometry(hw, hh, hw * 1.3), 0xcbb99a, hx, hh / 2, hz, 0.7);
    const roof = new THREE.ConeGeometry(hw * 0.85, 0.2, 4);
    roof.rotateY(Math.PI / 4);
    roof.scale(1, 1, 1.3);
    add(roof, 0x8a3b22, hx, hh + 0.1, hz, 0.8);
  }
  // keep
  const kh = city.capital ? 1.6 : 1.15;
  add(new THREE.BoxGeometry(0.85, kh, 0.85), stone, 0, kh / 2, 0, 0.6);
  const kroof = new THREE.ConeGeometry(0.72, 0.6, 4);
  kroof.rotateY(Math.PI / 4);
  add(kroof, roofColor, 0, kh + 0.3, 0, 0.75);
  if (city.capital) {
    add(new THREE.CylinderGeometry(0.2, 0.22, 0.9, 10), stone, 0.3, kh + 0.3, 0.3, 0.7);
    add(new THREE.ConeGeometry(0.27, 0.55, 10), roofColor, 0.3, kh + 1.0, 0.3, 0.75);
  }
  // banner
  add(new THREE.CylinderGeometry(0.015, 0.015, 0.7, 4), dark, 0, kh + 0.9, 0, 1);
  const flag = new THREE.BoxGeometry(0.32, 0.2, 0.01);
  add(flag, roofColor, 0.17, kh + 1.12, 0, 1);

  const g = mergeGeometries(parts);
  const k = footprintScale([g]);
  g.scale(k, k, k);
  g.rotateY(gateYaw(city));
  g.translate(city.x, city.y - 0.05, city.z);
  return g;
}

/** Procedural fallback used when the Blender models are unavailable. */
function createProceduralCastles(map) {
  const rng = mulberry32(map.params.seed ^ 0xca57);
  const geo = mergeGeometries(map.cities.map((c) => castleGeometry(c, rng)));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'castles';
  return mesh;
}

// Castles fill their 2x2 tiles exactly: the model's footprint is scaled to the
// footprint edge (tile size 2 -> half-extent 2) with a hair of margin.
const CASTLE_HALF = 1.98;

/** Yaw that turns the gatehouse (model +Z) to the city's gate side; always a multiple of 90°. */
function gateYaw(c) {
  const { dx, dy } = GATES.find((g) => g.name === c.gate); // map data carries the side's name
  return Math.atan2(dx, dy);
}

/** A castle's lamplit windows (its emissive map): a faint glow by day, bright at night,
 * with a candle's flicker that differs from castle to castle. */
function litWindows(mat) {
  mat.emissive = new THREE.Color(1, 1, 1);
  mat.emissiveIntensity = 3.2;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uNight = U.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vLampPhase;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLampPhase = 0.0;
        #ifdef USE_INSTANCING
          vLampPhase = instanceMatrix[3][0] * 1.3 + instanceMatrix[3][2] * 2.9;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uNight;
        varying float vLampPhase;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float flicker = 0.88 + 0.08 * sin(uTime * 5.3 + vLampPhase) + 0.04 * sin(uTime * 13.1 + vLampPhase * 2.0);
        totalEmissiveRadiance *= mix(0.12, 1.0, smoothstep(0.05, 0.8, uNight)) * flicker;`);
  };
  mat.customProgramCacheKey = () => 'castle-windows';
}

/** Uniform scale that makes a model's XZ footprint span exactly the city's 2x2 tiles. */
function footprintScale(geometries) {
  let half = 0;
  const box = new THREE.Box3();
  for (const geo of geometries) {
    geo.computeBoundingBox();
    box.copy(geo.boundingBox);
    half = Math.max(half, -box.min.x, box.max.x, -box.min.z, box.max.z);
  }
  return half > 0 ? CASTLE_HALF / half : 1;
}

/** Flag cloth flutters: offset along the normal, growing from pole (aWave = 0) to tip (1). */
function makeFlagMaterial(src) {
  const mat = src.clone();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aWave;
        uniform float uTime; uniform vec2 uWind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float fw = aWave.x;
        float fph = 0.0;
        #ifdef USE_INSTANCING
          fph = instanceMatrix[3][0] * 0.9 + instanceMatrix[3][2] * 0.7;
        #endif
        float wind = 0.5 + min(length(uWind), 2.0) * 0.5;
        float wave = sin(uTime * (4.0 + wind * 2.0) - fw * 7.0 + fph + position.y * 4.0)
                   + 0.4 * sin(uTime * 9.3 - fw * 13.0 + fph * 1.7);
        transformed += objectNormal * wave * 0.035 * fw * wind;
        transformed.y -= fw * fw * 0.03 * (1.0 - min(length(uWind), 1.0));`);
  };
  mat.customProgramCacheKey = () => 'castle-flag';
  return mat;
}

export function createCastles(map) {
  if (!map.cities.length) return null;
  const models = assets.castles;
  if (!models) return createProceduralCastles(map);
  const byLevel = new Map();
  map.cities.forEach((c) => {
    const level = models[c.level] ? c.level : 3;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push({ c, yaw: gateYaw(c) });
  });
  const group = new THREE.Group();
  group.name = 'castles';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  for (const [level, list] of byLevel) {
    const scale = footprintScale(models[level].map((part) => part.geometry));
    for (const part of models[level]) {
      // torches and lit windows glow with a slow flicker; banners and roofs take the owner's colour
      const mat = part.role === 'flag' ? makeFlagMaterial(part.material) : part.role === 'glow' ? makeGlowMaterial(part.material) : part.material.clone();
      if (mat.emissiveMap && part.role !== 'glow') litWindows(mat);
      const mesh = new THREE.InstancedMesh(part.geometry, mat, list.length);
      list.forEach(({ c, yaw }, k) => {
        p.set(c.x, c.y - 0.03, c.z);
        q.setFromAxisAngle(up, yaw);
        s.setScalar(scale);
        mesh.setMatrixAt(k, m4.compose(p, q, s));
        if (part.role === 'accent' || part.role === 'flag') {
          color.set(c.owner >= 0 ? Factions[c.owner].color : NEUTRAL_COLOR);
          mesh.setColorAt(k, color);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = part.role !== 'glow';
      mesh.receiveShadow = true;
      mesh.name = `castle-L${level}-${part.role}`;
      group.add(mesh);
    }
  }
  return group;
}

// --- special sites (mines, stables, smithies ...) ---------------------------------------

const SPECIAL_SCALE = 1.15;
/**
 * Special sites from specials.glb: list [{ model, x, y, z, yaw, owner, razed }]. Pennants
 * (accent) take the owner's colour; razed sites stand charred and sunken.
 */
export function createSpecials(list) {
  const models = assets.specials;
  if (!models || !list.length) return null;
  const group = new THREE.Group();
  group.name = 'specials';
  const byModel = new Map();
  for (const x of list) {
    if (!models[x.model]) continue;
    if (!byModel.has(x.model)) byModel.set(x.model, []);
    byModel.get(x.model).push(x);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(SPECIAL_SCALE, SPECIAL_SCALE, SPECIAL_SCALE);
  const e = new THREE.Euler();
  const color = new THREE.Color();
  for (const [name, sites] of byModel) {
    for (const part of models[name]) {
      const mat = part.role === 'glow' ? makeGlowMaterial(part.material) : part.material.clone();
      const mesh = new THREE.InstancedMesh(part.geometry, mat, sites.length);
      sites.forEach((x, k) => {
        p.set(x.x, x.y - (x.razed ? 0.22 : 0.02), x.z);
        q.setFromEuler(e.set(x.razed ? 0.08 : 0, x.yaw, x.razed ? -0.06 : 0));
        mesh.setMatrixAt(k, m4.compose(p, q, s));
        if (x.razed) color.setRGB(0.2, 0.18, 0.16);
        else if (part.role === 'accent') color.set(x.owner >= 0 ? Factions[x.owner].color : NEUTRAL_COLOR);
        else color.setRGB(1, 1, 1);
        mesh.setColorAt(k, color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = part.role !== 'glow';
      mesh.receiveShadow = true;
      mesh.name = `special-${name}-${part.role}`;
      group.add(mesh);
    }
  }
  return group;
}

/** Footprints of standing special sites, for game/obstacles.js. */
export function specialFootprints(list) {
  const out = [];
  for (const x of list) {
    const parts = assets.specials?.[x.model];
    const e = parts && solidExtent(parts, 0.25);
    if (!e || x.razed) continue;
    const c = Math.cos(x.yaw), sn = Math.sin(x.yaw);
    const hx = e.hx * SPECIAL_SCALE * 0.8, hz = e.hz * SPECIAL_SCALE * 0.8;
    out.push({ x: x.x + e.cx * c + e.cz * sn, z: x.z - e.cx * sn + e.cz * c, yaw: x.yaw, hx, hz, r: Math.min(hx, hz) * 0.5, top: x.y + e.top });
  }
  return out;
}

// --- footprints ---------------------------------------------------------------------

const _solid = new WeakMap();

/**
 * Model-space XZ extent of a model's solid parts {cx, cz, hx, hz} and its height `top`: vertices standing
 * higher than `minY` model units, so low rubble, steps and plinths an army could stand
 * on don't count. Cached per model.
 */
function solidExtent(parts, minY) {
  if (_solid.has(parts)) return _solid.get(parts);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  for (const part of parts) {
    const pos = part.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      top = Math.max(top, pos.getY(i));
      if (pos.getY(i) < minY) continue;
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  }
  const e = x0 < x1 ? { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, top } : null;
  _solid.set(parts, e);
  return e;
}

/**
 * Footprints of the structures armies walk around and stand beside (castles, ruins and
 * shrines) for game/obstacles.js: [{ x, z, yaw, hx, hz, r, top }] in world units (`top`:
 * height of the highest point, for flyers passing over).
 */
export function structureFootprints(map) {
  const out = [];
  const add = (x, z, y, yaw, e, scale, round) => {
    // model-space centre offset turned by the instance's yaw
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ox = e.cx * scale, oz = e.cz * scale;
    const hx = e.hx * scale, hz = e.hz * scale;
    out.push({ x: x + ox * c + oz * s, z: z - ox * s + oz * c, yaw, hx, hz, r: Math.min(hx, hz) * round, top: y + e.top * scale });
  };
  const castles = assets.castles;
  for (const c of map.cities) {
    const parts = castles?.[castles[c.level] ? c.level : 3];
    const scale = parts ? footprintScale(parts.map((p) => p.geometry)) : 1;
    const e = parts && solidExtent(parts, 0.25 / scale);
    // the walls fill the city's 2x2 tiles; corner towers round the corners a little
    if (e) add(c.x, c.z, c.y, gateYaw(c), e, scale, 0.18);
    else out.push({ x: c.x, z: c.z, yaw: 0, hx: CASTLE_HALF, hz: CASTLE_HALF, r: 0.35, top: c.y + 3 });
  }
  const SITE_SCALE = 1.15; // createSites
  for (const site of map.sites ?? []) {
    const parts = assets.sites?.[SiteTypes[site.type].model];
    const e = parts && solidExtent(parts, 0.3 / SITE_SCALE);
    // towers, obelisks and stone rings are round-ish
    if (e) add(site.x, site.z, site.y, site.yaw, e, SITE_SCALE, 0.7);
  }
  return out;
}
