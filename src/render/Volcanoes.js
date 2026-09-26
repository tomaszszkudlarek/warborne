import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL } from './shaders/common.js';

function particles(volcanoes, perVolcano, { smoke }) {
  const n = volcanoes.length * perVolcano;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n * 4);
  volcanoes.forEach((v, vi) => {
    for (let i = 0; i < perVolcano; i++) {
      const o = vi * perVolcano + i;
      pos.set([v.x, v.y + 0.2, v.z], o * 3);
      seed.set([Math.random(), Math.random(), Math.random(), Math.random()], o * 4);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
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
      varying float vLife;
      varying float vSeed;
      #include <fog_pars_vertex>
      void main() {
        float rate = ${smoke ? '0.05 + aSeed.w * 0.03' : '0.35 + aSeed.w * 0.3'};
        float life = fract(uTime * rate + aSeed.x);
        vLife = life; vSeed = aSeed.y;
        vec3 p = position;
        p.xz += (aSeed.yz - 0.5) * ${smoke ? '1.4' : '1.6'};
        ${smoke
          ? `p.y += life * 16.0;
             p.xz += (uWind + vec2(0.35, 0.1)) * life * life * 14.0;
             p.xz += vec2(sin(life * 5.0 + aSeed.w * 6.28), cos(life * 4.0 + aSeed.y * 6.28)) * life * 2.0;`
          : `p.y += life * 7.0 - life * life * 3.0;
             p.xz += (aSeed.yz - 0.5) * life * 5.0 + uWind * life * 2.0;`}
        vec4 mvPosition = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float size = ${smoke ? 'mix(1.2, 6.5, sqrt(life))' : '0.12 * (1.0 - life)'};
        gl_PointSize = min(size * uPointScale / -mvPosition.z, ${smoke ? '400.0' : '3.5'});
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uAmbient, uSunColor;
      uniform float uTime;
      varying float vLife;
      varying float vSeed;
      ${noiseGLSL}
      #include <fog_pars_fragment>
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        ${smoke
          ? `float n = vnoise(c * 5.0 + vSeed * 30.0 + uTime * 0.2);
             float a = smoothstep(0.5, 0.1, d + n * 0.18) * smoothstep(0.0, 0.08, vLife) * (1.0 - vLife) * 0.4;
             vec3 col = mix(vec3(0.07, 0.065, 0.06), vec3(0.22, 0.21, 0.21), vLife) * (uAmbient * 1.2 + uSunColor * 0.22);
             col += vec3(1.0, 0.3, 0.06) * smoothstep(0.1, 0.0, vLife) * 0.3;`
          : `float a = smoothstep(0.5, 0.0, d);
             vec3 col = mix(vec3(3.0, 1.1, 0.2), vec3(1.2, 0.2, 0.03), vLife) * (1.0 - vLife * 0.5);`}
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

export function createVolcanoFX(map) {
  if (!map.volcanoes.length) return null;
  const group = new THREE.Group();
  group.name = 'volcanoFX';
  const smoke = particles(map.volcanoes, 140, { smoke: true });
  const embers = particles(map.volcanoes, 90, { smoke: false });
  group.add(smoke, embers);
  const lights = map.volcanoes.map((v) => {
    const l = new THREE.PointLight(0xff5a1a, 14, 28, 2);
    l.position.set(v.x, v.rim + 4, v.z);
    group.add(l);
    return l;
  });
  group.userData.update = (t) => {
    lights.forEach((l, i) => {
      l.intensity = 13 + Math.sin(t * 7 + i) * 2 + Math.sin(t * 13.3 + i * 2) * 1.5;
    });
  };
  group.userData.setPointScale = (s) => {
    smoke.material.uniforms.uPointScale.value = s;
    embers.material.uniforms.uPointScale.value = s;
  };
  return group;
}
