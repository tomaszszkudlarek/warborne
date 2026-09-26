import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { U } from '../render/uniforms.js';

// Hidden map and fog of war as a screen pass: every pixel's world position is rebuilt from
// the depth buffer and looked up in a per-tile texture (R = explored, G = in view now).
// Unexplored land lies under dark drifting mist; land explored but out of sight is dimmed
// and greyed. Covers terrain, water, trees and buildings alike; the sky is left alone.
const FogShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tFog: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uMap: { value: new THREE.Vector4(1, 1, 1, 1) }, // worldW, worldH, tilesW, tilesH
    uEnabled: { value: 0 },
    uFogOfWar: { value: 1 },
    uTime: U.uTime,
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tDepth, tFog;
    uniform mat4 uInvProj, uCamWorld;
    uniform vec4 uMap;
    uniform float uEnabled, uFogOfWar, uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uEnabled < 0.5) { gl_FragColor = base; return; }
      float d = texture2D(tDepth, vUv).x;
      vec3 wp;
      if (d >= 1.0) {
        // nothing wrote depth: the sky, or open sea past the map's edge (water writes none)
        vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0); v /= v.w;
        vec3 o = uCamWorld[3].xyz, dir = normalize((uCamWorld * vec4(v.xyz, 1.0)).xyz - o);
        if (dir.y > -0.002) { gl_FragColor = base; return; }
        wp = o + dir * (-o.y / dir.y);
      } else {
        vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); v /= v.w;
        if (-v.z > 1500.0) { gl_FragColor = base; return; } // the sky dome
        wp = (uCamWorld * v).xyz;
      }
      vec2 tuv = (wp.xz + uMap.xy * 0.5) / uMap.xy;
      // beyond the map's edge counts as unexplored
      vec2 inMap = step(vec2(0.0), tuv) * step(tuv, vec2(1.0));
      vec2 f = texture2D(tFog, clamp(tuv, 0.0, 1.0)).rg * inMap.x * inMap.y;
      // explored land in view: the noise below can't move it off full (0.66 - 0.225 and
      // 0.7 - 0.15 are the lowest values that still come out 1), so the pixel stays as is
      bool inView = f.g >= 0.85 || uFogOfWar < 0.5;
      if (f.r >= 0.885 && inView) { gl_FragColor = base; return; }
      // ragged, drifting border between the known land and the clouds
      vec2 q = wp.xz;
      float n = fbm(q * 0.16 + vec2(uTime * 0.035, uTime * 0.02));
      float explored = smoothstep(0.34, 0.66, f.r + (n - 0.5) * 0.45);
      float seen = mix(1.0, smoothstep(0.3, 0.7, f.g + (n - 0.5) * 0.3), uFogOfWar);
      vec3 c = base.rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec3 memory = mix(vec3(l), c, 0.5) * 0.58 + vec3(0.008, 0.01, 0.018);
      c = mix(memory, c, seen);
      if (explored >= 1.0) { gl_FragColor = vec4(c, base.a); return; }
      // cloud cover over unexplored land: two drifting layers, lit on top, dark in the folds
      float c1 = fbm(q * 0.045 + vec2(uTime * 0.012, -uTime * 0.008));
      float c2 = fbm(q * 0.11 - vec2(uTime * 0.02, uTime * 0.015) + c1 * 2.0);
      float cl = smoothstep(0.25, 0.85, c1 * 0.6 + c2 * 0.55);
      vec3 mist = mix(vec3(0.045, 0.05, 0.065), vec3(0.2, 0.215, 0.25), cl);
      float rim = smoothstep(0.0, 0.5, explored) * (1.0 - smoothstep(0.5, 1.0, explored));
      mist += vec3(0.16, 0.15, 0.13) * rim * cl;
      c = mix(mist, c, explored);
      gl_FragColor = vec4(c, base.a);
    }`,
};

class FogPass extends Pass {
  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({ ...FogShader, uniforms: THREE.UniformsUtils.clone(FogShader.uniforms) });
    this.material.uniforms.uTime = U.uTime;
    this.quad = new FullScreenQuad(this.material);
    this.needsSwap = true;
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

export class FogOfWar {
  constructor(renderer, scene, camera, post, world) {
    this.camera = camera;
    this.world = world;
    this.pass = new FogPass();
    // the scene render keeps its depth for the pass
    const comp = post.composer;
    for (const rt of [comp.renderTarget1, comp.renderTarget2]) {
      rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
      rt.depthTexture.type = THREE.UnsignedIntType;
    }
    comp.insertPass(this.pass, 1);
    this.game = null;
    this.viewer = null;
    this.tex = null;
    this.dirty = true;
  }

  setMap(map) {
    const W = map.grid.tilesW, H = map.grid.tilesH;
    this.tex?.dispose();
    this.data = new Uint8Array(W * H * 4);
    this.tex = new THREE.DataTexture(this.data, W, H, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    const u = this.pass.material.uniforms;
    u.tFog.value = this.tex;
    u.uMap.value.set(map.grid.worldW, map.grid.worldH, W, H);
    this.map = map;
    this.game = null;
    u.uEnabled.value = 0;
  }

  /** Whose eyes (player id) look at the map; null shows everything. */
  setGame(game, viewer) {
    this.game = game;
    this.viewer = viewer;
    this.dirty = true;
  }
  markDirty() { this.dirty = true; }
  clear() { this.game = null; this.pass.material.uniforms.uEnabled.value = 0; this.pass.enabled = false; }

  update() {
    const u = this.pass.material.uniforms;
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    const g = this.game;
    // switched off, the pass would only copy the frame
    if (!g || this.viewer == null || (!g.s.options.hiddenMap && !g.s.options.fogOfWar)) { u.uEnabled.value = 0; this.pass.enabled = false; return; }
    u.uEnabled.value = 1;
    this.pass.enabled = true;
    u.uFogOfWar.value = g.s.options.fogOfWar ? 1 : 0;
    // re-read the tiles now and then (armies move every frame during a march)
    this._n = (this._n ?? 0) + 1;
    if (!this.dirty && this._n % 20) return;
    this.dirty = false;
    const ex = g.s.options.hiddenMap ? g.explored(this.viewer) : null;
    const vis = g.visible(this.viewer);
    // a soft field: each tile averages its 3x3 neighbourhood, so borders fade over a tile
    const W = g.W, H = g.H, d = this.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let e = 0, v = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const t = yy * W + xx;
            e += !ex || ex[t] ? 1 : 0;
            v += vis[t];
            n++;
          }
        }
        const i = (y * W + x) * 4;
        d[i] = Math.round((e / n) * 255);
        d[i + 1] = Math.round((v / n) * 255);
        d[i + 3] = 255;
      }
    }
    this.tex.needsUpdate = true;
  }
}
