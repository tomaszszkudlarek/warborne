import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL } from './shaders/common.js';

// Spell visual effects. Every spell is a short timeline assembled from a handful of
// GPU-driven building blocks, all procedural (no textures) and additive / premultiplied
// so they glow through the bloom pass by day and by night:
//   particles  instanced quads whose whole motion (ballistic, drag, swirl, polar spirals,
//              convergence, wobble) is evaluated in the vertex shader from spawn attributes;
//              the fragment shader draws one of ~25 procedural sprites (glow, star, spark,
//              flame, smoke, skull, note, coin, feather, skeletal hand, wraith, eye, ...)
//   decals     ground planes (optionally draped over the terrain) with rune circles, shock
//              rings, cracks, portals, swirls, ripples and scorch marks
//   columns    open cylinders / cones: light beams, fire, swirling tornadoes, rune walls
//   dome       hexagonal force-field hemisphere
//   ribbons    camera-facing strips along polylines: comet trails, helixes, rings, lightning
//   lights     two pooled PointLights shared by all effects (the strongest requests win)
// All effect materials use premultiplied-alpha blending (ONE, ONE_MINUS_SRC_ALPHA): alpha 0
// is purely additive light, alpha > 0 also occludes (smoke, rocks, dark portal centres).
//
//   const fx = new SpellFX(scene);
//   fx.update(dt);                              // every frame
//   await fx.play('heroism', groundPoint, { scale, target, onSpawn, heightAt, color });
//   const aura = fx.aura(stackObject, 'haste'); aura.dispose();

const TAU = Math.PI * 2;

/** Spell metadata: id -> { name, color (css hex), kind }. */
export const SPELL_FX = {
  // Wizard
  strength: { name: 'Strength', color: '#ff5a2a', kind: 'buff' },
  haste: { name: 'Haste', color: '#3fffc8', kind: 'buff' },
  flight: { name: 'Flight', color: '#bfe4ff', kind: 'buff' },
  wallofforce: { name: 'Wall of Force', color: '#4a9dff', kind: 'buff' },
  heroism: { name: 'Heroism', color: '#ffd24a', kind: 'buff' },
  invisibility: { name: 'Invisibility', color: '#b07aff', kind: 'buff' },
  phantomsteed: { name: 'Phantom Steed', color: '#8fffe6', kind: 'buff' },
  // Necromancer / Vampire
  terror: { name: 'Terror', color: '#8a2cff', kind: 'curse' },
  chaosseed: { name: 'Chaos Seed', color: '#ff2a1a', kind: 'curse' },
  reanimate: { name: 'Reanimate', color: '#5dff5a', kind: 'summon' },
  wraithcall: { name: 'Wraith Call', color: '#a8d8ff', kind: 'summon' },
  lifesbane: { name: "Life's Bane", color: '#9dff2a', kind: 'summon' },
  // Paladin / Priest / Ranger / Shaman
  fortify: { name: 'Fortify', color: '#e0b25a', kind: 'buff' },
  bravery: { name: 'Bravery', color: '#ffc04a', kind: 'buff' },
  mightyfeast: { name: 'Mighty Feast', color: '#b8f060', kind: 'buff' },
  dig: { name: 'Dig', color: '#b08850', kind: 'utility' },
  augury: { name: 'Augury', color: '#fff0b0', kind: 'utility' },
  jihad: { name: 'Jihad', color: '#ffa640', kind: 'buff' },
  evileye: { name: 'Evil Eye', color: '#9cff3a', kind: 'curse' },
  berserker: { name: 'Berserker', color: '#ff2020', kind: 'buff' },
  // Summoner
  summonimp: { name: 'Summon Imp', color: '#ff7a2a', kind: 'summon' },
  summonhound: { name: 'Summon Hellhound', color: '#ff3a10', kind: 'summon' },
  minordemon: { name: 'Minor Demon', color: '#8fd8ff', kind: 'summon' },
  greaterdemon: { name: 'Greater Demon', color: '#ff4a0a', kind: 'summon' },
  teleport: { name: 'Teleport', color: '#8a7aff', kind: 'utility' },
  // Alchemist
  creategolem: { name: 'Create Golem', color: '#ffa84a', kind: 'summon' },
  summonitem: { name: 'Summon Item', color: '#ffd760', kind: 'utility' },
  // Monk
  mightyblow: { name: 'Mighty Blow', color: '#ffb060', kind: 'buff' },
  bodycontrol: { name: 'Body Control', color: '#9fd0ff', kind: 'buff' },
  mindcontrol: { name: 'Mind Control', color: '#ff3ad8', kind: 'curse' },
  // Bard
  stormsong: { name: 'Storm Song', color: '#5ab4ff', kind: 'curse' },
  songofbattle: { name: 'Song of Battle', color: '#ff7040', kind: 'buff' },
  songoflife: { name: 'Song of Life', color: '#70ff80', kind: 'buff' },
  songofstone: { name: 'Song of Stone', color: '#d8c890', kind: 'buff' },
  songoffortune: { name: 'Song of Fortune', color: '#ffd040', kind: 'buff' },
  // Generic
  bless: { name: 'Blessing', color: '#ffe08a', kind: 'buff' },
  levelup: { name: 'Level Up', color: '#ffd24a', kind: 'utility' },
  capture: { name: 'City Captured', color: '#ffe070', kind: 'utility' },
};

// ---------------------------------------------------------------------------------------
// small helpers

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Envelope: 0 before a, eases up to 1 at b, holds, eases down to 0 at d (from c). */
const env = (t, a, b, c, d) => sstep(a, b, t) * (1 - sstep(c, d, t));
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const R = (a, b) => a + Math.random() * (b - a);
// Overall brightness of the emissive colours (tuned against ACES + bloom threshold 1.0).
const GAIN = 0.42;
// Scale of the requested point-light intensities.
const LIGHT_GAIN = 0.12;
/** Linear-space emissive colour from a css hex, scaled into HDR by k * GAIN. */
const hc = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k * GAIN);

// Premultiplied-alpha blending shared by every effect material.
function premul(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  mat.fog = false;
  return mat;
}

// ---------------------------------------------------------------------------------------
// GLSL

const commonGLSL = /* glsl */ `
#define TAU 6.28318530718
${noiseGLSL}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm3d(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise3(p); p = p * 2.03 + vec3(17.1, 9.2, 4.7); a *= 0.5; }
  return s / 0.875;
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
// Point of a 3x3 glyph grid picked by a hash in [0,1).
vec2 gridPt(float h) { float i = floor(h * 8.999); return (vec2(mod(i, 3.0), floor(i / 3.0)) - 1.0); }
// Distance to a random rune made of three strokes on a 3x3 grid (cell id -> glyph).
float runeGlyph(vec2 q, float id) {
  float d = 1e3;
  for (int s = 0; s < 3; s++) {
    float fs = float(s);
    vec2 a = gridPt(hash12(vec2(id * 1.37 + fs * 7.13, 3.1 + fs)));
    vec2 b = gridPt(hash12(vec2(id * 2.71 + fs * 3.77, 9.7 - fs)));
    if (dot(a - b, a - b) < 0.5) b = -a + vec2(0.0, 1.0);
    d = min(d, sdSeg(q, a, b));
  }
  return d;
}
// Cellular crack pattern: distance to the nearest Voronoi edge.
float voronoiEdge(vec2 x) {
  vec2 n = floor(x), f = fract(x), mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    if (dot(mr - r, mr - r) > 0.0001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}
// Hexagonal tiling: xy = offset inside the cell, zw = cell id. Period 1 along x.
vec4 hexGrid(vec2 uv) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(uv, uv - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(uv - hC.xy * s, uv - (hC.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
}
float hexEdge(vec2 gv) { vec2 p = abs(gv); return 0.5 - max(dot(p, vec2(0.5, 0.8660254)), p.x); }
`;

// --- particle sprites -------------------------------------------------------------------
// Each body reads p (quad coords, -1..1), col (colour for this particle), and writes
// vec4 o = (premultiplied emission, occlusion alpha). Uniforms: uColA/B/C, uHot, uParam.
const SHAPES = {
  // soft glowing mote with a hot core
  GLOW: `
    float r2 = dot(p, p);
    o.rgb = col * exp(-r2 * 5.0) + mix(col, vec3(1.0), 0.6) * exp(-r2 * 26.0) * uHot;
    o.rgb *= 1.0 - smoothstep(0.7, 1.0, sqrt(r2));`,
  // tiny flickering ember
  EMBER: `
    float r2 = dot(p, p);
    float fl = 0.6 + 0.4 * sin(uT * 23.0 + vSeed * 91.0) * sin(uT * 13.0 + vSeed * 37.0);
    o.rgb = (col * exp(-r2 * 7.0) + vec3(1.0, 0.9, 0.7) * exp(-r2 * 40.0) * uHot) * fl;
    o.rgb *= 1.0 - smoothstep(0.7, 1.0, sqrt(r2));`,
  // four-ray twinkling sparkle
  STAR: `
    vec2 q = abs(p);
    float rays = exp(-q.x * 26.0) * exp(-q.y * 2.8) + exp(-q.y * 26.0) * exp(-q.x * 2.8);
    vec2 d = abs(rot2(0.785) * p);
    rays += 0.45 * (exp(-d.x * 34.0) * exp(-d.y * 6.0) + exp(-d.y * 34.0) * exp(-d.x * 6.0));
    float core = exp(-dot(p, p) * 22.0);
    float tw = 0.6 + 0.4 * sin(uT * 17.0 + vSeed * 60.0);
    o.rgb = (col * (rays * 1.3 + core) + vec3(1.0) * core * uHot) * tw;
    o.rgb *= 1.0 - smoothstep(0.8, 1.0, length(p));`,
  // velocity-aligned streak: p.x across, p.y along (head at +1)
  SPARK: `
    float along = smoothstep(-1.0, 0.5, p.y) * (1.0 - smoothstep(0.75, 1.0, p.y));
    o.rgb = (col * exp(-p.x * p.x * 5.0) + vec3(1.0) * exp(-p.x * p.x * 30.0) * uHot) * along;`,
  // healing cross
  PLUS: `
    float d = min(sdBox(p, vec2(0.13, 0.5)), sdBox(p, vec2(0.5, 0.13))) - 0.05;
    o.rgb = col * (smoothstep(0.03, -0.03, d) * 1.2 + exp(-max(d, 0.0) * 9.0) * 0.6) + vec3(1.0) * smoothstep(0.0, -0.1, d) * uHot * 0.5;
    o.rgb *= 1.0 - smoothstep(0.8, 1.0, length(p));`,
  // billowing smoke puff; uColA albedo, uColB inner glow; uParam.x opacity, y glow, z flash glow
  SMOKE: `
    float r = length(p);
    float n = fbm3(rot2(vSeed * 6.28 + uT * 0.25 * (vSeed - 0.5)) * p * 1.7 + vec2(vSeed * 37.0, vSeed * 11.0 - uT * 0.2));
    float d = smoothstep(1.0, 0.2, r + (0.55 - n) * 0.9);
    float a = d * uParam.x;
    vec3 lit = uColA * (uAmbient * 1.4 + uSunColor * (0.35 + 0.35 * p.y));
    vec3 glow = uColB * (uParam.y * pow(1.0 - vAge, 2.0) + uParam.z) * smoothstep(0.35, 0.9, n) * (1.0 - r * 0.5);
    o = vec4(lit * a + glow * d, a);`,
  // licking flame, cylindrically billboarded & anchored at its base (uColA core, uColB rim)
  FLAME: `
    float y = p.y * 0.5 + 0.5;
    float n = fbm3(vec2(p.x * 1.7 + vSeed * 13.0, y * 2.2 - uT * 3.2 - vSeed * 7.0));
    float w = 0.95 * pow(clamp(1.0 - y, 0.0, 1.0), 0.8) * sqrt(clamp(y * 3.5, 0.0, 1.0));
    float dx = abs(p.x + (n - 0.5) * 0.9 * y) / max(w, 1e-3);
    float f = smoothstep(1.0, 0.25, dx + (0.5 - n) * 0.8 * y);
    float heat = f * (1.05 - y * 0.75);
    o.rgb = mix(uColB, uColA, smoothstep(0.15, 0.6, heat)) * heat * 1.3 + vec3(1.0, 0.92, 0.75) * smoothstep(0.6, 1.0, heat) * uHot;`,
  // screaming smoke skull: uColA smoky body, uColB rim, uColC eye glow; uParam.x jaw
  SKULL: `
    vec2 q = p * 1.08;
    q.x += sin(q.y * 5.0 + uT * 4.0 + vSeed * 9.0) * 0.03;
    float jaw = uParam.x * (0.55 + 0.45 * sin(uT * 9.0 + vSeed * 20.0));
    float cran = length((q - vec2(0.0, 0.2)) * vec2(1.0, 1.05)) - 0.56;
    float cheek = sdBox(q - vec2(0.0, -0.18), vec2(0.34, 0.16)) - 0.1;
    float jawd = sdBox(q - vec2(0.0, -0.5 - jaw * 0.2), vec2(0.24, 0.1)) - 0.08;
    float head = min(min(cran, cheek), jawd);
    vec2 e = vec2(abs(q.x) - 0.22, q.y + 0.02);
    float eyes = length(e * vec2(1.0, 1.25)) - 0.155;
    float nose = max(abs(q.x) * 1.9 + (q.y + 0.24) * 0.8, -(q.y + 0.34)) - 0.07;
    float mouth = sdBox(q - vec2(0.0, -0.44 - jaw * 0.1), vec2(0.17, 0.015 + jaw * 0.1));
    float teeth = step(0.5, fract(q.x * 9.0)) * step(abs(q.y + 0.44), 0.02 + jaw * 0.02);
    float holes = min(min(eyes, nose), mouth);
    float body = max(head, -holes);
    float sn = fbm3(q * 3.0 + vec2(vSeed * 9.0, -uT * 1.4));
    body += (sn - 0.5) * 0.14 + max(0.0, -q.y - 0.55) * 0.3;
    float fill = smoothstep(0.035, -0.035, body);
    float rim = exp(-abs(body) * 16.0);
    float eg = smoothstep(0.03, -0.08, eyes) + exp(-max(eyes, 0.0) * 12.0) * 0.5;
    float hollow = smoothstep(0.02, -0.02, holes) * smoothstep(0.1, -0.05, head);
    o.rgb = uColA * fill + uColB * rim * 0.9 + uColC * eg * 2.2 + uColB * hollow * 0.35 * (1.0 - teeth);
    o.a = fill * 0.85;`,
  // eighth note or beamed pair of notes
  NOTE: `
    vec2 q = p * 1.15;
    float d;
    if (vSeed < 0.55) {
      float head = length(rot2(-0.45) * (q - vec2(-0.2, -0.55)) * vec2(1.0, 1.5)) - 0.26;
      float stem = sdBox(q - vec2(0.02, 0.05), vec2(0.045, 0.6));
      float flag = sdSeg(q, vec2(0.04, 0.62), vec2(0.38, 0.12)) - 0.07;
      d = min(min(head, stem), flag);
    } else {
      vec2 h1 = q - vec2(-0.5, -0.55), h2 = q - vec2(0.3, -0.45);
      float head = min(length(rot2(-0.45) * h1 * vec2(1.0, 1.5)) - 0.21, length(rot2(-0.45) * h2 * vec2(1.0, 1.5)) - 0.21);
      float stems = min(sdBox(q - vec2(-0.33, 0.05), vec2(0.04, 0.55)), sdBox(q - vec2(0.47, 0.15), vec2(0.04, 0.55)));
      float beam = sdSeg(q, vec2(-0.33, 0.58), vec2(0.47, 0.68)) - 0.08;
      d = min(min(head, stems), beam);
    }
    float fill = smoothstep(0.03, -0.03, d);
    o.rgb = col * (fill * 1.5 + exp(-max(d, 0.0) * 8.0) * 0.55) + vec3(1.0) * fill * uHot * 0.4;
    o.rgb *= 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y)));`,
  // spinning gold coin with rim and star emblem
  COIN: `
    float fl = cos(uT * (5.0 + vSeed * 5.0) + vSeed * 30.0);
    vec2 q = vec2(p.x / max(abs(fl), 0.12), p.y);
    float r = length(q);
    float disc = smoothstep(0.8, 0.74, r);
    float rim = smoothstep(0.58, 0.66, r);
    float a = atan(q.y, q.x);
    float star = smoothstep(0.02, -0.02, r - 0.34 * (0.62 + 0.38 * cos(a * 5.0 + 1.57)));
    vec3 gold = uColA * (0.55 + 0.45 * rim + 0.35 * star) * (0.8 + 0.4 * q.y * sign(fl));
    float glint = pow(max(0.0, sin(uT * 7.0 + vSeed * 40.0)), 16.0) * exp(-dot(p, p) * 5.0);
    o.rgb = gold * disc * (uAmbient * 1.2 + uSunColor * 0.9 + 0.6) + vec3(1.0, 0.95, 0.8) * (glint * 3.0 * disc) + uColA * exp(-r * r * 2.5) * 0.25;
    o.a = disc * 0.95;`,
  // drifting feather
  FEATHER: `
    vec2 q = p;
    q.x += 0.18 * q.y * q.y - 0.05;
    float shaft = exp(-abs(q.x) * 70.0) * step(-0.98, q.y) * step(q.y, 0.9);
    float vw = 0.36 * sqrt(max(0.0, 1.0 - pow((q.y - 0.1) / 0.85, 2.0)));
    float vane = smoothstep(vw, vw - 0.1, abs(q.x)) * step(-0.72, q.y);
    float barbs = 0.7 + 0.3 * sin(q.y * 46.0 - abs(q.x) * 30.0);
    o.rgb = col * (vane * barbs * 0.9 + shaft * 1.6) + vec3(1.0) * shaft * uHot * 0.3;
    o.a = vane * 0.25;`,
  // skeletal hand clawing up out of the ground (cylindrical billboard, anchored)
  HAND: `
    vec2 q = p * vec2(1.05, 1.0);
    float grab = uParam.x * (0.5 + 0.5 * sin(uT * 3.0 + vSeed * 10.0));
    float d = min(sdSeg(q, vec2(-0.1, -1.3), vec2(-0.08, -0.42)) - 0.07, sdSeg(q, vec2(0.1, -1.3), vec2(0.08, -0.42)) - 0.062);
    d = min(d, length((q - vec2(0.0, -0.26)) * vec2(1.0, 1.3)) - 0.22);
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 base = vec2(-0.16 + fi * 0.105, -0.12);
      float ang = mix(0.5, -0.45, fi / 3.0) + (vSeed - 0.5) * 0.3;
      float len = (fi == 1.0 || fi == 2.0) ? 0.5 : 0.42;
      vec2 dir = vec2(sin(ang), cos(ang));
      vec2 j1 = base + dir * len * 0.5;
      vec2 dir2 = rot2((fi - 1.5) * 0.08 * grab - grab * 0.5) * dir; // fingers curl as the hand grabs
      vec2 j2 = j1 + dir2 * len * 0.5;
      d = min(d, sdSeg(q, base, j1) - 0.055);
      d = min(d, sdSeg(q, j1, j2) - 0.045);
      d = min(d, length(q - j1) - 0.065);
    }
    d = min(d, sdSeg(q, vec2(-0.18, -0.3), vec2(-0.42, -0.08)) - 0.058);
    d = min(d, sdSeg(q, vec2(-0.42, -0.08), vec2(-0.48, 0.12) + vec2(grab * 0.1, 0.0)) - 0.046);
    float fill = smoothstep(0.015, -0.015, d);
    float rim = exp(-max(d, 0.0) * 28.0) * (1.0 - fill);
    float shade = 0.55 + 0.45 * smoothstep(0.0, -0.05, d);
    vec3 bone = vec3(0.78, 0.8, 0.64) * (uAmbient * 0.8 + uSunColor * 0.3) * shade;
    o.rgb = bone * fill + uColA * (rim * 1.1 + fill * smoothstep(-0.03, 0.0, d) * 0.4);
    o.a = fill;`,
  // hooded wraith with tattered robe and glowing eyes (uColC eyes)
  GHOST: `
    vec2 q = p;
    float t = uT * 3.0 + vSeed * 10.0;
    q.x -= 0.1 * sin(q.y * 2.5 + t * 0.8) * (0.6 - q.y * 0.5);
    float y = q.y;
    float hood = length((q - vec2(0.0, 0.46)) * vec2(1.0, 0.82)) - 0.24;
    hood = min(hood, sdSeg(q, vec2(0.0, 0.5), vec2(0.07 * sin(t * 0.5), 0.84)) - 0.05);
    float hw = y > 0.22 ? mix(0.36, 0.16, clamp((y - 0.22) / 0.25, 0.0, 1.0)) : mix(0.04, 0.38, smoothstep(-1.0, 0.15, y));
    hw += 0.05 * sin(y * 9.0 + t * 2.0);
    float body = max(max(abs(q.x) - hw, y - 0.42), -0.98 - y);
    body += smoothstep(-0.2, -0.95, y) * (0.5 + 0.5 * sin(q.x * 24.0 + t)) * 0.12;
    float arms = min(sdSeg(q, vec2(-0.26, 0.2), vec2(-0.66, -0.05 + 0.08 * sin(t))), sdSeg(q, vec2(0.26, 0.2), vec2(0.66, -0.05 + 0.08 * sin(t + 2.0)))) - 0.06;
    arms = min(arms, min(sdSeg(q, vec2(-0.66, -0.05 + 0.08 * sin(t)), vec2(-0.76, -0.22)), sdSeg(q, vec2(0.66, -0.05 + 0.08 * sin(t + 2.0)), vec2(0.76, -0.22))) - 0.018);
    float d = min(min(hood, body), arms);
    float fill = smoothstep(0.04, -0.04, d);
    float tail = smoothstep(-1.0, -0.15, y);
    float face = smoothstep(0.02, -0.04, length((q - vec2(0.0, 0.42)) * vec2(1.25, 1.0)) - 0.14);
    vec2 e = vec2(abs(q.x) - 0.06, q.y - 0.43);
    float eyes = exp(-dot(e, e) * 1400.0);
    float n = fbm3(q * vec2(3.0, 1.4) + vec2(vSeed * 7.0, uT * 1.3));
    o.rgb = col * (fill * (0.2 + 0.5 * n) * tail + exp(-max(d, 0.0) * 16.0) * 0.55 * tail) * (1.0 - face) + uColC * eyes * 3.5;
    o.a = fill * tail * (0.22 + 0.25 * n) * (1.0 - face) + face * 0.85;`,
  // five-petal blossom
  BLOSSOM: `
    float r = length(p), a = atan(p.y, p.x) + vSeed * 6.0;
    float pr = 0.78 * (0.5 + 0.5 * abs(cos(a * 2.5)));
    float f = smoothstep(pr, pr - 0.08, r);
    float vein = 0.85 + 0.15 * cos(a * 2.5 * 2.0);
    float center = smoothstep(0.18, 0.1, r);
    vec3 pc = mix(uColA, vec3(1.0), smoothstep(0.55, 0.0, r) * 0.45);
    o.rgb = pc * f * vein * (uAmbient * 0.6 + uSunColor * 0.4) + uColA * f * 0.2 + uColB * center * 1.2;
    o.a = f * 0.9;`,
  // glowing rune glyph
  RUNE: `
    float d = runeGlyph(p * 1.5, floor(vSeed * 97.0)) / 1.5;
    float fill = smoothstep(0.06, 0.025, d);
    o.rgb = col * (fill * 1.8 + exp(-d * 11.0) * 0.55) + vec3(1.0) * fill * uHot * 0.4;
    o.rgb *= 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y)));`,
  // ice / crystal shard (elongated faceted diamond)
  SHARD: `
    vec2 q = abs(p);
    float d = q.x / 0.3 + q.y / 0.95 - 1.0;
    float fill = smoothstep(0.06, -0.06, d);
    float facet = p.x > 0.0 ? 1.0 : 0.55;
    float ridge = exp(-abs(p.x) * 28.0);
    o.rgb = col * (fill * (0.35 * facet + 0.25) + exp(-max(d, 0.0) * 7.0) * 0.35) + vec3(1.0) * ridge * fill * uHot;
    o.a = fill * 0.45;`,
  // tumbling rock chunk, lit by the scene (uColA albedo, uColB hot glow * uParam.x)
  ROCK: `
    float a = atan(p.y, p.x);
    float rr = 0.72 + 0.1 * sin(a * 3.0 + vSeed * 20.0) + 0.07 * sin(a * 5.0 + vSeed * 7.0) + 0.05 * abs(sin(a * 7.0 + vSeed * 3.0));
    float r = length(p);
    float fill = smoothstep(rr, rr - 0.07, r);
    vec2 fp = floor((rot2(vSeed * 6.0) * p) * 2.2);
    vec3 n = normalize(vec3(p / rr + (hash22(fp + vSeed * 13.0) - 0.5) * 0.9, 0.7));
    float diff = clamp(dot(n, normalize(vec3(-0.35, 0.8, 0.5))), 0.0, 1.0);
    vec3 alb = uColA * (0.75 + 0.5 * vnoise(p * 5.0 + vSeed * 19.0));
    o.rgb = alb * (uAmbient * 1.3 + uSunColor * (0.2 + diff * 0.9)) * fill + uColB * uParam.x * fill * (0.4 + 0.6 * smoothstep(rr - 0.3, rr, r));
    o.a = fill;`,
  // banner of light with swallowtail hem and emblem (cylindrical billboard, anchored)
  BANNER: `
    vec2 q = p;
    float t = uT * 3.5 + vSeed * 6.0;
    q.x += 0.1 * sin(q.y * 3.0 - t) * (0.9 - q.y) * 0.5;
    float hem = -0.78 + 0.28 * (1.0 - abs(q.x) / 0.72);
    float cloth = max(max(abs(q.x) - 0.72, q.y - 0.72), hem - q.y);
    float fill = smoothstep(0.03, -0.03, cloth);
    float border = exp(-abs(cloth + 0.07) * 40.0) * step(cloth, 0.0);
    vec2 ec = q - vec2(0.0, 0.2);
    float ang = atan(ec.y, ec.x);
    float em = length(ec) - 0.26 * (0.65 + 0.35 * cos(ang * 5.0 + 1.57));
    float emblem = smoothstep(0.03, -0.03, em);
    float rod = exp(-pow((q.y - 0.8) / 0.04, 2.0)) * step(abs(p.x), 0.9);
    float shade = 0.55 + 0.35 * sin(q.x * 6.0 - t) ;
    o.rgb = col * (fill * shade * 0.55 + border * 1.4 + emblem * 1.6 + rod * 1.8) + uColB * exp(-max(cloth, 0.0) * 8.0) * 0.4;
    o.rgb *= 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y)));`,
  // glowing horseshoe print (lies on the ground)
  HOOF: `
    float r = length(p * vec2(1.0, 0.85));
    float d = abs(r - 0.52) - 0.13;
    d = max(d, -(sdBox(p - vec2(0.0, 0.55), vec2(0.26, 0.35))));
    o.rgb = col * (smoothstep(0.03, -0.03, d) * 1.4 + exp(-max(d, 0.0) * 7.0) * 0.5);
    o.rgb *= 1.0 - smoothstep(0.85, 1.0, length(p));`,
  // giant eye: uParam.x lid opening, y slit pupil, z gaze; uColA iris, uColB lids/halo, uColC sclera
  EYE: `
    vec2 q = p * vec2(1.0, 1.35);
    float open = uParam.x;
    float lid = (0.62 * open + 0.001) * (1.0 - q.x * q.x / 0.85);
    float ed = abs(q.y) - lid;
    float inEye = smoothstep(0.025, -0.025, ed) * step(abs(q.x), 0.92);
    vec2 ic = q - vec2(uParam.z * 0.3, 0.0);
    float ir = length(ic);
    float ia = atan(ic.y, ic.x);
    float iris = smoothstep(0.43, 0.39, ir);
    float stri = 0.65 + 0.35 * sin(ia * 26.0 + fbm3(vec2(ia * 3.0, ir * 6.0)) * 5.0) ;
    float ring = exp(-pow((ir - 0.4) / 0.03, 2.0));
    float pupil = smoothstep(0.02, -0.02, length(ic * vec2(mix(1.0, 5.0, uParam.y), 1.0)) - mix(0.15, 0.36, uParam.y));
    float lidLine = exp(-abs(ed) * 45.0) * step(abs(q.x), 0.95);
    float halo = exp(-length(p * vec2(0.8, 1.6)) * 2.6);
    vec3 irisC = uColA * (0.35 + 1.1 * stri * smoothstep(0.05, 0.42, ir)) + uColA * exp(-pow((ir - 0.24) / 0.08, 2.0)) * 0.6;
    vec3 eye = mix(uColC * (0.4 + 0.3 * (1.0 - ir)), irisC, iris) * (1.0 - pupil) + uColA * ring * 1.2;
    o.rgb = eye * inEye + uColB * (lidLine * 2.0 + halo * 0.3 * (1.0 - inEye));
    o.a = inEye * (0.55 + 0.4 * pupil);
    o.rgb *= 1.0 - smoothstep(0.85, 1.0, length(p));`,
  // radiant sunburst with slowly turning rays
  SUNBURST: `
    float r = length(p), a = atan(p.y, p.x);
    float rays = pow(0.5 + 0.5 * cos(a * 12.0 + uT * 0.7), 10.0) + 0.7 * pow(0.5 + 0.5 * cos(a * 7.0 - uT * 0.45 + 1.0), 16.0);
    o.rgb = col * (rays * exp(-r * 2.6) * 1.6 * smoothstep(0.05, 0.3, r) + exp(-r * r * 12.0) * 1.5) + vec3(1.0) * exp(-r * r * 60.0) * uHot;
    o.rgb *= 1.0 - smoothstep(0.75, 1.0, r);`,
  // blinding flash with an anamorphic streak
  FLASH: `
    float r2 = dot(p, p);
    o.rgb = col * (exp(-r2 * 7.0) * 1.4 + exp(-abs(p.y) * 38.0) * exp(-abs(p.x) * 2.8) * 0.9) + vec3(1.0) * exp(-r2 * 45.0) * uHot;
    o.rgb *= 1.0 - smoothstep(0.8, 1.0, sqrt(r2));`,
  // pair of feathered wings of light; uParam.x flap
  WING: `
    vec2 q = vec2(abs(p.x), p.y + 0.1);
    float flap = uParam.x;
    vec2 root = vec2(0.07, 0.0);
    float d = 1e3, lead = 1e3;
    for (int i = 0; i < 7; i++) {
      float fi = float(i) / 6.0;
      float ang = mix(0.95, -0.55, fi) + flap * (0.35 - fi * 0.15);
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 rel = q - root - dir * fi * 0.05;
      float L = mix(0.92, 0.5, fi);
      float along = dot(rel, dir), across = dot(rel, vec2(-dir.y, dir.x));
      float e = (length(vec2((along - L * 0.5) / (L * 0.5), across / mix(0.075, 0.11, fi))) - 1.0) * 0.07;
      d = min(d, e);
      if (i == 0) lead = e;
    }
    float fill = smoothstep(0.012, -0.012, d);
    o.rgb = col * (fill * 0.7 + exp(-max(d, 0.0) * 28.0) * 0.6 + smoothstep(0.02, -0.01, lead) * 0.8) + vec3(1.0) * fill * uHot * 0.25;
    o.rgb *= 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y)));`,
  // dark seed orb with a fiery swirling rim (chaos seed)
  ORB: `
    float r = length(p);
    float n = fbm3(rot2(uT * 3.0 + r * 4.0) * p * 3.0 + vSeed * 10.0);
    float sphere = smoothstep(0.5, 0.46, r);
    float rim = exp(-pow((r - 0.48) / 0.07, 2.0));
    float halo = exp(-r * r * 3.5) * (1.0 - sphere);
    o.rgb = uColA * (rim * 2.2 + halo * 0.9) + uColB * sphere * pow(n, 2.0) * 2.5 * smoothstep(0.1, 0.5, r);
    o.a = sphere * (0.95 - n * 0.3);
    o.rgb *= 1.0 - smoothstep(0.8, 1.0, r);`,
};

const particleVert = /* glsl */ `
uniform float uT, uScale, uAlpha, uDrag, uSwirl, uConverge, uWobble, uLoop, uAnchor, uAspect, uColorAge, uPull;
uniform vec3 uGravity, uTarget, uSize;
uniform vec2 uFade;
attribute vec3 iPos, iVel;
attribute vec4 iA, iB; // iA: birth, life, size, seed   iB: spin, rot0, colour mix, stretch
varying vec2 vUv;
varying float vAge, vSeed, vFade, vMix;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

vec3 motion(float a, float life) {
#ifdef POLAR
  // iPos = (radius, angle, height), iVel = (radial speed, angular speed, vertical speed)
  float r = max(iPos.x + iVel.x * a, 0.0);
  float th = iPos.y + iVel.y * a;
  vec3 p = vec3(cos(th) * r, iPos.z + iVel.z * a + 0.5 * uGravity.y * a * a, sin(th) * r);
#else
  vec3 d = uDrag > 0.0 ? iVel * (1.0 - exp(-uDrag * a)) / uDrag : iVel * a;
  vec3 p = iPos + d + 0.5 * uGravity * a * a;
  float sw = uSwirl * a;
  p.xz = mat2(cos(sw), sin(sw), -sin(sw), cos(sw)) * p.xz;
#endif
  if (uConverge > 0.0) {
    float k = clamp(a / life, 0.0, 1.0);
    p = mix(p, uTarget, uConverge * k * k * (3.0 - 2.0 * k));
  }
  float sd = iA.w * 43.0;
  p += uWobble * vec3(sin(a * 2.3 + sd), 0.5 * sin(a * 1.7 + sd * 1.3), cos(a * 2.1 + sd * 0.7));
  return p;
}

void main() {
  float life = iA.y;
  float a = uT - iA.x;
  if (uLoop > 0.0) a = mod(a, life);
  if (a < 0.0 || a > life) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float k = a / life;
  vAge = k;
  vSeed = iA.w;
  vFade = smoothstep(0.0, uFade.x, k) * (1.0 - smoothstep(uFade.y, 1.0, k)) * uAlpha;
  vMix = clamp(iB.z + k * uColorAge, 0.0, 1.0);
  float sm = k < uSize.y ? mix(uSize.x, 1.0, smoothstep(0.0, uSize.y, k)) : mix(1.0, uSize.z, smoothstep(uSize.y, 1.0, k));
  float size = iA.z * sm * uScale;
  vec3 p = motion(a, life);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec2 c = position.xy;
  vUv = c;
  float rot = iB.y + iB.x * a;
  vec4 mv;
#if defined(ALIGN_STREAK)
  mv = viewMatrix * wp;
  vec2 d = mv.xy - (viewMatrix * modelMatrix * vec4(motion(max(a - 0.04, 0.0), life), 1.0)).xy;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(0.0, 1.0);
  float L = size + len / 0.04 * iB.w;
  mv.xy += vec2(-dir.y, dir.x) * c.x * size * uAspect * 0.5 + dir * (c.y * 0.5 - 0.5) * L;
#elif defined(ALIGN_YAXIS)
  vec3 toP = wp.xyz - cameraPosition;
  vec3 right = normalize(vec3(-toP.z, 0.0, toP.x) + vec3(1e-5, 0.0, 0.0));
  vec3 w = wp.xyz + right * c.x * size * uAspect * 0.5 + vec3(0.0, (c.y + uAnchor) * size * 0.5, 0.0);
  mv = viewMatrix * vec4(w, 1.0);
#elif defined(ALIGN_GROUND)
  vec2 rc = rot2(rot) * (c * vec2(uAspect, 1.0));
  mv = viewMatrix * vec4(wp.xyz + vec3(rc.x, 0.0, rc.y) * size * 0.5, 1.0);
#else
  mv = viewMatrix * wp;
  mv.xy += rot2(rot) * (c * vec2(uAspect, 1.0)) * size * 0.5;
  mv.z += size * uPull;
#endif
  gl_Position = projectionMatrix * mv;
}`;

function particleFrag(shape) {
  return /* glsl */ `
uniform float uT, uHot;
uniform vec3 uColA, uColB, uColC, uAmbient, uSunColor;
uniform vec4 uParam;
varying vec2 vUv;
varying float vAge, vSeed, vFade, vMix;
${commonGLSL}
void main() {
  vec2 p = vUv;
  vec3 col = mix(uColA, uColB, vMix);
  vec4 o = vec4(0.0);
  ${SHAPES[shape]}
  o *= vFade;
  if (o.a < 0.002 && o.r + o.g + o.b < 0.004) discard;
  gl_FragColor = o;
}`;
}

// --- ground decals ------------------------------------------------------------------------
// vP = position in units of the decal radius (-1..1). uParam meaning depends on the mode.
const DECALS = {
  // rune circle: x reveal sweep, y rotation, z pattern, w glyph cells
  RUNES: `
    float r = length(vP), a = atan(vP.y, vP.x);
    if (r > 1.02) discard;
    float rotA = uParam.y;
    float lines = 0.0;
    lines += exp(-pow((r - 0.97) / 0.012, 2.0)) + exp(-pow((r - 0.8) / 0.009, 2.0));
    lines += exp(-pow((r - 0.62) / 0.008, 2.0)) * 0.9 + exp(-pow((r - 0.56) / 0.006, 2.0)) * 0.7;
    // glyph band between the outer rings
    float N = uParam.w;
    float ga = a + rotA;
    float cf = ga / TAU * N;
    float cell = floor(cf);
    float cellW = TAU * 0.885 / N;
    vec2 q = vec2((fract(cf) - 0.5) * cellW, r - 0.885) / 0.06;
    float gd = runeGlyph(q * 1.1, mod(cell, N) + uParam.z * 31.0) / 1.1;
    lines += smoothstep(0.16, 0.06, gd) * step(abs(q.x), 1.3) * 0.95;
    // tick marks on the inner band
    float ta = (a - rotA * 1.7) / TAU * N * 3.0;
    lines += smoothstep(0.12, 0.0, abs(fract(ta) - 0.5) - 0.38) * step(0.565, r) * step(r, 0.615) * 0.6;
    // inner geometry, counter-rotating
    int pat = int(uParam.z + 0.5);
    float sd = 1e3;
    float ra = -rotA * 0.6;
    int n = pat == 0 ? 6 : pat == 1 ? 5 : pat == 2 ? 3 : pat == 3 ? 8 : 0;
    int kk = pat == 0 ? 2 : pat == 1 ? 2 : pat == 2 ? 1 : 3;
    for (int i = 0; i < 8; i++) {
      if (i >= n) break;
      float a0 = ra + float(i) / float(n) * TAU + 1.5708, a1 = ra + float(i + kk) / float(n) * TAU + 1.5708;
      sd = min(sd, sdSeg(vP, 0.56 * vec2(cos(a0), sin(a0)), 0.56 * vec2(cos(a1), sin(a1))));
    }
    if (pat == 2) { // alchemy: square around the triangle + inner circle
      vec2 sq = rot2(ra + 0.785) * vP;
      sd = min(sd, abs(sdBox(sq, vec2(0.395))));
      sd = min(sd, abs(r - 0.28));
    }
    if (pat == 4 || pat == 5) { // lotus petals
      float pa = a - ra;
      float pr = 0.5 * (0.55 + 0.45 * abs(cos(pa * 4.0)));
      sd = min(sd, abs(r - pr) * 1.3);
      sd = min(sd, abs(r - 0.22));
    }
    lines += exp(-pow(sd / 0.009, 2.0)) * 0.9;
    lines += exp(-pow((r - 0.14) / 0.01, 2.0)) * 0.8;
    // reveal sweep, starting at the top and running clockwise
    float am = fract((-a + 1.5708) / TAU + 1.0);
    float rev = uParam.x;
    float vis = smoothstep(am - 0.015, am + 0.015, rev * 1.03);
    float front = rev < 0.999 ? exp(-pow((am - rev) / 0.02, 2.0)) * smoothstep(0.5, 1.0, r) : 0.0;
    float fill = exp(-r * r * 2.5) * 0.18 + smoothstep(1.0, 0.8, r) * 0.05;
    vec3 col = mix(uColB, uColA, smoothstep(0.3, 0.9, r));
    o.rgb = (col * (lines * 1.6 + fill) + vec3(1.0) * lines * uHot * 0.3) * vis + uColA * front * 3.0;
    o.rgb *= smoothstep(1.02, 0.98, r);`,
  // soft pool of light
  GLOW: `
    float r2 = dot(vP, vP);
    if (r2 > 1.0) discard;
    o.rgb = uColA * exp(-r2 * uParam.x) * (1.0 - r2) + uColB * exp(-r2 * uParam.x * 6.0);`,
  // expanding shock ring: x radius (0..1), y thickness, z inner fill
  SHOCK: `
    float r = length(vP), a = atan(vP.y, vP.x);
    if (r > 1.0) discard;
    float n = fbm3(vec2(a * 3.0 / TAU * 8.0, r * 4.0 - uT * 2.0));
    float rad = uParam.x, th = uParam.y * (0.7 + 0.6 * n);
    float d = (r - rad) / th;
    float ring = exp(-d * d) * (d < 0.0 ? 1.0 : exp(-d * 2.0));
    float inner = smoothstep(rad, 0.0, r) * uParam.z * (0.5 + 0.5 * n);
    o.rgb = uColA * (ring * (0.7 + 0.6 * n) + inner) + uColB * exp(-d * d * 6.0) * 0.6;
    o.rgb *= smoothstep(1.0, 0.9, r);`,
  // glowing cracks spreading from the centre: x reach, y glow, z darkening, w cell density
  CRACKS: `
    float r = length(vP), a = atan(vP.y, vP.x);
    if (r > 1.0) discard;
    vec2 wp = rot2(r * 1.2) * vP;
    float e = voronoiEdge(wp * uParam.w + 3.7);
    float radial = abs(sin(a * 4.0 + fbm3(vP * 4.0) * 3.0));
    float n = fbm3(vP * 6.0);
    float reach = uParam.x;
    float mask = smoothstep(reach, reach - 0.25, r + (n - 0.5) * 0.3);
    float crack = smoothstep(0.07, 0.0, e) * (0.6 + 0.4 * n) + smoothstep(0.06, 0.0, radial) * 0.8;
    crack *= mask * smoothstep(1.0, 0.3, r);
    float pulse = 0.8 + 0.2 * sin(uT * 7.0 + r * 10.0);
    float dark = uParam.z * mask * smoothstep(1.0, 0.2, r) * (0.55 + 0.45 * crack);
    o.rgb = uColA * crack * uParam.y * pulse + uColB * crack * crack * uParam.y * 0.5 + uColC * dark;
    o.a = dark;`,
  // swirling portal: x open radius (0..1), y spin speed, z dark centre
  VORTEX: `
    float open = max(uParam.x, 0.001);
    vec2 q = vP / open;
    float r = length(q);
    if (r > 1.2) discard;
    float a = atan(q.y, q.x);
    float sp = log(r + 0.03) * 6.0;
    float arms = pow(0.5 + 0.5 * sin(a * 3.0 + sp - uT * uParam.y * 2.2), 3.0);
    float fine = pow(0.5 + 0.5 * sin(a * 8.0 + sp * 1.7 - uT * uParam.y * 3.4), 12.0);
    float n = fbm3(rot2(uT * uParam.y * 0.8 + r * 4.0) * q * 2.5 + 5.0);
    float band = smoothstep(0.12, 0.6, r) * smoothstep(1.06, 0.78, r);
    float inten = band * (0.2 + arms * 0.9 + fine * 0.7) * (0.45 + 1.0 * n);
    float rim = exp(-pow((r - 0.97) / 0.04, 2.0)) * (0.4 + 0.8 * n);
    vec3 c = mix(uColB, uColA, smoothstep(0.15, 0.9, inten));
    float hole = uParam.z * smoothstep(0.78, 0.15, r);
    o.rgb = c * inten * 1.3 + uColA * rim + vec3(1.0) * pow(max(inten - 0.85, 0.0), 2.0) * uHot;
    o.rgb += uColB * 0.35 * n * smoothstep(0.6, 0.0, r) * (0.5 + 0.5 * arms);
    o.rgb += uColC * hole;
    o.a = hole * (1.0 - inten * 0.4);
    o *= smoothstep(1.2, 1.02, r);`,
  // wind swirl streaks: x intensity
  SWIRL: `
    float r = length(vP), a = atan(vP.y, vP.x);
    if (r > 1.0) discard;
    float s = pow(0.5 + 0.5 * sin(a * 5.0 + r * 9.0 - uT * 11.0), 14.0);
    float s2 = pow(0.5 + 0.5 * sin(a * 3.0 - r * 6.0 - uT * 7.0 + 1.0), 18.0);
    float band = smoothstep(0.15, 0.45, r) * smoothstep(1.0, 0.7, r);
    o.rgb = (uColA * s + uColB * s2) * band * uParam.x * (0.6 + 0.4 * fbm3(vP * 5.0 - uT));`,
  // hypnotic spiral (mind control)
  SPIRAL: `
    float r = length(vP), a = atan(vP.y, vP.x);
    if (r > 1.0) discard;
    float s = pow(0.5 + 0.5 * sin(a * 3.0 + log(r + 0.01) * 9.0 + uT * 5.0), 6.0);
    float fall = smoothstep(1.0, 0.5, r) * smoothstep(0.0, 0.15, r);
    o.rgb = mix(uColB, uColA, s) * (s * 0.9 + 0.12) * fall * uParam.x;`,
  // outward ripples: x speed, y intensity
  RIPPLE: `
    float r = length(vP);
    if (r > 1.0) discard;
    float w = sin((r - uT * uParam.x) * 26.0);
    float ring = pow(0.5 + 0.5 * w, 10.0);
    o.rgb = uColA * ring * smoothstep(1.0, 0.4, r) * smoothstep(0.05, 0.3, r) * uParam.y;`,
  // scorched / dark ground: x opacity, y ember glow
  SCORCH: `
    float r = length(vP);
    if (r > 1.0) discard;
    float n = fbm3(vP * 3.0 + 2.0);
    float m = smoothstep(1.0, 0.35, r + (n - 0.5) * 0.5);
    float a = m * uParam.x;
    float emb = smoothstep(0.62, 0.8, fbm3(vP * 9.0 + uT * 0.3)) * m;
    o = vec4(uColA * a + uColB * emb * uParam.y + uColC * exp(-pow((r - 0.8 + (n - 0.5) * 0.3) / 0.08, 2.0)) * uParam.y, a);`,
  // hexagonal force floor: x intensity
  HEX: `
    float r = length(vP);
    if (r > 1.0) discard;
    vec4 h = hexGrid(vP * 7.0);
    float e = hexEdge(h.xy);
    float id = hash12(h.zw);
    float lines = smoothstep(0.07, 0.0, e) * (0.5 + 0.5 * sin(uT * 4.0 + id * 30.0));
    float band = smoothstep(0.45, 0.95, r) * smoothstep(1.0, 0.95, r);
    float edge = exp(-pow((r - 0.96) / 0.02, 2.0));
    o.rgb = uColA * (lines * band * 1.2 + edge * 1.8 + band * 0.08) * uParam.x;`,
};

const decalVert = /* glsl */ `
uniform float uRadius;
varying vec2 vP;
void main() {
  vP = position.xz / uRadius;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

function decalFrag(mode) {
  return /* glsl */ `
uniform float uT, uAlpha, uHot;
uniform vec3 uColA, uColB, uColC;
uniform vec4 uParam;
varying vec2 vP;
${commonGLSL}
void main() {
  vec4 o = vec4(0.0);
  ${DECALS[mode]}
  o *= uAlpha;
  if (o.a < 0.002 && o.r + o.g + o.b < 0.004) discard;
  gl_FragColor = o;
}`;
}

// --- columns (open cylinders / cones) -----------------------------------------------------
// q = local metric coordinates (unit geometry * uDim), y = 0..1 up the column, facing =
// |N.V| (1 in the middle of the silhouette, 0 at its edges).
const COLUMNS = {
  // light beam with rising streaks: x top falloff exponent
  BEAM: `
    float soft = pow(facing, 1.8);
    float n = fbm3d(vec3(q.x * 1.6, q.y * 0.3 - uT * uSpeed, q.z * 1.6));
    float vert = smoothstep(0.0, 0.05, y) * pow(max(1.0 - y, 1e-4), max(uParam.x, 1e-3));
    o.rgb = mix(uColB, uColA, soft) * soft * vert * (0.45 + 1.1 * n * n) + vec3(1.0) * pow(facing, 10.0) * vert * uHot;`,
  // roaring fire: flames licking up the column
  FIRE: `
    float n = fbm3d(vec3(q.x * 1.3, q.y * 0.7 - uT * uSpeed, q.z * 1.3));
    float n2 = fbm3d(vec3(q.x * 2.8, q.y * 1.5 - uT * uSpeed * 1.6, q.z * 2.8));
    float f = n * 0.65 + n2 * 0.35;
    float heat = clamp((f - y * 0.75) * 2.4 + 0.15, 0.0, 1.0) * pow(facing, 0.8) * smoothstep(0.0, 0.06, y);
    o.rgb = mix(uColB, uColA, smoothstep(0.2, 0.7, heat)) * heat * 1.25 + vec3(1.0, 0.85, 0.6) * smoothstep(0.75, 1.0, heat) * uHot * 0.5;`,
  // spiralling bands (tornado, teleport column): x top falloff exponent
  SWIRL: `
    float bands = pow(0.5 + 0.5 * sin(vUv.x * TAU * 3.0 + q.y * 2.0 - uT * uSpeed), 5.0);
    float n = fbm3d(q * 1.4 + vec3(0.0, -uT * 1.5, 0.0));
    float soft = pow(facing, 1.1);
    float vert = smoothstep(0.0, 0.08, y) * pow(max(1.0 - y, 1e-4), max(uParam.x, 1e-3));
    o.rgb = mix(uColB, uColA, bands) * (bands * 0.9 + 0.2) * (0.5 + 0.9 * n) * soft * vert + vec3(1.0) * bands * pow(facing, 6.0) * vert * uHot;`,
  // dark necrotic beam with glowing strands: y darkness
  DARK: `
    float soft = pow(facing, 1.4);
    float vert = smoothstep(0.0, 0.05, y) * pow(max(1.0 - y, 1e-4), max(uParam.x, 1e-3));
    float n = fbm3d(vec3(q.x * 1.3, q.y * 0.25 - uT * uSpeed, q.z * 1.3));
    float strands = pow(0.5 + 0.5 * sin(vUv.x * TAU * 5.0 + n * 7.0 + q.y * 0.5 - uT * 2.0), 10.0);
    float a = soft * vert * uParam.y * (0.55 + 0.45 * n);
    o.rgb = uColB * a + uColA * (strands * soft * 0.7 + pow(1.0 - facing, 4.0) * 0.5) * vert;
    o.a = a;`,
  // wall of glowing runes rising out of the ground: x rise (0..1)
  RUNEWALL: `
    float rise = uParam.x;
    float vis = smoothstep(rise + 0.001, rise - 0.04, y);
    vec2 cf = vec2(vUv.x * 30.0, y * 3.0);
    vec2 cell = floor(cf);
    vec2 lq = (fract(cf) - 0.5) * vec2(3.4, 3.0);
    float gd = runeGlyph(lq, cell.x * 7.0 + cell.y * 131.0);
    float glyph = smoothstep(0.14, 0.05, gd) * (0.65 + 0.35 * sin(uT * 4.0 + cell.x * 1.7 + cell.y));
    float base = exp(-y * 2.5);
    float front = exp(-pow((y - rise) / 0.035, 2.0)) * step(0.01, rise);
    float soft = 0.35 + 0.65 * facing;
    o.rgb = (uColA * (glyph * 2.6 + base * 0.6) * soft + uColB * front * 2.2) * vis;`,
  // refractive-looking shimmer fringes (invisibility)
  SHIMMER: `
    float vert = smoothstep(0.0, 0.1, y) * pow(max(1.0 - y, 1e-4), max(uParam.x, 1e-3));
    float n = fbm3d(vec3(q.x * 2.0, q.y * 1.5 - uT * 1.2, q.z * 2.0));
    float fr = sin(q.y * 9.0 + n * 9.0 - uT * 5.0);
    float s = pow(0.5 + 0.5 * fr, 5.0) * smoothstep(0.3, 0.7, n);
    float edge = pow(1.0 - facing, 2.5);
    o.rgb = (uColA * s * pow(facing, 1.5) * 0.9 + uColB * edge * s * 0.5) * vert * smoothstep(0.35, 0.65, n);`,
};

const columnVert = /* glsl */ `
uniform vec3 uDim;
varying vec3 vPos, vN, vW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vPos = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

function columnFrag(mode) {
  return /* glsl */ `
uniform float uT, uAlpha, uHot, uSpeed;
uniform vec3 uColA, uColB, uDim;
uniform vec4 uParam;
varying vec3 vPos, vN, vW;
varying vec2 vUv;
${commonGLSL}
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = abs(dot(normalize(vN), V));
  float y = vUv.y;
  vec3 q = vPos * uDim;
  vec4 o = vec4(0.0);
  ${COLUMNS[mode]}
  o *= uAlpha;
  if (o.a < 0.002 && o.r + o.g + o.b < 0.004) discard;
  gl_FragColor = o;
}`;
}

// --- hexagonal force dome -----------------------------------------------------------------
const domeFrag = /* glsl */ `
uniform float uT, uAlpha;
uniform vec3 uColA, uColB;
uniform vec4 uParam; // x reveal (elevation 0..1), y ripple band, z flash
varying vec3 vPos, vN, vW;
varying vec2 vUv;
${commonGLSL}
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float facing = abs(dot(normalize(vN), V));
  float el = vUv.y;
  vec4 h = hexGrid(vec2(vUv.x * 26.0, el * 7.5));
  float e = hexEdge(h.xy);
  float id = hash12(h.zw);
  float flick = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uT * 3.0 + id * 40.0), 3.0);
  float lines = smoothstep(0.06, 0.0, e);
  float cellGlow = smoothstep(0.25, 0.0, e) * 0.25;
  float pole = 1.0 - smoothstep(0.72, 0.97, el);
  float fres = pow(1.0 - facing, 2.3);
  float rev = smoothstep(uParam.x + 0.001, uParam.x - 0.03, el);
  float front = exp(-pow((el - uParam.x) / 0.035, 2.0)) * step(uParam.x, 0.995);
  float ripple = exp(-pow((el - uParam.y) / 0.05, 2.0));
  float fill = 0.06 + fres * 0.9 + (lines * flick + cellGlow * flick) * pole * (0.55 + ripple * 1.5) + uParam.z * 0.5;
  vec3 rgb = uColA * fill * rev + uColB * (front * 2.5 + ripple * lines * 0.6 * rev);
  rgb *= uAlpha;
  gl_FragColor = vec4(rgb, 0.0);
}`;

// --- ribbons (trails, helixes, rings, lightning) ----------------------------------------
const ribbonVert = /* glsl */ `
uniform float uT, uScale, uWidth, uTail, uLoop, uReveal, uTrail;
attribute vec3 aTan, aP; // aP: width, delay, speed
attribute float aSide, aT;
varying float vAcross, vVis, vT;
void main() {
  float vis;
  if (uTrail > 0.5) {
    float head = (uT - aP.y) * aP.z;
    if (uLoop > 0.0) head = fract(max(head, 0.0));
    head *= 1.0 + uTail;
    float d = head - aT;
    vis = (d >= 0.0 && d <= uTail) ? smoothstep(0.0, 0.03, d) * pow(1.0 - d / uTail, 1.3) : 0.0;
    if (head <= 0.0) vis = 0.0;
  } else {
    vis = smoothstep(aT - 0.03, aT, uReveal);
  }
  vVis = vis;
  vAcross = aSide;
  vT = aT;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 t = normalize(mat3(modelMatrix) * aTan + vec3(1e-6, 2e-6, 0.0));
  vec3 toCam = normalize(cameraPosition - wp.xyz);
  vec3 side = normalize(cross(t, toCam) + vec3(0.0, 1e-5, 0.0));
  float w = uWidth * aP.x * uScale * (uTrail > 0.5 ? mix(0.2, 1.0, vis) : 1.0);
  wp.xyz += side * aSide * w * 0.5;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const ribbonFrag = /* glsl */ `
uniform float uAlpha, uHot, uT;
uniform vec3 uColA, uColB;
varying float vAcross, vVis, vT;
void main() {
  float x = vAcross;
  float prof = exp(-x * x * 3.5);
  float core = exp(-x * x * 28.0);
  vec3 col = mix(uColB, uColA, vVis);
  vec3 rgb = (col * prof + vec3(1.0) * core * uHot) * vVis * uAlpha;
  if (rgb.r + rgb.g + rgb.b < 0.004) discard;
  gl_FragColor = vec4(rgb, 0.0);
}`;

// ---------------------------------------------------------------------------------------
// shared geometries (never disposed)

const GEO = {
  plane: (() => { const g = new THREE.PlaneGeometry(2, 2, 1, 1); g.rotateX(-Math.PI / 2); return g; })(),
  cylinder: (() => { const g = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true); g.translate(0, 0.5, 0); return g; })(),
  // cone with its apex at the origin, opening downward to radius 1 at y = -1
  cone: (() => { const g = new THREE.CylinderGeometry(0.02, 1, 1, 40, 1, true); g.translate(0, -0.5, 0); return g; })(),
  dome: new THREE.SphereGeometry(1, 56, 18, 0, TAU, 0, Math.PI / 2),
};
const QUAD_POS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_IDX = [0, 1, 2, 0, 2, 3];
const BLACK = new THREE.Color(0, 0, 0);
const WHITE = new THREE.Color(1, 1, 1);

const FRAG_CACHE = {};
const cachedFrag = (kind, mode, fn) => (FRAG_CACHE[kind + mode] ||= fn(mode));
const toColor = (c, fallback) => (c == null ? fallback.clone() : c.isColor ? c.clone() : new THREE.Color(c));
const vec3 = (a, d = [0, 0, 0]) => new THREE.Vector3(...(a || d));

// Reusable spawn record handed to particle spawn callbacks.
const P = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, birth: 0, life: 1, size: 0.2, seed: 0, spin: 0, rot: 0, mix: 0, stretch: 0.05 };

/** Writes a polyline's positions and tangents into ribbon attribute arrays. */
function writePath(pos, tan, off, pts) {
  const n = pts.length;
  const closed = pts[0].distanceToSquared(pts[n - 1]) < 1e-8;
  for (let j = 0; j < n; j++) {
    const a = pts[j > 0 ? j - 1 : closed ? n - 2 : 0];
    const b = pts[j < n - 1 ? j + 1 : closed ? 1 : n - 1];
    const p = pts[j];
    for (let s = 0; s < 2; s++) {
      const o = (off + j * 2 + s) * 3;
      pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
      tan[o] = b.x - a.x; tan[o + 1] = b.y - a.y; tan[o + 2] = b.z - a.z;
    }
  }
}

/** Helix from (r0, y0) to (r1, y1) winding `turns` times (negative = clockwise). */
function helixPath(r0, r1, y0, y1, turns, phase = 0, n = 48) {
  const pts = [];
  for (let j = 0; j < n; j++) {
    const s = j / (n - 1), a = phase + s * turns * TAU, r = r0 + (r1 - r0) * s;
    pts.push(new THREE.Vector3(Math.cos(a) * r, y0 + (y1 - y0) * s, Math.sin(a) * r));
  }
  return pts;
}

/** Closed horizontal circle. */
function circlePath(r, y = 0, n = 64) {
  const pts = [];
  for (let j = 0; j <= n; j++) { const a = (j / n) * TAU; pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); }
  pts[n].copy(pts[0]);
  return pts;
}

/** Jagged lightning path from a to b (random walk pinned at both ends) written into `out`. */
function boltPath(a, b, out, jag) {
  const n = out.length;
  let ox = 0, oz = 0;
  for (let j = 0; j < n; j++) {
    ox += R(-1, 1) * jag; oz += R(-1, 1) * jag;
    out[j].set(ox, 0, oz);
  }
  const ex = out[n - 1].x, ez = out[n - 1].z;
  for (let j = 0; j < n; j++) {
    const s = j / (n - 1), o = out[j];
    o.set(a.x + (b.x - a.x) * s + o.x - ex * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s + o.z - ez * s);
  }
}

// ---------------------------------------------------------------------------------------
// Effect: one running spell (a timeline of components under one or more root groups)

class Effect {
  constructor(fx, pos, opts = {}) {
    this.fx = fx;
    this.opts = opts;
    this.s = opts.scale ?? 1;
    this.heightAt = opts.heightAt || fx.heightAt || null;
    this.uT = { value: 0 };
    this.uScale = { value: this.s };
    this.t = 0;
    this.end = 2.5; // promise resolves here
    this.life = 3; // everything is gone by here
    this.roots = [];
    this.anims = [];
    this.events = [];
    this.lights = [];
    this.geos = [];
    this.mats = [];
    this.drapes = []; // draped decals: { mesh, root, lift }
    this.resolved = false;
    this.root = this.addRoot(pos);
  }

  /** Extra anchor group (e.g. the teleport destination). */
  addRoot(pos) {
    const g = new THREE.Group();
    g.position.copy(pos);
    g.scale.setScalar(this.s);
    this.fx.group.add(g);
    this.roots.push(g);
    return g;
  }

  /** Per-frame animation callback fn(t, dt). */
  anim(fn) { this.anims.push(fn); }

  /** One-shot event at time t; `always` events also fire if the effect is cut short. */
  at(time, fn, always = false) { this.events.push({ time, fn, done: false, always }); }

  /** Calls opts.onSpawn at time t (the moment summoned creatures should appear). */
  spawnAt(time) { this.at(time, () => this.opts.onSpawn?.(), true); }

  _mat(mat) { this.mats.push(mat); return mat; }

  /**
   * GPU particle system (instanced quads). cfg.spawn(P, i, n) fills the shared record P
   * for each particle: position x,y,z (polar: radius, angle, height), velocity vx,vy,vz
   * (polar: radial, angular, vertical), birth, life, size, spin, rot, mix, stretch.
   */
  particles(cfg) {
    const n = Math.max(1, Math.round(cfg.count ?? 1));
    const shape = cfg.shape || 'GLOW';
    const align = cfg.align || 'billboard';
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD_POS.slice(), 3));
    geo.setIndex(QUAD_IDX);
    const iPos = new Float32Array(n * 3), iVel = new Float32Array(n * 3);
    const iA = new Float32Array(n * 4), iB = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      P.x = P.y = P.z = P.vx = P.vy = P.vz = 0;
      P.birth = 0; P.life = 1; P.size = 0.2; P.seed = Math.random();
      P.spin = 0; P.rot = 0; P.mix = Math.random(); P.stretch = 0.05;
      cfg.spawn?.(P, i, n);
      iPos[i * 3] = P.x; iPos[i * 3 + 1] = P.y; iPos[i * 3 + 2] = P.z;
      iVel[i * 3] = P.vx; iVel[i * 3 + 1] = P.vy; iVel[i * 3 + 2] = P.vz;
      iA[i * 4] = P.birth; iA[i * 4 + 1] = Math.max(P.life, 0.01); iA[i * 4 + 2] = P.size; iA[i * 4 + 3] = P.seed;
      iB[i * 4] = P.spin; iB[i * 4 + 1] = P.rot; iB[i * 4 + 2] = P.mix; iB[i * 4 + 3] = P.stretch;
    }
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    geo.setAttribute('iVel', new THREE.InstancedBufferAttribute(iVel, 3));
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 4));
    geo.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 4));
    geo.instanceCount = n;
    this.geos.push(geo);

    const defines = {};
    if (cfg.polar) defines.POLAR = '';
    if (align === 'streak') defines.ALIGN_STREAK = '';
    else if (align === 'yaxis') defines.ALIGN_YAXIS = '';
    else if (align === 'ground') defines.ALIGN_GROUND = '';
    const grow = cfg.grow || [1, 0.2, 1];
    const fade = cfg.fade || [0.1, 0.7];
    const colA = toColor(cfg.colA, WHITE);
    const u = {
      uT: cfg.uT || this.uT,
      uScale: this.uScale,
      uAlpha: { value: cfg.alpha ?? 1 },
      uDrag: { value: cfg.drag ?? 0 },
      uSwirl: { value: cfg.swirl ?? 0 },
      uConverge: { value: cfg.converge ?? 0 },
      uWobble: { value: cfg.wobble ?? 0 },
      uLoop: { value: cfg.loop ? 1 : 0 },
      uAnchor: { value: cfg.anchor ? 1 : 0 },
      uAspect: { value: cfg.aspect ?? 1 },
      uColorAge: { value: cfg.colorAge ?? 0 },
      uPull: { value: cfg.pull ?? 0.35 },
      uGravity: { value: vec3(cfg.gravity) },
      uTarget: { value: vec3(cfg.target) },
      uSize: { value: new THREE.Vector3(grow[0], Math.max(grow[1], 0.001), grow[2]) },
      uFade: { value: new THREE.Vector2(Math.max(fade[0], 0.001), Math.min(fade[1], 0.999)) },
      uHot: { value: cfg.hot ?? 0.8 },
      uColA: { value: colA },
      uColB: { value: toColor(cfg.colB, colA) },
      uColC: { value: toColor(cfg.colC, WHITE) },
      uParam: { value: new THREE.Vector4(...(cfg.param || [0, 0, 0, 0])) },
      uAmbient: U.uAmbient,
      uSunColor: U.uSunColor,
    };
    const mat = this._mat(premul(new THREE.ShaderMaterial({
      uniforms: u, defines, vertexShader: particleVert,
      fragmentShader: cachedFrag('p', shape, particleFrag),
    })));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = cfg.order ?? 30;
    (cfg.root || this.root).add(mesh);
    return { mesh, u };
  }

  /** Ground decal of radius r (draped over opts.heightAt unless cfg.air). */
  decal(mode, r, cfg = {}) {
    const root = cfg.root || this.root;
    const colA = toColor(cfg.colA, WHITE);
    const u = {
      uT: this.uT,
      uAlpha: { value: cfg.alpha ?? 1 },
      uHot: { value: cfg.hot ?? 0.5 },
      uColA: { value: colA },
      uColB: { value: toColor(cfg.colB, colA) },
      uColC: { value: toColor(cfg.colC, BLACK) },
      uParam: { value: new THREE.Vector4(...(cfg.param || [0, 0, 0, 0])) },
      uRadius: { value: 1 },
    };
    const mat = this._mat(premul(new THREE.ShaderMaterial({
      uniforms: u, vertexShader: decalVert, fragmentShader: cachedFrag('d', mode, decalFrag),
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    })));
    let mesh;
    const lift = cfg.y ?? 0.03;
    if (this.heightAt && !cfg.air) {
      // drape a grid over the terrain around the root
      const seg = cfg.seg ?? Math.min(40, Math.max(12, Math.round(r * this.s * 5)));
      const g = new THREE.PlaneGeometry(2 * r, 2 * r, seg, seg);
      g.rotateX(-Math.PI / 2);
      this.geos.push(g);
      mesh = new THREE.Mesh(g, mat);
      u.uRadius.value = r;
      const d = { mesh, root, lift };
      this.drapes.push(d);
      this.drape(d);
    } else {
      mesh = new THREE.Mesh(GEO.plane, mat);
      mesh.scale.set(r, 1, r);
      mesh.position.y = lift;
    }
    mesh.renderOrder = cfg.order ?? 10;
    root.add(mesh);
    return { mesh, u };
  }

  /** Re-fits a draped decal to the terrain under its root's current position. */
  drape(d) {
    const pa = d.mesh.geometry.attributes.position, o = d.root.position, s = this.s;
    for (let i = 0; i < pa.count; i++) {
      pa.setY(i, (this.heightAt(o.x + pa.getX(i) * s, o.z + pa.getZ(i) * s) - o.y) / s + d.lift);
    }
    pa.needsUpdate = true;
    d.mesh.geometry.computeBoundingSphere();
  }

  /** Open cylinder (or downward cone with cfg.geo = 'cone') of radius r and height h. */
  column(mode, cfg) {
    const colA = toColor(cfg.colA, WHITE);
    const u = {
      uT: this.uT,
      uAlpha: { value: cfg.alpha ?? 1 },
      uHot: { value: cfg.hot ?? 0.5 },
      uSpeed: { value: cfg.speed ?? 2 },
      uColA: { value: colA },
      uColB: { value: toColor(cfg.colB, colA) },
      uDim: { value: new THREE.Vector3(cfg.r, cfg.h, cfg.r) },
      uParam: { value: new THREE.Vector4(...(cfg.param || [0.8, 0.8, 0, 0])) },
    };
    const mat = this._mat(premul(new THREE.ShaderMaterial({
      uniforms: u, vertexShader: columnVert, fragmentShader: cachedFrag('c', mode, columnFrag), side: THREE.DoubleSide,
    })));
    const mesh = new THREE.Mesh(cfg.geo === 'cone' ? GEO.cone : GEO.cylinder, mat);
    mesh.scale.set(cfg.r, cfg.h, cfg.r);
    mesh.position.y = cfg.y0 ?? 0;
    mesh.renderOrder = cfg.order ?? 20;
    (cfg.root || this.root).add(mesh);
    return { mesh, u };
  }

  /** Hexagonal force-field hemisphere. */
  dome(cfg) {
    const colA = toColor(cfg.colA, WHITE);
    const u = {
      uT: this.uT,
      uAlpha: { value: 0 },
      uColA: { value: colA },
      uColB: { value: toColor(cfg.colB, colA) },
      uDim: { value: new THREE.Vector3(1, 1, 1) },
      uParam: { value: new THREE.Vector4(0, -1, 0, 0) },
    };
    const mat = this._mat(premul(new THREE.ShaderMaterial({ uniforms: u, vertexShader: columnVert, fragmentShader: domeFrag, side: THREE.DoubleSide })));
    const mesh = new THREE.Mesh(GEO.dome, mat);
    mesh.scale.set(cfg.r, cfg.r * (cfg.squash ?? 1), cfg.r);
    mesh.renderOrder = 22;
    (cfg.root || this.root).add(mesh);
    return { mesh, u };
  }

  /**
   * Camera-facing ribbons along polylines: paths = [{ pts, width, delay, speed }].
   * mode 'trail': a comet segment (length cfg.tail) runs along each path; 'full': the
   * whole path, revealed up to uReveal.
   */
  ribbons(paths, cfg = {}) {
    let nv = 0, ni = 0;
    for (const p of paths) { nv += p.pts.length * 2; ni += (p.pts.length - 1) * 6; }
    const pos = new Float32Array(nv * 3), tan = new Float32Array(nv * 3);
    const side = new Float32Array(nv), at = new Float32Array(nv), ap = new Float32Array(nv * 3);
    const idx = [];
    const offsets = [];
    let v = 0;
    for (const p of paths) {
      offsets.push(v);
      const n = p.pts.length;
      for (let j = 0; j < n; j++) {
        for (let s = 0; s < 2; s++) {
          const o = v + j * 2 + s;
          side[o] = s ? 1 : -1;
          at[o] = j / (n - 1);
          ap[o * 3] = p.width ?? 1; ap[o * 3 + 1] = p.delay ?? 0; ap[o * 3 + 2] = p.speed ?? 1;
        }
        if (j < n - 1) { const a = v + j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      writePath(pos, tan, v, p.pts);
      v += n * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTan', new THREE.BufferAttribute(tan, 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aT', new THREE.BufferAttribute(at, 1));
    geo.setAttribute('aP', new THREE.BufferAttribute(ap, 3));
    geo.setIndex(idx);
    this.geos.push(geo);
    const colA = toColor(cfg.colA, WHITE);
    const u = {
      uT: this.uT,
      uScale: this.uScale,
      uWidth: { value: cfg.width ?? 0.1 },
      uTail: { value: cfg.tail ?? 0.3 },
      uLoop: { value: cfg.loop ? 1 : 0 },
      uReveal: { value: cfg.reveal ?? 1.05 },
      uTrail: { value: cfg.mode === 'full' ? 0 : 1 },
      uAlpha: { value: cfg.alpha ?? 1 },
      uHot: { value: cfg.hot ?? 0.5 },
      uColA: { value: colA },
      uColB: { value: toColor(cfg.colB, colA) },
    };
    const mat = this._mat(premul(new THREE.ShaderMaterial({ uniforms: u, vertexShader: ribbonVert, fragmentShader: ribbonFrag, side: THREE.DoubleSide })));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = cfg.order ?? 25;
    (cfg.root || this.root).add(mesh);
    return {
      mesh, u,
      /** Rewrites path i (same point count), e.g. to re-jag a lightning bolt. */
      write(i, pts) {
        writePath(pos, tan, offsets[i], pts);
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aTan.needsUpdate = true;
      },
    };
  }

  /**
   * Requests a point light: intensity rises t0 -> peak, falls peak -> t1 (or cfg.fn(t)
   * returning 0..1). The two strongest requests across all effects get the pooled lights.
   */
  light(cfg) {
    this.lights.push({
      root: cfg.root || this.root, obj: cfg.obj || null,
      off: new THREE.Vector3(cfg.x ?? 0, cfg.y ?? 1.5, cfg.z ?? 0),
      col: new THREE.Color(cfg.col), I: cfg.I ?? 40, dist: cfg.dist ?? 14,
      t0: cfg.t0 ?? 0, peak: cfg.peak ?? 0.5, t1: cfg.t1 ?? 2, flicker: cfg.flicker ?? 0, fn: cfg.fn || null,
      pos: new THREE.Vector3(), i: 0,
    });
  }

  _collectLights(out) {
    const t = this.t;
    for (const L of this.lights) {
      let k = L.fn ? L.fn(t) : t < L.peak ? sstep(L.t0, L.peak, t) : Math.pow(1 - sstep(L.peak, L.t1, t), 2);
      if (L.flicker) k *= 1 - L.flicker * (0.5 + 0.5 * Math.sin(t * 37.0) * Math.sin(t * 23.0 + 1.3));
      if (k <= 0.003) continue;
      L.i = k * L.I * LIGHT_GAIN * this.s;
      if (L.obj) { L.obj.updateWorldMatrix(true, false); L.obj.localToWorld(L.pos.set(0, 0, 0)); L.pos.y += L.off.y * this.s; }
      else L.pos.copy(L.off).multiplyScalar(this.s).add(L.root.position);
      out.push(L);
    }
  }

  step(dt) {
    this.t += dt;
    const t = this.t;
    this.uT.value = t;
    for (const ev of this.events) {
      if (!ev.done && t >= ev.time) {
        ev.done = true;
        try { ev.fn(); } catch (err) { console.error(err); }
      }
    }
    for (const a of this.anims) a(t, dt);
    if (!this.resolved && t >= this.end) { this.resolved = true; this.resolve?.(); }
  }

  dispose() {
    for (const ev of this.events) {
      if (!ev.done && ev.always) { ev.done = true; try { ev.fn(); } catch (err) { console.error(err); } }
    }
    if (!this.resolved) { this.resolved = true; this.resolve?.(); }
    for (const r of this.roots) r.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.roots.length = this.geos.length = this.mats.length = this.anims.length = 0;
  }
}

// ---------------------------------------------------------------------------------------
// composite building blocks (each animates itself)

/** Rune circle drawn in by a sweeping light, rotating, pulsing at `pulse` = [t, k]. */
function runeCircle(e, o) {
  const d = e.decal('RUNES', o.r ?? 2, { root: o.root, colA: o.col, colB: o.col2 ?? o.col, hot: o.hot ?? 0.6, param: [0, 0, o.pattern ?? 0, o.cells ?? 22], alpha: 0 });
  const t0 = o.t0 ?? 0, rv = o.reveal ?? 0.5, t1 = o.t1 ?? 2.5, out = o.out ?? 0.7, spin = o.spin ?? 0.5, a = o.alpha ?? 1;
  e.anim((t) => {
    d.mesh.visible = t >= t0 && t <= t1;
    d.u.uParam.value.x = easeInOut((t - t0) / rv);
    d.u.uParam.value.y = t * spin;
    let al = sstep(t0, t0 + 0.12, t) * (1 - sstep(t1 - out, t1, t));
    if (o.pulse) al *= 1 + o.pulse[1] * Math.exp(-Math.pow((t - o.pulse[0]) / 0.18, 2));
    d.u.uAlpha.value = al * a;
  });
  return d;
}

/** Soft pool of light on the ground. */
function glowPool(e, o) {
  const d = e.decal('GLOW', o.r ?? 2.5, { root: o.root, colA: o.col, colB: o.col2 ?? BLACK, param: [o.falloff ?? 2.5, 0, 0, 0], alpha: 0 });
  const a = (o.alpha ?? 1) * 0.6, t0 = o.t0 ?? 0, pk = o.peak ?? 0.5, t1 = o.t1 ?? 2.5;
  e.anim((t) => {
    const k = t < pk ? sstep(t0, pk, t) : 1 - sstep(pk, t1, t);
    d.mesh.visible = k > 0.001;
    d.u.uAlpha.value = a * k * (o.flicker ? 1 - o.flicker * (0.5 + 0.5 * Math.sin(t * 31) * Math.sin(t * 17)) : 1);
  });
  return d;
}

/** Expanding shock ring (on the ground, or flat in the air at height o.y). */
function shock(e, o) {
  const air = o.y != null;
  const d = e.decal('SHOCK', o.r ?? 3, { root: o.root, colA: o.col, colB: o.col2 ?? o.col, param: [0, o.thick ?? 0.06, o.fill ?? 0.12, 0], air, y: o.y, alpha: 0 });
  const t0 = o.t0 ?? 0, dur = o.dur ?? 0.8, a = o.alpha ?? 1, from = o.from ?? 0.04, to = o.to ?? 0.88;
  e.anim((t) => {
    const k = (t - t0) / dur;
    d.mesh.visible = k >= 0 && k <= 1;
    if (!d.mesh.visible) return;
    d.u.uParam.value.x = from + (to - from) * easeOut(k);
    d.u.uAlpha.value = a * Math.pow(1 - k, 1.3) * sstep(0, 0.06, k);
  });
  return d;
}

/** Glowing cracks spreading across (and darkening) the ground. */
function cracks(e, o) {
  const d = e.decal('CRACKS', o.r ?? 2.5, {
    root: o.root, colA: o.col, colB: o.col2 ?? WHITE, colC: o.dark ?? new THREE.Color(0.02, 0.015, 0.01),
    param: [0, o.glow ?? 1.4, o.darkness ?? 0.55, o.density ?? 4.5], alpha: 0,
  });
  const t0 = o.t0 ?? 0, grow = o.grow ?? 0.5, t1 = o.t1 ?? 2.5, out = o.out ?? 0.8;
  e.anim((t) => {
    d.mesh.visible = t >= t0 && t <= t1;
    d.u.uParam.value.x = 0.05 + 1.1 * easeOut((t - t0) / grow);
    d.u.uAlpha.value = sstep(t0, t0 + 0.1, t) * (1 - sstep(t1 - out, t1, t));
  });
  return d;
}

/** Swirling ground portal that irises open and closed. */
function portal(e, o) {
  const d = e.decal('VORTEX', o.r ?? 1.5, {
    root: o.root, colA: o.colA, colB: o.colB, colC: o.colC ?? BLACK, hot: o.hot ?? 0.8,
    param: [0.001, o.spin ?? 1.3, o.dark ?? 0.9, 0], alpha: 0,
  });
  const t0 = o.t0 ?? 0, op = o.open ?? 0.6, t1 = o.t1 ?? 2.2, cl = o.close ?? 0.6;
  e.anim((t) => {
    const k = easeOut((t - t0) / op) * (1 - easeInOut((t - (t1 - cl)) / cl));
    d.mesh.visible = k > 0.002;
    d.u.uParam.value.x = Math.max(k, 0.002) * 0.8;
    d.u.uAlpha.value = sstep(0, 0.2, k);
  });
  return d;
}

/**
 * Animated column: grows over `rise` from t0 (up from y0, or down from the sky with
 * fromSky), fades out ending at t1; `pinch` narrows it while fading, `swell` bulges it
 * around swellT.
 */
function column(e, mode, o) {
  const c = e.column(mode, { root: o.root, r: o.r, h: o.h, y0: o.y0 ?? 0, colA: o.colA, colB: o.colB ?? o.colA, hot: o.hot ?? 0.5, speed: o.speed ?? 2, param: o.param ?? [0.8, 0.8, 0, 0], geo: o.geo, alpha: 0 });
  const t0 = o.t0 ?? 0, rise = o.rise ?? 0.35, t1 = o.t1 ?? 2.5, out = o.out ?? 0.7, a = o.alpha ?? 1, h = o.h, y0 = o.y0 ?? 0, r = o.r;
  e.anim((t) => {
    const g = easeOut((t - t0) / rise);
    const f = 1 - sstep(t1 - out, t1, t);
    c.mesh.visible = g > 0.001 && f > 0.001;
    if (!c.mesh.visible) return;
    const hh = Math.max(h * g, 0.001);
    c.mesh.scale.y = hh;
    c.mesh.position.y = o.fromSky ? y0 + h - hh : y0;
    let rs = r * (1 - (o.pinch ?? 0) * (1 - f));
    if (o.swell) rs *= 1 + o.swell * Math.exp(-Math.pow((t - o.swellT) / 0.22, 2));
    c.mesh.scale.x = c.mesh.scale.z = rs;
    let al = a * f * sstep(t0, t0 + 0.1, t);
    if (o.flicker) al *= 1 - o.flicker * (0.5 + 0.5 * Math.sin(t * 43) * Math.sin(t * 19));
    c.u.uAlpha.value = al;
  });
  return c;
}

/** A single long-lived sprite particle (flash, sunburst, eye, wings, orb). */
function sprite(e, shape, o) {
  return e.particles({
    count: 1, shape, root: o.root, colA: o.col, colB: o.colB ?? o.col, colC: o.colC, hot: o.hot ?? 1,
    aspect: o.aspect ?? 1, param: o.param, align: o.align, pull: o.pull ?? 0.2, order: o.order,
    grow: o.grow ?? [1, 0.5, 1], fade: o.fade ?? [0.15, 0.7],
    spawn: (p) => {
      p.x = o.x ?? 0; p.y = o.y ?? 1; p.z = o.z ?? 0; p.vy = o.vy ?? 0;
      p.birth = o.t0 ?? 0; p.life = o.dur ?? 1; p.size = o.size ?? 2; p.mix = 0;
      p.rot = o.rot ?? 0; p.spin = o.spin ?? 0; p.seed = 0.3;
    },
  });
}

/** Bright flash with an anamorphic streak. */
function flash(e, o) {
  return sprite(e, 'FLASH', { hot: 0.7, grow: [0.3, 0.12, 1.2], fade: [0.04, 0.2], dur: 0.5, pull: 0.3, ...o, size: (o.size ?? 3) * 0.8 });
}

/** Radial burst of velocity-stretched sparks (o.up: min vertical component, o.flat: horizontal). */
function sparks(e, o) {
  const sp = o.speed ?? [3, 7], life = o.life ?? [0.4, 0.9], size = o.size ?? [0.05, 0.09];
  return e.particles({
    count: o.count ?? 80, shape: o.shape ?? 'SPARK', align: 'streak', root: o.root, colA: o.col, colB: o.col2 ?? o.col,
    colorAge: 1, hot: o.hot ?? 1, aspect: o.aspect ?? 1, drag: o.drag ?? 2.2, gravity: [0, o.gravity ?? -4, 0],
    grow: [1, 0.1, 0.4], fade: [0.02, 0.45],
    spawn: (p) => {
      const th = Math.random() * TAU;
      const vy = o.flat ? R(-0.02, 0.2) : R(o.up ?? -0.3, 1);
      const hz = Math.sqrt(Math.max(0, 1 - vy * vy)), s = R(sp[0], sp[1]), r0 = o.r0 ?? 0.1;
      p.x = Math.cos(th) * r0; p.z = Math.sin(th) * r0; p.y = o.y ?? 0.5;
      p.vx = Math.cos(th) * hz * s; p.vz = Math.sin(th) * hz * s; p.vy = vy * s;
      p.birth = (o.t0 ?? 0) + Math.random() * (o.spread ?? 0.05);
      p.life = R(life[0], life[1]); p.size = R(size[0], size[1]);
      p.stretch = o.stretch ?? 0.06; p.mix = 0;
    },
  });
}

/** Motes rising in slow spirals around the stack. */
function motes(e, o) {
  const vy = o.vy ?? [0.6, 1.4], om = o.omega ?? [0.3, 0.9], life = o.life ?? [1.0, 1.8], size = o.size ?? [0.06, 0.14], vr = o.vr ?? [0, 0];
  return e.particles({
    count: o.count ?? 60, shape: o.shape ?? 'GLOW', polar: true, root: o.root, colA: o.col, colB: o.col2 ?? o.col,
    hot: o.hot ?? 0.8, wobble: o.wobble ?? 0.08, grow: o.grow ?? [0.3, 0.25, 0.2], fade: o.fade ?? [0.15, 0.6],
    gravity: [0, o.g ?? 0, 0], align: o.align, aspect: o.aspect, converge: o.converge, target: o.target,
    spawn: (p) => {
      p.x = R(o.r0 ?? 0.2, o.r1 ?? 1.4); p.y = Math.random() * TAU; p.z = R(o.y0 ?? 0, o.y1 ?? 0.4);
      p.vx = R(vr[0], vr[1]); p.vy = R(om[0], om[1]) * (o.dir ?? (Math.random() < 0.5 ? -1 : 1)); p.vz = R(vy[0], vy[1]);
      p.birth = R(o.t0 ?? 0, o.t1 ?? 1.5); p.life = R(life[0], life[1]); p.size = R(size[0], size[1]);
      if (o.spin) { p.spin = R(-o.spin, o.spin); p.rot = R(-0.4, 0.4); }
    },
  });
}

/** Smoke / dust / mist puffs thrown outward and lifted. */
function smoke(e, o) {
  const sp = o.speed ?? [0.5, 2], vy = o.vy ?? [0.3, 1.2], life = o.life ?? [1.2, 2.2], size = o.size ?? [0.8, 1.4];
  return e.particles({
    count: o.count ?? 30, shape: 'SMOKE', root: o.root, colA: o.col, colB: o.glow ?? BLACK,
    param: [o.opacity ?? 0.6, o.glowAmt ?? 0, 0, 0], drag: o.drag ?? 1.6, gravity: [0, o.lift ?? 0.3, 0],
    swirl: o.swirl ?? 0, grow: o.grow ?? [0.4, 0.3, 1.5], fade: o.fade ?? [0.12, 0.45], pull: 0.3, order: 28,
    spawn: (p) => {
      const th = Math.random() * TAU, rr = R(o.r0 ?? 0, o.r1 ?? 0.8), s = R(sp[0], sp[1]);
      p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(o.y0 ?? 0.1, o.y1 ?? 0.5);
      p.vx = Math.cos(th) * s; p.vz = Math.sin(th) * s; p.vy = R(vy[0], vy[1]);
      p.birth = R(o.t0 ?? 0, o.t1 ?? 0.3); p.life = R(life[0], life[1]); p.size = R(size[0], size[1]);
      p.rot = Math.random() * TAU; p.spin = R(-0.6, 0.6);
    },
  });
}

/** Comet trails winding up a helix around the stack. */
function helixTrails(e, o) {
  const sp = o.speed ?? [1.2, 1.6], paths = [];
  for (let i = 0; i < o.count; i++) {
    paths.push({
      pts: helixPath(o.r0, o.r1, o.y0, o.y1, o.turns, (i / o.count) * TAU + R(0, o.jitter ?? 0.5), o.n ?? 56),
      width: R(0.7, 1.2), delay: (o.t0 ?? 0) + R(0, o.spread ?? 0.6), speed: R(sp[0], sp[1]),
    });
  }
  return e.ribbons(paths, { root: o.root, mode: 'trail', width: o.width ?? 0.08, tail: o.tail ?? 0.35, colA: o.col, colB: o.col2 ?? o.col, hot: o.hot ?? 0.6, loop: o.loop });
}

/** Expanding / rising ring of light (ribbon circle) animated by fn(t) -> [y, radius, alpha]. */
function lightRing(e, o, fn) {
  const rb = e.ribbons([{ pts: circlePath(1, 0, 72) }], { root: o.root, mode: 'full', width: o.width ?? 0.07, colA: o.col, colB: o.col2 ?? o.col, hot: o.hot ?? 0.5, alpha: 0 });
  e.anim((t) => {
    const [y, r, a] = fn(t);
    rb.mesh.visible = a > 0.002;
    rb.mesh.position.y = y;
    rb.mesh.scale.set(r, 1, r);
    rb.u.uAlpha.value = a;
  });
  return rb;
}

/** Five-line musical staff winding up around the stack. */
function staff(e, o) {
  const paths = [];
  for (let l = 0; l < 5; l++) paths.push({ pts: helixPath(o.r, o.r, o.y0 + l * 0.085, o.y1 + l * 0.085, o.turns, o.phase ?? 0, 110) });
  const rb = e.ribbons(paths, { mode: 'full', width: o.width ?? 0.035, colA: o.col, colB: o.col2 ?? o.col, hot: 0.3, reveal: 0 });
  const t0 = o.t0 ?? 0.1, t1 = o.t1 ?? 2.8;
  e.anim((t) => {
    rb.u.uReveal.value = easeInOut((t - t0) / 1.0) * 1.05;
    rb.mesh.rotation.y = -t * (o.spin ?? 0.9);
    rb.u.uAlpha.value = 1 - sstep(t1 - 0.7, t1, t);
  });
  return rb;
}

/** Music notes riding up and around the staff. */
function notes(e, o) {
  return e.particles({
    count: o.count ?? 30, shape: o.shape ?? 'NOTE', polar: true, colA: o.col, colB: o.col2 ?? o.col, hot: 0.6,
    wobble: 0.06, grow: [0.3, 0.15, 0.8], fade: [0.1, 0.7],
    spawn: (p) => {
      p.x = (o.r ?? 1.4) + R(-0.15, 0.15); p.y = Math.random() * TAU; p.z = R(0.1, 1.0);
      p.vy = -(o.spin ?? 0.9) * R(1.2, 1.8); p.vz = R(0.4, 0.9); p.vx = R(0.0, 0.25);
      p.birth = R(o.t0 ?? 0.2, o.t1 ?? 1.8); p.life = R(1.1, 1.6); p.size = R(0.36, 0.5);
      p.rot = R(-0.3, 0.3); p.spin = R(-0.5, 0.5);
    },
  });
}

/** Hellish / icy / arcane summoning flames licking around a ring. */
function flameRing(e, o) {
  const life = o.life ?? [0.55, 0.9], size = o.size ?? [0.7, 1.2];
  return e.particles({
    count: o.count ?? 40, shape: 'FLAME', align: 'yaxis', anchor: true, aspect: 0.55, root: o.root,
    colA: o.col, colB: o.col2, hot: o.hot ?? 1, fade: [0.15, 0.55], grow: [0.4, 0.3, 0.6],
    spawn: (p) => {
      const th = Math.random() * TAU, rr = R(o.r0 ?? 1.1, o.r1 ?? 1.5);
      p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = -0.08;
      p.vy = R(0.2, 0.7); p.birth = R(o.t0 ?? 0.2, o.t1 ?? 2.0); p.life = R(life[0], life[1]); p.size = R(size[0], size[1]);
    },
  });
}

/** Embers / sparkles floating up (cartesian, with wobble). */
function embers(e, o) {
  const vy = o.vy ?? [1.5, 3.5], life = o.life ?? [0.8, 1.6], size = o.size ?? [0.05, 0.1];
  return e.particles({
    count: o.count ?? 100, shape: o.shape ?? 'EMBER', root: o.root, colA: o.col, colB: o.col2 ?? o.col, hot: o.hot ?? 1,
    wobble: o.wobble ?? 0.3, drag: 0.4, colorAge: o.colorAge ?? 0, grow: [0.6, 0.2, 0.3], fade: [0.08, 0.6],
    spawn: (p) => {
      const th = Math.random() * TAU, rr = Math.sqrt(Math.random()) * (o.r ?? 1.5);
      p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(o.y0 ?? 0, o.y1 ?? 0.4);
      p.vx = R(-0.3, 0.3); p.vz = R(-0.3, 0.3); p.vy = R(vy[0], vy[1]);
      p.birth = R(o.t0 ?? 0, o.t1 ?? 1.5); p.life = R(life[0], life[1]); p.size = R(size[0], size[1]); p.mix = Math.random() * (o.colorAge ? 0.3 : 1);
    },
  });
}

/** Rock chunks thrown up ballistically (lit by the scene). */
function rocks(e, o) {
  const vy = o.vy ?? [3, 6], hs = o.hs ?? [0.8, 2.5], size = o.size ?? [0.12, 0.28], life = o.life ?? [1.0, 1.4];
  return e.particles({
    count: o.count ?? 30, shape: 'ROCK', root: o.root, colA: o.col, colB: o.glow ?? BLACK, param: [o.glowAmt ?? 0, 0, 0, 0],
    gravity: [0, o.gravity ?? -13, 0], fade: [0.02, 0.85], grow: [1, 0.1, 0.9], pull: 0.2,
    spawn: (p, i, n) => {
      const th = o.ring ? (i / n) * TAU + R(-0.1, 0.1) : Math.random() * TAU;
      const rr = o.ring ? o.ring + R(-0.1, 0.1) : R(0, o.r ?? 0.4), s = R(hs[0], hs[1]);
      p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = o.y ?? 0.05;
      p.vx = Math.cos(th) * s; p.vz = Math.sin(th) * s; p.vy = R(vy[0], vy[1]);
      p.birth = (o.t0 ?? 0) + Math.random() * (o.spread ?? 0.08); p.life = R(life[0], life[1]); p.size = R(size[0], size[1]);
      p.rot = Math.random() * TAU; p.spin = R(-8, 8);
    },
  });
}

// ---------------------------------------------------------------------------------------
// spell recipes: BUILD[id](effect, opts). Distances are in world units at scale 1 (a
// tile is 2 units, a figure ~0.9 tall); times in seconds.

const BUILD = {};
const C = (r, g, b) => new THREE.Color(r, g, b);

// --- Wizard -----------------------------------------------------------------------------

// Red-gold power surge: embers drawn in, a burst, then veins of light flex over the stack.
BUILD.strength = (e) => {
  e.end = 2.4; e.life = 3.0;
  const TP = 0.75;
  const red = hc('#ff3010', 3.2), gold = hc('#ffb030', 3.0), ember = hc('#ff6a20', 2.5);
  runeCircle(e, { r: 2.0, col: gold, col2: red, pattern: 3, reveal: 0.55, t1: 2.8, spin: 0.7, pulse: [TP, 1.2] });
  glowPool(e, { r: 2.8, col: hc('#ff4a14', 0.7), col2: hc('#ffb040', 0.3), peak: TP, t1: 2.8 });
  e.particles({
    count: 90, shape: 'EMBER', polar: true, converge: 1, target: [0, 0.9, 0], colA: gold, colB: red, hot: 1.2,
    grow: [1, 0.5, 0.5], fade: [0.2, 0.85],
    spawn: (p) => { p.x = R(2.2, 3.6); p.y = R(0, TAU); p.z = R(0, 1.8); p.vy = R(1.5, 3); p.birth = R(0, 0.35); p.life = TP + 0.02 - p.birth; p.size = R(0.1, 0.18); },
  });
  flash(e, { t0: TP, size: 3.0, y: 0.8, col: hc('#ff7a30', 2.0) });
  shock(e, { t0: TP, r: 3.6, col: gold, col2: red, dur: 0.8, thick: 0.06 });
  sparks(e, { t0: TP, count: 120, y: 0.4, speed: [4, 9], up: 0.35, col: gold, col2: red, gravity: -6, life: [0.4, 0.9] });
  // muscles of light: bulging veins pulsing up over the stack in two waves
  const paths = [];
  for (let set = 0; set < 2; set++) {
    for (let i = 0; i < 11; i++) {
      const th = (i / 11) * TAU + set * 0.3, sgn = i % 2 ? 1 : -1, pts = [];
      for (let j = 0; j < 30; j++) {
        const s = j / 29, bul = Math.sin(Math.PI * s);
        const a = th + sgn * 0.6 * bul * bul + s * 0.3, r = 0.45 + 0.8 * bul * (1 - 0.3 * s);
        pts.push(new THREE.Vector3(Math.cos(a) * r, s * 2.0, Math.sin(a) * r));
      }
      paths.push({ pts, width: R(0.8, 1.2), delay: TP - 0.05 + set * 0.5 + R(0, 0.2), speed: R(0.75, 0.95) });
    }
  }
  e.ribbons(paths, { mode: 'trail', width: 0.17, tail: 0.5, colA: hc('#ffc040', 3.4), colB: red, hot: 0.6 });
  motes(e, { count: 70, shape: 'EMBER', col: gold, col2: ember, r0: 0.3, r1: 1.3, t0: TP, t1: 2.0, vy: [1.2, 2.4], omega: [0.5, 1.5], size: [0.08, 0.14], life: [0.8, 1.4] });
  // power rising off the figures
  e.particles({
    count: 90, shape: 'SPARK', align: 'streak', colA: hc('#ffc040', 3), colB: red, colorAge: 1, hot: 0.8, fade: [0.1, 0.6],
    spawn: (p) => { const th = R(0, TAU), rr = Math.sqrt(Math.random()) * 0.9; p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(0, 0.6); p.vy = R(2.5, 4.5); p.birth = R(TP, 2.0); p.life = R(0.35, 0.6); p.size = R(0.06, 0.1); p.stretch = 0.1; p.mix = 0; },
  });
  sprite(e, 'GLOW', { t0: TP - 0.1, dur: 1.6, size: 2.6, y: 0.6, col: hc('#ff4010', 0.7), hot: 0.1, grow: [0.5, 0.2, 1], fade: [0.1, 0.5] });
  e.light({ col: '#ff6a30', y: 1.5, t0: 0.2, peak: TP, t1: 2.2, I: 60 });
};

// Cyan-green speed lines corkscrewing up in a tornado, streaks whipping round the stack.
BUILD.haste = (e) => {
  e.end = 2.0; e.life = 2.5;
  const cyan = hc('#30ffd0', 2.6), green = hc('#60ff70', 2.2), pale = hc('#c8fff0', 2.6);
  const sw = e.decal('SWIRL', 2.4, { colA: cyan, colB: green });
  e.anim((t) => { sw.u.uParam.value.x = env(t, 0, 0.3, 1.4, 2.2) * 0.35; });
  glowPool(e, { r: 2.4, col: hc('#20ffc0', 0.5), peak: 0.4, t1: 2.2 });
  helixTrails(e, { count: 14, r0: 1.5, r1: 0.65, y0: 0.05, y1: 2.6, turns: 1.3, t0: 0, spread: 1.0, speed: [1.2, 1.6], width: 0.13, tail: 0.45, col: hc('#d8fff4', 3.2), col2: cyan, hot: 0.4 });
  helixTrails(e, { count: 8, r0: 1.1, r1: 1.4, y0: 0.3, y1: 1.6, turns: -0.9, t0: 0.3, spread: 0.8, speed: [1.6, 2.0], width: 0.09, tail: 0.5, col: green, col2: cyan });
  e.particles({
    count: 110, shape: 'SPARK', align: 'streak', polar: true, colA: pale, colB: cyan, hot: 0.8, fade: [0.15, 0.6],
    spawn: (p) => { p.x = R(0.9, 1.7); p.y = R(0, TAU); p.z = R(0.1, 1.9); p.vy = R(6, 9); p.vz = R(0.2, 0.8); p.vx = R(-0.2, 0.1); p.birth = R(0, 1.3); p.life = R(0.35, 0.6); p.size = R(0.07, 0.11); p.stretch = 0.12; },
  });
  shock(e, { t0: 0.05, r: 3.2, col: cyan, col2: pale, dur: 0.6, thick: 0.05 });
  shock(e, { t0: 0.7, r: 2.6, col: green, dur: 0.6, thick: 0.05 });
  smoke(e, { count: 22, col: C(0.55, 0.5, 0.4), opacity: 0.3, r0: 0.6, r1: 1.4, speed: [0.3, 0.9], vy: [0.05, 0.3], swirl: 3, t0: 0, t1: 0.5, life: [0.9, 1.4], size: [0.6, 1.0], lift: 0.1 });
  motes(e, { count: 40, col: green, col2: pale, r0: 0.3, r1: 1.4, t0: 0.2, t1: 1.4, vy: [1.5, 2.5], omega: [2, 3.5], size: [0.05, 0.1], life: [0.6, 1.0] });
  e.light({ col: '#40ffd0', y: 1.2, t0: 0, peak: 0.4, t1: 1.8, I: 25 });
};

// White-blue updraft: a column of rising wind, feathers spiralling up, wings of light.
BUILD.flight = (e) => {
  e.end = 2.6; e.life = 3.2;
  const white = hc('#eef6ff', 2.4), blue = hc('#6ab0ff', 2.4), sky = hc('#a8d8ff', 1.8);
  column(e, 'BEAM', { r: 1.2, h: 5.5, colA: sky, colB: blue, t0: 0.1, rise: 0.5, t1: 2.8, out: 1.0, alpha: 0.35, speed: 5, param: [1.2], hot: 0.2 });
  const w = sprite(e, 'WING', { t0: 0.35, dur: 2.2, size: 3.3, aspect: 1.6, y: 1.5, vy: 0.3, col: hc('#cfe6ff', 1.25), colB: blue, hot: 0.25, grow: [0.3, 0.25, 1.05], fade: [0.12, 0.6], pull: 0.3, param: [0, 0, 0, 0] });
  e.anim((t) => { w.u.uParam.value.x = Math.sin((t - 0.35) * 5.5) * 0.9; });
  e.particles({
    count: 45, shape: 'FEATHER', polar: true, colA: white, colB: sky, hot: 0.4, wobble: 0.25, grow: [0.6, 0.2, 0.8], fade: [0.15, 0.65],
    spawn: (p) => { p.x = R(0.3, 1.5); p.y = R(0, TAU); p.z = R(0, 0.8); p.vx = R(0.05, 0.3); p.vy = R(0.8, 1.6); p.vz = R(0.8, 1.6); p.birth = R(0.1, 1.4); p.life = R(1.2, 1.8); p.size = R(0.3, 0.45); p.rot = R(0, TAU); p.spin = R(-2.5, 2.5); },
  });
  e.particles({
    count: 80, shape: 'SPARK', align: 'streak', colA: white, colB: sky, hot: 0.6, fade: [0.1, 0.6],
    spawn: (p) => { const th = R(0, TAU), rr = Math.sqrt(Math.random()) * 1.3; p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(0, 0.8); p.vy = R(6, 10); p.birth = R(0.1, 1.8); p.life = R(0.3, 0.55); p.size = R(0.03, 0.05); p.stretch = 0.08; },
  });
  shock(e, { t0: 0.3, r: 3.0, col: sky, col2: white, dur: 0.7, thick: 0.05 });
  glowPool(e, { r: 2.2, col: hc('#80c0ff', 0.6), peak: 0.5, t1: 2.8 });
  e.light({ col: '#a0d0ff', y: 1.8, t0: 0.1, peak: 0.6, t1: 2.6, I: 30 });
};

// A hexagonal force dome knits itself together from the ground up, then fades.
BUILD.wallofforce = (e) => {
  e.end = 2.8; e.life = 3.4;
  const blue = hc('#3a8cff', 2.2), ice = hc('#c8e4ff', 3), deep = hc('#1a50ff', 1.3);
  const R0 = 1.9, TC = 1.3;
  const hex = e.decal('HEX', R0 * 1.03, { colA: blue });
  e.anim((t) => { hex.u.uParam.value.x = env(t, 0.1, 0.5, 2.4, 3.2); });
  runeCircle(e, { r: R0 + 0.45, col: blue, col2: deep, pattern: 0, reveal: 0.4, t1: 3.2, spin: 0.3, alpha: 0.8 });
  const d = e.dome({ r: R0, squash: 0.85, colA: blue, colB: ice });
  e.anim((t) => {
    const u = d.u.uParam.value;
    u.x = easeInOut((t - 0.25) / (TC - 0.25));
    u.y = t > TC ? ((t - TC) * 0.9) % 1.3 : -1;
    u.z = Math.exp(-Math.pow((t - TC) / 0.12, 2));
    d.u.uAlpha.value = env(t, 0.2, 0.35, 2.3, 3.2) * (1 + 0.8 * u.z);
  });
  e.particles({
    count: 170, shape: 'STAR', colA: ice, colB: blue, hot: 1, drag: 1.5, gravity: [0, -0.5, 0], grow: [1, 0.2, 0.3], fade: [0.05, 0.5],
    spawn: (p) => {
      const b = R(0.25, TC), el = easeInOut((b - 0.25) / (TC - 0.25)) * Math.PI / 2, th = R(0, TAU);
      const cr = Math.cos(el) * R0;
      p.x = Math.cos(th) * cr; p.z = Math.sin(th) * cr; p.y = Math.sin(el) * R0 * 0.85;
      p.vx = Math.cos(th) * R(0.2, 1); p.vz = Math.sin(th) * R(0.2, 1); p.vy = R(-0.2, 0.5);
      p.birth = b; p.life = R(0.4, 0.8); p.size = R(0.12, 0.22);
    },
  });
  flash(e, { t0: TC, y: R0 * 0.85, size: 3.5, col: ice });
  shock(e, { t0: TC, r: 3.6, col: blue, col2: ice, dur: 0.7, thick: 0.05 });
  e.light({ col: '#5aa0ff', y: 2, t0: 0.2, peak: TC, t1: 2.8, I: 40 });
};

// A golden pillar of light descends from the sky, sunburst and radiant rings.
BUILD.heroism = (e) => {
  e.end = 4.0; e.life = 4.8;
  const gold = hc('#ffc830', 3), white = hc('#fff4d0', 3.2), warm = hc('#ff9a20', 1.5);
  column(e, 'BEAM', { r: 0.9, h: 16, colA: hc('#ffd878', 1.7), colB: hc('#ff9a20', 1.2), t0: 0.1, rise: 0.45, fromSky: true, t1: 3.9, out: 1.8, speed: -3, param: [0.35], hot: 0.35, pinch: 0.6, swell: 0.35, swellT: 0.6 });
  column(e, 'BEAM', { r: 2.1, h: 16, colA: gold, colB: warm, t0: 0.2, rise: 0.5, fromSky: true, t1: 3.7, out: 1.6, alpha: 0.2, speed: -2, param: [0.3], hot: 0 });
  sprite(e, 'SUNBURST', { t0: 0.45, dur: 3.3, size: 6.5, y: 1.0, col: hc('#ffc040', 1.8), hot: 0.4, grow: [0.2, 0.15, 1.1], fade: [0.08, 0.55], pull: 0.15 });
  flash(e, { t0: 0.52, size: 4.5, y: 0.9, col: hc('#ffe0a0', 2.2), dur: 0.6 });
  runeCircle(e, { r: 2.4, col: hc('#ffc030', 2.4), col2: warm, pattern: 0, reveal: 0.5, t0: 0.05, t1: 4.2, spin: 0.4, pulse: [0.55, 0.6] });
  glowPool(e, { r: 3.5, col: hc('#ffb030', 1.0), col2: hc('#fff0c0', 0.4), peak: 0.6, t1: 4.2 });
  shock(e, { t0: 0.55, r: 5.5, col: gold, col2: white, dur: 1.0, thick: 0.05 });
  shock(e, { t0: 0.8, r: 3.5, col: gold, dur: 0.9, thick: 0.06 });
  e.particles({
    count: 140, shape: 'GLOW', colA: white, colB: gold, hot: 0.8, wobble: 0.15, fade: [0.1, 0.7], grow: [1, 0.2, 0.5],
    spawn: (p) => { const th = R(0, TAU), rr = Math.sqrt(Math.random()) * 1.1; p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(3, 12); p.vy = R(-4.5, -2.5); p.birth = R(0.3, 2.6); p.life = R(0.9, 1.6); p.size = R(0.07, 0.14); },
  });
  motes(e, { count: 90, shape: 'STAR', col: white, col2: gold, r0: 0.3, r1: 1.8, t0: 0.6, t1: 2.8, vy: [0.8, 2.0], life: [1.0, 1.8], size: [0.16, 0.3] });
  e.light({ col: '#ffc860', y: 3, t0: 0.1, peak: 0.6, t1: 3.8, I: 90, dist: 18 });
};

// Violet mist and shimmering fringes swallow the stack; glitter drifts off; it implodes.
BUILD.invisibility = (e) => {
  e.end = 2.6; e.life = 3.2;
  const violet = hc('#a060ff', 2.2), pale = hc('#e4d0ff', 2.4);
  smoke(e, { count: 40, col: C(0.5, 0.4, 0.72), glow: violet, glowAmt: 0.5, opacity: 0.32, r0: 0.4, r1: 1.6, speed: [0.3, 1.0], vy: [0.1, 0.5], swirl: 1.2, y0: 0.1, y1: 0.8, t0: 0, t1: 1.2, life: [1.4, 2.0], size: [1.0, 1.6] });
  column(e, 'SHIMMER', { r: 1.1, h: 2.6, colA: pale, colB: violet, t0: 0.2, rise: 0.6, t1: 2.4, out: 0.8, speed: 1, param: [0.6], pinch: 0.8 });
  const rp = e.decal('RIPPLE', 2.4, { colA: violet, param: [0.6, 0, 0, 0] });
  e.anim((t) => { rp.u.uParam.value.y = env(t, 0, 0.4, 1.6, 2.4); });
  motes(e, { count: 160, shape: 'STAR', col: pale, col2: violet, r0: 0.2, r1: 1.3, y0: 0, y1: 1.6, t0: 0.3, t1: 1.8, vy: [0.3, 1.2], omega: [1.5, 3], life: [0.7, 1.3], size: [0.1, 0.2] });
  shock(e, { t0: 1.4, r: 2.6, from: 0.88, to: 0.05, col: pale, col2: violet, dur: 0.6, thick: 0.05 });
  flash(e, { t0: 1.95, size: 2.2, y: 0.9, col: violet, dur: 0.5 });
  e.light({ col: '#a070ff', y: 1.2, t0: 0.1, peak: 0.8, t1: 2.4, I: 20 });
};

// Spectral horses: bounding teal wisps gallop round the stack leaving glowing hoofprints.
BUILD.phantomsteed = (e) => {
  e.end = 2.6; e.life = 3.3;
  const teal = hc('#70ffe0', 2.4), pale = hc('#d8fff8', 2.6), deep = hc('#20a0a0', 1.2);
  runeCircle(e, { r: 2.3, col: teal, col2: deep, pattern: 4, reveal: 0.5, t1: 3.1, spin: -0.8, alpha: 0.45 });
  const R1 = 1.75, turns = 1.4, strides = 7, speed = 0.5, tail = 0.18, paths = [];
  for (let i = 0; i < 4; i++) {
    const ph = (i / 4) * TAU, pts = [];
    for (let j = 0; j <= 90; j++) {
      const s = j / 90, a = ph + s * turns * TAU;
      const rise = sstep(0.82, 1, s);
      const rr = (R1 + 0.12 * Math.sin(a * 3)) * (1 - 0.7 * rise);
      const y = 0.25 + Math.abs(Math.sin(s * strides * Math.PI)) * 0.5 * (1 - rise) + rise * 1.3;
      pts.push(new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr));
    }
    paths.push({ pts, width: 1, delay: 0.15 + i * 0.12, speed });
  }
  e.ribbons(paths, { mode: 'trail', width: 0.5, tail, colA: hc('#e0fffa', 3.6), colB: hc('#40ffd8', 3), hot: 0.8 });
  e.ribbons(paths.map((p) => ({ ...p, pts: p.pts.map((v) => v.clone().setY(v.y + 0.22)), delay: p.delay + 0.03 })), { mode: 'trail', width: 0.16, tail: 0.12, colA: pale, colB: teal, hot: 0.4 });
  // hoofprints appear as each wisp touches down
  const perWisp = strides;
  e.particles({
    count: 4 * perWisp * 2, shape: 'HOOF', align: 'ground', colA: hc('#70ffe0', 3.5), colB: pale, hot: 0.5, fade: [0.05, 0.3], grow: [0.6, 0.1, 1],
    spawn: (p, i) => {
      const w = i % 4, k = Math.floor(i / 4), stride = k >> 1, side = k & 1 ? 1 : -1;
      const s = (stride + 1) / strides * 0.82;
      const a = (w / 4) * TAU + s * turns * TAU;
      const rr = R1 + 0.12 * Math.sin(a * 3) + side * 0.12;
      p.x = Math.cos(a) * rr; p.z = Math.sin(a) * rr; p.y = 0.03;
      p.birth = 0.15 + w * 0.12 + s / (speed * (1 + tail)) + (side > 0 ? 0.05 : 0);
      p.life = 1.0; p.size = 0.34; p.rot = -a;
    },
  });
  smoke(e, { count: 26, col: C(0.55, 0.75, 0.72), glow: teal, glowAmt: 0.4, opacity: 0.25, r0: 1.2, r1: 2.0, speed: [0.1, 0.4], vy: [0.1, 0.3], swirl: 1.5, t0: 0.2, t1: 1.6, life: [1.0, 1.6], size: [0.8, 1.2] });
  motes(e, { count: 60, col: teal, col2: pale, r0: 0.3, r1: 1.8, t0: 0.3, t1: 2.2, vy: [0.6, 1.2] });
  const TE = 0.15 + 0.36 + 1 / (speed * (1 + tail)) - 0.1;
  flash(e, { t0: TE, size: 3, y: 1.4, col: pale });
  shock(e, { t0: TE, r: 2.8, col: teal, col2: pale, dur: 0.6 });
  e.light({ col: '#70ffe0', y: 1.2, t0: 0.2, peak: TE, t1: TE + 0.8, I: 30 });
};

// --- Necromancer / Vampire ----------------------------------------------------------------

// Black-purple smoke erupts; screaming skulls and wailing wisps rise out of it.
BUILD.terror = (e) => {
  e.end = 2.8; e.life = 3.5;
  const purple = hc('#9a30ff', 2.5), magenta = hc('#ff40d0', 2.0), eye = hc('#e080ff', 4);
  const sc = e.decal('SCORCH', 2.8, { colA: C(0.02, 0.0, 0.04), colB: hc('#7020ff', 0.6), colC: purple });
  e.anim((t) => { const k = env(t, 0, 0.4, 2.2, 3.3); sc.u.uParam.value.x = 0.7 * k; sc.u.uParam.value.y = 0.6 * k; });
  smoke(e, { count: 70, col: C(0.018, 0.008, 0.03), glow: purple, glowAmt: 0.6, opacity: 0.85, r0: 0, r1: 1.0, speed: [0.5, 2.0], vy: [1.2, 3.0], drag: 1.2, lift: 0.5, t0: 0.1, t1: 0.8, life: [1.3, 2.2], size: [0.9, 1.5], grow: [0.3, 0.3, 1.8] });
  e.particles({
    count: 8, shape: 'SKULL', colA: C(0.05, 0.015, 0.08), colB: purple, colC: eye, param: [1, 0, 0, 0], wobble: 0.3, fade: [0.15, 0.6], grow: [0.4, 0.3, 1.2], pull: 0.5, order: 32,
    spawn: (p, i) => {
      const th = (i / 8) * TAU + R(-0.3, 0.3), rr = R(0.3, 1.2), s = R(0.1, 0.4);
      p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(0.6, 1.2);
      p.vx = Math.cos(th) * s; p.vz = Math.sin(th) * s; p.vy = R(0.7, 1.3);
      p.birth = 0.25 + i * 0.1 + R(0, 0.1); p.life = R(1.3, 1.8); p.size = R(0.75, 1.05);
    },
  });
  helixTrails(e, { count: 7, r0: 0.4, r1: 1.8, y0: 0.2, y1: 3.8, turns: 1.1, t0: 0.2, spread: 0.8, speed: [0.8, 1.1], width: 0.12, tail: 0.45, col: magenta, col2: purple, hot: 0.5 });
  flash(e, { t0: 0.3, size: 3, y: 0.8, col: purple, hot: 0.6 });
  shock(e, { t0: 0.3, r: 3.2, col: purple, col2: magenta, dur: 0.8 });
  e.light({ col: '#8a30ff', y: 1.5, t0: 0.1, peak: 0.4, t1: 2.5, I: 35, flicker: 0.3 });
};

// A red-black seed of chaos gathers a vortex into itself, then bursts.
BUILD.chaosseed = (e) => {
  e.end = 2.8; e.life = 3.6;
  const red = hc('#ff2010', 3), orange = hc('#ff7a20', 3), hot = hc('#ffd0a0', 3);
  const SY = 1.3, TB = 1.65;
  portal(e, { r: 2.4, colA: red, colB: hc('#400000', 1), colC: C(0.02, 0, 0), t0: 0, open: 0.7, t1: TB + 0.3, close: 0.4, spin: 2.5, dark: 0.7 });
  sprite(e, 'ORB', { t0: 0.15, dur: TB - 0.1, size: 1.6, y: SY, col: orange, colB: red, grow: [0.1, 0.9, 1.3], fade: [0.1, 0.97], pull: 0.2 });
  e.particles({
    count: 220, shape: 'SPARK', align: 'streak', polar: true, converge: 1, target: [0, SY, 0], colA: orange, colB: red, hot: 0.8, fade: [0.1, 0.9], grow: [1, 0.5, 0.6],
    spawn: (p) => { p.x = R(1.6, 3.6); p.y = R(0, TAU); p.z = R(0, 2.6); p.vy = R(3, 5); p.life = R(0.5, 0.9); p.birth = R(0, TB - p.life); p.size = R(0.04, 0.07); p.stretch = 0.05; },
  });
  e.particles({
    count: 36, shape: 'SMOKE', polar: true, converge: 1, target: [0, SY, 0], colA: C(0.02, 0.004, 0.004), colB: red, param: [0.5, 0.0, 0, 0], grow: [1, 0.5, 0.3], fade: [0.3, 0.8], pull: 0.3,
    spawn: (p) => { p.x = R(1.5, 3); p.y = R(0, TAU); p.z = R(0, 2.2); p.vy = R(2, 3.5); p.life = R(0.7, 1.1); p.birth = R(0, TB - p.life); p.size = R(0.3, 0.5); p.rot = R(0, TAU); },
  });
  flash(e, { t0: TB, size: 6, y: SY, col: orange, hot: 1.5, dur: 0.7 });
  shock(e, { t0: TB, r: 5, col: red, col2: orange, dur: 0.9, thick: 0.06, fill: 0.2 });
  shock(e, { t0: TB, r: 3.2, y: SY, col: orange, dur: 0.5, thick: 0.08 });
  sparks(e, { t0: TB, count: 180, y: SY, speed: [5, 11], up: -0.6, col: hot, col2: red, gravity: -9, life: [0.5, 1.1], size: [0.05, 0.1] });
  smoke(e, { t0: TB, t1: TB + 0.1, count: 40, col: C(0.02, 0.004, 0.004), glow: red, glowAmt: 0.35, opacity: 0.8, r0: 0, r1: 0.3, y0: SY - 0.3, y1: SY + 0.3, speed: [2, 4.5], vy: [-0.5, 1.5], drag: 2.5, life: [1.0, 1.8], size: [0.8, 1.4] });
  cracks(e, { r: 3.2, col: red, col2: orange, t0: TB, grow: 0.35, t1: 3.5, out: 1.2, glow: 2 });
  e.light({ col: '#ff3010', y: SY, t0: 0.2, peak: TB, t1: TB + 1.2, I: 70 });
};

// Green necrotic pentagram; skeletal hands claw up out of the earth.
BUILD.reanimate = (e) => {
  e.end = 2.4; e.life = 3.2;
  const TS = 1.5;
  const green = hc('#40ff50', 2.6), sick = hc('#b0ff40', 2.2), deep = hc('#0a8020', 1.2);
  runeCircle(e, { r: 2.2, col: green, col2: deep, pattern: 1, reveal: 0.7, t1: 3.0, spin: -0.5, pulse: [TS, 1.2] });
  glowPool(e, { r: 2.8, col: hc('#20ff40', 0.7), col2: hc('#b0ff40', 0.4), peak: TS, t1: 3.0 });
  e.particles({
    count: 9, shape: 'HAND', align: 'yaxis', anchor: true, aspect: 0.7, colA: green, param: [1, 0, 0, 0], drag: 2.2, fade: [0.1, 0.82], grow: [1, 0.1, 1],
    spawn: (p, i) => {
      const th = (i / 9) * TAU + R(-0.3, 0.3), rr = R(1.1, 1.9);
      p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = -1.35;
      p.vy = R(2.0, 2.3); p.birth = 0.4 + R(0, 0.7); p.life = 2.9 - p.birth; p.size = R(1.35, 1.6);
    },
  });
  motes(e, { count: 120, col: green, col2: sick, r0: 0.2, r1: 2.0, t0: 0.2, t1: 2.2, vy: [0.6, 1.6], size: [0.06, 0.12] });
  smoke(e, { count: 30, col: C(0.04, 0.1, 0.04), glow: green, glowAmt: 0.5, opacity: 0.5, r0: 0.2, r1: 1.8, speed: [0.1, 0.5], vy: [0.2, 0.6], t0: 0.3, t1: 1.6, life: [1.4, 2.0], size: [0.9, 1.4] });
  flash(e, { t0: TS, size: 3.5, y: 0.8, col: green });
  shock(e, { t0: TS, r: 3.6, col: green, col2: sick, dur: 0.8 });
  sparks(e, { t0: TS, count: 80, y: 0.3, speed: [3, 6], up: 0.4, col: sick, col2: green, gravity: -5 });
  e.spawnAt(TS);
  e.light({ col: '#40ff60', y: 1.2, t0: 0.2, peak: TS, t1: 2.8, I: 45 });
};

// A cold ghostly vortex; hooded wraiths spiral in and coalesce.
BUILD.wraithcall = (e) => {
  e.end = 2.8; e.life = 3.5;
  const TS = 2.0;
  const pale = hc('#a8d4ff', 2.2), cold = hc('#5a90ff', 2.0), eyes = hc('#80ffff', 4);
  portal(e, { r: 2.2, colA: pale, colB: hc('#203050', 1), colC: C(0.0, 0.01, 0.02), t0: 0, open: 0.8, t1: TS + 0.8, close: 0.6, spin: -1.6, dark: 0.85 });
  column(e, 'SWIRL', { r: 1.3, h: 4.5, colA: pale, colB: cold, t0: 0.3, rise: 0.8, t1: TS + 0.5, out: 0.6, alpha: 0.5, speed: 6, param: [1.2], pinch: 0.7 });
  e.particles({
    count: 7, shape: 'GHOST', polar: true, colA: pale, colB: cold, colC: eyes, hot: 0.4, aspect: 0.8, grow: [0.5, 0.3, 0.6], fade: [0.2, 0.85], pull: 0.4, order: 32,
    spawn: (p, i) => {
      p.birth = R(0, 0.25); p.life = TS - p.birth - R(0, 0.1);
      p.x = R(4.2, 5.2); p.vx = -(p.x - 0.4) / p.life; p.y = (i / 7) * TAU; p.vy = R(1.8, 2.4);
      p.z = R(2.4, 3.2); p.vz = -(p.z - 1.0) / p.life; p.size = R(1.6, 1.9);
    },
  });
  e.particles({
    count: 50, shape: 'SMOKE', polar: true, colA: C(0.45, 0.55, 0.65), colB: pale, param: [0.16, 0.25, 0, 0], grow: [0.6, 0.3, 1.4], fade: [0.2, 0.7], pull: 0.3,
    spawn: (p) => { p.x = R(3, 4.5); p.vx = -R(1.5, 2.2); p.y = R(0, TAU); p.vy = R(1.2, 1.8); p.z = R(0.2, 1.8); p.birth = R(0, 1.2); p.life = R(1.2, 1.6); p.size = R(1.0, 1.6); p.rot = R(0, TAU); },
  });
  motes(e, { count: 60, shape: 'STAR', col: pale, col2: cold, r0: 0.3, r1: 2.0, t0: 0.4, t1: 2.4, vy: [0.4, 1.2], omega: [1.5, 2.5], dir: 1, size: [0.1, 0.18] });
  flash(e, { t0: TS, size: 4, y: 1, col: pale });
  shock(e, { t0: TS, r: 3.8, col: pale, col2: cold });
  e.spawnAt(TS);
  e.light({ col: '#90c0ff', y: 1.5, t0: 0.3, peak: TS, t1: TS + 1, I: 40 });
};

// Massive necrotic nova: a dark beam from the sky, cracks spread, a sickly green blast.
BUILD.lifesbane = (e) => {
  e.end = 4.4; e.life = 5.3;
  const TP = 2.2;
  const green = hc('#90ff20', 3), toxic = hc('#40ff40', 2.4), pale = hc('#e0ffb0', 3);
  column(e, 'DARK', { r: 1.5, h: 18, colA: hc('#80ff20', 1.5), colB: C(0.005, 0.015, 0.0), t0: 0.2, rise: 0.8, fromSky: true, t1: TP + 1.4, out: 1.2, speed: -4, param: [0.3, 0.97], pinch: 0.5, swell: 0.4, swellT: TP });
  column(e, 'BEAM', { r: 0.5, h: 18, colA: hc('#c0ff60', 2), colB: green, t0: 1.0, rise: 0.8, fromSky: true, t1: TP + 1.0, out: 0.8, speed: -8, param: [0.3], hot: 0.3 });
  cracks(e, { r: 5.5, col: green, col2: pale, t0: 0.4, grow: TP - 0.4, t1: 5.2, out: 1.8, glow: 1.6, darkness: 0.6, density: 5 });
  const sc = e.decal('SCORCH', 4, { colA: C(0.01, 0.02, 0.005), colB: toxic, colC: green });
  e.anim((t) => { const k = env(t, 0.3, TP, 4.2, 5.2); sc.u.uParam.value.x = 0.6 * k; sc.u.uParam.value.y = 0.4 * k; });
  e.particles({
    count: 280, shape: 'SPARK', align: 'streak', polar: true, converge: 1, target: [0, 0.8, 0], colA: green, colB: toxic, hot: 0.6, fade: [0.1, 0.9], grow: [1, 0.5, 0.6],
    spawn: (p) => { p.x = R(4, 8); p.y = R(0, TAU); p.z = R(0, 4); p.vy = R(1, 2); p.life = R(0.7, 1.2); p.birth = R(0.2, TP - p.life); p.size = R(0.06, 0.1); p.stretch = 0.05; },
  });
  glowPool(e, { r: 5, col: hc('#60ff20', 0.9), col2: hc('#e0ffb0', 0.3), t0: 0.2, peak: TP, t1: 5 });
  flash(e, { t0: TP, size: 8, y: 1.2, col: hc('#90ff30', 2.2), hot: 0.6, dur: 0.8 });
  shock(e, { t0: TP, r: 9, col: green, col2: toxic, dur: 1.4, thick: 0.045, fill: 0.15 });
  shock(e, { t0: TP + 0.12, r: 6, col: toxic, dur: 1.1, thick: 0.06 });
  shock(e, { t0: TP, r: 4, y: 1.0, col: toxic, dur: 0.6, thick: 0.08 });
  sparks(e, { t0: TP, count: 250, y: 0.6, speed: [6, 14], up: -0.1, col: pale, col2: green, gravity: -6, life: [0.6, 1.3], size: [0.07, 0.12] });
  smoke(e, { t0: TP, t1: TP + 0.15, count: 70, col: C(0.04, 0.07, 0.02), glow: green, glowAmt: 1.0, opacity: 0.6, r0: 0.5, r1: 1.5, speed: [3, 6], vy: [0.2, 1.2], drag: 1.8, life: [1.6, 2.6], size: [1.4, 2.2], y0: 0.2, y1: 0.8 });
  motes(e, { count: 200, col: toxic, col2: pale, r0: 0.5, r1: 5, t0: TP, t1: 4.2, vy: [0.8, 2.2], size: [0.08, 0.16], life: [1.0, 1.8] });
  e.particles({
    count: 5, shape: 'SKULL', colA: C(0.02, 0.05, 0.01), colB: green, colC: pale, param: [1, 0, 0, 0], wobble: 0.3, fade: [0.15, 0.6], grow: [0.4, 0.3, 1.3], pull: 0.5, order: 32,
    spawn: (p, i) => { const th = (i / 5) * TAU; p.x = Math.cos(th) * 1.2; p.z = Math.sin(th) * 1.2; p.y = 1.0; p.vx = Math.cos(th) * 0.5; p.vz = Math.sin(th) * 0.5; p.vy = R(1.0, 1.5); p.birth = TP + 0.1 + i * 0.08; p.life = R(1.4, 1.9); p.size = R(1.0, 1.3); },
  });
  e.spawnAt(TP);
  e.light({ col: '#80ff30', y: 2.5, t0: 0.3, peak: TP, t1: TP + 2.2, I: 160, dist: 22 });
};

// --- Paladin / Priest / Ranger / Shaman --------------------------------------------------

// Earth ward: a stone rune circle, a wall of golden runes rises, pebbles and dust.
BUILD.fortify = (e) => {
  e.end = 2.8; e.life = 3.4;
  const gold = hc('#ffc050', 2.6), earth = hc('#c08040', 1.6), stone = C(0.42, 0.38, 0.33);
  runeCircle(e, { r: 2.2, col: gold, col2: earth, pattern: 3, reveal: 0.45, t1: 3.1, spin: 0.25 });
  const wall = column(e, 'RUNEWALL', { r: 1.75, h: 1.4, colA: gold, colB: hc('#fff0c0', 3), t0: 0.3, rise: 0.01, t1: 3.0, out: 0.8, speed: 1, param: [0, 0, 0, 0] });
  e.anim((t) => { wall.u.uParam.value.x = easeOut((t - 0.35) / 0.8); });
  rocks(e, { count: 36, ring: 1.75, t0: 0.35, spread: 0.5, col: stone, glow: gold, glowAmt: 0.25, vy: [2, 3.5], hs: [0.3, 1.2], size: [0.1, 0.2] });
  smoke(e, { count: 30, col: C(0.5, 0.42, 0.32), opacity: 0.45, r0: 1.6, r1: 1.9, speed: [0.5, 1.2], vy: [0.2, 0.5], t0: 0.3, t1: 0.9, life: [1.0, 1.6], size: [0.7, 1.1] });
  motes(e, { count: 60, shape: 'STAR', col: gold, r0: 1.65, r1: 1.85, t0: 0.5, t1: 2.2, vy: [0.6, 1.2], omega: [0.2, 0.4], size: [0.12, 0.2] });
  shock(e, { t0: 0.35, r: 2.8, col: gold, col2: earth, dur: 0.6 });
  glowPool(e, { r: 2.4, col: hc('#ffa040', 0.5), peak: 0.8, t1: 3.1 });
  e.light({ col: '#ffc060', y: 1.4, t0: 0.2, peak: 0.9, t1: 2.8, I: 35 });
};

// Warm golden banners of light unfurl around the stack with a lion's roar of light.
BUILD.bravery = (e) => {
  e.end = 2.6; e.life = 3.2;
  const gold = hc('#ffc040', 2.6), warm = hc('#ff8a20', 2), white = hc('#fff0c0', 3);
  e.particles({
    count: 6, shape: 'BANNER', align: 'yaxis', anchor: true, aspect: 0.48, colA: gold, colB: warm, hot: 0.5, drag: 2.5, fade: [0.15, 0.75], grow: [0.3, 0.25, 1],
    spawn: (p, i) => { const th = (i / 6) * TAU + 0.3; p.x = Math.cos(th) * 1.55; p.z = Math.sin(th) * 1.55; p.vy = R(1.2, 1.5); p.birth = 0.2 + i * 0.06; p.life = 2.2; p.size = R(2.0, 2.2); },
  });
  sprite(e, 'SUNBURST', { t0: 0.35, dur: 1.9, size: 4.5, y: 1.1, col: gold, hot: 1, grow: [0.3, 0.2, 1.2], fade: [0.1, 0.6], pull: 0.15 });
  flash(e, { t0: 0.4, size: 3.5, y: 1.0, col: white });
  shock(e, { t0: 0.4, r: 3.8, col: gold, col2: white, dur: 0.8 });
  shock(e, { t0: 0.45, r: 2.5, y: 1.1, col: warm, dur: 0.5 });
  motes(e, { count: 80, shape: 'STAR', col: white, col2: gold, r0: 0.3, r1: 1.8, t0: 0.4, t1: 2.0, vy: [0.8, 1.6], size: [0.14, 0.24] });
  glowPool(e, { r: 2.6, col: hc('#ff9a30', 0.8), peak: 0.45, t1: 2.8 });
  e.light({ col: '#ffb040', y: 1.5, t0: 0.1, peak: 0.45, t1: 2.4, I: 45 });
};

// Warm healing motes, crosses and halo rings drifting up.
BUILD.mightyfeast = (e) => {
  e.end = 2.6; e.life = 3.2;
  const gold = hc('#ffd060', 2.2), green = hc('#90ff60', 2.2), white = hc('#f8ffe0', 2.5);
  glowPool(e, { r: 2.4, col: hc('#a0e040', 0.8), col2: hc('#ffd060', 0.3), peak: 0.8, t1: 3 });
  motes(e, { count: 200, col: gold, col2: green, r0: 0.1, r1: 1.6, y0: 0, y1: 0.3, t0: 0, t1: 1.9, vy: [0.5, 1.2], omega: [0.2, 0.6], wobble: 0.15, life: [1.1, 1.9], size: [0.06, 0.13] });
  motes(e, { count: 24, shape: 'PLUS', col: white, col2: green, r0: 0.3, r1: 1.3, y0: 0.2, y1: 0.8, t0: 0.3, t1: 1.6, vy: [0.6, 1.0], life: [1.0, 1.4], size: [0.2, 0.3], grow: [0.3, 0.3, 0.6] });
  for (let k = 0; k < 3; k++) {
    const t0 = 0.2 + k * 0.5;
    lightRing(e, { col: gold, col2: green, width: 0.08 }, (t) => { const q = (t - t0) / 1.4; return q < 0 || q > 1 ? [0, 1, 0] : [0.1 + 1.9 * easeOut(q), 1.3 - 0.5 * q, Math.sin(Math.PI * q)]; });
  }
  e.light({ col: '#c0ff70', y: 1.3, t0: 0, peak: 0.8, t1: 2.8, I: 25 });
};

// The ground bursts: rocks, grit and billowing dust, a crater with faint glowing cracks.
BUILD.dig = (e) => {
  e.end = 2.0; e.life = 3.0;
  const TB = 0.25;
  const dirt = C(0.3, 0.22, 0.14), dust = C(0.55, 0.46, 0.34);
  const sc = e.decal('SCORCH', 1.7, { colA: C(0.1, 0.07, 0.04) });
  e.anim((t) => { sc.u.uParam.value.x = 0.85 * env(t, TB, TB + 0.2, 2.2, 3.0); });
  cracks(e, { r: 2.2, col: hc('#c08040', 1.2), col2: hc('#ffd090', 0.6), dark: C(0.06, 0.04, 0.02), darkness: 0.4, t0: TB, grow: 0.3, t1: 2.8, out: 1.0, glow: 0.8 });
  rocks(e, { count: 45, t0: TB, col: dirt, vy: [4, 7.5], hs: [0.8, 2.8], size: [0.12, 0.3], gravity: -14 });
  rocks(e, { count: 120, t0: TB, col: C(0.35, 0.28, 0.2), vy: [3, 6], hs: [0.5, 2.5], size: [0.04, 0.08], gravity: -14, life: [0.7, 1.1] });
  smoke(e, { count: 45, col: dust, opacity: 0.7, r0: 0, r1: 0.6, speed: [1, 3.5], vy: [0.8, 2.5], drag: 2.2, lift: 0.1, t0: TB, t1: TB + 0.15, life: [1.2, 2.2], size: [0.9, 1.6], grow: [0.3, 0.25, 1.6] });
  shock(e, { t0: TB, r: 2.8, col: hc('#d8b890', 0.8), dur: 0.6, thick: 0.08, fill: 0 });
};

// A giant eye of light opens in the sky and sweeps a scanning beam over the land.
BUILD.augury = (e) => {
  e.end = 3.6; e.life = 4.2;
  const gold = hc('#ffe080', 2.6), white = hc('#fffbe8', 3), iris = hc('#ffb020', 2.6);
  const EY = 6.0, D = 2.2;
  sprite(e, 'SUNBURST', { t0: 0.4, dur: 3.3, size: 7, y: EY, col: hc('#ffd070', 1.6), hot: 0.4, grow: [0.3, 0.2, 1], fade: [0.15, 0.85], pull: 0, order: 29 });
  const eye = sprite(e, 'EYE', { t0: 0.1, dur: 3.8, size: 4.2, aspect: 1.5, y: EY, col: iris, colB: gold, colC: hc('#503010', 0.9), hot: 0.6, grow: [0.5, 0.15, 1.0], fade: [0.08, 0.9], pull: 0, param: [0, 0, 0, 0], order: 31 });
  e.anim((t) => {
    const u = eye.u.uParam.value;
    u.x = easeOut((t - 0.3) / 0.6) * (1 - easeInOut((t - 3.2) / 0.45));
    u.z = Math.sin((t - 0.9) * 1.9) * sstep(0.8, 1.2, t);
  });
  const pivot = new THREE.Group();
  pivot.position.y = EY;
  e.root.add(pivot);
  const tilt = Math.atan2(D, EY), len = Math.hypot(D, EY);
  const cone = e.column('BEAM', { geo: 'cone', r: 1.2, h: len, colA: gold, colB: hc('#ffb030', 1.4), alpha: 0, hot: 0.4, speed: -3, param: [0, 0, 0, 0], root: pivot });
  cone.mesh.rotation.z = tilt;
  const spot = e.decal('GLOW', 1.5, { colA: hc('#ffd070', 1.0), colB: hc('#fffbe8', 0.5), param: [2.2, 0, 0, 0], air: true, y: 0.06 });
  const spotRing = e.decal('RIPPLE', 1.6, { colA: gold, param: [0.8, 0, 0, 0], air: true, y: 0.07 });
  e.anim((t) => {
    const ang = (t - 0.9) * 1.9;
    pivot.rotation.y = ang;
    spot.mesh.position.set(Math.cos(ang) * D, 0.06, -Math.sin(ang) * D);
    spotRing.mesh.position.set(Math.cos(ang) * D, 0.07, -Math.sin(ang) * D);
    const k = env(t, 0.8, 1.2, 3.0, 3.4);
    cone.mesh.visible = spot.mesh.visible = spotRing.mesh.visible = k > 0.001;
    cone.u.uAlpha.value = k * 0.45;
    spot.u.uAlpha.value = k;
    spotRing.u.uParam.value.y = k;
  });
  e.particles({
    count: 90, shape: 'STAR', colA: white, colB: gold, hot: 0.8, gravity: [0, -1.2, 0], drag: 0.8, fade: [0.1, 0.6], grow: [1, 0.2, 0.4],
    spawn: (p) => { const th = R(0, TAU); p.x = Math.cos(th) * R(0.5, 2.2); p.z = Math.sin(th) * R(0.3, 0.8); p.y = EY + R(-0.6, 0.6); p.vx = p.x * 0.3; p.vy = R(-1, 0.2); p.birth = R(0.6, 3.0); p.life = R(0.8, 1.4); p.size = R(0.14, 0.26); },
  });
  runeCircle(e, { r: 2.8, col: gold, col2: hc('#ffb030', 1.2), pattern: 5, alpha: 0.6, reveal: 0.8, t0: 0.2, t1: 3.8, spin: 0.2 });
  flash(e, { t0: 0.75, size: 5, y: EY, col: gold, hot: 1, pull: 0 });
  e.light({ col: '#ffe0a0', obj: spot.mesh, y: 1.2, t0: 0.8, peak: 1.3, t1: 3.5, I: 40 });
};

// Holy fire: a ring of white-orange flames, a fire column and a radiant sunburst.
BUILD.jihad = (e) => {
  e.end = 2.8; e.life = 3.4;
  const white = hc('#fff2d0', 3.2), orange = hc('#ff9a30', 3), red = hc('#ff4a10', 2.2);
  runeCircle(e, { r: 2.1, col: orange, col2: white, pattern: 0, reveal: 0.4, t1: 3.0, spin: 0.9, alpha: 0.9 });
  column(e, 'FIRE', { r: 0.95, h: 3.8, colA: hc('#ff9020', 1.5), colB: red, t0: 0.3, rise: 0.4, t1: 2.6, out: 0.8, speed: 3, hot: 0.2, pinch: 0.4, alpha: 0.8 });
  flameRing(e, { count: 70, r0: 1.2, r1: 1.8, col: hc('#ffb040', 2.6), col2: red, t0: 0.2, t1: 2.0, size: [0.8, 1.4] });
  embers(e, { count: 180, col: hc('#ffe0a0', 2.6), col2: orange, r: 1.8, t0: 0.2, t1: 2.3, vy: [1.5, 3.5] });
  sprite(e, 'SUNBURST', { t0: 0.3, dur: 1.4, size: 4.5, y: 1.3, col: hc('#ffb050', 1.2), hot: 0.2, pull: 0.15 });
  flash(e, { t0: 0.32, size: 3.2, y: 1, col: hc('#ffd0a0', 2) });
  shock(e, { t0: 0.32, r: 3.8, col: orange, col2: hc('#ffd0a0', 1.5) });
  glowPool(e, { r: 2.8, col: hc('#ff8020', 1.0), peak: 0.5, t1: 2.9, flicker: 0.2 });
  e.light({ col: '#ff9a40', y: 1.8, t0: 0.1, peak: 0.4, t1: 2.8, I: 70, flicker: 0.25 });
};

// A baleful slit-pupilled eye glares down; curse runes orbit and sink into the victims.
BUILD.evileye = (e) => {
  e.end = 2.8; e.life = 3.4;
  const EY = 3.0;
  const green = hc('#90ff30', 3), violet = hc('#a040ff', 2.4);
  const eye = sprite(e, 'EYE', { t0: 0.1, dur: 2.9, size: 2.8, aspect: 1.5, y: EY, col: hc('#70ff10', 1.6), colB: violet, colC: hc('#300c50', 0.7), hot: 0.4, grow: [0.6, 0.2, 1], fade: [0.1, 0.88], pull: 0, param: [0, 1, 0, 0], order: 31 });
  e.anim((t) => {
    const u = eye.u.uParam.value;
    u.x = easeOut((t - 0.2) / 0.35) * (1 - easeInOut((t - 2.4) / 0.35));
    u.z = 0.2 * Math.sin(t * 9) * sstep(0.6, 0.8, t) * (1 - sstep(1.0, 1.4, t));
  });
  smoke(e, { count: 18, col: C(0.04, 0.01, 0.06), glow: violet, glowAmt: 0.5, opacity: 0.5, r0: 0.2, r1: 1.2, y0: EY - 0.4, y1: EY + 0.3, speed: [0.1, 0.4], vy: [-0.1, 0.2], t0: 0.1, t1: 1.0, life: [1.6, 2.2], size: [1.0, 1.5] });
  e.particles({
    count: 16, shape: 'RUNE', polar: true, converge: 1, target: [0, 0.6, 0], colA: green, colB: violet, hot: 0.6, fade: [0.15, 0.9], grow: [0.3, 0.2, 0.6],
    spawn: (p, i) => { p.x = R(1.5, 2.0); p.y = (i / 16) * TAU; p.z = R(1.2, 2.4); p.vy = 1.6; p.birth = 0.4 + R(0, 0.4); p.life = R(1.3, 1.6); p.size = R(0.35, 0.5); },
  });
  column(e, 'BEAM', { r: 0.3, h: EY, colA: hc('#80ff30', 2), colB: violet, t0: 0.7, rise: 0.25, fromSky: true, t1: 2.0, out: 0.4, speed: -6, param: [0.05], hot: 0.25, flicker: 0.3 });
  runeCircle(e, { r: 1.9, col: violet, col2: green, pattern: 1, reveal: 0.5, t0: 0.6, t1: 3.0, spin: -0.8 });
  flash(e, { t0: 0.45, size: 3, y: EY, col: green, pull: 0 });
  glowPool(e, { r: 2.2, col: hc('#6020c0', 0.8), col2: hc('#90ff30', 0.3), peak: 1.0, t1: 3.2 });
  e.light({ col: '#90ff50', y: EY, t0: 0.2, peak: 0.9, t1: 2.8, I: 35 });
};

// Blood-red rage fire: flames, a roaring column and a heavy shockwave.
BUILD.berserker = (e) => {
  e.end = 2.6; e.life = 3.2;
  const TB = 0.55;
  const red = hc('#ff1a0a', 3), blood = hc('#a00008', 1.6), orange = hc('#ff6020', 3);
  column(e, 'FIRE', { r: 1.0, h: 3.2, colA: hc('#ff5018', 2.2), colB: blood, t0: 0.1, rise: 0.4, t1: 2.5, out: 0.8, speed: 4, hot: 0.3, swell: 0.5, swellT: TB });
  flameRing(e, { count: 60, r0: 0.6, r1: 1.3, col: orange, col2: blood, t0: 0.1, t1: 2.0, size: [0.8, 1.3] });
  flash(e, { t0: TB, size: 4, y: 0.9, col: red, hot: 1 });
  shock(e, { t0: TB, r: 4.5, col: red, col2: orange, dur: 0.8, thick: 0.07, fill: 0.2 });
  shock(e, { t0: TB + 0.15, r: 3, col: orange, dur: 0.7 });
  cracks(e, { r: 2.8, col: red, col2: orange, t0: TB, grow: 0.3, t1: 3.0, out: 1.0 });
  sparks(e, { t0: TB, count: 130, y: 0.4, speed: [5, 10], up: 0.0, col: orange, col2: red, gravity: -9 });
  smoke(e, { count: 25, col: C(0.06, 0.01, 0.01), glow: red, glowAmt: 0.8, opacity: 0.7, r0: 0.3, r1: 1.2, speed: [0.3, 1.0], vy: [1.0, 2.0], t0: TB, t1: TB + 0.5, life: [1.2, 1.8], size: [0.8, 1.3] });
  embers(e, { count: 100, col: orange, col2: red, r: 1.4, t0: 0.2, t1: 2.0, vy: [2, 4] });
  e.light({ col: '#ff2a10', y: 1.3, t0: 0.05, peak: TB, t1: 2.6, I: 70, flicker: 0.3 });
};

// --- Summoner -----------------------------------------------------------------------------

// A small fiery portal spits out a puff of flame and smoke.
BUILD.summonimp = (e) => {
  e.end = 1.8; e.life = 2.4;
  const TS = 1.1;
  const orange = hc('#ff8a20', 3), red = hc('#ff3010', 2), yellow = hc('#ffd060', 3);
  portal(e, { r: 1.1, colA: orange, colB: hc('#801000', 1.2), colC: C(0.03, 0.0, 0.0), t0: 0.0, open: 0.45, t1: 1.9, close: 0.5, spin: 2.5, dark: 0.85 });
  flameRing(e, { count: 22, r0: 0.6, r1: 0.85, col: yellow, col2: red, t0: 0.2, t1: 1.4, size: [0.4, 0.65] });
  embers(e, { count: 70, col: yellow, col2: orange, r: 0.8, t0: 0.1, t1: 1.5, vy: [1.5, 3] });
  flash(e, { t0: TS, size: 2.6, y: 0.6, col: yellow });
  sparks(e, { t0: TS, count: 60, y: 0.3, speed: [3, 6], up: 0.2, col: yellow, col2: red, gravity: -8 });
  smoke(e, { t0: TS, t1: TS + 0.08, count: 18, col: C(0.1, 0.08, 0.07), glow: orange, glowAmt: 0.8, opacity: 0.7, r1: 0.4, speed: [0.8, 1.8], vy: [0.8, 1.6], life: [0.8, 1.3], size: [0.6, 0.9] });
  shock(e, { t0: TS, r: 2.0, col: orange, col2: yellow, dur: 0.5 });
  e.spawnAt(TS);
  e.light({ col: '#ff8a30', y: 1, t0: 0.1, peak: TS, t1: 1.9, I: 30, flicker: 0.2 });
};

// Hellfire portal on the ground, ringed with flames, erupting in a burst of fire.
BUILD.summonhound = (e) => {
  e.end = 2.2; e.life = 3.0;
  const TS = 1.4;
  const fire = hc('#ff6a18', 3), red = hc('#ff2a08', 2.4), deep = hc('#600800', 1.2), yellow = hc('#ffc860', 3);
  cracks(e, { r: 2.4, col: red, col2: fire, t0: 0.1, grow: 0.8, t1: 3.0, out: 1.0, glow: 1.6, darkness: 0.5 });
  portal(e, { r: 1.6, colA: fire, colB: deep, colC: C(0.03, 0.0, 0.0), t0: 0.1, open: 0.6, t1: 2.5, close: 0.6, spin: -2.0, dark: 0.9 });
  flameRing(e, { count: 40, r0: 1.1, r1: 1.35, col: yellow, col2: red, t0: 0.3, t1: 2.0, size: [0.5, 0.9] });
  column(e, 'FIRE', { r: 0.9, h: 2.6, colA: fire, colB: red, t0: TS - 0.15, rise: 0.25, t1: TS + 0.9, out: 0.6, speed: 4, hot: 1, swell: 0.3, swellT: TS });
  embers(e, { count: 120, col: yellow, col2: fire, r: 1.2, t0: 0.2, t1: 2.0, vy: [1.5, 3.5] });
  flash(e, { t0: TS, size: 3.2, y: 0.7, col: yellow });
  smoke(e, { t0: TS, t1: TS + 0.1, count: 25, col: C(0.06, 0.03, 0.02), glow: fire, glowAmt: 1.0, opacity: 0.75, r1: 0.6, speed: [1, 2.5], vy: [1, 2], life: [1.0, 1.6], size: [0.8, 1.2] });
  sparks(e, { t0: TS, count: 70, y: 0.3, speed: [3, 7], up: 0.2, col: yellow, col2: red, gravity: -8 });
  shock(e, { t0: TS, r: 3.0, col: fire, col2: yellow, dur: 0.6 });
  e.spawnAt(TS);
  e.light({ col: '#ff5020', y: 1.0, t0: 0.1, peak: TS, t1: 2.4, I: 55, flicker: 0.3 });
};

// Icy blue-white portal: frost cracks, rising shards, a burst of ice.
BUILD.minordemon = (e) => {
  e.end = 2.2; e.life = 3.0;
  const TS = 1.4;
  const ice = hc('#70c0ff', 3), white = hc('#d8f0ff', 3), deep = hc('#1040c0', 1.5);
  cracks(e, { r: 2.5, col: ice, col2: hc('#a0d8ff', 2), dark: C(0.3, 0.4, 0.52), darkness: 0.3, t0: 0.1, grow: 1.0, t1: 3.0, out: 1.0, glow: 1.3, density: 3.5 });
  portal(e, { r: 1.9, colA: ice, colB: deep, colC: C(0.0, 0.01, 0.03), t0: 0.1, open: 0.6, t1: 2.5, close: 0.6, spin: 1.4, dark: 0.92 });
  e.particles({
    count: 30, shape: 'SHARD', polar: true, colA: ice, colB: white, hot: 0.8, grow: [0.3, 0.3, 0.7], fade: [0.15, 0.7],
    spawn: (p) => { p.x = R(1.1, 1.5); p.y = R(0, TAU); p.vy = R(0.3, 0.7); p.z = R(0, 0.3); p.vz = R(0.3, 0.8); p.birth = R(0.3, 1.2); p.life = R(1.0, 1.4); p.size = R(0.3, 0.5); p.rot = R(-0.3, 0.3); p.spin = R(-1, 1); },
  });
  sparks(e, { t0: TS, count: 60, shape: 'SHARD', aspect: 0.45, y: 0.3, speed: [4, 8], up: 0.3, col: white, col2: ice, gravity: -9, drag: 1, size: [0.18, 0.3], stretch: 0.02, life: [0.6, 1.0] });
  smoke(e, { count: 22, col: C(0.45, 0.58, 0.75), glow: hc('#4090ff', 2), glowAmt: 0.3, opacity: 0.2, r0: 0.5, r1: 1.6, speed: [0.2, 0.8], vy: [0.1, 0.4], t0: 0.2, t1: 1.6, life: [1.2, 1.8], size: [0.8, 1.3] });
  motes(e, { count: 90, shape: 'STAR', col: ice, col2: deep, r0: 0.2, r1: 1.8, t0: 0.2, t1: 2.0, vy: [0.4, 1.2], size: [0.08, 0.16] });
  flash(e, { t0: TS, size: 3.0, y: 0.7, col: hc('#90d0ff', 2) });
  shock(e, { t0: TS, r: 3.2, col: ice, col2: white, dur: 0.7 });
  e.spawnAt(TS);
  e.light({ col: '#90d0ff', y: 1.0, t0: 0.1, peak: TS, t1: 2.4, I: 50 });
};

// Huge infernal portal, a towering pillar of fire, embers and smoke billowing high.
BUILD.greaterdemon = (e) => {
  e.end = 4.4; e.life = 5.4;
  const TS = 2.6;
  const fire = hc('#ff6010', 3.2), red = hc('#ff2008', 2.4), yellow = hc('#ffd070', 3.4), deep = hc('#500500', 1.2);
  cracks(e, { r: 5, col: red, col2: fire, t0: 0.0, grow: 1.6, t1: 5.3, out: 1.5, glow: 1.8, darkness: 0.6, density: 3.5 });
  const sc = e.decal('SCORCH', 3.8, { colA: C(0.03, 0.01, 0.0), colB: fire, colC: red });
  e.anim((t) => { const k = env(t, 0.5, 2.0, 4.4, 5.4); sc.u.uParam.value.x = 0.75 * k; sc.u.uParam.value.y = 0.8 * k; });
  portal(e, { r: 2.9, colA: fire, colB: deep, colC: C(0.02, 0, 0), t0: 0.4, open: 1.2, t1: 4.6, close: 1.0, spin: 1.2, dark: 0.92 });
  column(e, 'FIRE', { r: 1.7, h: 12, colA: hc('#ff6a10', 2.6), colB: red, t0: 1.9, rise: 0.5, t1: 4.2, out: 1.0, speed: 5, hot: 0.6, swell: 0.3, swellT: TS, pinch: 0.3 });
  column(e, 'BEAM', { r: 0.8, h: 14, colA: hc('#ffc050', 2.0), colB: fire, t0: 2.1, rise: 0.4, t1: 3.9, out: 0.8, speed: 8, param: [0.5], hot: 0.3 });
  flameRing(e, { count: 90, r0: 2.1, r1: 2.8, col: yellow, col2: red, t0: 0.8, t1: 4.0, size: [0.9, 1.6], life: [0.6, 1.0] });
  embers(e, { count: 420, col: yellow, col2: fire, r: 2.8, t0: 0.8, t1: 4.2, vy: [2.5, 7], wobble: 0.4, life: [1.0, 2.0] });
  smoke(e, { count: 60, col: C(0.05, 0.03, 0.02), glow: fire, glowAmt: 0.9, opacity: 0.75, r0: 0.3, r1: 1.8, speed: [0.3, 1.2], vy: [2, 4], drag: 0.6, lift: 0.3, t0: 1.9, t1: 3.8, life: [1.8, 2.6], size: [1.6, 2.4], grow: [0.4, 0.3, 2.0] });
  flash(e, { t0: TS, size: 7.5, y: 1.5, col: hc('#ffa040', 2.4), hot: 0.6, dur: 0.8 });
  shock(e, { t0: TS, r: 8, col: fire, col2: yellow, dur: 1.2, thick: 0.05, fill: 0.2 });
  shock(e, { t0: TS + 0.15, r: 5.5, col: red, dur: 1.0, thick: 0.06 });
  sparks(e, { t0: TS, count: 200, y: 0.8, speed: [6, 13], up: 0.0, col: yellow, col2: red, gravity: -8, life: [0.6, 1.2], size: [0.07, 0.12] });
  e.spawnAt(TS);
  e.light({ col: '#ff5010', y: 3, t0: 0.4, peak: TS, t1: 5.0, I: 160, dist: 24, flicker: 0.2 });
};

// Arcane dissolve: a swirling column lifts the stack away in sparkles, and it
// reassembles in a descending column at opts.target. Resolves after the arrival.
BUILD.teleport = (e, o) => {
  e.end = 2.5; e.life = 3.1;
  const TA = 1.25;
  const arc = hc('#8a70ff', 2.6), cyan = hc('#70c8ff', 2.4), white = hc('#f0e8ff', 3);
  runeCircle(e, { r: 1.8, col: arc, col2: cyan, pattern: 0, reveal: 0.35, t1: 1.9, spin: 1.2 });
  column(e, 'SWIRL', { r: 1.15, h: 5, colA: white, colB: arc, t0: 0.1, rise: 0.35, t1: 1.55, out: 0.4, speed: 9, param: [0.8], hot: 0.6, pinch: 0.95 });
  motes(e, { count: 160, shape: 'STAR', col: white, col2: cyan, r0: 0.1, r1: 1.1, y0: 0, y1: 1.0, t0: 0.3, t1: 1.3, vy: [2, 5], omega: [2, 4], dir: 1, life: [0.5, 0.9], size: [0.1, 0.2] });
  flash(e, { t0: TA - 0.05, size: 3, y: 1.0, col: arc });
  glowPool(e, { r: 2.0, col: hc('#7060ff', 0.8), peak: 0.8, t1: 1.8 });
  const dest = o.target ? e.addRoot(o.target) : e.root;
  column(e, 'SWIRL', { root: dest, r: 1.15, h: 5, colA: white, colB: cyan, t0: TA, rise: 0.3, fromSky: true, t1: 2.4, out: 0.5, speed: -9, param: [0.8], pinch: 0.95 });
  runeCircle(e, { root: dest, r: 1.8, col: cyan, col2: arc, pattern: 0, reveal: 0.3, t0: TA, t1: 2.9, spin: -1.2 });
  e.particles({
    root: dest, count: 140, shape: 'STAR', polar: true, converge: 1, target: [0, 0.7, 0], colA: white, colB: cyan, hot: 1, fade: [0.1, 0.9], grow: [1, 0.5, 0.5],
    spawn: (p) => { p.x = R(1.5, 2.6); p.y = R(0, TAU); p.z = R(1, 4); p.vy = R(2, 4); p.birth = TA + R(0, 0.3); p.life = TA + 0.47 - p.birth; p.size = R(0.12, 0.22); },
  });
  flash(e, { root: dest, t0: TA + 0.45, size: 3.5, y: 0.8, col: white });
  shock(e, { root: dest, t0: TA + 0.45, r: 3.2, col: cyan, col2: white });
  motes(e, { root: dest, count: 50, shape: 'STAR', col: white, col2: arc, r0: 0.2, r1: 1.2, t0: TA + 0.45, t1: 2.2, vy: [0.5, 1.2], size: [0.08, 0.16], life: [0.6, 1.0] });
  glowPool(e, { root: dest, r: 2.0, col: hc('#60a0ff', 0.8), t0: TA, peak: TA + 0.5, t1: 2.9 });
  e.light({ col: '#9080ff', y: 1.5, t0: 0, peak: 0.6, t1: TA + 0.2, I: 35 });
  e.light({ root: dest, col: '#80c0ff', y: 1.5, t0: TA, peak: TA + 0.45, t1: 2.8, I: 45 });
};

// --- Alchemist ----------------------------------------------------------------------------

// Alchemical circle; earth and stone spiral up out of it and burst into a golem.
BUILD.creategolem = (e) => {
  e.end = 2.6; e.life = 3.3;
  const TS = 2.0;
  const amber = hc('#ffa030', 2.8), gold = hc('#ffd070', 2.6), stone = C(0.4, 0.33, 0.26);
  runeCircle(e, { r: 2.2, col: amber, col2: gold, pattern: 2, reveal: 0.8, t1: 3.1, spin: 0.35, pulse: [TS, 1.5] });
  cracks(e, { r: 1.9, col: amber, col2: gold, t0: 0.7, grow: 1.0, t1: 3.2, out: 1.0, glow: 1.4, darkness: 0.4 });
  e.particles({
    count: 60, shape: 'ROCK', polar: true, colA: stone, colB: amber, param: [0.5, 0, 0, 0], wobble: 0.05, fade: [0.1, 0.8], grow: [0.3, 0.3, 0.8], pull: 0.2,
    spawn: (p) => { p.x = R(0.3, 1.3); p.y = R(0, TAU); p.z = -0.1; p.vx = -R(0.05, 0.3); p.vy = R(1.5, 2.5); p.vz = R(0.6, 1.3); p.birth = R(0.5, TS - 0.3); p.life = Math.min(R(1, 1.5), TS + 0.1 - p.birth); p.size = R(0.14, 0.32); p.rot = R(0, TAU); p.spin = R(-3, 3); },
  });
  motes(e, { count: 80, col: amber, col2: gold, r0: 0.2, r1: 1.8, t0: 0.4, t1: 2.4, vy: [0.5, 1.2] });
  smoke(e, { count: 20, col: C(0.45, 0.38, 0.3), opacity: 0.4, r0: 0.4, r1: 1.4, speed: [0.1, 0.4], vy: [0.2, 0.5], t0: 0.6, t1: 1.8, life: [1.2, 1.8], size: [0.8, 1.2] });
  flash(e, { t0: TS, size: 3.5, y: 0.9, col: amber });
  shock(e, { t0: TS, r: 3.5, col: amber, col2: gold });
  rocks(e, { count: 30, t0: TS, col: stone, glow: amber, glowAmt: 0.3, vy: [3, 6], hs: [1, 3], size: [0.12, 0.25] });
  smoke(e, { count: 30, col: C(0.5, 0.42, 0.32), opacity: 0.6, r1: 0.6, speed: [1.5, 3.5], vy: [0.5, 1.5], drag: 2.2, t0: TS, t1: TS + 0.1, life: [1.0, 1.6], size: [0.8, 1.3] });
  e.spawnAt(TS);
  e.light({ col: '#ffa040', y: 1.2, t0: 0.3, peak: TS, t1: 3.0, I: 45 });
};

// Glittering arcane sparkles spiral in and condense into a single golden point.
BUILD.summonitem = (e) => {
  e.end = 2.0; e.life = 2.8;
  const TP = 1.4, PY = 1.3;
  const gold = hc('#ffd050', 3), white = hc('#fff8e0', 3.2), arc = hc('#b080ff', 2);
  e.particles({
    count: 240, shape: 'STAR', polar: true, converge: 1, target: [0, PY, 0], colA: white, colB: gold, hot: 1, grow: [1, 0.5, 0.4], fade: [0.15, 0.95],
    spawn: (p) => { p.x = R(1.2, 3.0); p.y = R(0, TAU); p.z = R(0, 2.6); p.vy = R(1.5, 3); p.birth = R(0, 0.8); p.life = TP - p.birth + R(-0.05, 0.02); p.size = R(0.12, 0.24); },
  });
  helixTrails(e, { count: 6, r0: 2.2, r1: 0.05, y0: 0.2, y1: PY, turns: 1.5, t0: 0.2, spread: 0.3, speed: [0.85, 1.0], width: 0.06, tail: 0.5, col: gold, col2: arc });
  sprite(e, 'GLOW', { t0: 0.3, dur: TP - 0.2, size: 1.2, y: PY, col: gold, hot: 1.5, grow: [0.2, 0.95, 1.5], fade: [0.3, 0.97] });
  flash(e, { t0: TP, size: 3.2, y: PY, col: white });
  sprite(e, 'SUNBURST', { t0: TP, dur: 0.8, size: 2.8, y: PY, col: gold, hot: 1, grow: [0.3, 0.2, 1.2], fade: [0.05, 0.4] });
  sparks(e, { t0: TP, count: 90, y: PY, speed: [2, 5], up: -1, col: white, col2: gold, gravity: -4, life: [0.4, 0.9] });
  glowPool(e, { r: 2.0, col: hc('#ffc040', 0.6), peak: TP, t1: 2.6 });
  e.light({ col: '#ffd060', y: PY, t0: 0.2, peak: TP, t1: 2.4, I: 45 });
};

// --- Monk ---------------------------------------------------------------------------------

// A ki strike slams down: blinding impact, stacked shock rings, cracks and a dust ring.
BUILD.mightyblow = (e) => {
  e.end = 1.6; e.life = 2.3;
  const TI = 0.28;
  const white = hc('#fff4e0', 3.4), orange = hc('#ff9a40', 3), ki = hc('#ffc070', 2.6);
  const strike = [];
  for (let j = 0; j < 14; j++) strike.push(new THREE.Vector3(0, 7 - (j / 13) * 6.8, 0));
  e.ribbons([{ pts: strike, delay: 0, speed: 1 / (TI * 1.6) }], { mode: 'trail', width: 0.5, tail: 0.6, colA: white, colB: orange, hot: 1.2 });
  flash(e, { t0: TI, size: 4.5, y: 0.5, col: ki, hot: 2, dur: 0.5 });
  sprite(e, 'SUNBURST', { t0: TI, dur: 0.45, size: 3.5, y: 0.5, col: orange, hot: 1, grow: [0.3, 0.2, 1.4], fade: [0.05, 0.3] });
  shock(e, { t0: TI, r: 4.2, col: orange, col2: white, dur: 0.6, thick: 0.08, fill: 0.2 });
  shock(e, { t0: TI + 0.08, r: 3.0, col: ki, dur: 0.55, thick: 0.1 });
  shock(e, { t0: TI + 0.18, r: 2.0, col: white, dur: 0.5, thick: 0.12 });
  shock(e, { t0: TI, r: 2.6, y: 0.5, col: white, col2: orange, dur: 0.35, thick: 0.06 });
  cracks(e, { r: 2.3, col: orange, col2: white, t0: TI, grow: 0.15, t1: 2.2, out: 1.0, glow: 1.6 });
  sparks(e, { t0: TI, count: 160, y: 0.15, speed: [6, 12], flat: true, col: white, col2: orange, gravity: -5, life: [0.3, 0.7], stretch: 0.05 });
  smoke(e, { count: 40, col: C(0.55, 0.48, 0.38), opacity: 0.5, r0: 0.3, r1: 0.6, speed: [3, 5], vy: [0.1, 0.4], drag: 3, lift: 0.1, t0: TI, t1: TI + 0.05, life: [0.8, 1.4], size: [0.6, 1.0] });
  e.light({ col: '#ffb070', y: 1, t0: TI - 0.1, peak: TI, t1: TI + 0.8, I: 90 });
};

// Seven chakras ignite from root to crown inside a turning double helix.
BUILD.bodycontrol = (e) => {
  e.end = 2.6; e.life = 3.2;
  const blue = hc('#80c0ff', 2.6), white = hc('#eef6ff', 3), deep = hc('#4080ff', 3);
  runeCircle(e, { r: 1.8, col: hc('#60a8ff', 2.4), col2: hc('#3060ff', 1.6), pattern: 5, reveal: 0.6, t1: 3.0, spin: 0.3, alpha: 0.85 });
  e.particles({
    count: 7, shape: 'GLOW', colA: deep, colB: hc('#c0e0ff', 3), hot: 1.2, grow: [0.2, 0.12, 0.8], fade: [0.06, 0.75], pull: 1.4,
    spawn: (p, i) => { p.y = 0.15 + i * 0.3; p.birth = 0.3 + i * 0.16; p.life = 2.4 - i * 0.12; p.size = 0.75; p.mix = i / 6; },
  });
  const hx = e.ribbons([0, Math.PI].map((ph) => ({ pts: helixPath(0.85, 0.85, 0.0, 2.2, 2.0, ph, 90) })), { mode: 'full', width: 0.08, colA: hc('#a0d0ff', 3), colB: hc('#4080ff', 2.4), hot: 0.4, reveal: 0 });
  e.anim((t) => { hx.u.uReveal.value = easeInOut((t - 0.2) / 1.2) * 1.05; hx.u.uAlpha.value = 1 - sstep(2.0, 2.8, t); hx.mesh.rotation.y = t * 1.5; });
  helixTrails(e, { count: 4, r0: 0.9, r1: 0.4, y0: 0, y1: 2.3, turns: 1.5, t0: 0.4, spread: 1.0, speed: [0.9, 1.2], width: 0.06, tail: 0.3, col: white, col2: blue });
  motes(e, { count: 60, col: blue, col2: white, r0: 0.3, r1: 1.4, t0: 0.3, t1: 2.2, vy: [0.3, 0.8] });
  shock(e, { t0: 1.4, r: 2.4, y: 2.05, col: blue, col2: white, dur: 0.6 });
  e.light({ col: '#80c0ff', y: 1.2, t0: 0.2, peak: 1.4, t1: 2.8, I: 30 });
};

// A hypnotic magenta spiral and rings of psychic ripples pulsing out at head height.
BUILD.mindcontrol = (e) => {
  e.end = 2.6; e.life = 3.2;
  const HY = 1.1;
  const mag = hc('#ff40e0', 2.8), violet = hc('#9040ff', 2.2), pink = hc('#ffc0f8', 3);
  const sp = e.decal('SPIRAL', 2.2, { colA: mag, colB: violet });
  e.anim((t) => { sp.u.uParam.value.x = env(t, 0, 0.5, 2.2, 3.0); });
  for (let k = 0; k < 6; k++) {
    const t0 = 0.3 + k * 0.28;
    lightRing(e, { col: hc('#ff60e0', 3), col2: mag, width: 0.08, hot: 0.2 }, (t) => { const q = (t - t0) / 1.0; return q < 0 || q > 1 ? [HY, 1, 0] : [HY + 0.1 * Math.sin(q * 6), 0.3 + 2.6 * easeOut(q), Math.pow(1 - q, 1.5) * sstep(0, 0.1, q)]; });
  }
  motes(e, { count: 110, shape: 'STAR', col: pink, col2: mag, r0: 2.0, r1: 3.0, y0: 0.3, y1: 2.2, t0: 0, t1: 1.6, vy: [0, 0.2], omega: [2, 3], dir: 1, converge: 1, target: [0, HY, 0], life: [0.8, 1.0], size: [0.12, 0.2], fade: [0.2, 0.9], grow: [1, 0.5, 0.3] });
  sprite(e, 'GLOW', { t0: 0.2, dur: 2.3, size: 1.1, y: HY, col: mag, hot: 1, grow: [0.3, 0.4, 0.8], fade: [0.2, 0.7] });
  flash(e, { t0: 1.6, size: 2.5, y: HY, col: mag });
  e.light({ col: '#ff50e0', y: 1.4, t0: 0.1, peak: 0.9, t1: 2.6, I: 30 });
};

// --- Bard ---------------------------------------------------------------------------------

// Thunderclouds gather overhead and loose electric-blue lightning around the stack.
BUILD.stormsong = (e) => {
  e.end = 3.0; e.life = 3.8;
  const CY = 5.2;
  const elec = hc('#60b8ff', 3), white = hc('#e8f4ff', 4);
  const cloud = e.particles({
    count: 44, shape: 'SMOKE', colA: C(0.07, 0.075, 0.1), colB: hc('#80c0ff', 2.4), param: [0.92, 0, 0, 0], wobble: 0.12, grow: [0.5, 0.25, 1.1], fade: [0.15, 0.8], pull: 0.3,
    spawn: (p) => { const th = R(0, TAU), rr = Math.sqrt(Math.random()) * 2.4; p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = CY + R(-0.3, 0.4) + (1 - rr / 2.4) * 0.5; p.vx = R(-0.1, 0.1); p.birth = R(0, 0.4); p.life = R(3.0, 3.4); p.size = R(1.4, 2.4); p.rot = R(0, TAU); p.spin = R(-0.2, 0.2); },
  });
  const strikes = [0.7, 1.0, 1.35, 1.75, 2.1, 2.4].map((ts) => {
    const th = R(0, TAU), rr = R(0.2, 1.5);
    const to = new THREE.Vector3(Math.cos(th) * rr, 0.05, Math.sin(th) * rr);
    const from = new THREE.Vector3(to.x * 0.4 + R(-0.8, 0.8), CY - 0.3, to.z * 0.4 + R(-0.8, 0.8));
    return { ts, to, from };
  });
  const NP = 24, NB = 10, main = [], br1 = [], br2 = [];
  for (let j = 0; j < NP; j++) main.push(new THREE.Vector3());
  for (let j = 0; j < NB; j++) { br1.push(new THREE.Vector3()); br2.push(new THREE.Vector3()); }
  const bolt = e.ribbons([{ pts: main }, { pts: br1, width: 0.6 }, { pts: br2, width: 0.5 }], { mode: 'full', width: 0.26, colA: hc('#c8e4ff', 3.2), colB: elec, hot: 1.0, alpha: 0 });
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const regen = (s) => {
    boltPath(s.from, s.to, main, 0.16);
    for (const br of [br1, br2]) {
      const k = 4 + ((Math.random() * (NP - 10)) | 0);
      tmpA.copy(main[k]);
      tmpB.set(tmpA.x + R(-1.2, 1.2), Math.max(0.3, tmpA.y - R(1, 2)), tmpA.z + R(-1.2, 1.2));
      boltPath(tmpA, tmpB, br, 0.12);
    }
    bolt.write(0, main); bolt.write(1, br1); bolt.write(2, br2);
  };
  let cur = -1, nextRegen = 0;
  const flashAmt = (t) => {
    let f = 0;
    for (const s of strikes) { const q = (t - s.ts) / 0.25; if (q >= 0 && q <= 1) f = Math.max(f, (1 - q) * (0.65 + 0.35 * Math.sin(q * 40))); }
    return f;
  };
  e.anim((t) => {
    let active = -1;
    for (let i = 0; i < strikes.length; i++) if (t >= strikes[i].ts && t < strikes[i].ts + 0.25) active = i;
    bolt.mesh.visible = active >= 0;
    if (active >= 0) {
      if (active !== cur || t >= nextRegen) { regen(strikes[active]); nextRegen = t + 0.06; cur = active; }
      bolt.u.uAlpha.value = flashAmt(t);
    }
    cloud.u.uParam.value.z = flashAmt(t) * 0.55;
  });
  e.particles({
    count: strikes.length, shape: 'FLASH', colA: elec, hot: 1.5, grow: [0.3, 0.1, 1.2], fade: [0.03, 0.2], pull: 0.3,
    spawn: (p, i) => { const s = strikes[i]; p.x = s.to.x; p.y = 0.3; p.z = s.to.z; p.birth = s.ts; p.life = 0.45; p.size = 2.2; },
  });
  e.particles({
    count: strikes.length * 25, shape: 'SPARK', align: 'streak', colA: white, colB: elec, colorAge: 1, hot: 1, drag: 2, gravity: [0, -6, 0], fade: [0.02, 0.4], grow: [1, 0.1, 0.4],
    spawn: (p, i) => { const s = strikes[i % strikes.length], th = R(0, TAU), sp = R(2, 5), vy = R(0.1, 0.9); p.x = s.to.x; p.y = 0.1; p.z = s.to.z; p.vx = Math.cos(th) * sp; p.vz = Math.sin(th) * sp; p.vy = vy * sp; p.birth = s.ts; p.life = R(0.3, 0.6); p.size = R(0.04, 0.06); p.mix = 0; },
  });
  for (const s of strikes) shock(e, { t0: s.ts, r: 1.2, y: 0.04, col: elec, col2: white, dur: 0.4, thick: 0.1 }).mesh.position.set(s.to.x, 0.04, s.to.z);
  notes(e, { count: 16, col: elec, col2: white, t0: 0.3, t1: 2.2 });
  const gp = glowPool(e, { r: 2.6, col: hc('#4080ff', 0.4), peak: 0.6, t1: 3.2 });
  e.anim((t) => { gp.u.uAlpha.value *= 1 + flashAmt(t) * 2.5; });
  e.light({ col: '#80c0ff', y: 3, I: 110, dist: 20, fn: flashAmt });
};

// Red-gold notes riding a winding musical staff, a rousing battle chord.
BUILD.songofbattle = (e) => {
  e.end = 2.6; e.life = 3.2;
  const red = hc('#ff5030', 2.8), gold = hc('#ffc040', 2.8), white = hc('#fff0d0', 3);
  staff(e, { r: 1.45, y0: 0.2, y1: 1.9, turns: 1.2, col: gold, col2: red });
  notes(e, { count: 36, col: red, col2: gold, r: 1.45 });
  motes(e, { count: 60, shape: 'STAR', col: white, col2: gold, r0: 0.4, r1: 1.6, t0: 0.3, t1: 2.2, vy: [0.6, 1.4], size: [0.1, 0.2] });
  shock(e, { t0: 0.2, r: 3.2, col: red, col2: gold, dur: 0.7 });
  sparks(e, { t0: 0.25, count: 60, y: 0.3, speed: [2, 5], up: 0.5, col: gold, col2: red, gravity: -4 });
  glowPool(e, { r: 2.4, col: hc('#ff5020', 0.7), peak: 0.6, t1: 2.9 });
  e.light({ col: '#ff7040', y: 1.4, t0: 0.1, peak: 0.6, t1: 2.6, I: 35 });
};

// Green notes and drifting blossoms, gentle healing light.
BUILD.songoflife = (e) => {
  e.end = 2.8; e.life = 3.4;
  const green = hc('#60ff70', 2.6), leaf = hc('#b0ff60', 2.2), white = hc('#f0fff0', 2.6);
  staff(e, { r: 1.4, y0: 0.2, y1: 1.8, turns: 1.0, col: green, col2: leaf, spin: 0.6 });
  notes(e, { count: 30, col: green, col2: white, r: 1.4, spin: 0.6 });
  e.particles({
    count: 50, shape: 'BLOSSOM', colA: C(1.0, 0.72, 0.85), colB: hc('#ffe060', 1.5), hot: 0.4, wobble: 0.35, swirl: 0.8, gravity: [0, -0.3, 0], fade: [0.15, 0.75], grow: [0.4, 0.2, 0.9], pull: 0.2,
    spawn: (p) => { const th = R(0, TAU), rr = R(0.3, 1.8); p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(1.8, 3.2); p.vy = R(-0.6, -0.2); p.birth = R(0.2, 1.8); p.life = R(1.4, 2.0); p.size = R(0.18, 0.3); p.rot = R(0, TAU); p.spin = R(-1.5, 1.5); },
  });
  motes(e, { count: 110, col: green, col2: leaf, r0: 0.2, r1: 1.6, t0: 0.2, t1: 2.2, vy: [0.4, 1.0], size: [0.06, 0.12] });
  glowPool(e, { r: 2.4, col: hc('#40ff60', 0.7), peak: 0.8, t1: 3.0 });
  e.light({ col: '#70ff80', y: 1.4, t0: 0.1, peak: 0.8, t1: 2.8, I: 30 });
};

// Grey-gold runic notes and orbiting stone fragments.
BUILD.songofstone = (e) => {
  e.end = 2.8; e.life = 3.4;
  const gold = hc('#e8c870', 2.6), grey = hc('#c8c0b0', 1.8), stone = C(0.45, 0.42, 0.38);
  runeCircle(e, { r: 2.0, col: gold, col2: grey, pattern: 3, reveal: 0.6, t1: 3.1, spin: 0.25, alpha: 0.8 });
  staff(e, { r: 1.5, y0: 0.2, y1: 1.7, turns: 1.0, col: gold, col2: grey, spin: 0.7 });
  notes(e, { count: 22, col: gold, col2: grey, r: 1.5, spin: 0.7 });
  notes(e, { count: 18, shape: 'RUNE', col: gold, col2: hc('#fff0c0', 3), r: 1.5, spin: 0.7 });
  e.particles({
    count: 34, shape: 'ROCK', polar: true, colA: stone, colB: gold, param: [0.3, 0, 0, 0], wobble: 0.08, fade: [0.15, 0.75], grow: [0.4, 0.2, 0.7], pull: 0.2,
    spawn: (p) => { p.x = R(1.0, 1.9); p.y = R(0, TAU); p.z = R(0.0, 0.3); p.vy = R(1.2, 2.0); p.vz = R(0.4, 0.9); p.birth = R(0.2, 1.6); p.life = R(1.2, 1.7); p.size = R(0.12, 0.26); p.rot = R(0, TAU); p.spin = R(-3, 3); },
  });
  smoke(e, { count: 16, col: C(0.5, 0.45, 0.38), opacity: 0.35, r0: 0.8, r1: 1.8, speed: [0.2, 0.6], vy: [0.1, 0.4], t0: 0.1, t1: 0.8, life: [1.2, 1.8], size: [0.7, 1.1] });
  e.light({ col: '#e8d090', y: 1.4, t0: 0.1, peak: 0.8, t1: 2.8, I: 30 });
};

// Golden notes, a fountain of spinning coins and sparkles.
BUILD.songoffortune = (e) => {
  e.end = 2.8; e.life = 3.4;
  const gold = hc('#ffd040', 2.8), white = hc('#fff6d0', 3);
  staff(e, { r: 1.45, y0: 0.2, y1: 1.8, turns: 1.1, col: gold, col2: hc('#ffa020', 2) });
  notes(e, { count: 26, col: gold, col2: white, r: 1.45 });
  e.particles({
    count: 60, shape: 'COIN', colA: hc('#ffc040', 1.4), hot: 0.5, gravity: [0, -8, 0], fade: [0.05, 0.85], grow: [0.5, 0.1, 1], pull: 0.2,
    spawn: (p) => { const th = R(0, TAU), s = R(0.6, 1.6); p.x = Math.cos(th) * 0.2; p.z = Math.sin(th) * 0.2; p.y = 1.0; p.vx = Math.cos(th) * s; p.vz = Math.sin(th) * s; p.vy = R(3, 5); p.birth = R(0.3, 1.6); p.life = R(1.0, 1.3); p.size = R(0.22, 0.3); },
  });
  motes(e, { count: 150, shape: 'STAR', col: white, col2: gold, r0: 0.2, r1: 1.8, t0: 0.2, t1: 2.2, vy: [0.5, 1.5], size: [0.1, 0.2] });
  glowPool(e, { r: 2.4, col: hc('#ffb020', 0.8), peak: 0.8, t1: 3.0 });
  e.light({ col: '#ffd060', y: 1.4, t0: 0.1, peak: 0.8, t1: 2.8, I: 35 });
};

// --- generic ------------------------------------------------------------------------------

// Temple / shrine blessing: soft golden light falling from above.
BUILD.bless = (e) => {
  e.end = 2.4; e.life = 3.0;
  const gold = hc('#ffe090', 2.2), white = hc('#fffae8', 2.6);
  column(e, 'BEAM', { r: 1.5, h: 14, colA: white, colB: gold, t0: 0.0, rise: 0.6, fromSky: true, t1: 2.9, out: 1.3, alpha: 0.7, speed: -1.5, param: [0.4], hot: 0.4 });
  glowPool(e, { r: 2.4, col: hc('#ffd070', 0.9), col2: hc('#fffae8', 0.3), peak: 0.7, t1: 2.9 });
  e.particles({
    count: 70, shape: 'GLOW', colA: white, colB: gold, hot: 0.8, wobble: 0.2, fade: [0.15, 0.7], grow: [1, 0.3, 0.5],
    spawn: (p) => { const th = R(0, TAU), rr = Math.sqrt(Math.random()) * 1.4; p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = R(3, 7); p.vy = R(-2.2, -1.2); p.birth = R(0.2, 1.8); p.life = R(1.2, 2.0); p.size = R(0.06, 0.12); },
  });
  motes(e, { count: 40, shape: 'STAR', col: white, col2: gold, r0: 0.2, r1: 1.2, t0: 0.5, t1: 2.0, vy: [0.4, 0.9], size: [0.12, 0.2] });
  lightRing(e, { col: white, col2: gold, width: 0.06 }, (t) => [1.8 + 0.05 * Math.sin(t * 3), 0.55, env(t, 0.4, 0.8, 2.0, 2.7)]);
  e.light({ col: '#ffe0a0', y: 2.5, t0: 0, peak: 0.8, t1: 2.8, I: 35 });
};

// Hero level-up: a golden ring rises up the figure shedding sparkles, then a burst of stars.
BUILD.levelup = (e) => {
  e.end = 2.2; e.life = 2.8;
  const gold = hc('#ffcc40', 3), white = hc('#fff6d8', 3.2);
  const ringY = (t) => 0.05 + 2.1 * easeOut((t - 0.1) / 0.9);
  const ringR = (t) => 1.2 - 0.5 * easeOut((t - 0.1) / 0.9);
  for (let k = 0; k < 2; k++) {
    const d = k * 0.15;
    lightRing(e, { col: k ? gold : white, col2: gold, width: k ? 0.05 : 0.09, hot: 0.8 }, (t) => [ringY(t - d), ringR(t - d), env(t, 0.1 + d, 0.2 + d, 1.0, 1.4)]);
  }
  e.particles({
    count: 120, shape: 'STAR', colA: white, colB: gold, hot: 1, gravity: [0, -1.5, 0], drag: 1, fade: [0.05, 0.5], grow: [1, 0.2, 0.3],
    spawn: (p) => { const b = R(0.1, 1.0), th = R(0, TAU), rr = ringR(b); p.x = Math.cos(th) * rr; p.z = Math.sin(th) * rr; p.y = ringY(b); p.vx = Math.cos(th) * R(0.1, 0.6); p.vz = Math.sin(th) * R(0.1, 0.6); p.birth = b; p.life = R(0.6, 1.0); p.size = R(0.12, 0.22); },
  });
  column(e, 'BEAM', { r: 0.7, h: 3.2, colA: white, colB: gold, t0: 0.05, rise: 0.4, t1: 1.8, out: 0.8, alpha: 0.6, speed: 4, param: [0.8] });
  flash(e, { t0: 1.0, size: 3, y: 2.2, col: gold });
  e.particles({
    count: 50, shape: 'STAR', colA: white, colB: gold, hot: 1, gravity: [0, -2.5, 0], drag: 1.2, fade: [0.05, 0.6], grow: [1, 0.2, 0.5],
    spawn: (p) => { const th = R(0, TAU), s = R(1.5, 3.5), vy = R(0.2, 1); p.y = 2.2; p.vx = Math.cos(th) * s; p.vz = Math.sin(th) * s; p.vy = vy * s; p.birth = 1.0; p.life = R(0.9, 1.4); p.size = R(0.2, 0.35); },
  });
  glowPool(e, { r: 2.0, col: hc('#ffc040', 0.8), peak: 0.6, t1: 2.4 });
  e.light({ col: '#ffd060', y: 1.8, t0: 0.05, peak: 1.0, t1: 2.2, I: 45 });
};

// City captured: a burst in the conqueror's colour (opts.color).
BUILD.capture = (e, o) => {
  e.end = 2.0; e.life = 2.8;
  const base = new THREE.Color(o.color ?? '#ffe070');
  const lum = base.r * 0.2126 + base.g * 0.7152 + base.b * 0.0722;
  if (lum < 0.12) base.lerp(WHITE, 0.35); // very dark banners still need to glow
  const col = base.clone().multiplyScalar(2.8 / Math.max(0.35, Math.max(base.r, base.g, base.b)));
  const white = hc('#ffffff', 3);
  flash(e, { t0: 0.1, size: 5, y: 1.2, col, hot: 1.5, dur: 0.6 });
  column(e, 'BEAM', { r: 0.9, h: 9, colA: white, colB: col, t0: 0.05, rise: 0.25, t1: 1.8, out: 1.0, speed: 5, param: [0.6], pinch: 0.8, hot: 0.8 });
  shock(e, { t0: 0.1, r: 5.5, col, col2: white, dur: 1.0 });
  shock(e, { t0: 0.3, r: 3.5, col, dur: 0.8 });
  sparks(e, { t0: 0.1, count: 150, y: 0.6, speed: [5, 11], up: 0.1, col: white, col2: col, gravity: -7 });
  e.particles({
    count: 120, shape: 'STAR', colA: col, colB: white, hot: 0.8, drag: 1.5, gravity: [0, -3, 0], fade: [0.05, 0.7], grow: [1, 0.2, 0.5],
    spawn: (p) => { const th = R(0, TAU), s = R(1, 4); p.y = R(0.5, 1.5); p.vx = Math.cos(th) * s; p.vz = Math.sin(th) * s; p.vy = R(3, 7); p.birth = R(0.1, 0.3); p.life = R(1.2, 2.0); p.size = R(0.14, 0.26); p.mix = Math.random() * 0.5; },
  });
  glowPool(e, { r: 3.0, col: col.clone().multiplyScalar(0.3), peak: 0.2, t1: 2.4 });
  e.light({ col: '#' + base.getHexString(), y: 2, t0: 0, peak: 0.15, t1: 1.9, I: 60 });
};

// --- ongoing aura ---------------------------------------------------------------------------

/** Subtle looping aura: slowly turning rune ring, faint glow and a few motes. */
function buildAura(e, meta) {
  const base = new THREE.Color(meta.color);
  const col = base.clone().multiplyScalar(1.8), dim = base.clone().multiplyScalar(0.8);
  const curse = meta.kind === 'curse';
  const pat = { buff: 0, curse: 1, summon: 2, utility: 4 }[meta.kind] ?? 0;
  const ring = e.decal('RUNES', 1.15, { colA: col, colB: dim, hot: 0.2, param: [1, 0, pat, 18], alpha: 0.45, y: 0.045, seg: 16 });
  e.anim((t) => { ring.u.uParam.value.y = t * (curse ? -0.25 : 0.25); });
  e.decal('GLOW', 1.5, { colA: base.clone().multiplyScalar(0.3), param: [3, 0, 0, 0], y: 0.04, seg: 16 });
  e.particles({
    count: 18, shape: 'GLOW', polar: true, loop: true, colA: col, colB: base.clone().multiplyScalar(2.6), hot: 0.5, wobble: 0.06,
    grow: [0.4, 0.3, 0.3], fade: [0.2, 0.6],
    spawn: (p) => {
      p.x = R(0.35, 1.05); p.y = R(0, TAU); p.z = curse ? R(1.3, 1.7) : R(0.0, 0.2);
      p.vy = R(0.2, 0.5) * (curse ? -1 : 1); p.vz = curse ? -R(0.35, 0.55) : R(0.35, 0.6);
      p.birth = R(0, 3); p.life = R(2.2, 3.0); p.size = R(0.07, 0.11);
    },
  });
}

// ---------------------------------------------------------------------------------------

/**
 * Spell effect library. Owns a group in the scene, two pooled point lights (always in
 * the scene so light count never changes and materials never recompile) and every
 * running effect / aura. Call update(dt) every frame.
 */
export class SpellFX {
  /** opts.heightAt(x, z): default ground sampler for draping decals (per-call opts override it). */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.heightAt = opts.heightAt || null;
    this.group = new THREE.Group();
    this.group.name = 'SpellFX';
    scene.add(this.group);
    this.effects = [];
    this.auras = [];
    this.lights = [0, 1].map(() => {
      const l = new THREE.PointLight(0xffffff, 0, 14, 2);
      l.castShadow = false;
      this.group.add(l);
      return l;
    });
    this._req = [];
  }

  /**
   * Plays spell `id` at ground point `pos`. Resolves when the main effect is over (the
   * fade-out tail continues briefly). opts: scale, target (teleport destination),
   * onSpawn (summons), heightAt(x, z) ground sampler, color (capture).
   */
  play(id, pos, opts = {}) {
    const build = BUILD[id];
    if (!build) {
      console.warn(`SpellFX: unknown spell '${id}'`);
      opts.onSpawn?.();
      return Promise.resolve();
    }
    const e = new Effect(this, pos, opts);
    build(e, opts);
    const done = new Promise((resolve) => { e.resolve = resolve; });
    this.effects.push(e);
    e.step(0);
    return done;
  }

  /**
   * Ongoing aura following object3D's world position; returns { dispose() }.
   * opts: scale, heightAt (drapes the aura's ground ring over the terrain as it moves).
   */
  aura(object3D, spellId, opts = {}) {
    const meta = SPELL_FX[spellId] || { color: '#ffffff', kind: 'buff' };
    const e = new Effect(this, new THREE.Vector3(), { scale: opts.scale ?? 1, heightAt: opts.heightAt });
    object3D.getWorldPosition(e.root.position);
    buildAura(e, meta);
    const a = {
      effect: e, object: object3D, last: new THREE.Vector3(1e9, 0, 0),
      dispose: () => {
        const i = this.auras.indexOf(a);
        if (i >= 0) this.auras.splice(i, 1);
        e.dispose();
      },
    };
    this.auras.push(a);
    this._followAura(a);
    return a;
  }

  _followAura(a) {
    const root = a.effect.root;
    let vis = !!a.object.parent;
    for (let o = a.object; o && vis; o = o.parent) if (!o.visible) vis = false;
    root.visible = vis;
    if (!vis) return;
    a.object.getWorldPosition(root.position);
    // re-drape the ground ring once the stack has moved
    if (a.effect.drapes.length && root.position.distanceToSquared(a.last) > 0.0004) {
      a.last.copy(root.position);
      for (const d of a.effect.drapes) a.effect.drape(d);
    }
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const req = this._req;
    req.length = 0;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.step(dt);
      if (e.t >= e.life) { e.dispose(); this.effects.splice(i, 1); continue; }
      e._collectLights(req);
    }
    for (const a of this.auras) { a.effect.step(dt); this._followAura(a); }
    // the two strongest light requests get the pooled lights
    req.sort((a, b) => b.i - a.i);
    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k], r = req[k];
      if (r) { l.position.copy(r.pos); l.color.copy(r.col); l.intensity = r.i; l.distance = r.dist * r.root.scale.x; }
      else l.intensity = 0;
    }
  }

  /**
   * Compiles every effect shader up front, avoiding a hitch on each spell's first cast.
   * Pass the render target the scene is drawn into (with PostFX: post.composer.readBuffer)
   * so the programs match the real render state. The warm-up materials are kept (never
   * disposed) so their programs stay cached. Returns a Promise when compileAsync exists.
   */
  prewarm(renderer, camera, target = null) {
    const far = new THREE.Vector3(0, -1000, 0);
    const tmp = Object.keys(BUILD).map((id) => { const e = new Effect(this, far, {}); BUILD[id](e, {}); return e; });
    const a = new Effect(this, far, {});
    buildAura(a, SPELL_FX.haste);
    tmp.push(a);
    this._warm ||= [];
    const finish = () => {
      for (const e of tmp) {
        for (const r of e.roots) r.removeFromParent();
        for (const g of e.geos) g.dispose();
        this._warm.push(...e.mats);
      }
    };
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target ?? prev);
    try {
      if (renderer.compileAsync) {
        const p = renderer.compileAsync(this.scene, camera);
        renderer.setRenderTarget(prev);
        return p.then(finish, (err) => { finish(); throw err; });
      }
      renderer.compile(this.scene, camera);
    } finally {
      renderer.setRenderTarget(prev);
    }
    finish();
    return Promise.resolve();
  }

  /** Stops everything (pending promises resolve, pending onSpawn callbacks fire). */
  clear() {
    for (const e of this.effects) e.dispose();
    this.effects.length = 0;
    for (const a of [...this.auras]) a.dispose();
    for (const l of this.lights) l.intensity = 0;
  }

  dispose() {
    this.clear();
    for (const m of this._warm || []) m.dispose();
    this.group.removeFromParent();
  }
}
