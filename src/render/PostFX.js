import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';

// Sun glare: halo, starburst streak and chromatic ghosts, faded by occlusion.
const LensFlareShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSunPos: { value: new THREE.Vector2(0.5, 0.5) },
    uVisible: { value: 0 },
    uAspect: { value: 1 },
    uColor: { value: new THREE.Color(1, 0.9, 0.75) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunPos;
    uniform float uVisible, uAspect;
    uniform vec3 uColor;
    varying vec2 vUv;
    float ghost(vec2 uv, vec2 c, float r, float soft) {
      vec2 d = (uv - c) * vec2(uAspect, 1.0);
      return smoothstep(r, r * soft, length(d));
    }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uVisible < 0.001) { gl_FragColor = base; return; }
      vec2 d = (vUv - uSunPos) * vec2(uAspect, 1.0);
      float dist = length(d);
      vec3 flare = uColor * (exp(-dist * 7.0) * 0.55 + exp(-dist * 40.0) * 1.5);
      // anamorphic streak
      flare += uColor * exp(-abs(d.y) * 180.0) * exp(-abs(d.x) * 3.0) * 0.35;
      // starburst
      float ang = atan(d.y, d.x);
      flare += uColor * pow(abs(sin(ang * 6.0)), 40.0) * exp(-dist * 10.0) * 0.5;
      // ghosts along the axis through the screen centre
      vec2 axis = vec2(0.5) - uSunPos;
      vec3 g = vec3(0.0);
      g += vec3(0.3, 0.6, 1.0) * ghost(vUv, uSunPos + axis * 0.6, 0.05, 0.7) * 0.18;
      g += vec3(1.0, 0.6, 0.3) * ghost(vUv, uSunPos + axis * 1.25, 0.09, 0.85) * 0.12;
      g += vec3(0.5, 1.0, 0.6) * ghost(vUv, uSunPos + axis * 1.6, 0.03, 0.5) * 0.25;
      g += vec3(0.8, 0.5, 1.0) * ghost(vUv, uSunPos + axis * 2.1, 0.14, 0.9) * 0.08;
      float halo = smoothstep(0.02, 0.0, abs(dist - 0.32)) * 0.12;
      gl_FragColor = vec4(base.rgb + (flare + g + uColor * halo) * uVisible, base.a);
    }`,
};

// Final grade: vignette, gentle saturation/contrast.
const gradeGLSL = /* glsl */ `
  vec3 grade(vec3 c, vec2 uv) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSaturation);
    c = (c - 0.5) * uContrast + 0.5;
    vec2 q = uv - 0.5;
    return c * (1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2));
  }`;
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.28 },
    uSaturation: { value: 1.08 },
    uContrast: { value: 1.04 },
  },
  vertexShader: LensFlareShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uContrast;
    varying vec2 vUv;
    ${gradeGLSL}
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(grade(c.rgb, vUv), c.a);
    }`,
};

/** Tone mapping and sRGB output with the grade folded in (one full-screen pass less);
 * with tilt-shift on, the grade runs as its own pass after the blur instead. */
function gradedOutputPass(grade) {
  const pass = new OutputPass();
  const u = pass.material.uniforms;
  for (const k of ['uVignette', 'uSaturation', 'uContrast']) u[k] = grade.uniforms[k];
  u.uGrade = { value: 1 };
  const src = pass.material.fragmentShader;
  const end = src.lastIndexOf('}');
  pass.material.fragmentShader = src.slice(0, end).replace('varying vec2 vUv;', `varying vec2 vUv;
    uniform float uVignette, uSaturation, uContrast, uGrade;
    ${gradeGLSL}`) + `
    if (uGrade > 0.5) gl_FragColor.rgb = grade(gl_FragColor.rgb, vUv);
  }`;
  return pass;
}

export class PostFX {
  constructor(renderer, scene, camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 2 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.flare = new ShaderPass(LensFlareShader);
    this.composer.addPass(this.flare);
    this.grade = new ShaderPass(GradeShader);
    this.output = gradedOutputPass(this.grade);
    this.composer.addPass(this.output);
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.tiltH.enabled = this.tiltV.enabled = false;
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.grade.enabled = false;
    this.composer.addPass(this.grade);
    this.renderer = renderer;
  }

  setTiltShift(on, amount = 3) {
    this.tiltH.enabled = this.tiltV.enabled = on;
    this.grade.enabled = on;
    this.output.material.uniforms.uGrade.value = on ? 0 : 1;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.tiltH.uniforms.h.value = amount / size.x;
    this.tiltV.uniforms.v.value = amount / size.y;
    this.tiltH.uniforms.r.value = this.tiltV.uniforms.r.value = 0.5;
  }

  /**
   * Anti-aliasing `samples` (0, 2 or 4: MSAA of the scene render) and render `scale`
   * (1 = the screen's full resolution, capped at 2x on high-DPI screens). Returns true
   * when the resolution changed, so the caller re-sizes everything drawn per pixel.
   */
  setQuality(samples, scale) {
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === samples) continue;
      rt.samples = samples;
      rt.dispose(); // re-created with the new sample count on next use
    }
    const ratio = Math.min(window.devicePixelRatio, 2) * scale;
    if (ratio === this.renderer.getPixelRatio()) return false;
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    return true;
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.flare.uniforms.uAspect.value = w / h;
    if (this.tiltH.enabled) this.setTiltShift(true);
  }

  render(dt) {
    // an invisible flare would only copy the frame
    this.flare.enabled = this.flare.uniforms.uVisible.value >= 0.001;
    this.bloom.enabled = this.bloom.strength > 0;
    this.composer.render(dt);
  }
}
