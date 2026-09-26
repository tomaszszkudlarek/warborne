import * as THREE from 'three';
import { U } from './uniforms.js';
import { mapUniforms, mapLookupGLSL } from './Terrain.js';
import { noiseGLSL, cloudGLSL } from './shaders/common.js';
import { mulberry32 } from '../core/rng.js';

// Grass tufts on the ground around the view, drawn only when the camera is close.
// One instance per cell of a GRID x GRID window of SPACING-unit cells that follows the
// camera's focus; the vertex shader places each tuft in its world cell (so a tuft stays
// put as the window slides), reads the ground height, and sizes it by how grassy the
// ground is there (splat maps, slope, water, snow, roads), so it grows where the terrain
// shader paints grass and nowhere else.

const GRID = 150;
const SPACING = 0.24;
const RADIUS = 16; // tufts shrink away toward this distance from the focus
const NEAR = 22, FAR = 36; // camera distance over which the grass fades out

/** One tuft: a handful of curved blades fanning out from a point, 1 unit tall. */
function tuftGeometry() {
  const rng = mulberry32(7);
  const pos = [], tip = [], idx = [];
  const BLADES = 9;
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + rng() * 0.8;
    const r = 0.04 + rng() * 0.26;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const h = 0.6 + rng() * 0.4;
    const lean = 0.15 + rng() * 0.35; // outward, growing toward the tip
    const w = 0.035 + rng() * 0.025;
    const face = a + Math.PI / 2 + (rng() - 0.5) * 0.8; // blade width direction
    const wx = Math.cos(face) * w, wz = Math.sin(face) * w;
    const base = pos.length / 3;
    // base pair, middle pair, tip
    for (const [t, k] of [[0, 1], [0.55, 0.65]]) {
      const bend = lean * t * t;
      const x = cx + Math.cos(a) * bend, z = cz + Math.sin(a) * bend, y = h * t;
      pos.push(x - wx * k, y, z - wz * k, x + wx * k, y, z + wz * k);
      tip.push(t, t);
    }
    pos.push(cx + Math.cos(a) * lean, h, cz + Math.sin(a) * lean);
    tip.push(1);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('aTip', new THREE.Float32BufferAttribute(tip, 1));
  geo.setIndex(idx);
  const cells = new Float32Array(GRID * GRID * 2);
  for (let j = 0, k = 0; j < GRID; j++) for (let i = 0; i < GRID; i++, k += 2) {
    cells[k] = i - GRID / 2;
    cells[k + 1] = j - GRID / 2;
  }
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
  geo.instanceCount = GRID * GRID;
  return geo;
}

export function createGrass(map, textures) {
  const extra = {
    uFocus: { value: new THREE.Vector2() }, // window centre, in whole cells
    uCentre: { value: new THREE.Vector2() }, // the camera's focus, world xz
    uFade: { value: 0 },
    uSpacing: { value: SPACING },
    uRadius: { value: RADIUS },
  };
  const mapU = mapUniforms(map, textures);
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mapU, extra, {
      uTime: U.uTime, uWind: U.uWind, uIceT: U.uIceT, uSnowCover: U.uSnowCover, uWetness: U.uWetness,
      uCloudCover: U.uCloudCover, uCloudOffset: U.uCloudOffset, uSunDir: U.uSunDir,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aCell;
        attribute float aTip;
        uniform vec2 uFocus, uCentre;
        uniform float uFade, uSpacing, uRadius, uTime, uIceT, uSnowCover, uWetness;
        uniform vec2 uWind;
        uniform sampler2D uHeightTex, uSplatA, uSplatB, uClimate, uWaterLevel;
        ${mapLookupGLSL}
        ${noiseGLSL}
        varying vec3 vGrassCol;
        varying vec3 vGWorld;`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        vec2 cell = uFocus + aCell;
        vec2 xz = (cell + 0.15 + 0.7 * vec2(hash12(cell), hash12(cell + 17.3))) * uSpacing;
        vec2 uv = mapUV(xz);
        float gh = textureLod(uHeightTex, uv, 0.0).r;
        vec4 sa = textureLod(uSplatA, uv, 0.0);
        vec4 sb = textureLod(uSplatB, uv, 0.0);
        vec4 cl = textureLod(uClimate, uv, 0.0);
        float wl = textureLod(uWaterLevel, uv, 0.0).r;
        vec2 e = vec2(1.0 / uTexSize.x, 0.0);
        float sx = textureLod(uHeightTex, uv + e.xy, 0.0).r - textureLod(uHeightTex, uv - e.xy, 0.0).r;
        float sz = textureLod(uHeightTex, uv + e.yx * uTexSize.x / uTexSize.y, 0.0).r - textureLod(uHeightTex, uv - e.yx * uTexSize.x / uTexSize.y, 0.0).r;
        float slope = length(vec2(sx, sz)) / (2.0 * uCellSize);
        float wsum = sa.r + sa.g + sa.b + sa.a + sb.r + sb.g + 1e-3;
        float dens = (sa.r + sa.g * 0.6 + sa.b * 0.45) / wsum;
        dens *= 1.0 - smoothstep(0.2, 0.5, sb.a);           // roads, city grounds
        dens *= 1.0 - smoothstep(0.02, 0.1, sb.b);          // lava
        dens *= 1.0 - smoothstep(0.45, 0.75, slope);        // bare rock on steep ground
        dens *= smoothstep(0.06, 0.14, gh - wl);            // not in the water or on its bank
        float snowT = uIceT + 0.035 + uSnowCover * 0.95;
        dens *= smoothstep(snowT - 0.02, snowT + 0.06, cl.r) * (1.0 - cl.a * 0.6);
        float n1 = fbm3(xz * 0.21), n2 = fbm3(xz * 1.35 + 3.1);
        dens *= 0.55 + 0.9 * n2;                            // clumps and clearings
        float keep = step(hash12(cell + 5.1), dens * 1.6);
        float d = length(xz - uCentre);
        float size = keep * uFade * (1.0 - smoothstep(uRadius * 0.55, uRadius, d)) * (0.65 + 0.7 * hash12(cell + 9.7));
        // the terrain's grass palette (Terrain.js) so tufts grow out of matching ground
        float temp = cl.r, moist = cl.g;
        vec3 cPlains = mix(vec3(0.36, 0.44, 0.13), vec3(0.20, 0.36, 0.08), smoothstep(0.35, 0.85, moist + (n1 - 0.5) * 0.5));
        cPlains = mix(cPlains, vec3(0.52, 0.47, 0.22), smoothstep(0.5, 0.85, temp) * smoothstep(0.55, 0.2, moist));
        cPlains *= 0.82 + 0.36 * n2;
        vec3 cForest = mix(vec3(0.07, 0.14, 0.05), vec3(0.16, 0.2, 0.08), n2) * 1.1;
        vec3 cSwamp = vec3(0.19, 0.22, 0.1);
        vec3 col = (cPlains * sa.r + cForest * sa.g + cSwamp * sa.b) / max(sa.r + sa.g + sa.b, 1e-3);
        col *= 0.9 + 0.25 * hash12(cell + 3.3);
        col = mix(col, col * vec3(1.3, 1.18, 0.6), step(0.82, hash12(cell + 7.7)) * 0.6); // a dry tuft here and there
        // darker in the tuft's heart, lit at the tips; wet in the rain; frosted in snow
        col *= mix(0.6, 1.08, aTip);
        col *= 1.0 - 0.3 * uWetness;
        col = mix(col, vec3(0.9, 0.93, 0.97), uSnowCover * aTip * 0.8);
        vGrassCol = col;
        // turn the tuft, bow it downwind
        float ang = hash12(cell + 1.3) * 6.2832;
        float ca = cos(ang), sn = sin(ang);
        vec3 p = position;
        p.xz = mat2(ca, sn, -sn, ca) * p.xz;
        p *= vec3(0.24, 0.12 + 0.07 * n2, 0.24) * size;
        float gust = 0.65 + 0.35 * sin(uTime * 0.8 + xz.x * 0.08);
        float sway = sin(uTime * 2.3 + xz.x * 0.9 + xz.y * 0.7) * 0.5 + sin(uTime * 4.1 + xz.x * 2.1) * 0.2;
        p.xz += (uWind * (0.5 + 0.5 * sway) * gust) * aTip * aTip * 0.08 * size;
        vec3 transformed = vec3(xz.x, gh, xz.y) + p;
        vGWorld = transformed;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunDir;
        varying vec3 vGrassCol;
        varying vec3 vGWorld;
        ${noiseGLSL}
        ${cloudGLSL}`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vGrassCol;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.directDiffuse *= cloudShadow(vGWorld, uSunDir);`);
  };
  mat.customProgramCacheKey = () => 'grass-tufts';

  const mesh = new THREE.Mesh(tuftGeometry(), mat);
  mesh.name = 'grass-tufts';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.visible = false;
  const group = new THREE.Group();
  group.name = 'grass';
  group.add(mesh);

  /** Follows the camera: the window slides with its focus, fading out as it pulls back. */
  group.userData.update = (camera, focus) => {
    const dist = camera.position.distanceTo(focus);
    const fade = 1 - THREE.MathUtils.smoothstep(dist, NEAR, FAR);
    extra.uFade.value = fade;
    mesh.visible = fade > 0.001;
    if (!mesh.visible) return;
    // lean the window toward the far side of the view
    const fx = focus.x - camera.position.x, fz = focus.z - camera.position.z, fl = Math.hypot(fx, fz) || 1;
    const cx = focus.x + (fx / fl) * RADIUS * 0.3, cz = focus.z + (fz / fl) * RADIUS * 0.3;
    extra.uFocus.value.set(Math.round(cx / SPACING), Math.round(cz / SPACING));
    extra.uCentre.value.set(cx, cz);
  };
  return group;
}
