import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL, cloudGLSL } from './shaders/common.js';
import { mapUniforms, mapLookupGLSL, smoothHeightGLSL } from './Terrain.js';
import { rasterizePolyline } from '../generator/grid.js';

const waterCommonGLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uSunDir, uSunColor, uAmbient, uSkyColor, uHorizonColor;
uniform sampler2D uHeightTex, uClimate;
uniform float uFreezeT, uWetness, uNight;
${mapLookupGLSL}
${smoothHeightGLSL}
${noiseGLSL}
${cloudGLSL}

float terrainHeight(vec2 xz) {
  if (!all(lessThan(abs(xz), uMapSize * 0.5 - 0.01))) return -9.0;
  return texture2D(uHeightTex, mapUV(xz)).r;
}
float temperatureAt(vec2 xz) {
  // beyond the board, extend the edge climate and let it drift back to temperate
  vec2 outside = max(abs(xz) - uMapSize * 0.5, 0.0);
  float t = texture2D(uClimate, clamp(mapUV(xz), vec2(0.0), vec2(1.0))).r;
  return mix(t, 0.5, smoothstep(0.0, 1.0, length(outside) / 90.0 + (vnoise(xz * 0.05) - 0.5) * 0.4));
}

float waveH(vec2 p, float t, vec2 flow) {
  float w = length(uWind);
  vec2 d = uWind / max(w, 0.001);
  float h = vnoise(p * 0.9 + d * t * 0.35 + flow) * 0.5;
  h += vnoise(p * 2.1 - vec2(d.y, -d.x) * t * 0.28 + flow * 1.7) * 0.3;
  h += vnoise(p * 4.7 + d * t * 0.6 + flow * 2.3) * 0.2;
  h += (sin(dot(p, d) * 1.3 - t * 1.6) * 0.5 + 0.5) * 0.25;
  return h * (0.45 + w * 0.6);
}
vec3 waveNormal(vec2 p, float t, vec2 flow, float strength) {
  float e = 0.06;
  float h0 = waveH(p, t, flow);
  float hx = waveH(p + vec2(e, 0.0), t, flow);
  float hz = waveH(p + vec2(0.0, e), t, flow);
  // rain ripples
  vec3 n = normalize(vec3((h0 - hx) / e * strength, 1.0, (h0 - hz) / e * strength));
  if (uWetness > 0.05) {
    vec2 cell = floor(p * 3.0);
    vec2 f = fract(p * 3.0) - 0.5;
    float ph = fract(uTime * 1.3 + hash12(cell));
    float r = length(f - (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5) * 0.5);
    float ring = sin((r - ph * 0.5) * 60.0) * (1.0 - ph) * smoothstep(0.5 * ph + 0.05, 0.5 * ph, r);
    n.xz += (f / max(r, 0.01)) * ring * 0.15 * uWetness;
    n = normalize(n);
  }
  return n;
}

vec4 shadeWater(vec3 wp, vec3 n, float depth, float foam, float temperature, float opacityBoost, float silt) {
  vec3 V = normalize(cameraPosition - wp);
  vec3 L = normalize(uSunDir);
  float NdV = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uHorizonColor, uSkyColor, smoothstep(0.0, 0.6, R.y));

  float dt = 1.0 - exp(-depth * 0.5);
  // silt: suspended sediment turns lowland rivers green-brown and less clear
  vec3 shallow = mix(vec3(0.06, 0.34, 0.33), vec3(0.2, 0.24, 0.12), silt);
  vec3 deep = mix(vec3(0.008, 0.05, 0.1), vec3(0.045, 0.06, 0.035), silt);
  dt = mix(dt, sqrt(dt), silt * 0.7);
  vec3 body = mix(shallow, deep, dt);
  float sunDiff = max(L.y, 0.0);
  vec3 lit = body * (uAmbient * 1.2 + uSunColor * sunDiff);
  // light scattering through wave crests
  lit += vec3(0.02, 0.12, 0.1) * uSunColor * pow(max(dot(V, -L) * 0.5 + 0.5, 0.0), 4.0) * 0.25 * (1.0 - dt);

  vec3 col = mix(lit, sky, fres * 0.9);
  float rl = max(dot(R, L), 0.0);
  col += uSunColor * (pow(rl, 700.0) * 30.0 * (1.0 - uNight * 0.75) + pow(rl, 60.0) * 0.6) * (1.0 - uWetness * 0.7);

  vec3 foamCol = vec3(0.92) * (uAmbient * 1.3 + uSunColor * sunDiff * 0.9);
  col = mix(col, foamCol, foam);
  // shallow water is clear enough to show the bed; deep water goes opaque
  float alpha = clamp(mix(0.26, 0.97, pow(dt, 0.8)) + fres * 0.25 + foam + opacityBoost, 0.0, 1.0);
  alpha *= smoothstep(0.0, 0.15, depth + foam * 0.1);

  // Freezing: cold water turns to cracked sea ice.
  float freeze = smoothstep(uFreezeT + 0.03, uFreezeT - 0.03, temperature + (vnoise(wp.xz * 0.35) - 0.5) * 0.06);
  if (freeze > 0.001) {
    col = mix(col, lit, freeze); // no glitter or foam under the ice
    float cr = abs(vnoise(wp.xz * 1.3) - 0.5);
    float crack = 1.0 - smoothstep(0.0, 0.025, cr);
    vec3 iceAlb = mix(vec3(0.62, 0.78, 0.88), vec3(0.9, 0.95, 1.0), vnoise(wp.xz * 0.6)) * (1.0 - crack * 0.35);
    vec3 iceLit = iceAlb * (uAmbient * 1.4 + uSunColor * sunDiff * 0.85);
    iceLit += uSunColor * pow(max(dot(reflect(-V, vec3(0, 1, 0)), L), 0.0), 40.0) * 0.3;
    col = mix(col, iceLit, freeze);
    alpha = mix(alpha, 1.0, freeze);
  }
  return vec4(col, alpha);
}

// --- open sea ---------------------------------------------------------------------------------
// A handful of directional waves fanned around the wind, long swell down to short chop, with
// sharp crests (exp(sin) profile). A wave is dropped once a pixel spans a good part of its
// wavelength, so the far sea doesn't sparkle; what is dropped comes back as roughness.
// Returns the surface slope; crest = how high the swell stands here (0..1).
const float SEA_L[6] = float[6](12.0, 7.3, 4.6, 2.9, 1.8, 1.1);
const float SEA_A[6] = float[6](-0.35, 0.45, -0.95, 0.8, -0.15, 1.2);
const float SEA_P[6] = float[6](0.0, 1.7, 4.1, 2.3, 5.2, 3.3);
vec2 seaSlope(vec2 p, float t, float fw, float calm, out float crest, out float lost) {
  float w = length(uWind);
  vec2 d = uWind / max(w, 0.001);
  float amp = (0.4 + w * 0.45) * calm;
  vec2 g = vec2(0.0);
  float h = 0.0, hsum = 0.0;
  lost = 0.0;
  for (int i = 0; i < 6; i++) {
    float L = SEA_L[i], k = 6.2832 / L;
    float ca = cos(SEA_A[i]), sa = sin(SEA_A[i]);
    vec2 dir = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
    float omega = sqrt(9.8 * k) * 0.5; // deep-water dispersion, slowed to the board's scale
    float ph = dot(p, dir) * k - t * omega + SEA_P[i];
    float A = L * 0.013 * amp;
    float e = exp(sin(ph) - 1.0);
    float vis = 1.0 - smoothstep(0.12, 0.45, fw / L);
    h += A * e * vis; hsum += A * vis;
    g += dir * (A * k * e * cos(ph) * vis);
    lost += (1.0 - vis) * A * k;
  }
  crest = h / max(hsum, 1e-4);
  return g;
}

vec4 shadeSea(vec3 wp, vec3 n, float depth, float foam, float temperature, float rough, float crest) {
  vec3 V = normalize(cameraPosition - wp);
  vec3 L = normalize(uSunDir);
  float NdV = max(dot(n, V), 0.001);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 sky = mix(uHorizonColor, uSkyColor, smoothstep(0.0, 0.55, R.y));
  // the cloud layer mirrored in the swell
  float cd = cloudDensity(wp.xz + R.xz / max(R.y, 0.1) * 40.0);
  sky = mix(sky, uHorizonColor * 1.12 + uSunColor * 0.08, cd * 0.55);
  float shade = cloudShadow(wp, L);

  // turquoise shallows, teal shelf, deep navy offshore
  float dt = 1.0 - exp(-depth * 0.42);
  vec3 body = mix(vec3(0.06, 0.38, 0.37), vec3(0.018, 0.17, 0.23), smoothstep(0.0, 0.55, dt));
  body = mix(body, vec3(0.006, 0.05, 0.11), smoothstep(0.45, 1.0, dt));
  float sunDiff = max(L.y, 0.0);
  vec3 lit = body * (uAmbient * 1.15 + uSunColor * sunDiff * shade);
  // sunlight through the thin tops of the waves
  float sss = pow(clamp(dot(V, -normalize(L + n * 0.5)), 0.0, 1.0), 3.0) + 0.25 * max(dot(n, L), 0.0);
  lit += vec3(0.02, 0.2, 0.16) * uSunColor * shade * sss * smoothstep(0.35, 1.0, crest) * 0.55 * (1.0 - uNight);

  vec3 col = mix(lit, sky, fres * 0.95);
  // sun: GGX highlight, a clean glittering path instead of noise
  vec3 H = normalize(L + V);
  float a = rough * rough, a2 = a * a;
  float NdH = max(dot(n, H), 0.0), NdL = max(dot(n, L), 0.0), VdH = max(dot(V, H), 0.0);
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float Fs = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
  float spec = min(D * Fs * NdL / (4.0 * max(VdH * VdH, 0.1)), 14.0);
  col += uSunColor * spec * shade * (1.0 - uNight * 0.7) * (1.0 - uWetness * 0.7);

  vec3 foamCol = vec3(0.93) * (uAmbient * 1.3 + uSunColor * sunDiff * 0.9 * shade);
  col = mix(col, foamCol, foam);
  float alpha = clamp(mix(0.34, 0.98, pow(dt, 0.8)) + fres * 0.25 + foam, 0.0, 1.0);
  alpha *= smoothstep(0.0, 0.15, depth + foam * 0.1);

  float freeze = smoothstep(uFreezeT + 0.03, uFreezeT - 0.03, temperature + (vnoise(wp.xz * 0.35) - 0.5) * 0.06);
  if (freeze > 0.001) {
    col = mix(col, lit, freeze);
    float cr = abs(vnoise(wp.xz * 1.3) - 0.5);
    float crack = 1.0 - smoothstep(0.0, 0.025, cr);
    vec3 iceAlb = mix(vec3(0.62, 0.78, 0.88), vec3(0.9, 0.95, 1.0), vnoise(wp.xz * 0.6)) * (1.0 - crack * 0.35);
    vec3 iceLit = iceAlb * (uAmbient * 1.4 + uSunColor * sunDiff * 0.85 * shade);
    iceLit += uSunColor * pow(max(dot(reflect(-V, vec3(0, 1, 0)), L), 0.0), 40.0) * 0.3;
    col = mix(col, iceLit, freeze);
    alpha = mix(alpha, 1.0, freeze);
  }
  return vec4(col, alpha);
}
`;

const baseVertex = /* glsl */ `
varying vec3 vWPos;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

function sharedUniforms(map, textures) {
  return {
    ...THREE.UniformsLib.fog,
    ...mapUniforms(map, textures),
    uTime: U.uTime, uWind: U.uWind, uSunDir: U.uSunDir, uSunColor: U.uSunColor, uAmbient: U.uAmbient,
    uSkyColor: U.uSkyColor, uHorizonColor: U.uHorizonColor, uFreezeT: U.uFreezeT, uWetness: U.uWetness, uNight: U.uNight,
    uCloudCover: U.uCloudCover, uCloudOffset: U.uCloudOffset,
  };
}

/**
 * The sea floor softened (a Gaussian a few cells wide): the water's colour and clarity follow
 * it, so a shelf that drops away within one cell fades into the deep over a smooth, rounded
 * line instead of the heightfield's straight cell edges.
 */
function makeBedTexture(map) {
  const { grid: g, heights } = map;
  const { gw, gh } = g;
  const R = 5, sigma = 2.2;
  const k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(gw * gh), out = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    let v = 0;
    for (let d = -R; d <= R; d++) v += k[d + R] * heights[j * gw + Math.min(gw - 1, Math.max(0, i + d))];
    tmp[j * gw + i] = v / ks;
  }
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    let v = 0;
    for (let d = -R; d <= R; d++) v += k[d + R] * tmp[Math.min(gh - 1, Math.max(0, j + d)) * gw + i];
    out[j * gw + i] = v / ks;
  }
  const half = new Uint16Array(out.length);
  for (let i = 0; i < out.length; i++) half[i] = THREE.DataUtils.toHalfFloat(out[i]);
  const tex = new THREE.DataTexture(half, gw, gh, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Sea surface (infinite-looking plane at y = 0) and lake surfaces. */
export function createStillWaterMaterial(map, textures) {
  return new THREE.ShaderMaterial({
    name: 'StillWater',
    uniforms: { ...sharedUniforms(map, textures), uBedTex: { value: makeBedTexture(map) } },
    vertexShader: baseVertex,
    fragmentShader: /* glsl */ `
      varying vec3 vWPos;
      uniform sampler2D uBedTex;
      ${waterCommonGLSL}
      #include <fog_pars_fragment>
      // the softened sea floor through a cubic B-spline (four bilinear taps): no kinks anywhere
      float bedSmooth(vec2 xz) {
        vec2 p = (xz + uMapSize * 0.5) / uCellSize;
        vec2 i = floor(p), f = p - i, f2 = f * f, f3 = f2 * f;
        vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
        vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
        vec2 g0 = w0 + w1, g1 = w2 + w3;
        vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / uTexSize, h1 = (i + 1.0 + w3 / g1 + 0.5) / uTexSize;
        return g0.y * (g0.x * texture2D(uBedTex, h0).r + g1.x * texture2D(uBedTex, vec2(h1.x, h0.y)).r)
             + g1.y * (g0.x * texture2D(uBedTex, vec2(h0.x, h1.y)).r + g1.x * texture2D(uBedTex, h1).r);
      }
      void main() {
        vec2 xz = vWPos.xz;
        float th = terrainHeight(xz);
        // in the shallows the ground is read smoothly (no bilinear kinks at the cell edges) and
        // a touch high, so the soft edge of the water hides the terrain mesh's faceted waterline
        if (th > -9.0 && vWPos.y - th < 0.9) th = mix(heightSmooth(xz) + SHORE_SINK, th, smoothstep(0.6, 0.9, vWPos.y - th));
        float dS = vWPos.y - th; // signed: the foam and the water's edge fade out just past the line
        float depth = max(dS, 0.0);
        // Past the board the sea runs on forever: the sea floor falls away into the deep along a
        // wavy line (never the board's rectangle) and the water turns opaque over it.
        vec2 q = abs(xz) - uMapSize * 0.5;
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); // signed distance to the board's edge
        float warp = (vnoise(xz * 0.019) - 0.5) * 40.0 + (vnoise(xz * 0.083 + 5.0) - 0.5) * 9.0;
        float open = smoothstep(-34.0, 8.0, sd + warp);
        float edgeH = texture2D(uHeightTex, clamp(mapUV(xz), 0.5 / uTexSize, 1.0 - 0.5 / uTexSize)).r;
        // colour and clarity follow the softened floor (wobbled a little, so the drop-off's line
        // wanders like a real reef edge); only the waterline itself uses the true ground
        float soft = bedSmooth(xz + (vec2(vnoise(xz * 0.7), vnoise(xz * 0.7 + 17.0)) - 0.5) * 0.9);
        float bedIn = mix(max(soft, th - 0.6), th, smoothstep(0.35, 0.05, depth));
        float bed = sd < 0.0 ? mix(bedIn, -14.0, open * smoothstep(-0.4, -2.5, th)) : mix(min(edgeH, -1.0), -14.0, open);
        float sea = max(vWPos.y - bed, 0.0);

        float fw = length(fwidth(xz));
        float crest, lost;
        vec2 g = seaSlope(xz, uTime, fw, mix(0.3, 1.0, smoothstep(0.2, 3.5, sea)), crest, lost);
        // fine chop and rain rings on top, faded out with distance like the swell
        float fine = 1.0 - smoothstep(0.08, 0.35, fw);
        vec3 nd = waveNormal(xz, uTime, vec2(0.0), 0.3);
        vec3 n = normalize(vec3(-g.x + nd.x / nd.y * fine, 1.0, -g.y + nd.z / nd.y * fine));
        float rough = 0.07 + clamp(lost * 0.35 + (1.0 - fine) * 0.08, 0.0, 0.3);

        // shoreline: a thin soft wash at the waterline and faint broken lines lapping in
        // (only the shallows pay for it)
        float foam = 0.0;
        if (dS < 0.12 && dS > -0.04) {
          float fn = vnoise(xz * 1.3 + uTime * 0.15);
          float wash = smoothstep(-0.035, 0.0, dS) * (1.0 - smoothstep(0.0, 0.03 + fn * 0.04, dS));
          float lap = smoothstep(0.8, 1.0, sin(depth * 40.0 - uTime * 1.3 + fn * 5.0));
          lap *= (1.0 - smoothstep(0.02, 0.12, depth)) * smoothstep(0.45, 0.75, fn) * smoothstep(-0.01, 0.01, dS);
          foam = (wash * 0.35 + lap * 0.2) * (1.0 - smoothstep(-2.0, 0.0, sd));
        }
        // whitecaps break on the swell's crests when the wind freshens
        float w = length(uWind);
        if (w > 0.7 && fine > 0.0 && sea > 2.0) {
          float caps = smoothstep(0.8, 0.97, crest + (vnoise(xz * 1.1 + uWind * uTime * 0.4) - 0.5) * 0.3);
          foam = max(foam, caps * smoothstep(0.7, 2.0, w) * smoothstep(2.0, 6.0, sea) * 0.45 * fine);
        }

        vec4 c = shadeSea(vWPos, n, sea, foam * 0.85, temperatureAt(xz), rough, crest);
        // opaque out at the open sea (not over the shallows of a coast near the board's edge)
        c.a = mix(c.a, 1.0, max(open * smoothstep(-0.3, -1.5, th), smoothstep(-6.0, 0.0, sd)));
        c.a *= smoothstep(0.0, 0.12, depth + foam * 0.1); // the water thins out at the true waterline
        gl_FragColor = c;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: true,
    // the shoreline is nearly coplanar with the terrain; bias the water forward
    // (as the rivers do) so it doesn't z-fight while the camera moves
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export function createSea(map, material) {
  const geo = new THREE.PlaneGeometry(6000, 6000, 60, 60); // subdivided: two huge triangles interpolate depth too coarsely
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sea';
  mesh.renderOrder = 1;
  return mesh;
}

/** One quad per lake cell at the lake's water level. */
export function createLakes(map, material) {
  const { grid: g, lakeLevel } = map;
  const { gw, gh, cellSize } = g;
  const pos = [];
  const x0 = -g.worldW / 2, z0 = -g.worldH / 2;
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const ks = [j * gw + i, j * gw + i + 1, (j + 1) * gw + i, (j + 1) * gw + i + 1];
      let lvl = NaN;
      for (const k of ks) if (!Number.isNaN(lakeLevel[k])) { lvl = lakeLevel[k]; break; }
      if (Number.isNaN(lvl)) {
        // pad one cell around the lake so the shoreline is hidden under terrain
        const nb = [j * gw + i - 1, j * gw + i + 2, (j - 1) * gw + i, (j + 2) * gw + i];
        for (const k of nb) if (k >= 0 && k < lakeLevel.length && !Number.isNaN(lakeLevel[k])) { lvl = lakeLevel[k]; break; }
        if (Number.isNaN(lvl)) continue;
      }
      const xa = x0 + i * cellSize, xb = xa + cellSize, za = z0 + j * cellSize, zb = za + cellSize;
      pos.push(xa, lvl, za, xa, lvl, zb, xb, lvl, zb, xa, lvl, za, xb, lvl, zb, xb, lvl, za);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'lakes';
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * River water as one continuous sheet over the heightfield grid rather than
 * per-river ribbons: ribbons fold over themselves on tight bends and overlap at
 * confluences. Each grid vertex takes the water level, flow direction and slope
 * of the nearest river (same metric the channel carving uses), and the shoreline
 * falls out of the water depth, so it follows the carved channel exactly.
 */
const hash01 = (x) => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

export function buildRiverField(map) {
  const { grid: g, rivers, heights, lakeLevel } = map;
  const { gw, gh, n, cellSize } = g;
  const best = new Float32Array(n).fill(1e9); // distance / channel radius
  const level = new Float32Array(n);
  const flow = new Float32Array(n * 2);
  const drop = new Float32Array(n);
  const fade = new Float32Array(n);
  const speed = new Float32Array(n);
  const silt = new Float32Array(n);
  rivers.forEach((r, ri) => {
    const m = r.x.length;
    if (m < 2) return;
    const along = new Float32Array(m);
    for (let p = 1; p < m; p++) along[p] = along[p - 1] + Math.hypot(r.x[p] - r.x[p - 1], r.z[p] - r.z[p - 1]);
    const total = along[m - 1];
    // Reach-scale slope: the carved surface is a staircase (flat pools, then
    // steps), so slope is measured over a few units of river length. Surface
    // speed then follows Manning's v ~ R^(2/3) S^(1/2), with width standing in
    // for depth, times a per-river character factor.
    const character = 0.8 + 0.45 * hash01(ri * 7.13 + (r.main ? 1.7 : 0));
    const vel = new Float32Array(m), mud = new Float32Array(m);
    const REACH = 2.5;
    for (let p = 0, a = 0, b = 0; p < m; p++) {
      while (along[p] - along[a] > REACH) a++;
      while (b < m - 1 && along[b] - along[p] < REACH) b++;
      const slope = Math.max(0, (r.s[a] - r.s[b]) / Math.max(0.5, along[b] - along[a]));
      const width = r.w[p];
      vel[p] = Math.min(2.4, Math.max(0.22, (0.28 + 2.6 * Math.sqrt(slope)) * (width / 1.3) ** 0.35 * character));
      mud[p] = Math.min(1, Math.max(0, (width - 1.0) / 1.6) * 0.6 + (1 - Math.min(1, slope / 0.08)) * 0.35 + (character - 1) * 0.3);
    }
    let maxR = 0;
    for (const w of r.w) maxR = Math.max(maxR, w / 2);
    rasterizePolyline(g, r.x, r.z, maxR * 1.6 + cellSize, (k, d, seg, t) => {
      const radius = (r.w[seg] * (1 - t) + r.w[seg + 1] * t) / 2;
      const dn = d / radius;
      if (dn >= best[k]) return;
      best[k] = dn;
      level[k] = r.s[seg] * (1 - t) + r.s[seg + 1] * t;
      const pa = Math.max(0, seg - 3), pb = Math.min(m - 1, seg + 4);
      const dx = r.x[pb] - r.x[pa], dz = r.z[pb] - r.z[pa];
      const len = Math.hypot(dx, dz) || 1;
      flow[k * 2] = dx / len; flow[k * 2 + 1] = dz / len;
      drop[k] = Math.max(0, (r.s[pa] - r.s[pb]) / Math.max(0.05, len));
      const dist = along[seg] + (along[seg + 1] - along[seg]) * t;
      fade[k] = Math.min(1, dist / 1.2) * (r.endsInSea ? 1 : Math.min(1, (total - dist) / Math.max(0.5, r.w[m - 1] * 0.7) + 0.3));
      speed[k] = vel[seg] * (1 - t) + vel[seg + 1] * t;
      silt[k] = mud[seg] * (1 - t) + mud[seg + 1] * t;
    });
  });
  // Coverage: full inside the channel, feathered out past the banks, and off
  // where a lake or the sea takes over (those have their own surfaces).
  const cover = new Float32Array(n);
  const has = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (best[k] > 1.6) continue;
    has[k] = 1;
    const lake = !Number.isNaN(lakeLevel[k]);
    const t = Math.min(1, Math.max(0, (best[k] - 1.05) / 0.5));
    const sea = Math.min(1, Math.max(0, level[k] / 0.12));
    cover[k] = lake ? 0 : (1 - t * t * (3 - 2 * t)) * sea * fade[k];
  }
  // One ring of padding so quads touching the edge have a sensible level.
  const pad = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * gw + i;
    if (has[k]) continue;
    let s = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
      const kk = jj * gw + ii;
      if (has[kk]) { s += level[kk]; c++; }
    }
    if (c) pad.push(k, s / c);
  }
  for (let p = 0; p < pad.length; p += 2) { level[pad[p]] = pad[p + 1]; has[pad[p]] = 2; }
  // Soften the per-vertex fields so rapids and slopes don't show the grid.
  const blur = (arr, passes) => {
    const tmp = new Float32Array(n);
    for (let it = 0; it < passes; it++) {
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (!has[k]) continue;
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
          const kk = jj * gw + ii;
          if (has[kk]) { s += arr[kk]; c++; }
        }
        tmp[k] = s / c;
      }
      for (let k = 0; k < n; k++) if (has[k]) arr[k] = tmp[k];
    }
  };
  // pad cells take their neighbours' speed and silt too, then soften so
  // confluences blend instead of showing a seam between two rivers' speeds
  for (let p = 0; p < pad.length; p += 2) {
    const k = pad[p], i = k % gw, j = (k - i) / gw;
    let sp = 0, sl = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const kk = (j + dj) * gw + i + di;
      if (kk >= 0 && kk < n && has[kk] === 1) { sp += speed[kk]; sl += silt[kk]; c++; }
    }
    if (c) { speed[k] = sp / c; silt[k] = sl / c; }
  }
  blur(drop, 3);
  blur(level, 1);
  blur(speed, 3);
  blur(silt, 2);
  return { level, flow, drop, cover, has, heights, speed, silt, best, fade };
}

/**
 * Local water surface under every grid vertex, for the terrain shader's banks:
 * R = water level (river sheet, lake or sea), G = how river-like the shore is
 * (1 river, 0.7 lake, 0 sea). River and lake levels are dilated a few cells past
 * the water so bilinear lookups stay sensible across the whole bank.
 */
export function makeWaterLevelTexture(map, field) {
  const { grid: g, lakeLevel } = map;
  const { gw, gh, n } = g;
  const level = new Float32Array(n).fill(NaN);
  const kind = new Float32Array(n);
  if (field) {
    for (let k = 0; k < n; k++) {
      if (!field.has[k]) continue;
      level[k] = field.level[k] + 0.03; // same offset as the river mesh
      kind[k] = field.has[k] === 1 ? Math.max(0.35, field.fade[k]) : 1;
    }
  }
  for (let k = 0; k < n; k++) if (!Number.isNaN(lakeLevel[k])) { level[k] = lakeLevel[k]; kind[k] = 0.7; }
  for (let ring = 0; ring < 5; ring++) {
    const add = [];
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      if (!Number.isNaN(level[k])) continue;
      let s = 0, kd = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
        const kk = jj * gw + ii;
        if (!Number.isNaN(level[kk])) { s += level[kk]; kd += kind[kk]; c++; }
      }
      if (c) add.push(k, s / c, kd / c);
    }
    for (let p = 0; p < add.length; p += 3) { level[add[p]] = add[p + 1]; kind[add[p]] = add[p + 2]; }
  }
  // B = horizontal distance to the nearest submerged vertex (two-pass chamfer),
  // so flat floodplains barely above the water don't turn into one big bank.
  // Only vertices that really hold water count as submerged; where the dilated
  // level runs over a dry hollow next to a perched river, drop it below ground.
  const dist = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const h = map.heights[k];
    const water = h < 0 || !Number.isNaN(lakeLevel[k]) || (field && field.has[k] === 1 && field.cover[k] > 0.01);
    if (Number.isNaN(level[k])) level[k] = 0;
    if (h < level[k] && !water) level[k] = h - 0.4;
    dist[k] = h < level[k] ? 0 : 1e9;
  }
  const D1 = map.grid.cellSize, D2 = D1 * Math.SQRT2;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * gw + i;
    let d = dist[k];
    if (i > 0) d = Math.min(d, dist[k - 1] + D1);
    if (j > 0) {
      d = Math.min(d, dist[k - gw] + D1);
      if (i > 0) d = Math.min(d, dist[k - gw - 1] + D2);
      if (i < gw - 1) d = Math.min(d, dist[k - gw + 1] + D2);
    }
    dist[k] = d;
  }
  for (let j = gh - 1; j >= 0; j--) for (let i = gw - 1; i >= 0; i--) {
    const k = j * gw + i;
    let d = dist[k];
    if (i < gw - 1) d = Math.min(d, dist[k + 1] + D1);
    if (j < gh - 1) {
      d = Math.min(d, dist[k + gw] + D1);
      if (i < gw - 1) d = Math.min(d, dist[k + gw + 1] + D2);
      if (i > 0) d = Math.min(d, dist[k + gw - 1] + D2);
    }
    dist[k] = d;
  }
  const data = new Uint16Array(n * 4);
  for (let k = 0; k < n; k++) {
    data[k * 4] = THREE.DataUtils.toHalfFloat(level[k]);
    data[k * 4 + 1] = THREE.DataUtils.toHalfFloat(kind[k]);
    data[k * 4 + 2] = THREE.DataUtils.toHalfFloat(Math.min(dist[k], 60));
    data[k * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, gw, gh, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function createRivers(map, textures, f) {
  if (!f) return null;
  const g = map.grid;
  const { gw, gh, cellSize } = g;
  const x0 = -g.worldW / 2, z0 = -g.worldH / 2;
  const remap = new Int32Array(gw * gh).fill(-1);
  const pos = [], attr = [], attr2 = [], idx = [];
  const vert = (k) => {
    if (remap[k] >= 0) return remap[k];
    const i = k % gw, j = (k - i) / gw;
    remap[k] = pos.length / 3;
    pos.push(x0 + i * cellSize, f.level[k] + 0.03, z0 + j * cellSize);
    attr.push(f.flow[k * 2], f.flow[k * 2 + 1], f.drop[k], f.cover[k]);
    attr2.push(f.speed[k], Math.min(1.6, f.best[k]), f.silt[k]);
    return remap[k];
  };
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      if (!(f.has[a] && f.has[b] && f.has[c] && f.has[d])) continue;
      if (f.cover[a] + f.cover[b] + f.cover[c] + f.cover[d] <= 0) continue;
      // skip quads that are dry everywhere (bank well above the water)
      const lv = Math.max(f.level[a], f.level[b], f.level[c], f.level[d]) + 0.03;
      if (Math.min(f.heights[a], f.heights[b], f.heights[c], f.heights[d]) > lv + 0.05) continue;
      const va = vert(a), vb = vert(b), vc = vert(c), vd = vert(d);
      idx.push(va, vc, vd, va, vd, vb);
    }
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(attr, 4));
  geo.setAttribute('aRiver', new THREE.Float32BufferAttribute(attr2, 3));
  geo.setIndex(idx);

  const mat = new THREE.ShaderMaterial({
    name: 'River',
    uniforms: sharedUniforms(map, textures),
    vertexShader: /* glsl */ `
      attribute vec4 aFlow;
      attribute vec3 aRiver;
      varying vec3 vWPos;
      varying vec4 vFlow;
      varying vec3 vRiver;
      #include <fog_pars_vertex>
      void main() {
        vFlow = aFlow;
        vRiver = aRiver;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWPos;
      varying vec4 vFlow;
      varying vec3 vRiver;
      ${waterCommonGLSL}
      #include <fog_pars_fragment>
      // Fast water breaks into finer, choppier ripples; slow water keeps broad swells.
      float ripple(vec2 p, float chop) {
        return vnoise(p * 1.3) * (0.55 - chop * 0.25) + vnoise(p * 3.1 + 3.0) * 0.35 + vnoise(p * 7.3 + 11.0) * (0.1 + chop * 0.35);
      }
      vec2 rippleGrad(vec2 p, float chop) {
        const float e = 0.04;
        float h0 = ripple(p, chop);
        return vec2(ripple(p + vec2(e, 0.0), chop) - h0, ripple(p + vec2(0.0, e), chop) - h0) / e;
      }
      void main() {
        vec2 dir = normalize(vFlow.xy + vec2(1e-5));
        vec2 side = vec2(-dir.y, dir.x);
        float drop = vFlow.z, cover = vFlow.w;
        float bank = clamp(vRiver.y, 0.0, 1.0); // 0 mid-channel .. 1 at the bank
        float silt = vRiver.z;
        // current: fastest in the thalweg, dragging to a crawl along the banks
        float speed = vRiver.x * (1.0 - 0.7 * bank * bank);
        float chop = clamp((vRiver.x - 0.5) / 1.4, 0.0, 1.0);

        // Two-phase flow map in world space. The phase is offset by a slow noise
        // so different stretches (and different rivers) don't pulse in sync.
        const float PERIOD = 2.2;
        float off = vnoise(vWPos.xz * 0.07 + 17.0) * 2.0;
        float ph0 = fract(uTime / PERIOD + off), ph1 = fract(uTime / PERIOD + off + 0.5);
        float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
        vec2 v = dir * speed * PERIOD;
        vec2 p0 = vWPos.xz - v * ph0;
        vec2 p1 = vWPos.xz - v * ph1 + vec2(3.7, 1.3);
        vec2 grad = mix(rippleGrad(p1, chop), rippleGrad(p0, chop), w0);
        // stretch the ripples along the current: slopes across the flow survive,
        // slopes along it are damped, so highlights streak downstream
        float along = dot(grad, dir), across = dot(grad, side);
        grad = dir * along * mix(0.55, 0.3, chop) + side * across * 1.15;
        float strength = (0.08 + clamp(drop, 0.0, 0.3) + chop * 0.1) * mix(1.0, 0.35, bank * bank);
        vec3 n = normalize(vec3(-grad.x * strength, 1.0, -grad.y * strength));

        float th = terrainHeight(vWPos.xz);
        float depth = max(vWPos.y - th, 0.0);
        // foam: sampled twice along the current so blobs smear into streaks
        vec2 q0 = p0, q1 = p1;
        float fn0 = vnoise(q0 * 4.5 + 5.0) * 0.6 + vnoise((q0 - dir * 0.35) * 4.5 + 5.0) * 0.4;
        float fn1 = vnoise(q1 * 4.5 + 5.0) * 0.6 + vnoise((q1 - dir * 0.35) * 4.5 + 5.0) * 0.4;
        float fn = mix(fn1, fn0, w0);
        float fine = mix(vnoise(p1 * 11.0 + 9.0), vnoise(p0 * 11.0 + 9.0), w0);
        float rapids = smoothstep(0.04, 0.3, drop + chop * 0.12) * smoothstep(0.35, 0.85, fn * 0.65 + fine * 0.35) * 0.85;
        // scum lines where the slow bank water meets the current
        float seam = smoothstep(0.55, 0.78, bank) * (1.0 - smoothstep(0.82, 1.0, bank));
        float lines = seam * smoothstep(0.45, 0.75, fn) * 0.45;
        // Shoreline: the sheet thins to nothing over the last few centimetres of
        // depth, with a wobbly edge so it never traces the terrain facets, and a
        // faint lapping line of froth just inside it.
        float edgeN = vnoise(vWPos.xz * 3.1 + uTime * 0.15) * 0.6 + vnoise(vWPos.xz * 9.0 - uTime * 0.25) * 0.4;
        float edge = smoothstep(0.0, 0.1 + edgeN * 0.12, depth - 0.005);
        float lap = sin(depth * 60.0 - uTime * 1.4 + edgeN * 5.0) * 0.5 + 0.5;
        float bankFoam = (1.0 - smoothstep(0.02, 0.12, depth)) * smoothstep(0.5, 0.95, lap * 0.6 + fn * 0.5) * edge;
        float foam = clamp(rapids * 0.8 * edge + bankFoam * 0.22 + lines, 0.0, 1.0);
        vec4 c = shadeWater(vWPos, n, depth * 2.2 + 0.12, foam, temperatureAt(vWPos.xz), 0.14 + silt * 0.2, silt);
        // clear at the margin so the wet bank shows through
        c.a *= cover * edge * mix(0.45, 1.0, smoothstep(0.05, 0.35, depth));
        gl_FragColor = c;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'rivers';
  mesh.renderOrder = 2;
  return mesh;
}
