import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL, cloudGLSL } from './shaders/common.js';

export function makeDataTexture(data, w, h, { format = THREE.RGBAFormat, type = THREE.UnsignedByteType } = {}) {
  const tex = new THREE.DataTexture(data, w, h, format, type);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Heightfield as a half-float texture (linear filtering works everywhere in WebGL2). */
export function makeHeightTexture(heights, gw, gh) {
  const half = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) half[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  return makeDataTexture(half, gw, gh, { format: THREE.RedFormat, type: THREE.HalfFloatType });
}

/** Uniforms describing how world xz maps onto the map textures. */
export function mapUniforms(map, textures) {
  const g = map.grid;
  return {
    uMapSize: { value: new THREE.Vector2(g.worldW, g.worldH) },
    uTexSize: { value: new THREE.Vector2(g.gw, g.gh) },
    uCellSize: { value: g.cellSize },
    uTileSize: { value: g.tileSize },
    uHeightTex: { value: textures.height },
    uSplatA: { value: textures.splatA },
    uSplatB: { value: textures.splatB },
    uClimate: { value: textures.climate },
    uWaterLevel: { value: textures.waterLevel },
  };
}

export const mapLookupGLSL = /* glsl */ `
uniform vec2 uMapSize;
uniform vec2 uTexSize;
uniform float uCellSize;
vec2 mapUV(vec2 xz) { return ((xz + uMapSize * 0.5) / uCellSize + 0.5) / uTexSize; }
bool insideMap(vec2 xz) { return all(lessThan(abs(xz), uMapSize * 0.5)); }
`;

/**
 * The ground's height through a Catmull-Rom patch of the 4x4 nearest heightfield samples:
 * no creases at the cell edges (as bilinear filtering and the triangle mesh have), so the
 * waterline follows a smooth curve at any zoom. Needs uHeightTex. SHORE_SINK: the ground
 * counts this much higher at the sea and lake shores, so the water's soft edge sits just
 * inside the mesh's own (faceted) waterline and hides it.
 */
export const smoothHeightGLSL = /* glsl */ `
const float SHORE_SINK = 0.05;
vec4 crWeights(float f) {
  return vec4(f * (-0.5 + f * (1.0 - 0.5 * f)), 1.0 + f * f * (-2.5 + 1.5 * f), f * (0.5 + f * (2.0 - 1.5 * f)), f * f * (-0.5 + 0.5 * f));
}
float heightSmooth(vec2 xz) {
  vec2 p = (xz + uMapSize * 0.5) / uCellSize;
  vec2 i0 = floor(p), f = p - i0;
  vec4 wx = crWeights(f.x), wy = crWeights(f.y);
  ivec2 b = ivec2(i0) - 1, mx = ivec2(uTexSize) - 1;
  float h = 0.0;
  for (int j = 0; j < 4; j++) {
    float row = 0.0;
    for (int i = 0; i < 4; i++) row += wx[i] * texelFetch(uHeightTex, clamp(b + ivec2(i, j), ivec2(0), mx), 0).r;
    h += wy[j] * row;
  }
  return h;
}
`;

function buildGeometry(map) {
  const { grid: g, heights } = map;
  const { gw, gh, cellSize } = g;
  const skirt = 2 * (gw + gh);
  const count = gw * gh + skirt;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const x0 = -g.worldW / 2, z0 = -g.worldH / 2;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      pos[k * 3] = x0 + i * cellSize;
      pos[k * 3 + 1] = heights[k];
      pos[k * 3 + 2] = z0 + j * cellSize;
      const hl = heights[j * gw + Math.max(0, i - 1)], hr = heights[j * gw + Math.min(gw - 1, i + 1)];
      const hd = heights[Math.max(0, j - 1) * gw + i], hu = heights[Math.min(gh - 1, j + 1) * gw + i];
      let nx = hl - hr, ny = 2 * cellSize, nz = hd - hu;
      const l = Math.hypot(nx, ny, nz);
      nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;
    }
  }
  const index = [];
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      // alternate the diagonal to avoid directional artifacts
      if ((i + j) & 1) index.push(a, c, b, b, c, d);
      else index.push(a, c, d, a, d, b);
    }
  }
  // Skirt: walls down to the sea floor around the board edge.
  const ring = [];
  for (let i = 0; i < gw; i++) ring.push(i);
  for (let j = 1; j < gh; j++) ring.push(j * gw + gw - 1);
  for (let i = gw - 2; i >= 0; i--) ring.push((gh - 1) * gw + i);
  for (let j = gh - 2; j > 0; j--) ring.push(j * gw);
  const base = gw * gh;
  ring.forEach((k, r) => {
    const s = base + r;
    pos[s * 3] = pos[k * 3];
    pos[s * 3 + 1] = -9;
    pos[s * 3 + 2] = pos[k * 3 + 2];
    const cx = pos[k * 3], cz = pos[k * 3 + 2];
    const ax = Math.abs(cx) / g.worldW, az = Math.abs(cz) / g.worldH;
    if (ax > az) { nrm[s * 3] = Math.sign(cx); } else { nrm[s * 3 + 2] = Math.sign(cz); }
  });
  for (let r = 0; r < ring.length; r++) {
    const a = ring[r], b = ring[(r + 1) % ring.length];
    const sa = base + r, sb = base + ((r + 1) % ring.length);
    index.push(a, b, sa, b, sb, sa);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export function createTerrain(map, textures) {
  const geo = buildGeometry(map);
  const mapU = mapUniforms(map, textures);
  const extra = { uBump: { value: 1.0 } };

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mapU, extra, {
      uTime: U.uTime, uWetness: U.uWetness, uSnowCover: U.uSnowCover, uIceT: U.uIceT,
      uGrid: U.uGrid, uCloudCover: U.uCloudCover, uCloudOffset: U.uCloudOffset, uSunDir: U.uSunDir,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWorldPos;\nvarying vec3 vTWorldNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vTWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTWorldPos;
        varying vec3 vTWorldNormal;
        uniform sampler2D uSplatA, uSplatB, uClimate, uWaterLevel, uHeightTex;
        uniform float uTime, uWetness, uSnowCover, uIceT, uGrid, uTileSize, uBump;
        uniform vec3 uSunDir;
        ${mapLookupGLSL}
        ${smoothHeightGLSL}
        ${noiseGLSL}
        ${cloudGLSL}
        vec3 perturbNormalH(vec3 surfPos, vec3 surfNorm, float h, float fd) {
          vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
          vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
          float det = dot(sx, r1) * fd;
          vec2 dh = vec2(dFdx(h), dFdy(h));
          vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
          return normalize(abs(det) * surfNorm - grad);
        }`
      )
      .replace('#include <color_fragment>', terrainColorGLSL)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          float fade = 1.0 - smoothstep(35.0, 110.0, length(vViewPosition));
          float bh = 0.0;
          // (the noise is skipped wherever its weight is zero: far away, or out of the close-up)
          if (fade > 0.0) bh = (vnoise(wp.xz * 2.4) * 0.55 + vnoise(wp.xz * 7.5) * 0.2) * mix(0.02, 0.07, rockW) * fade * uBump * (1.0 - snow * 0.7);
          // close up: fine relief in the grain of the ground, and stones standing proud
          if (nearD > 0.0) {
            bh += (vnoise(wp.xz * 19.0) * 0.008 * AA(0.05) + vnoise(wp.xz * 43.0) * 0.003 * AA(0.023)) * nearD * uBump * (1.0 - snow * 0.7) * (1.0 - sub);
            bh += stone * soilW * nearD * 0.012;
          }
          normal = perturbNormalH(-vViewPosition, normal, bh, faceDirection);
        }`
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += tEmissive;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float cs = cloudShadow(vTWorldPos, uSunDir);
          reflectedLight.directDiffuse *= cs;
          reflectedLight.directSpecular *= cs;
        }`
      );
  };
  mat.customProgramCacheKey = () => 'warlords-terrain';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'terrain';
  // drawn after the other opaque meshes, so the (costly) ground shader skips the pixels
  // that forests, castles and armies already cover
  mesh.renderOrder = 0.5;
  mesh.userData.uniforms = extra;
  return mesh;
}

const terrainColorGLSL = /* glsl */ `
vec3 wp = vTWorldPos;
vec2 tuv = mapUV(wp.xz);
vec4 sa = texture2D(uSplatA, tuv);
vec4 sb = texture2D(uSplatB, tuv);
vec4 cl = texture2D(uClimate, tuv);
float temp = cl.r, moist = cl.g, wetSoil = cl.b, rockiness = cl.a;
vec3 Nw = normalize(vTWorldNormal);
float slope = 1.0 - Nw.y;

float n1 = fbm3(wp.xz * 0.21);
float n2 = fbm3(wp.xz * 1.35 + 3.1);
float n3 = vnoise(wp.xz * 8.0);

// Organic transitions: noise-modulated splat weights.
vec4 wa = sa * (0.6 + 0.8 * vec4(n2, 1.0 - n2, n1, n2));
vec2 wb = sb.rg * (0.6 + 0.8 * vec2(n1, 1.0 - n2));

// --- material palette -------------------------------------------------------
vec3 cLush = vec3(0.20, 0.36, 0.08);
vec3 cMeadow = vec3(0.36, 0.44, 0.13);
vec3 cDry = vec3(0.52, 0.47, 0.22);
vec3 cPlains = mix(cMeadow, cLush, smoothstep(0.35, 0.85, moist + (n1 - 0.5) * 0.5));
cPlains = mix(cPlains, cDry, smoothstep(0.5, 0.85, temp) * smoothstep(0.55, 0.2, moist));
cPlains *= 0.82 + 0.36 * n2;
cPlains = mix(cPlains, vec3(0.62, 0.6, 0.3), smoothstep(0.78, 0.92, n3 * n2 * 1.8) * 0.5);

vec3 cForest = mix(vec3(0.07, 0.14, 0.05), vec3(0.16, 0.2, 0.08), n2) * (0.85 + 0.3 * n3);

// (the noise only where there is swamp to show it)
float puddle = sa.b > 0.0 ? smoothstep(0.56, 0.64, fbm3(wp.xz * 0.8 + 7.0)) : 0.0;
vec3 cSwamp = mix(vec3(0.19, 0.22, 0.1), vec3(0.13, 0.15, 0.09), n1) * (0.85 + 0.3 * n3);
cSwamp = mix(cSwamp, vec3(0.04, 0.07, 0.06), puddle * 0.9);

vec3 cSand = mix(vec3(0.78, 0.69, 0.5), vec3(0.64, 0.56, 0.4), n2) * (0.92 + 0.12 * n3);
vec3 cIce = mix(vec3(0.78, 0.86, 0.93), vec3(0.94, 0.97, 1.0), n2);
vec3 cVolc = mix(vec3(0.07, 0.06, 0.06), vec3(0.2, 0.12, 0.09), n1) * (0.75 + 0.5 * n3);
vec3 cRock = mix(vec3(0.3, 0.27, 0.24), vec3(0.18, 0.17, 0.16), n2);
cRock *= 0.86 + 0.14 * sin(wp.y * 4.5 + n1 * 7.0);
cRock = mix(cRock, vec3(0.1, 0.09, 0.09), sb.g);
vec3 cRoad = mix(vec3(0.4, 0.31, 0.2), vec3(0.3, 0.24, 0.17), n3);
vec3 cSnow = vec3(0.93, 0.95, 0.99) * (0.94 + 0.06 * n3);

float wsum = wa.r + wa.g + wa.b + wa.a + wb.x + wb.y + 1e-3;
vec3 albedo = (cPlains * wa.r + cForest * wa.g + cSwamp * wa.b + cSand * wa.a + cIce * wb.x + cVolc * wb.y) / wsum;
float tRough = (0.92 * wa.r + 0.95 * wa.g + mix(0.75, 0.12, puddle) * wa.b + 0.88 * wa.a + 0.3 * wb.x + 0.82 * wb.y) / wsum;

// Rock on steep slopes and mountain massifs.
float rockW = smoothstep(0.3, 0.52, slope + (n2 - 0.5) * 0.25);
rockW = max(rockW, rockiness * smoothstep(0.06, 0.22, slope + (n1 - 0.5) * 0.3));
albedo = mix(albedo, cRock, rockW);
tRough = mix(tRough, 0.78, rockW);

// Shores: height above the local water surface, limited by horizontal distance
// to the waterline, drives a noise-edged bank of damp earth, sand and pebbles,
// a dark glossy waterline, and a pebbly bed below.
vec3 wl = texture2D(uWaterLevel, tuv).rgb;
float riverK = wl.g;
// near sea and lake shores the waterline runs on the smooth ground (as the water's edge does),
// not on the mesh's facets; rivers keep the mesh (their water follows the carved channel)
float hG = wp.y;
float nearWL = smoothstep(0.7, 0.35, abs(wp.y - wl.r)) * smoothstep(0.95, 0.75, riverK);
if (nearWL > 0.0) hG = mix(wp.y, heightSmooth(wp.xz) + SHORE_SINK, nearWL);
float hA = hG - wl.r;
float shoreN = (n2 - 0.5) * 0.1 + (n3 - 0.5) * 0.04;
float reach = mix(0.35, 0.8 + 0.9 * n1, riverK);
float nearW = 1.0 - smoothstep(reach * 0.2, reach, wl.b + (n2 - 0.5) * 0.4);
float bankTop = mix(0.06, 0.14 + 0.12 * n1, riverK);
float bankW = (1.0 - smoothstep(-0.03, bankTop, hA + shoreN)) * nearW;
bankW *= bankW * (3.0 - 2.0 * bankW);
bankW *= 1.0 - rockW * 0.5;
// round pebbles: one per jittered cell, about half the cells filled; only searched for
// where they can show: high on a bank (pebW) or on a river bed in the shallows (cBed)
float peb = 0.0, pebShade = 1.0;
float subK = smoothstep(0.02, -0.06, hA + shoreN * 0.3) * riverK;
if (bankW > 0.45 || (subK > 0.0 && hA > -0.6)) {
  vec2 pp = wp.xz * 7.0;
  vec2 pc = floor(pp);
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    vec2 c = pc + vec2(float(dx), float(dy));
    float hsh = hash12(c);
    if (hsh < 0.45) continue;
    vec2 o = c + 0.25 + 0.5 * vec2(hash12(c + 7.1), hash12(c + 3.3));
    vec2 dd = (pp - o) * vec2(1.0, 1.0 + hash12(c + 1.9) * 0.6);
    float r = 0.18 + 0.2 * hash12(c + 5.7);
    float m = 1.0 - smoothstep(r - 0.06, r, length(dd));
    if (m > peb) { peb = m; pebShade = 0.75 + 0.5 * hash12(c + 9.4) - dd.y * 0.6; }
  }
}
vec3 cMud = mix(vec3(0.33, 0.26, 0.16), vec3(0.43, 0.35, 0.22), n2) * (0.9 + 0.2 * n3);
vec3 cRiverSand = mix(vec3(0.62, 0.53, 0.36), vec3(0.52, 0.45, 0.31), n3);
vec3 cBank = mix(cMud, cRiverSand, smoothstep(0.45, 0.8, n1 + (n3 - 0.5) * 0.3) * 0.8);
vec3 cPeb = peb > 0.0 ? mix(vec3(0.52, 0.47, 0.4), vec3(0.66, 0.6, 0.5), hash12(floor(wp.xz * 7.0))) * pebShade : vec3(0.0);
float pebW = peb * smoothstep(0.35, 0.65, n2 + (n3 - 0.5) * 0.3) * smoothstep(0.45, 0.85, bankW);
cBank = mix(cBank, cPeb, pebW * 0.85);
// sea and lake shores keep their own ground, just damp
cBank = mix(albedo * 0.85, cBank, riverK);
// lusher, darker grass on the damp ground above the bank
float lush = (1.0 - smoothstep(0.0, bankTop * 3.0, hA + shoreN)) * (1.0 - smoothstep(reach * 0.5, reach * 1.8, wl.b)) * riverK;
albedo = mix(albedo, albedo * vec3(0.78, 0.9, 0.7), lush * (1.0 - rockW) * 0.8);
// grass thins out toward the water instead of stopping at a line
if (bankW > 0.0) {
  float grassFringe = smoothstep(0.3, 0.7, n3 * 0.7 + fbm3(wp.xz * 3.2) * 0.3 + bankW * 0.55);
  albedo = mix(albedo, cBank, bankW * mix(0.35, 1.0, grassFringe));
}
tRough = mix(tRough, 0.7, bankW);

// Snow: cold climate + altitude, weather accumulation.
float snowT = uIceT + 0.035 + uSnowCover * 0.95;
float snow = smoothstep(snowT + 0.05, snowT - 0.05, temp + (n1 - 0.5) * 0.14);
snow *= smoothstep(0.7, 0.35, slope + (n2 - 0.5) * 0.2) * smoothstep(-0.05, 0.25, wp.y);
snow *= 1.0 - smoothstep(0.2, 0.6, sb.g) * (1.0 - uSnowCover * 0.6); // volcanic heat melts snow
snow = max(snow, wb.x / wsum * smoothstep(0.5, 0.2, slope) * 0.6);
albedo = mix(albedo, cSnow, snow);
tRough = mix(tRough, 0.5, snow);

// Roads & city grounds.
float road = smoothstep(0.3, 0.7, sb.a + (n3 - 0.5) * 0.3);
albedo = mix(albedo, cRoad, road * (1.0 - snow * 0.5));
tRough = mix(tRough, 0.9, road);

// Underwater: pebbly bed in the shallows, sediment tint deeper down, and
// sunlight caustics dancing over the bed.
float sub = smoothstep(0.02, -0.06, hA + shoreN * 0.3);
vec3 cBed = mix(mix(vec3(0.46, 0.4, 0.29), vec3(0.32, 0.29, 0.22), n2), vec3(0.18, 0.2, 0.15), smoothstep(0.0, 0.7, -hA));
cBed = mix(cBed, cPeb * 0.9, peb * 0.75 * smoothstep(-0.6, -0.05, hA));
albedo = mix(albedo, cBed, sub * riverK * 0.85);
float under = smoothstep(0.05, -1.2, hA);
albedo = mix(albedo, albedo * vec3(0.6, 0.72, 0.7), under);
{
  float shallow = sub * smoothstep(-0.6, -0.08, hA) * (1.0 - snow);
  if (shallow > 0.0) {
    vec2 cp = wp.xz * 1.6;
    float c1 = 1.0 - abs(vnoise(cp + vec2(uTime * 0.35, uTime * 0.2)) - vnoise(cp * 1.3 - vec2(uTime * 0.25, -uTime * 0.3) + 5.0));
    float caustic = pow(c1, 9.0);
    albedo *= 1.0 + caustic * shallow * 0.4;
  }
}

// Wet soil along rivers and in the rain; soaked and glossy right at the waterline.
float waterline = (1.0 - smoothstep(0.0, 0.07 + n3 * 0.07, hA + shoreN * 0.4)) * (1.0 - sub);
float damp = (1.0 - smoothstep(0.0, bankTop * 1.8, hA + shoreN)) * nearW;
float wet = clamp(wetSoil * 0.55 + uWetness * (1.0 - snow), 0.0, 1.0) * (1.0 - under);
albedo *= 1.0 - 0.38 * wet;
albedo *= 1.0 - 0.18 * damp * (1.0 - snow);
albedo *= 1.0 - 0.28 * waterline * (1.0 - snow);
tRough = mix(tRough, 0.22, wet * 0.85);
tRough = mix(tRough, 0.3, waterline * (1.0 - snow));

// Lava: animated crust with glowing channels.
vec3 tEmissive = vec3(0.0);
float lava = sb.b;
if (lava > 0.01) {
  float flow = fbm3(wp.xz * 1.1 + vec2(uTime * 0.07, -uTime * 0.04));
  float crust = smoothstep(0.42, 0.6, flow + (n3 - 0.5) * 0.2);
  float glow = lava * (1.0 - crust * 0.9);
  albedo = mix(albedo, vec3(0.04, 0.025, 0.02), lava);
  tRough = mix(tRough, 0.55, lava);
  float pulse = 0.85 + 0.15 * sin(uTime * 1.7 + n1 * 12.0);
  tEmissive = mix(vec3(1.0, 0.2, 0.02), vec3(1.0, 0.5, 0.08), 1.0 - crust) * glow * 1.5 * pulse;
}
// Faint glowing fissures on volcanic ground.
if (sb.g > 0.75) {
  float fis = 1.0 - smoothstep(0.0, 0.012, abs(vnoise(wp.xz * 0.9 + 3.3) - 0.5));
  fis *= smoothstep(0.55, 0.75, vnoise(wp.xz * 0.35 + 9.0));
  tEmissive += vec3(1.0, 0.22, 0.03) * fis * smoothstep(0.75, 1.0, sb.g) * 0.9 * (1.0 - rockW * 0.6);
}

// Close-up detail: fine grain in the grass, grit and small stones on bare ground,
// cracks in rock. It fades in as the camera comes near, and each layer only where its
// features span a few pixels, so nothing shimmers.
float camDist = length(vViewPosition);
float nearD = 1.0 - smoothstep(12.0, 42.0, camDist);
float px = max(length(fwidth(wp.xz)), 1e-4); // world units per pixel
#define AA(size) clamp(((size) / px - 1.5) * 0.4, 0.0, 1.0)
float stone = 0.0, soilW = 0.0; // also raise the stones in the bump below
if (nearD > 0.001) {
  vec2 gp = wp.xz;
  float bare = (1.0 - snow) * (1.0 - sub);
  // grass: clumps, blade streaks and single blades catching the light
  float grassW = clamp((wa.r + wa.g * 0.8 + wa.b * 0.5) / wsum, 0.0, 1.0) * (1.0 - rockW) * (1.0 - road) * (1.0 - bankW) * bare;
  float g1 = vnoise(gp * 11.0);
  float g2 = vnoise(vec2(gp.x * 38.0 + g1 * 3.0, gp.y * 17.0));
  float g3 = hash12(floor(gp * 64.0));
  float gd = 1.0 + (g1 - 0.5) * 0.34 * AA(0.09) + (g2 - 0.5) * 0.3 * AA(0.03) + (g3 - 0.5) * 0.22 * AA(0.016);
  vec3 grassCol = albedo * gd;
  grassCol = mix(grassCol, grassCol * vec3(1.25, 1.15, 0.62), smoothstep(0.7, 0.92, g2) * 0.45 * AA(0.03)); // dry blades
  albedo = mix(albedo, grassCol, grassW * nearD);
  // bare ground (roads, sand, soil, volcanic): grit and scattered small stones
  soilW = clamp(max(road, max(bankW * (1.0 - pebW), (wa.a + wb.y) / wsum)), 0.0, 1.0) * bare * (1.0 - rockW * 0.5);
  float grit = 1.0 + (hash12(floor(gp * 48.0)) - 0.5) * 0.3 * AA(0.021) + (vnoise(gp * 16.0) - 0.5) * 0.2 * AA(0.06);
  vec2 sp = gp * 9.0, sc = floor(sp);
  float sh = hash12(sc + 41.0);
  vec2 so = sc + 0.3 + 0.4 * vec2(hash12(sc + 2.7), hash12(sc + 8.1));
  float sr = 0.12 + 0.12 * hash12(sc + 6.3);
  stone = step(0.72, sh) * (1.0 - smoothstep(sr - 0.04, sr, length(sp - so))) * AA(0.03);
  vec3 stoneCol = mix(vec3(0.5, 0.47, 0.42), vec3(0.66, 0.62, 0.55), hash12(sc + 3.9)) * (0.85 + 0.35 * (so.y - sp.y) / sr);
  albedo = mix(albedo, albedo * grit, soilW * nearD);
  albedo = mix(albedo, mix(albedo, stoneCol, 0.8), stone * soilW * nearD * 0.9);
  // rock: fine cracks and lichen
  float cr = abs(vnoise(gp * 7.0 + wp.y * 2.5) - 0.5) + abs(vnoise(gp * 17.0 - wp.y * 4.0) - 0.5) * 0.5;
  float crack = (1.0 - smoothstep(0.0, 0.045, cr)) * AA(0.05);
  float lichen = smoothstep(0.66, 0.74, vnoise(gp * 5.0 + 11.0)) * smoothstep(0.35, 0.65, vnoise(gp * 23.0)) * AA(0.06);
  albedo *= 1.0 - crack * 0.4 * rockW * nearD * (1.0 - snow);
  albedo = mix(albedo, vec3(0.42, 0.44, 0.24) * (0.8 + 0.4 * n3), lichen * rockW * nearD * (1.0 - snow) * 0.5);
}

// Tile grid overlay (Warlords board).
if (uGrid > 0.001) {
  vec2 tc = (wp.xz + uMapSize * 0.5) / uTileSize;
  vec2 fw = fwidth(tc);
  vec2 d = abs(fract(tc + 0.5) - 0.5);
  vec2 l = 1.0 - smoothstep(fw * 0.5, fw * 1.6, d);
  float line = max(l.x, l.y) * uGrid * (1.0 - under);
  albedo = mix(albedo, vec3(0.02, 0.02, 0.015), line * 0.55);
}

diffuseColor.rgb = albedo;
`;
