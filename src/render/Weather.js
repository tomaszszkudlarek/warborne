import * as THREE from 'three';
import { U } from './uniforms.js';
import { noiseGLSL, cloudGLSL } from './shaders/common.js';

// Target states; the live state eases toward the selected preset.
export const WEATHER_PRESETS = {
  Clear: { clouds: 0.18, overcast: 0.0, rain: 0, snow: 0, fog: 0.0028, wind: 0.35, lightning: 0, wet: 0, snowCover: 0 },
  'Fair clouds': { clouds: 0.5, overcast: 0.12, rain: 0, snow: 0, fog: 0.0035, wind: 0.55, lightning: 0, wet: 0, snowCover: 0 },
  Overcast: { clouds: 0.85, overcast: 0.6, rain: 0, snow: 0, fog: 0.006, wind: 0.6, lightning: 0, wet: 0.1, snowCover: 0 },
  Rain: { clouds: 0.92, overcast: 0.75, rain: 0.7, snow: 0, fog: 0.008, wind: 0.8, lightning: 0, wet: 0.85, snowCover: 0 },
  Thunderstorm: { clouds: 1.0, overcast: 0.92, rain: 1.0, snow: 0, fog: 0.01, wind: 1.3, lightning: 1, wet: 1, snowCover: 0 },
  Snowfall: { clouds: 0.9, overcast: 0.7, rain: 0, snow: 0.85, fog: 0.011, wind: 0.45, lightning: 0, wet: 0, snowCover: 1 },
  Blizzard: { clouds: 1.0, overcast: 0.9, rain: 0, snow: 1.0, fog: 0.022, wind: 1.6, lightning: 0, wet: 0, snowCover: 1 },
  'Morning mist': { clouds: 0.35, overcast: 0.3, rain: 0, snow: 0, fog: 0.02, wind: 0.15, lightning: 0, wet: 0.35, snowCover: 0 },
};

// Rain, storms and snow pass in spells of at most two game hours (sky clock), with calmer
// skies between them, for as long as the game's weather (climate) stays showery.
const SPELL_LULL = { Rain: 'Overcast', Thunderstorm: 'Overcast', Snowfall: 'Overcast' };
const SPELL_HOURS = [0.75, 2];
const LULL_HOURS = [3, 8];
const between = ([a, b]) => a + Math.random() * (b - a);

const BOX = new THREE.Vector3(90, 45, 90);

function makePrecipitation(count, isSnow) {
  const geo = new THREE.BufferGeometry();
  const verts = isSnow ? 1 : 2;
  const pos = new Float32Array(count * verts * 3);
  const rnd = new Float32Array(count * verts);
  const end = new Float32Array(count * verts);
  for (let i = 0; i < count; i++) {
    const x = Math.random(), y = Math.random(), z = Math.random(), r = Math.random();
    for (let v = 0; v < verts; v++) {
      const o = i * verts + v;
      pos.set([x, y, z], o * 3);
      rnd[o] = r;
      end[o] = v;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const uniforms = {
    uTime: U.uTime, uWind: U.uWind,
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: BOX.clone() },
    uIntensity: { value: 0 },
    uAmbient: U.uAmbient, uSunColor: U.uSunColor,
    uPointScale: { value: 800 },
  };
  const vertexShader = /* glsl */ `
    uniform float uTime, uIntensity, uPointScale;
    uniform vec2 uWind;
    uniform vec3 uCenter, uBox;
    attribute float aRand, aEnd;
    varying float vAlpha;
    void main() {
      float speed = ${isSnow ? '1.6 + aRand * 1.2' : '26.0 + aRand * 10.0'};
      vec3 origin = uCenter - uBox * 0.5;
      vec3 p = position * uBox;
      p.y -= uTime * speed;
      vec2 drift = uWind * uTime * ${isSnow ? '2.2' : '4.0'};
      ${isSnow ? 'drift += vec2(sin(uTime * 0.9 + aRand * 40.0), cos(uTime * 0.7 + aRand * 17.0)) * 0.7;' : ''}
      p.xz += drift;
      p = origin + mod(p - origin, uBox);
      ${isSnow ? '' : `
      vec3 vel = normalize(vec3(uWind.x * 4.0, -speed, uWind.y * 4.0));
      p += vel * aEnd * 0.9;`}
      vAlpha = step(aRand, uIntensity) * smoothstep(0.0, 6.0, p.y - origin.y) * smoothstep(0.0, 6.0, origin.y + uBox.y - p.y);
      vec4 mv = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      ${isSnow ? 'gl_PointSize = min((0.07 + aRand * 0.06) * uPointScale / -mv.z, 7.0);' : ''}
    }`;
  const fragmentShader = /* glsl */ `
    uniform vec3 uAmbient, uSunColor;
    varying float vAlpha;
    void main() {
      ${isSnow
        ? 'float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.15, d);'
        : 'float a = 0.32;'}
      vec3 col = ${isSnow ? 'vec3(1.0)' : 'vec3(0.75, 0.8, 0.9)'} * (uAmbient * 1.6 + uSunColor * 0.25) + 0.05;
      gl_FragColor = vec4(col, a * vAlpha);
      if (gl_FragColor.a < 0.01) discard;
    }`;
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false });
  const obj = isSnow ? new THREE.Points(geo, mat) : new THREE.LineSegments(geo, mat);
  obj.frustumCulled = false;
  obj.renderOrder = 5;
  return obj;
}

function makeCloudLayer() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uCloudCover: U.uCloudCover, uCloudOffset: U.uCloudOffset,
      uSunColor: U.uSunColor, uAmbient: U.uAmbient, uSunDir: U.uSunDir,
      uOpacity: { value: 0.6 },
      uFocus: { value: new THREE.Vector3() },
      uClearRadius: { value: 40 },
      ...THREE.UniformsLib.fog,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor, uAmbient, uSunDir;
      uniform float uOpacity, uClearRadius;
      uniform vec3 uFocus;
      varying vec3 vWPos;
      ${noiseGLSL}
      ${cloudGLSL}
      #include <fog_pars_fragment>
      void main() {
        float d = cloudDensity(vWPos.xz);
        float d2 = cloudDensity(vWPos.xz + uSunDir.xz * 3.0);
        float selfShadow = clamp(1.0 - (d2 - d) * 1.5, 0.45, 1.0);
        vec3 col = (uAmbient * 1.5 + uSunColor * max(uSunDir.y, 0.1) * 0.55 * selfShadow);
        col *= mix(1.0, 0.55, smoothstep(0.7, 1.0, uCloudCover));
        float camDist = distance(cameraPosition, vWPos);
        // keep the area the player is looking at clear; clouds frame the view
        float focusClear = smoothstep(uClearRadius * 0.55, uClearRadius * 1.25, distance(vWPos.xz, uFocus.xz));
        float a = d * uOpacity * smoothstep(6.0, 40.0, camDist) * mix(focusClear, 1.0, uCloudCover * uCloudCover * 0.35);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
  });
  const geo = new THREE.PlaneGeometry(1400, 1400, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 40;
  mesh.renderOrder = 6;
  mesh.name = 'cloudLayer';
  return mesh;
}

export class WeatherSystem {
  constructor(scene, sky) {
    this.scene = scene;
    this.sky = sky;
    this.preset = 'Fair clouds';
    this.state = { ...WEATHER_PRESETS[this.preset] };
    this.windAngle = 0.4;
    this.windScale = 1;
    this.cloudLayerEnabled = true;
    this.autoCycle = false;
    this._cycleTimer = 60;
    this.cloudOffset = new THREE.Vector2();

    this.rain = makePrecipitation(16000, false);
    this.snow = makePrecipitation(12000, true);
    scene.add(this.rain, this.snow);
    this.cloudLayer = makeCloudLayer();
    scene.add(this.cloudLayer);

    this.boltGroup = new THREE.Group();
    scene.add(this.boltGroup);
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 9), fog: false, transparent: true });
    this.flash = 0;
    this._nextStrike = 3;
    this.bolt = null;
    this.boltLife = 0;
    this.heightAt = () => 0;
    this.mapExtent = new THREE.Vector2(100, 100);
  }

  setPreset(name) {
    if (WEATHER_PRESETS[name]) this.preset = name;
  }

  /** The game's weather: showery kinds come and go in short spells (see SPELL_HOURS). */
  setClimate(name) {
    this.climate = name;
    this.setPreset(name);
    this._spellLeft = SPELL_LULL[name] ? between(SPELL_HOURS) : 0;
  }

  _tickClimate(dt) {
    const lull = SPELL_LULL[this.climate];
    if (!lull) return;
    this._spellLeft -= dt * (this.sky?.daySpeed ?? 0);
    if (this._spellLeft > 0) return;
    const raining = this.preset === this.climate;
    this.preset = raining ? lull : this.climate;
    this._spellLeft = between(raining ? LULL_HOURS : SPELL_HOURS);
    this.onChange?.(this.preset);
  }

  update(dt, camera, target) {
    this._tickClimate(dt);
    if (this.autoCycle) {
      this._cycleTimer -= dt;
      if (this._cycleTimer <= 0) {
        const names = Object.keys(WEATHER_PRESETS);
        this.preset = names[Math.floor(Math.random() * names.length)];
        this._cycleTimer = 45 + Math.random() * 60;
        this.onAutoChange?.(this.preset);
      }
    }
    const tgt = WEATHER_PRESETS[this.preset];
    const s = this.state;
    const k = 1 - Math.exp(-dt * 0.6);
    const kSlow = 1 - Math.exp(-dt * 0.12);
    for (const key of Object.keys(tgt)) {
      const rate = key === 'snowCover' || key === 'wet' ? kSlow : k;
      s[key] += (tgt[key] - s[key]) * rate;
    }

    const wind = s.wind * this.windScale;
    U.uWind.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle)).multiplyScalar(wind);
    this.cloudOffset.addScaledVector(U.uWind.value, dt * 2.5);
    U.uCloudOffset.value.copy(this.cloudOffset);
    U.uCloudCover.value = s.clouds;
    U.uWetness.value = s.wet;
    U.uSnowCover.value = s.snowCover;
    // hard frost: lakes and slow water freeze further south while it snows
    U.uFreezeT.value = U.uIceT.value + s.snowCover * 0.3;
    this.sky.overcast = s.overcast;
    this.sky.fogDensity = s.fog;

    const center = this.rain.material.uniforms.uCenter.value;
    // Centre precipitation between camera and focus point, at ground level.
    center.copy(camera.position).lerp(target, 0.6);
    center.y = Math.max(target.y, 0) + BOX.y * 0.5 - 4;
    this.snow.material.uniforms.uCenter.value.copy(center);
    this.rain.material.uniforms.uIntensity.value = s.rain;
    this.snow.material.uniforms.uIntensity.value = s.snow;
    this.rain.visible = s.rain > 0.01;
    this.snow.visible = s.snow > 0.01;
    this.cloudLayer.visible = this.cloudLayerEnabled && s.clouds > 0.05;
    const cu = this.cloudLayer.material.uniforms;
    cu.uOpacity.value = 0.18 + s.overcast * 0.5;
    cu.uFocus.value.copy(target);
    cu.uClearRadius.value = 18 + camera.position.distanceTo(target) * 0.45;

    // Lightning
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.boltLife > 0) {
      this.boltLife -= dt;
      this.boltMat.opacity = Math.max(0, this.boltLife / 0.35) * (0.6 + Math.random() * 0.4);
      if (this.boltLife <= 0) this.clearBolt();
    }
    if (s.lightning > 0.5) {
      this._nextStrike -= dt;
      if (this._nextStrike <= 0) {
        this._nextStrike = 1.5 + Math.random() * 6;
        this.strike(target);
      }
    }
    this.sky.lightningFlash = this.flash;
  }

  strike(target) {
    this.clearBolt();
    const ang = Math.random() * Math.PI * 2, r = 10 + Math.random() * 45;
    const x = THREE.MathUtils.clamp(target.x + Math.cos(ang) * r, -this.mapExtent.x / 2, this.mapExtent.x / 2);
    const z = THREE.MathUtils.clamp(target.z + Math.sin(ang) * r, -this.mapExtent.y / 2, this.mapExtent.y / 2);
    const ground = Math.max(0, this.heightAt(x, z));
    const top = 42;
    const geos = [];
    const branch = (sx, sy, sz, ex, ey, ez, radius, depth) => {
      const pts = [];
      const segs = 14;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const j = i === 0 || i === segs ? 0 : 1;
        pts.push(new THREE.Vector3(
          sx + (ex - sx) * t + (Math.random() - 0.5) * 2.2 * j,
          sy + (ey - sy) * t,
          sz + (ez - sz) * t + (Math.random() - 0.5) * 2.2 * j,
        ));
      }
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
      geos.push(new THREE.TubeGeometry(curve, segs * 3, radius, 4, false));
      if (depth < 2) {
        for (let b = 0; b < 2; b++) {
          const p = pts[3 + Math.floor(Math.random() * (segs - 6))];
          branch(p.x, p.y, p.z, p.x + (Math.random() - 0.5) * 12, p.y - 6 - Math.random() * 10, p.z + (Math.random() - 0.5) * 12, radius * 0.5, depth + 1);
        }
      }
    };
    branch(x + (Math.random() - 0.5) * 8, top, z + (Math.random() - 0.5) * 8, x, ground, z, 0.09, 0);
    for (const g of geos) this.boltGroup.add(new THREE.Mesh(g, this.boltMat));
    this.boltLife = 0.35;
    this.flash = 1;
    this.onStrike?.();
  }

  clearBolt() {
    for (const m of [...this.boltGroup.children]) {
      m.geometry.dispose();
      this.boltGroup.remove(m);
    }
  }

  setPointScale(v) {
    this.snow.material.uniforms.uPointScale.value = v;
  }
}
