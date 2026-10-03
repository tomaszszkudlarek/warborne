import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL } from './shaders/common.js';
import { SiteTypes } from '../generator/terrainTypes.js';

// Atmosphere round the ruins and shrines: thin smoke curling up from ruins not yet searched,
// tinted from below by the site's own light, and glowing motes drifting round every shrine and
// (more, bigger and brighter) round every ruin not yet searched: a searched ruin goes dark. The colours match the glow of each model (and the light NightGlow splats under it).
export const SITE_LIGHT = {
  tower: [0.62, 0.42, 1.0], // cold violet sorcery
  cave: [0.45, 1.0, 0.25], // witch-fire braziers
  dungeon: [0.45, 1.0, 0.3],
  temple: [0.72, 0.3, 1.0], // the cursed crystal
  crypt: [0.3, 1.0, 0.6], // grave-lanterns
  circle: [0.45, 0.82, 1.0], // pale rune-light
  sanctum: [1.0, 0.8, 0.45], // holy gold
  obelisk: [0.7, 0.3, 1.0],
};
const SMOKE_PER_RUIN = 28;
const MOTES_PER_SITE = 24; // room for a ruin's swarm; a shrine lights only SHRINE_MOTES of them
const SHRINE_MOTES = 14;
const RUIN_MOTE_BOOST = 1.6; // a ruin's motes: size and brightness against a shrine's

function particles(sites, per, smoke, onOf = () => 1) {
  const n = sites.length * per;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4), col = new Float32Array(n * 3), on = new Float32Array(n);
  sites.forEach((s, si) => {
    const c = SITE_LIGHT[s.type] ?? [1, 1, 1];
    for (let i = 0; i < per; i++) {
      const o = si * per + i;
      pos.set([s.x, s.y, s.z], o * 3);
      seed.set([Math.random(), Math.random(), Math.random(), Math.random()], o * 4);
      col.set(c, o * 3);
      on[o] = onOf(s, i);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aOn', new THREE.BufferAttribute(on, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uWind: U.uWind, uAmbient: U.uAmbient, uSunColor: U.uSunColor,
      uPointScale: { value: 800 },
      ...THREE.UniformsLib.fog,
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uPointScale;
      uniform vec2 uWind;
      attribute vec4 aSeed;
      attribute vec3 aColor;
      attribute float aOn;
      varying float vLife, vSeed, vOn;
      varying vec3 vColor;
      #include <fog_pars_vertex>
      void main() {
        float rate = ${smoke ? '0.07 + aSeed.w * 0.05' : '0.12 + aSeed.w * 0.12'};
        float life = fract(uTime * rate + aSeed.x);
        vLife = life; vSeed = aSeed.y; vOn = aOn; vColor = aColor;
        vec3 p = position;
        ${smoke
          ? `p.xz += (aSeed.yz - 0.5) * 0.9;
             p.y += 0.5 + life * 3.4;
             p.xz += (uWind + vec2(0.2, 0.08)) * life * life * 2.6;
             p.xz += vec2(sin(life * 6.0 + aSeed.w * 6.28), cos(life * 5.0 + aSeed.y * 6.28)) * life * 0.45;`
          : `float a = aSeed.y * 6.2832 + uTime * (0.15 + aSeed.z * 0.2);
             float r = 0.45 + aSeed.z * 0.75;
             p.xz += vec2(cos(a), sin(a)) * r;
             p.y += 0.15 + life * 1.6 + sin(uTime * 1.7 + aSeed.w * 20.0) * 0.08;`}
        vec4 mvPosition = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float size = ${smoke ? 'mix(0.35, 1.7, sqrt(life))' : '0.07 * aOn'};
        gl_PointSize = aOn < 0.5 ? 0.0 : min(size * uPointScale / -mvPosition.z, ${smoke ? '220.0' : '6.0 * aOn'});
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uAmbient, uSunColor;
      uniform float uTime;
      varying float vLife, vSeed, vOn;
      varying vec3 vColor;
      ${noiseGLSL}
      #include <fog_pars_fragment>
      void main() {
        if (vOn < 0.5) discard;
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        ${smoke
          ? `float n = vnoise(c * 4.0 + vSeed * 30.0 + uTime * 0.25);
             float a = smoothstep(0.5, 0.08, d + n * 0.2) * smoothstep(0.0, 0.15, vLife) * (1.0 - vLife) * 0.26;
             vec3 col = mix(vec3(0.06, 0.06, 0.065), vec3(0.2, 0.2, 0.21), vLife) * (uAmbient * 1.2 + uSunColor * 0.2);
             col += vColor * smoothstep(0.45, 0.0, vLife) * 0.22; // lit from below by the site's glow`
          : `float a = smoothstep(0.5, 0.0, d) * sin(vLife * 3.1416) * (0.6 + 0.4 * sin(uTime * 6.0 + vSeed * 40.0));
             vec3 col = vColor * 2.4 * vOn;`}
        gl_FragColor = vec4(col, a);
        if (a < 0.01) discard;
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
    fog: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = smoke ? 7 : 8;
  return pts;
}

/** Smoke over the ruins and motes round every site; userData.setExplored(flags per map.sites)
 * puts out a searched ruin's smoke and motes, userData.setPointScale(s) as for the volcanoes. */
export function createSiteFX(map) {
  const sites = map.sites ?? [];
  if (!sites.length) return null;
  const ruins = sites.map((s, i) => ({ s, i })).filter((x) => SiteTypes[x.s.type]?.kind === 'ruin');
  const group = new THREE.Group();
  group.name = 'siteFX';
  const smoke = ruins.length ? particles(ruins.map((x) => x.s), SMOKE_PER_RUIN, true) : null;
  const isRuin = (s) => SiteTypes[s.type]?.kind === 'ruin';
  const motes = particles(sites, MOTES_PER_SITE, false, (s, i) => (isRuin(s) ? RUIN_MOTE_BOOST : i < SHRINE_MOTES ? 1 : 0));
  if (smoke) group.add(smoke);
  group.add(motes);
  group.userData.setExplored = (flags) => {
    if (!smoke) return;
    const on = smoke.geometry.attributes.aOn, mon = motes.geometry.attributes.aOn;
    ruins.forEach(({ i }, k) => {
      on.array.fill(flags[i] ? 0 : 1, k * SMOKE_PER_RUIN, (k + 1) * SMOKE_PER_RUIN);
      mon.array.fill(flags[i] ? 0 : RUIN_MOTE_BOOST, i * MOTES_PER_SITE, (i + 1) * MOTES_PER_SITE);
    });
    on.needsUpdate = true;
    mon.needsUpdate = true;
  };
  group.userData.setPointScale = (s) => {
    if (smoke) smoke.material.uniforms.uPointScale.value = s;
    motes.material.uniforms.uPointScale.value = s;
  };
  return group;
}
