import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { U } from './uniforms.js';
import { mulberry32 } from '../core/rng.js';
import { assets } from './Assets.js';

// --- procedural models ---------------------------------------------------------

function part(geo, color, { x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0, rz = 0, jitter = 0, seed = 1, shade = true } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  if (jitter) {
    // deterministic per-position jitter keeps shared vertices welded
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const h = Math.sin(vx * 127.1 + vy * 311.7 + vz * 74.7 + seed) * 43758.5453;
      const r = (h - Math.floor(h)) - 0.5;
      const s = 1 + r * jitter;
      p.setXYZ(i, vx * s, vy * s, vz * s);
    }
  }
  g.scale(sx, sy, sz);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color(color);
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  for (let i = 0; i < pos.count; i++) {
    // fake ambient occlusion: darker toward the bottom of each part
    const t = shade ? 0.62 + 0.38 * ((pos.getY(i) - min.y) / Math.max(1e-3, max.y - min.y)) : 1;
    col[i * 3] = c.r * t; col[i * 3 + 1] = c.g * t; col[i * 3 + 2] = c.b * t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function pineGeometry(snowy = false) {
  const trunk = part(new THREE.CylinderGeometry(0.045, 0.075, 0.4, 5), 0x4a3322, { y: 0.2 });
  const green = snowy ? 0x3a5a44 : 0x1f4a26;
  const tiers = [
    [0.44, 0.62, 0.55], [0.35, 0.55, 0.86], [0.24, 0.46, 1.13],
  ].map(([r, h, y], i) => part(new THREE.ConeGeometry(r, h, 7), green, { y, jitter: 0.12, seed: i, ry: i * 0.5 }));
  const parts = [trunk, ...tiers];
  if (snowy) {
    [[0.4, 0.2, 0.72], [0.31, 0.18, 1.02], [0.2, 0.2, 1.3]].forEach(([r, h, y], i) =>
      parts.push(part(new THREE.ConeGeometry(r, h, 7), 0xeef3f8, { y, ry: i * 0.5, shade: false })));
  }
  return mergeGeometries(parts);
}

function oakGeometry() {
  const trunk = part(new THREE.CylinderGeometry(0.05, 0.09, 0.55, 5), 0x4d3524, { y: 0.27 });
  const c1 = part(new THREE.IcosahedronGeometry(0.42, 1), 0x2f5a1c, { y: 0.8, jitter: 0.22, seed: 3 });
  const c2 = part(new THREE.IcosahedronGeometry(0.3, 1), 0x3a6a22, { x: 0.22, y: 0.66, z: 0.1, jitter: 0.25, seed: 5 });
  const c3 = part(new THREE.IcosahedronGeometry(0.28, 1), 0x2a5019, { x: -0.18, y: 0.95, z: -0.08, jitter: 0.25, seed: 7 });
  return mergeGeometries([trunk, c1, c2, c3]);
}

function deadTreeGeometry() {
  const col = 0x3b322b;
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.025, 0.07, 0.95, 5), col, { y: 0.47 }),
    part(new THREE.CylinderGeometry(0.012, 0.03, 0.45, 4), col, { x: 0.12, y: 0.72, rz: -0.8 }),
    part(new THREE.CylinderGeometry(0.01, 0.025, 0.38, 4), col, { x: -0.1, y: 0.58, rz: 0.9, ry: 0.6 }),
    part(new THREE.CylinderGeometry(0.01, 0.02, 0.3, 4), col, { x: 0.02, y: 0.85, z: 0.08, rz: 0.5, ry: 2.1 }),
  ]);
}

function bushGeometry() {
  return mergeGeometries([
    part(new THREE.IcosahedronGeometry(0.3, 1), 0x365e20, { y: 0.14, sy: 0.65, jitter: 0.3, seed: 11 }),
    part(new THREE.IcosahedronGeometry(0.2, 0), 0x40692a, { x: 0.18, y: 0.12, sy: 0.7, jitter: 0.3, seed: 12 }),
  ]);
}

function rockGeometry(color) {
  return mergeGeometries([
    part(new THREE.DodecahedronGeometry(0.4, 0), color, { y: 0.1, sy: 0.62, jitter: 0.35, seed: 21 }),
    part(new THREE.DodecahedronGeometry(0.22, 0), color, { x: 0.32, y: 0.03, z: 0.1, sy: 0.7, jitter: 0.4, seed: 22 }),
  ]);
}

function reedGeometry() {
  const rng = mulberry32(99);
  const parts = [];
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 0.18;
    const h = 0.35 + rng() * 0.35;
    parts.push(part(new THREE.ConeGeometry(0.018, h, 3), i % 3 ? 0x6b7a34 : 0x8a8a44, {
      x: Math.cos(a) * r, z: Math.sin(a) * r, y: h / 2, rz: (rng() - 0.5) * 0.3,
    }));
    if (i % 3 === 0) parts.push(part(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 4), 0x4a3522, { x: Math.cos(a) * r, z: Math.sin(a) * r, y: h * 0.85, shade: false }));
  }
  return mergeGeometries(parts);
}

// `blender`: object names in public/models/trees.glb (variants); the procedural
// geometry is the fallback when that file is missing.
const MODELS = {
  pine: { geo: () => pineGeometry(false), blender: ['Pine_A', 'Pine_B'], wind: 1, shadow: true },
  oak: { geo: oakGeometry, blender: ['Oak_A', 'Oak_B'], wind: 1, shadow: true },
  snowPine: { geo: () => pineGeometry(true), blender: ['SnowPine_A', 'SnowPine_B'], wind: 0.7, shadow: true },
  dead: { geo: deadTreeGeometry, blender: ['Dead_A', 'Dead_B'], wind: 0.3, shadow: true },
  bush: { geo: bushGeometry, blender: ['Bush_A', 'Bush_B'], wind: 0.6, shadow: true },
  rock: { geo: () => rockGeometry(0x77726b), wind: 0, shadow: true },
  reed: { geo: reedGeometry, wind: 1.6, shadow: false },
  basalt: { geo: () => rockGeometry(0x2a2624), wind: 0, shadow: true },
};

function makeMaterial(wind, flat = true, leafy = !flat) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, flatShading: flat });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uSnowCover = U.uSnowCover;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform vec2 uWind; varying float vUpY; varying vec3 vLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = transformed;
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = ip.x * 0.37 + ip.z * 0.23;
          float gust = 0.6 + 0.4 * sin(uTime * 0.7 + ip.x * 0.05);
          float sway = (sin(uTime * 1.9 + ph) * 0.6 + sin(uTime * 3.7 + ph * 1.7) * 0.25) * gust;
          float bend = max(transformed.y, 0.0);
          transformed.xz += (uWind * (0.55 + sway * 0.45)) * bend * bend * ${(0.09 * wind).toFixed(3)};
        #endif
        vUpY = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uSnowCover; varying float vUpY; varying vec3 vLocal;
        float vhash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vnoise3(vec3 x) {
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(vhash(i), vhash(i + vec3(1, 0, 0)), f.x), mix(vhash(i + vec3(0, 1, 0)), vhash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(vhash(i + vec3(0, 0, 1)), vhash(i + vec3(1, 0, 1)), f.x), mix(vhash(i + vec3(0, 1, 1)), vhash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${leafy ? `
        // leafy breakup on foliage (green-dominant colours) so crowns aren't smooth blobs
        float foliage = smoothstep(0.1, 0.35, (diffuseColor.g - diffuseColor.r) / max(diffuseColor.g, 1e-3));
        float ln = vnoise3(vLocal * 16.0) * 0.65 + vnoise3(vLocal * 37.0) * 0.35;
        diffuseColor.rgb *= mix(1.0, 0.72 + 0.5 * ln, foliage);
        // close up: single leaves in the crown, grain in the bark
        float nearV = 1.0 - smoothstep(8.0, 26.0, length(vViewPosition));
        if (nearV > 0.001) {
          float leaf = vnoise3(vLocal * 85.0);
          diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * leaf, foliage * nearV);
          float barkW = smoothstep(0.02, 0.12, (diffuseColor.r - diffuseColor.g) / max(diffuseColor.r, 1e-3)) * (1.0 - foliage);
          float grain = vnoise3(vec3(vLocal.x * 70.0, vLocal.y * 9.0, vLocal.z * 70.0));
          diffuseColor.rgb *= mix(1.0, 0.7 + 0.5 * grain, barkW * nearV);
        }` : ''}
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.97), smoothstep(0.25, 0.75, vUpY) * uSnowCover);`);
  };
  mat.customProgramCacheKey = () => `veg-${wind}-${flat}-${leafy}`;
  return mat;
}

// The placements are split into CHUNK x CHUNK world-unit squares, one InstancedMesh per
// model variant per square, so forests off screen (or outside the sun's shadow frustum,
// which closes in around the view when zoomed in) are culled instead of drawn whole.
const CHUNK = 24;
// Trees that stand fewer than LOD_PX screen pixels tall (CSS pixels) switch to the
// simplified models (Assets.js makeTreeLods); TREE_H is a typical tree's height.
const LOD_PX = 28, TREE_H = 1.3;

/** Builds the InstancedMeshes of every vegetation kind from the generator's placements. */
export function createVegetation(map) {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const rng = mulberry32(map.params.seed ^ 0x5eed);
  const g = map.grid;
  const cols = Math.max(1, Math.ceil(g.worldW / CHUNK)), rows = Math.max(1, Math.ceil(g.worldH / CHUNK));
  const chunkOf = (x, z) => {
    const ci = Math.min(cols - 1, Math.max(0, Math.floor((x + g.worldW / 2) / CHUNK)));
    const cj = Math.min(rows - 1, Math.max(0, Math.floor((z + g.worldH / 2) / CHUNK)));
    return cj * cols + ci;
  };
  const lodMeshes = [];
  for (const [kind, data] of Object.entries(map.vegetation)) {
    const count = data.length / 5;
    if (!count || !MODELS[kind]) continue;
    const model = MODELS[kind];
    const fromBlender = assets.trees && model.blender?.every((n) => assets.trees[n]);
    const geos = fromBlender ? model.blender.map((n) => assets.trees[n]) : [model.geo()];
    const lods = fromBlender && assets.treeLods ? model.blender.map((n) => assets.treeLods[n]) : null;
    // room for the wind's sway, so a tree at the frustum's edge isn't culled mid-swing
    for (const geo of [...geos, ...(lods ?? [])]) {
      if (!geo.userData.swayPadded) {
        geo.computeBoundingSphere();
        geo.boundingSphere.radius += 0.3;
        geo.userData.swayPadded = true;
      }
    }
    const mat = makeMaterial(model.wind, !fromBlender);
    // deterministic split of the placements across the variants, then into chunks
    const bucket = new Uint32Array(count);
    const sizes = new Map();
    for (let i = 0; i < count; i++) {
      const h = Math.sin(data[i * 5] * 12.9898 + data[i * 5 + 2] * 78.233) * 43758.5453;
      const v = Math.floor((h - Math.floor(h)) * geos.length);
      const b = chunkOf(data[i * 5], data[i * 5 + 2]) * geos.length + v;
      bucket[i] = b;
      sizes.set(b, (sizes.get(b) ?? 0) + 1);
    }
    const meshes = new Map(), filled = new Map();
    for (const [b, n] of sizes) {
      const v = b % geos.length;
      const mesh = new THREE.InstancedMesh(geos[v], mat, n);
      mesh.name = geos.length > 1 ? `${kind}-${v}` : kind;
      if (lods) {
        mesh.userData.full = geos[v];
        mesh.userData.lod = lods[v];
        lodMeshes.push(mesh);
      }
      meshes.set(b, mesh);
      filled.set(b, 0);
    }
    const isRock = kind === 'rock' || kind === 'basalt';
    for (let i = 0; i < count; i++) {
      const o = i * 5;
      p.set(data[o], data[o + 1], data[o + 2]);
      const sc = data[o + 3];
      q.setFromAxisAngle(up, data[o + 4]);
      if (isRock) s.set(sc * (0.8 + rng() * 0.5), sc * (0.6 + rng() * 0.8), sc * (0.8 + rng() * 0.5));
      else s.set(sc, sc * (0.85 + rng() * 0.35), sc);
      m4.compose(p, q, s);
      const mesh = meshes.get(bucket[i]), k = filled.get(bucket[i]);
      filled.set(bucket[i], k + 1);
      mesh.setMatrixAt(k, m4);
      const v = 0.82 + rng() * 0.32;
      color.setRGB(v * (0.94 + rng() * 0.12), v, v * (0.9 + rng() * 0.12));
      mesh.setColorAt(k, color);
    }
    for (const mesh of meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = model.shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  /** Per frame: chunks whose nearest tree is small on screen draw the simplified models
   * (in the shadow pass too). `viewH`: the view's height in CSS pixels. */
  const camPos = new THREE.Vector3();
  group.userData.update = (camera, viewH) => {
    if (!lodMeshes.length) return;
    camera.getWorldPosition(camPos);
    const pxPerUnit = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const lodDist = (TREE_H * pxPerUnit) / LOD_PX;
    for (const mesh of lodMeshes) {
      const bs = mesh.boundingSphere;
      const near = camPos.distanceTo(bs.center) - bs.radius;
      mesh.geometry = near > lodDist ? mesh.userData.lod : mesh.userData.full;
    }
  };
  return group;
}
