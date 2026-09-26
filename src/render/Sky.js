import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL } from './shaders/common.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerpColor = (out, a, b, t) => out.copy(a).lerp(b, t);

// Shadows fade out toward the edge of the shadow map instead of stopping at a line, so
// the sun's shadow frustum can close in around the view when the camera zooms in.
THREE.ShaderChunk.shadowmap_pars_fragment = (() => {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  const cut = src.indexOf('getPointShadow');
  const fade = `float shadowEdge = max( abs( shadowCoord.x - 0.5 ), abs( shadowCoord.y - 0.5 ) ) * 2.0;
			shadow = mix( shadow, 1.0, smoothstep( 0.82, 0.98, shadowEdge ) );
			return mix( 1.0, shadow, shadowIntensity );`;
  return src.slice(0, cut).replaceAll('return mix( 1.0, shadow, shadowIntensity );', fade) + src.slice(cut);
})();

// Palette keyframes (linear HDR).
const C = {
  dayZenith: new THREE.Color(0.11, 0.3, 0.78),
  dayHorizon: new THREE.Color(0.55, 0.7, 0.9),
  duskZenith: new THREE.Color(0.12, 0.14, 0.34),
  duskHorizon: new THREE.Color(1.0, 0.45, 0.2),
  nightZenith: new THREE.Color(0.025, 0.045, 0.11),
  nightHorizon: new THREE.Color(0.07, 0.09, 0.16),
  overcast: new THREE.Color(0.42, 0.45, 0.5),
  sunNoon: new THREE.Color(1.0, 0.95, 0.86),
  sunLow: new THREE.Color(1.0, 0.45, 0.16),
  moon: new THREE.Color(0.65, 0.75, 1.0),
};

const skyFragment = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSunDir, uSunTrueDir, uSkyColor, uHorizonColor, uGlowColor, uDiscColor;
uniform float uCloudCover, uTime, uNight, uOvercast, uSunVisible;
uniform vec2 uCloudOffset;
${noiseGLSL}
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float hz = pow(1.0 - max(y, 0.0), 4.0);
  vec3 col = mix(uSkyColor, uHorizonColor, hz);
  if (y < 0.0) col = mix(uHorizonColor, uHorizonColor * 0.55, smoothstep(0.0, -0.25, y));

  vec3 S = normalize(uSunTrueDir);
  float sd = max(dot(d, S), 0.0);
  float clearSky = 1.0 - uOvercast * 0.85;
  col += uGlowColor * (pow(sd, 6.0) * 0.45 + pow(sd, 48.0) * 0.9) * clearSky;
  float disc = smoothstep(0.99965, 0.9998, sd);
  col += uDiscColor * disc * 45.0 * clearSky * uSunVisible;

  // moon (opposite the sun)
  vec3 M = normalize(-S + vec3(0.15, 0.1, 0.0));
  float md = dot(d, M);
  float moon = smoothstep(0.99955, 0.9997, md);
  col += vec3(0.9, 0.93, 1.0) * (moon * 2.2 + pow(max(md, 0.0), 180.0) * 0.08) * uNight * clearSky;

  // stars
  if (uNight > 0.01 && y > 0.0) {
    vec3 sp = d * 220.0;
    vec3 cell = floor(sp);
    vec3 rnd = hash33(cell);
    vec3 center = cell + 0.25 + rnd * 0.5;
    float dist = length(sp - center);
    float bright = step(0.93, hash13(cell + 11.0));
    float tw = 0.6 + 0.4 * sin(uTime * (1.0 + rnd.x * 3.0) + rnd.y * 6.28);
    float star = smoothstep(0.12, 0.0, dist) * bright * tw * (0.5 + rnd.z);
    col += vec3(0.8, 0.85, 1.0) * star * 1.4 * uNight * clearSky * smoothstep(0.0, 0.2, y);
    // milky band
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, 0.8))) * 3.5, 2.0));
    col += vec3(0.02, 0.025, 0.04) * band * fbm3(d.xz * 6.0) * uNight * clearSky;
  }

  // clouds projected on a dome
  if (y > 0.0) {
    vec2 uv = d.xz / (y + 0.12) * 60.0 + uCloudOffset;
    float n = fbm5(uv * 0.016);
    float cov = uCloudCover;
    float dens = smoothstep(1.0 - cov * 0.95 - 0.12, 1.0 - cov * 0.95 + 0.25, n);
    float light = mix(0.55, 1.0, smoothstep(0.3, 0.8, n + sd * 0.3));
    vec3 cloudLit = mix(uHorizonColor * 0.9, vec3(1.0), 0.45) * light * max(1.0 - uNight, 0.04);
    cloudLit += uGlowColor * pow(sd, 4.0) * 0.6 * (1.0 - dens * 0.5);
    cloudLit = mix(cloudLit, uHorizonColor * 0.6, uOvercast * 0.6);
    col = mix(col, cloudLit, dens * smoothstep(0.0, 0.15, y) * 0.92);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkySystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.timeOfDay = 15.5; // hours
    this.daySpeed = 0; // game hours per real second
    this.azimuth = 215; // degrees
    this.maxElevation = 58;
    this.overcast = 0; // set by weather
    this.lightningFlash = 0;

    this.uniforms = {
      uSunDir: U.uSunDir,
      uSunTrueDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyColor: U.uSkyColor,
      uHorizonColor: U.uHorizonColor,
      uGlowColor: { value: new THREE.Color() },
      uDiscColor: { value: new THREE.Color() },
      uCloudCover: U.uCloudCover,
      uCloudOffset: U.uCloudOffset,
      uTime: U.uTime,
      uNight: U.uNight,
      uOvercast: { value: 0 },
      uSunVisible: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      name: 'SkyDome',
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.dome.scale.setScalar(4000);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    // Environment capture scene (sky only)
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(this.dome.geometry, mat);
    this.envDome.scale.setScalar(100);
    this.envScene.add(this.envDome);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this._lastEnvKey = null;
    this._envTimer = 0;

    // Main light (sun by day, moon by night)
    this.light = new THREE.DirectionalLight(0xffffff, 3);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(4096, 4096);
    this.light.shadow.bias = -0.0004;
    this.light.shadow.normalBias = 0.06;
    this.light.shadow.radius = 2;
    scene.add(this.light);
    scene.add(this.light.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3020, 0.2);
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xaabbcc, 0.004);
    scene.fog = this.fog;
    this.fogDensity = 0.0035;

    this.sunDir = new THREE.Vector3();
    this.sunElevation = 0;
    this._tmpC = new THREE.Color();
  }

  fitShadowToMap(worldW, worldH) {
    // a margin past the corners keeps the edge fade off the board
    this.mapShadowRadius = (Math.hypot(worldW, worldH) / 2 + 4) * 1.12;
    this._setShadowRadius(this.mapShadowRadius);
  }

  _setShadowRadius(r) {
    if (r === this.shadowRadius) return;
    const cam = this.light.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = r * 2 + 150;
    cam.updateProjectionMatrix();
    this.shadowRadius = r;
  }

  /**
   * Zoomed in, the sun's shadow map covers only the ground around the view (`center`,
   * seen from `viewDist` units along `viewDir`) for crisper shadows; zoomed out, the whole
   * map. The size steps in fixed ratios and the centre snaps to whole shadow texels, so
   * shadows don't crawl as the camera pans and zooms.
   */
  focusShadow(center, viewDist, viewDir) {
    const full = this.mapShadowRadius;
    const target = this.light.target.position;
    if (!full) { target.set(0, 0, 0); return; }
    const STEP = 1.2;
    const want = Math.max(18, 12 + viewDist * 2.2);
    const r = want >= full ? full : full / STEP ** Math.floor(Math.log(full / want) / Math.log(STEP));
    this._setShadowRadius(r);
    if (r === full) { target.set(0, 0, 0); return; }
    // reach further ahead than behind: the far side of the view shows more ground
    const fx = viewDir.x, fz = viewDir.z, fl = Math.hypot(fx, fz) || 1;
    target.set(center.x + (fx / fl) * r * 0.3, center.y, center.z + (fz / fl) * r * 0.3);
    // snap to the shadow texel grid in the light's frame
    const L = U.uSunDir.value;
    const right = this._sr ??= new THREE.Vector3(), up = this._su ??= new THREE.Vector3();
    right.set(0, 1, 0).cross(L);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(L, right);
    const texel = (2 * r) / this.light.shadow.mapSize.x;
    const a = target.dot(right), b = target.dot(up), c = target.dot(L);
    const sa = Math.round(a / texel) * texel, sb = Math.round(b / texel) * texel;
    target.set(0, 0, 0).addScaledVector(right, sa).addScaledVector(up, sb).addScaledVector(L, c);
  }

  update(dt) {
    if (this.daySpeed) this.timeOfDay = (this.timeOfDay + dt * this.daySpeed + 24) % 24;
    const theta = ((this.timeOfDay - 6) / 24) * Math.PI * 2;
    const el = THREE.MathUtils.degToRad(this.maxElevation);
    const az = THREE.MathUtils.degToRad(this.azimuth);
    const sx = Math.cos(theta), sy = Math.sin(theta) * Math.sin(el), sz = Math.sin(theta) * Math.cos(el);
    this.sunDir.set(sx * Math.cos(az) - sz * Math.sin(az), sy, sx * Math.sin(az) + sz * Math.cos(az)).normalize();
    const e = this.sunDir.y;
    this.sunElevation = e;
    const oc = this.overcast;

    const day = smoothstep(-0.12, 0.2, e);
    const dusk = Math.max(0, 1 - Math.abs(e - 0.03) / 0.22) * (1 - oc * 0.7);
    const night = 1 - smoothstep(-0.2, -0.02, e);

    // Sky colours
    const z = this.uniforms.uSkyColor.value, h = this.uniforms.uHorizonColor.value;
    lerpColor(z, C.nightZenith, C.dayZenith, day);
    lerpColor(h, C.nightHorizon, C.dayHorizon, day);
    z.lerp(C.duskZenith, dusk * 0.45);
    h.lerp(C.duskHorizon, dusk * 0.75);
    const ocBright = 0.15 + 0.85 * day;
    this._tmpC.copy(C.overcast).multiplyScalar(ocBright);
    z.lerp(this._tmpC, oc * 0.9);
    h.lerp(this._tmpC, oc * 0.85);
    if (this.lightningFlash > 0) {
      z.addScalar(this.lightningFlash * 0.5);
      h.addScalar(this.lightningFlash * 0.6);
    }
    this.uniforms.uGlowColor.value.copy(C.sunLow).lerp(C.sunNoon, smoothstep(0.05, 0.5, e)).multiplyScalar(day * 0.8 + dusk * 0.8);
    this.uniforms.uDiscColor.value.copy(C.sunLow).lerp(C.sunNoon, smoothstep(0.0, 0.3, e));
    this.uniforms.uSunTrueDir.value.copy(this.sunDir);
    this.uniforms.uOvercast.value = oc;
    U.uNight.value = night;

    // Dominant light: sun, or the moon at night.
    const sunI = smoothstep(-0.04, 0.1, e) * 3.4 * (1 - oc * 0.78);
    const moonI = night * 1.25 * (1 - oc * 0.6);
    const L = U.uSunDir.value;
    if (sunI >= moonI) {
      L.copy(this.sunDir);
      this.light.color.copy(C.sunLow).lerp(C.sunNoon, smoothstep(0.0, 0.4, e));
      this.light.intensity = sunI;
    } else {
      L.copy(this.sunDir).negate().add(new THREE.Vector3(0.15, 0.1, 0)).normalize();
      this.light.color.copy(C.moon);
      this.light.intensity = moonI;
    }
    if (L.y < 0.08) { L.y = 0.08; L.normalize(); }
    // Same convention as three's Lambert BRDF (albedo / PI), so custom shaders
    // match the PBR materials in brightness.
    U.uSunColor.value.copy(this.light.color).multiplyScalar(this.light.intensity / Math.PI);

    const target = this.light.target.position;
    this.light.position.copy(target).addScaledVector(L, (this.shadowRadius || 120) + 60);

    // Ambient terms
    const amb = U.uAmbient.value;
    amb.copy(z).lerp(h, 0.5).multiplyScalar(0.9);
    amb.r += 0.012; amb.g += 0.014; amb.b += 0.022; // starlight floor
    // Moonlit fill so the map stays readable at night.
    amb.r += night * 0.05; amb.g += night * 0.06; amb.b += night * 0.09;
    if (this.lightningFlash > 0) amb.addScalar(this.lightningFlash * 1.5);
    this.hemi.color.copy(z).lerp(h, 0.3);
    this.hemi.groundColor.setRGB(0.22, 0.18, 0.12).multiplyScalar(0.3 + 0.7 * day);
    this.hemi.intensity = 0.12 + night * 0.5 + this.lightningFlash * 3;
    this.scene.environmentIntensity = 0.55 + night * 0.9;

    // Fog tracks the horizon so the map melts into the sky.
    this.fog.color.copy(h).lerp(z, 0.15);
    this.fog.density = this.fogDensity;

    // Re-bake the environment map when the sky changed noticeably.
    this._envTimer -= dt;
    const key = `${this.sunDir.x.toFixed(2)},${this.sunDir.y.toFixed(2)},${this.sunDir.z.toFixed(2)},${oc.toFixed(2)},${U.uCloudCover.value.toFixed(2)}`;
    if (key !== this._lastEnvKey && this._envTimer <= 0) {
      this._lastEnvKey = key;
      this._envTimer = 0.4;
      const discVis = this.uniforms.uSunVisible.value;
      this.uniforms.uSunVisible.value = 0; // keep the disc out of the IBL
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
      this.uniforms.uSunVisible.value = discVis;
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }
}
