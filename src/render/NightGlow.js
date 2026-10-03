import * as THREE from 'three';
import { U } from './uniforms.js';
import { Flag, Factions, SiteTypes } from '../generator/terrainTypes.js';
import { SITE_LIGHT } from './SiteFX.js';

// Light that things on the map give off: lava, volcano craters, castles, ruins, shrines,
// special sites, forges and the armies. Instead of hundreds of point lights, the sources are
// splatted into light textures laid over the map (TEX_PER_TILE texels a tile) that every
// lit material samples by world position; a few marching armies, which move every frame,
// get their own uniform slots. Two layers: fire (lava, embers, forges) shows only at night;
// the beacons of what matters to the player (cities, ruins, shrines, sites, armies in their
// side's colour) glow all the time, day and night alike (DAY_GLOW), so they stay visible in fog
// and storms before the night comes — the dark just makes them stand out more.
const TEX_PER_TILE = 4;
const DAY_GLOW = 1.0;
const BEACON = 0.8; // strength of the beacons (and armies) against the fire
const SCALE = 4; // the texture stores light / SCALE (8-bit, linear filtered)
export const DYN_MAX = 4;
const patched = new WeakSet(); // (not userData: a clone would copy the flag but not the hook)

const COLORS = {
  lava: [1.0, 0.32, 0.07],
  crater: [1.0, 0.38, 0.1],
  castle: [1.0, 0.7, 0.3], // warm hearth gold
  embers: [0.9, 0.25, 0.06],
  shrine: [0.3, 1.0, 0.35],
  ruin: [1.0, 0.12, 0.08],
  site: [0.35, 0.62, 1.0], // special sites: an arcane azure lantern
  forge: [1.0, 0.45, 0.12],
  torch: [1.0, 0.62, 0.3], // neutral armies
};
// sources that glow by day too (the rest is fire, seen only at night)
const ALWAYS = new Set(['castle', 'shrine', 'ruin', 'site']);

/** The light an army gives off: its side's colour at full brightness (Lord Vhane's black
 * turns into a ghostly grave-light). */
export const SIDE_LIGHT = Factions.map((f) => {
  if (/Vhane/.test(f.name)) return [0.35, 1.0, 0.8];
  const n = parseInt(f.color.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const m = Math.max(...c);
  return c.map((v) => v / m);
});
const armyLight = (owner) => SIDE_LIGHT[owner] ?? COLORS.torch;

const glowParsV = /* glsl */ `
varying vec3 vNgPos;`;
const glowV = /* glsl */ `
{
  vec4 ngP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  ngP = instanceMatrix * ngP;
  #endif
  vNgPos = (modelMatrix * ngP).xyz;
}`;
const glowParsF = /* glsl */ `
varying vec3 vNgPos;
uniform sampler2D uNgTex, uNgTexA;
uniform vec2 uNgSize;
uniform float uNgNight, uNgTime;
uniform vec4 uNgDyn[${DYN_MAX}];
uniform vec3 uNgDynC[${DYN_MAX}];
vec3 nightGlow(vec3 p) {
  float k = smoothstep(0.05, 0.85, uNgNight);
  float ka = mix(${DAY_GLOW.toFixed(2)}, 1.0, k);
  vec2 uv = (p.xz + uNgSize * 0.5) / uNgSize;
  // fire flickers, beacons only breathe
  float fl = 0.88 + 0.07 * sin(uNgTime * 8.3 + p.x * 1.9 + p.z * 1.3) + 0.05 * sin(uNgTime * 13.7 - p.z * 2.3);
  vec3 c = texture2D(uNgTex, uv).rgb * (${SCALE.toFixed(1)} * k * fl);
  c += texture2D(uNgTexA, uv).rgb * (${(SCALE * BEACON).toFixed(2)} * ka * (0.6 + 0.4 * fl));
  for (int i = 0; i < ${DYN_MAX}; i++) {
    vec4 d = uNgDyn[i];
    if (d.w <= 0.0) continue;
    float r = length(p.xz - d.xy) / d.z;
    float f = max(0.0, 1.0 - r * r);
    c += uNgDynC[i] * d.w * f * f * ka * ${BEACON.toFixed(2)};
  }
  return c;
}`;

export class NightGlow {
  constructor() {
    this.uniforms = {
      uNgTex: { value: null },
      uNgTexA: { value: null },
      uNgSize: { value: new THREE.Vector2(1, 1) },
      uNgNight: U.uNight,
      uNgTime: U.uTime,
      uNgDyn: { value: Array.from({ length: DYN_MAX }, () => new THREE.Vector4()) },
      uNgDynC: { value: Array.from({ length: DYN_MAX }, () => new THREE.Vector3()) },
    };
    this.map = null;
    this.static = null; // Float32Array rgb per texel: map sources (night fire)
    this.staticA = null; // ... and the beacons that glow all the time
    this.armies = []; // [{ x, z, owner }] standing armies (visible to the viewer)
  }

  /** Sets up the light texture for a map and splats its fixed sources. */
  setMap(map, extra = []) {
    this.map = map;
    const g = map.grid;
    this.W = g.tilesW * TEX_PER_TILE;
    this.H = g.tilesH * TEX_PER_TILE;
    this.texel = g.tileSize / TEX_PER_TILE;
    this.uniforms.uNgSize.value.set(g.worldW, g.worldH);
    this.acc = new Float32Array(this.W * this.H * 3);
    const make = (old) => {
      old?.dispose();
      const tex = new THREE.DataTexture(new Uint8Array(this.W * this.H * 4), this.W, this.H, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    };
    this.tex = make(this.tex);
    this.texA = make(this.texA);
    this.uniforms.uNgTex.value = this.tex;
    this.uniforms.uNgTexA.value = this.texA;
    this.extra = extra;
    this.armies = [];
    this.rebuildStatic();
  }

  /** Re-splats the map's fixed sources (after castles were razed or rebuilt). */
  rebuildStatic() {
    const map = this.map;
    if (!map) return;
    const g = map.grid, T = g.tileSize;
    this.static = new Float32Array(this.W * this.H * 3);
    this.staticA = new Float32Array(this.W * this.H * 3);
    const tc = (t) => [((t % g.tilesW) + 0.5) * T - g.worldW / 2, (((t / g.tilesW) | 0) + 0.5) * T - g.worldH / 2];
    const into = this.static, always = this.staticA;
    for (let t = 0; t < g.tilesW * g.tilesH; t++) {
      if (!(map.flags[t] & Flag.LAVA)) continue;
      const [x, z] = tc(t);
      this._splat(into, x, z, 1.9 * T, COLORS.lava, 0.28);
    }
    for (const v of map.volcanoes ?? []) this._splat(into, v.x, v.z, 4 * T, COLORS.crater, 0.5);
    for (const c of map.cities ?? []) {
      if (c.razed) this._splat(into, c.x, c.z, 2.2 * T, COLORS.embers, 0.5);
      else this._splat(always, c.x, c.z, (2.2 + 0.25 * (c.level ?? 1)) * T, COLORS.castle, 0.55);
    }
    for (const s of map.sites ?? []) {
      const [x, z] = tc(s.ty * g.tilesW + s.tx);
      const shrine = SiteTypes[s.type]?.kind === 'shrine';
      // each site in the colour of its own glow; a searched ruin keeps only a faint ember of its menace
      if (shrine) this._splat(always, x, z, 1.9 * T, SITE_LIGHT[s.type] ?? COLORS.shrine, 0.4);
      else this._splat(always, x, z, 1.9 * T, SITE_LIGHT[s.type] ?? COLORS.ruin, s.explored ? 0.06 : 0.6);
    }
    for (const e of this.extra) this._splat(ALWAYS.has(e.color) ? always : into, e.x, e.z, e.r * T, COLORS[e.color] ?? COLORS.torch, e.k ?? 0.6);
    this._compose();
  }

  /** Marks searched ruins (index into map.sites) — they dim. */
  setExplored(list) {
    const sites = this.map?.sites ?? [];
    let changed = false;
    sites.forEach((s, i) => { const e = !!list[i]; if (!!s.explored !== e) { s.explored = e; changed = true; } });
    if (changed) this.rebuildStatic();
  }

  /** Extra fixed sources: [{ x, z, r (tiles), color, k }] (special sites and their forges ...). */
  setExtra(list) { this.extra = list; this.rebuildStatic(); }

  /** Standing armies, which light the ground in their side's colour: [{ x, z, owner }]. */
  setArmies(list) {
    const key = list.map((a) => `${a.x.toFixed(2)},${a.z.toFixed(2)},${a.owner}`).join('|');
    if (key === this._armyKey) return;
    this._armyKey = key;
    this.armies = list;
    this._compose();
  }

  /** Marching armies (moving every frame): [{ x, z, owner }], at most DYN_MAX. */
  setMoving(list) {
    const d = this.uniforms.uNgDyn.value, col = this.uniforms.uNgDynC.value;
    const T = this.map?.grid.tileSize ?? 1;
    for (let i = 0; i < DYN_MAX; i++) {
      const a = list[i];
      if (a) { d[i].set(a.x, a.z, 1.4 * T, 0.75); col[i].fromArray(armyLight(a.owner)); } else d[i].w = 0;
    }
  }

  _compose() {
    if (!this.static) return;
    this._upload(this.static, this.tex);
    const acc = this.acc;
    acc.set(this.staticA);
    const T = this.map.grid.tileSize;
    for (const a of this.armies) this._splat(acc, a.x, a.z, 1.4 * T, armyLight(a.owner), 0.75);
    this._upload(acc, this.texA);
  }

  _upload(acc, tex) {
    const data = tex.image.data;
    for (let i = 0, n = this.W * this.H; i < n; i++) {
      // soft ceiling so lava fields and crowded castles don't burn out
      for (let c = 0; c < 3; c++) {
        const v = acc[i * 3 + c];
        data[i * 4 + c] = Math.min(255, Math.round((v / (1 + v * 0.45)) / SCALE * 255));
      }
      data[i * 4 + 3] = 255;
    }
    tex.needsUpdate = true;
  }

  _splat(into, x, z, r, col, k) {
    const g = this.map.grid;
    const px = (x + g.worldW / 2) / this.texel - 0.5, pz = (z + g.worldH / 2) / this.texel - 0.5;
    const rr = r / this.texel;
    const x0 = Math.max(0, Math.floor(px - rr)), x1 = Math.min(this.W - 1, Math.ceil(px + rr));
    const z0 = Math.max(0, Math.floor(pz - rr)), z1 = Math.min(this.H - 1, Math.ceil(pz + rr));
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d2 = ((i - px) ** 2 + (j - pz) ** 2) / (rr * rr);
        if (d2 >= 1) continue;
        const f = (1 - d2) ** 2 * k;
        const o = (j * this.W + i) * 3;
        into[o] += col[0] * f; into[o + 1] += col[1] * f; into[o + 2] += col[2] * f;
      }
    }
  }

  /** Makes the lit materials under `obj` (standard, physical, lambert, phong) take the night glow. */
  patch(obj) {
    obj?.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.patchMaterial(m);
    });
  }

  patchMaterial(m) {
    if (!m || patched.has(m)) return;
    if (!(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return;
    patched.add(m);
    const prev = m.onBeforeCompile;
    // the program cache key must still tell materials with different hooks apart
    const key = m.customProgramCacheKey();
    const uniforms = this.uniforms;
    m.onBeforeCompile = function (shader, renderer) {
      prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>${glowParsV}`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>${glowV}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${glowParsF}`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectDiffuse += nightGlow(vNgPos) * diffuseColor.rgb;`);
    };
    m.customProgramCacheKey = () => `${key}|ng`;
    m.needsUpdate = true;
  }
}
