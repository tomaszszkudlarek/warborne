import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import { Factions, SiteTypes } from '../generator/terrainTypes.js';
import { SPECIAL_TYPES } from '../game/specials.js';

// Models built in Blender by tools/blender/build_*.py and served from public/models.
const BASE = import.meta.env.BASE_URL + 'models/';

/** Loaded model data; empty until loadAssets() resolves. Renderers fall back to procedural geometry. */
export const assets = { castles: null, trees: null, treeLods: null, bridges: null, sites: null, ports: null, specials: null };

let pending = null;

/** A glTF loader for the game's models: the build (tools/pack-models.mjs) ships them
 * meshopt-compressed with WebP textures; the dev server serves them as exported. */
export const gltfLoader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Anisotropic filtering on a material's textures: they stay sharp seen at a glancing
 * angle, as the map's tilted camera sees most of them (the renderer clamps to what the
 * GPU supports). */
export function sharpenTextures(mat) {
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
    if (mat[key]) mat[key].anisotropy = 8;
  }
}

export function loadAssets() {
  pending ??= Promise.all([
    load('castles.glb').then((g) => (assets.castles = extractCastles(g))),
    load('trees.glb').then(async (g) => {
      assets.trees = extractTrees(g);
      assets.treeLods = await makeTreeLods(assets.trees);
    }),
    load('bridges.glb').then((g) => (assets.bridges = extractModels(g, BRIDGE_MODELS))),
    load('sites.glb').then((g) => (assets.sites = extractModels(g, SITE_MODELS))),
    load('ports.glb').then((g) => (assets.ports = extractModels(g, ['Port', 'Ship', ...BOAT_MODELS]))),
    load('specials.glb').then((g) => (assets.specials = extractModels(g, SPECIAL_MODELS))),
  ]).then(() => assets);
  return pending;
}

function load(file) {
  return gltfLoader().loadAsync(BASE + file).catch((err) => {
    console.warn(`Could not load ${file}; using procedural fallback.`, err);
    return null;
  });
}

/**
 * Castle_L{1,2,3}: each mesh has its primitives -> Base / Accent / Flag / Glow materials.
 * Returns { [level]: [{ geometry, role, material }] } with the flag's colour
 * attribute renamed to `aWave` (glTF COLOR_0 would otherwise tint everything).
 */
function extractCastles(gltf) {
  if (!gltf) return null;
  const out = {};
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = /Castle_L(\d)/.exec(o.name) || /Castle_L(\d)/.exec(o.parent?.name ?? '');
    if (!m) return;
    const level = +m[1];
    const mat = o.material;
    const role = /Glow/.test(mat.name) ? 'glow' : /Accent/.test(mat.name) ? 'accent' : /Flag/.test(mat.name) ? 'flag' : 'base';
    const geo = o.geometry;
    if (geo.attributes.color) {
      geo.setAttribute('aWave', geo.attributes.color);
      geo.deleteAttribute('color');
    }
    mat.vertexColors = false;
    sharpenTextures(mat);
    (out[level] ??= []).push({ geometry: geo, role, material: mat });
  });
  return out;
}

/** Trees: one geometry per object name (Pine_A, Oak_B, ...), colour attribute kept as vec3. */
function extractTrees(gltf) {
  if (!gltf) return null;
  const out = {};
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    const col = geo.attributes.color;
    if (col && col.itemSize === 4) {
      const n = col.count;
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        rgb[i * 3] = col.getX(i); rgb[i * 3 + 1] = col.getY(i); rgb[i * 3 + 2] = col.getZ(i);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    geo.deleteAttribute('uv');
    out[o.name] = geo;
  });
  return out;
}

/** Distant-view stand-ins for the trees: each model welded and simplified to about a
 * third of its triangles (shape, normals and colours weighted), for trees that stand a
 * few dozen pixels tall on screen. { [name]: geometry }; null if the simplifier fails. */
async function makeTreeLods(trees, ratio = 0.3) {
  if (!trees) return null;
  try {
    await MeshoptSimplifier.ready;
  } catch (err) {
    console.warn('Mesh simplifier unavailable; trees keep full detail at every distance.', err);
    return null;
  }
  const out = {};
  for (const [name, geo] of Object.entries(trees)) out[name] = simplifyTree(geo, ratio);
  return out;
}

function simplifyTree(geo, ratio) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, col = geo.attributes.color;
  // weld split vertices (colour seams) by position so edges can collapse across them;
  // each welded vertex averages the normals and colours it stands for
  const key = new Map(), remap = new Uint32Array(pos.count);
  const P = [], N = [], C = [], cnt = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let v = key.get(k);
    if (v === undefined) {
      v = cnt.length;
      key.set(k, v);
      P.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      N.push(0, 0, 0); C.push(0, 0, 0); cnt.push(0);
    }
    remap[i] = v;
    N[v * 3] += nor.getX(i); N[v * 3 + 1] += nor.getY(i); N[v * 3 + 2] += nor.getZ(i);
    if (col) { C[v * 3] += col.getX(i); C[v * 3 + 1] += col.getY(i); C[v * 3 + 2] += col.getZ(i); }
    cnt[v]++;
  }
  const n = cnt.length;
  const attrs = new Float32Array(n * 6);
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
    for (let c = 0; c < 3; c++) {
      attrs[v * 6 + c] = N[v * 3 + c] / l;
      attrs[v * 6 + 3 + c] = C[v * 3 + c] / cnt[v];
    }
  }
  const src = geo.index ? geo.index.array : Array.from({ length: pos.count }, (_, i) => i);
  const index = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) index[i] = remap[src[i]];
  const positions = new Float32Array(P);
  const target = Math.max(3, Math.floor((index.length * ratio) / 3) * 3);
  const [simple] = MeshoptSimplifier.simplifyWithAttributes(index, positions, 3, attrs, 6, [0.5, 0.5, 0.5, 1, 1, 1], null, target, 0.05);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => attrs[Math.floor(i / 3) * 6 + (i % 3)]), 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => attrs[Math.floor(i / 3) * 6 + 3 + (i % 3)]), 3));
  out.setIndex(new THREE.BufferAttribute(simple, 1));
  return out;
}

export const BRIDGE_MODELS = ['Bridge_Wood', 'Bridge_Stone_1', 'Bridge_Stone_3'];
const SITE_MODELS = Object.values(SiteTypes).map((t) => t.model);
const BOAT_MODELS = [...new Set(Factions.map((f) => f.boat))];
const SPECIAL_MODELS = Object.values(SPECIAL_TYPES).map((t) => t.model);

/**
 * Baked single-atlas models (bridges.glb, sites.glb). Returns
 * { [objectName]: [{ geometry, role: 'base' | 'glow', material }] }; a model with a
 * glow material is a group of two meshes, so the name is looked up on ancestors too.
 */
function extractModels(gltf, names) {
  if (!gltf) return null;
  const known = new Set(names);
  const out = {};
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    let n = o;
    while (n && !known.has(n.name)) n = n.parent;
    if (!n) return;
    const geo = o.geometry;
    if (geo.attributes.color) geo.deleteAttribute('color');
    o.material.vertexColors = false;
    sharpenTextures(o.material);
    const role = /Glow/.test(o.material.name) ? 'glow' : /Accent/.test(o.material.name) ? 'accent' : 'base';
    (out[n.name] ??= []).push({ geometry: geo, role, material: o.material });
  });
  return out;
}
