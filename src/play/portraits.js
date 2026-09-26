import * as THREE from 'three';
import { HeroFigure, HERO_TYPES } from '../render/Heroes.js';
import { art } from './art.js';

// Unit and hero portraits for the interface, rendered from the 3D models themselves in the
// owner's colours: humanoids as a three-quarter bust, beasts and engines whole. Rendered
// with the game's renderer into a render target (no second WebGL context), cached as data
// URLs per (type, owner). Painted portraits (src/assets/art/units/<type>.webp, play/art.js) win.
const SIZE = 160;

export class Portraits {
  /** renderer: the game's WebGLRenderer; models: () => { [type]: gltf } (loaded so far). */
  constructor(renderer, models) {
    this.renderer = renderer;
    this.models = models;
    this.cache = new Map();
    this.queue = [];
    this.scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a2e22, 1.4);
    const key = new THREE.DirectionalLight(0xfff0dc, 3.2);
    key.position.set(2.5, 4, 3.5);
    const rim = new THREE.DirectionalLight(0x9fc0ff, 2.4);
    rim.position.set(-3, 2.5, -3);
    const fill = new THREE.DirectionalLight(0xffd9a8, 0.8);
    fill.position.set(-3, 0.5, 2);
    this.scene.add(hemi, key, rim, fill);
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.01, 100);
    this.rt = new THREE.WebGLRenderTarget(SIZE * 2, SIZE * 2, { samples: 4 });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE * 2;
    this.ctx = this.canvas.getContext('2d');
    this.pixels = new Uint8Array(SIZE * SIZE * 16);
    this.listeners = new Set();
  }

  /** Called when a queued portrait is ready (UI re-renders images). */
  onReady(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** URL for a portrait now, or a placeholder while it's queued. */
  url(type, owner = -1) {
    const painted = art.unit(type);
    if (painted) return painted;
    const key = `${type}|${owner}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.queue.some((q) => q.key === key)) this.queue.push({ key, type, owner });
    return PLACEHOLDER;
  }

  /** Renders a few queued portraits; call once per frame. */
  update(budget = 2) {
    let done = 0;
    while (this.queue.length && done < budget) {
      const q = this.queue[0];
      const gltf = this.models()?.[q.type];
      if (!gltf) {
        // not loaded (yet): try again later, keep others moving
        this.queue.push(this.queue.shift());
        q.tries = (q.tries ?? 0) + 1;
        if (q.tries > 600) this.queue.shift();
        return;
      }
      this.queue.shift();
      try { this.cache.set(q.key, this._render(q.type, q.owner, gltf)); } catch (e) { console.warn('portrait', q.type, e); this.cache.set(q.key, PLACEHOLDER); }
      done++;
    }
    if (done) for (const fn of this.listeners) fn();
  }

  _render(type, owner, gltf) {
    const fig = new HeroFigure(type, gltf, owner);
    fig.ring.visible = false;
    if (fig.banner) fig.banner.visible = false;
    if (fig.ship) fig.ship.visible = false;
    fig.idle?.setEffectiveWeight(1);
    fig.walk?.setEffectiveWeight(0);
    if (fig.idle) fig.idle.time = 0.4;
    fig.mixer.update(0);
    fig.figure.position.y = 0;
    fig.root.updateMatrixWorld(true);
    this.scene.add(fig.root);
    // framing from the posed figure's bounds
    const box = new THREE.Box3();
    fig.figure.traverse((o) => {
      if (!o.isMesh) return;
      // a skinned mesh's box in its posed shape
      let b;
      if (o.isSkinnedMesh) { o.computeBoundingBox(); b = o.boundingBox.clone(); } else { o.geometry.computeBoundingBox(); b = o.geometry.boundingBox.clone(); }
      box.union(b.applyMatrix4(o.matrixWorld));
    });
    const size = box.getSize(new THREE.Vector3());
    const t = HERO_TYPES[type];
    const beast = !!t.scale || !!t.fly || size.x > size.y * 0.95 || size.z > size.y * 1.2;
    const c = box.getCenter(new THREE.Vector3());
    let target, dist;
    if (beast) {
      target = c;
      dist = Math.max(size.x, size.y, size.z) * 1.5;
    } else {
      // head and shoulders
      const h = size.y;
      target = new THREE.Vector3(c.x, box.min.y + h * 0.8, c.z);
      dist = h * 1.25;
    }
    const dir = new THREE.Vector3(0.62, beast ? 0.42 : 0.12, 1).normalize();
    const place = () => {
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);
    };
    place();
    // a beast long in the body (a rat and its tail) may not fit that frame: back off until
    // every corner of its bounds is in the picture
    if (beast) {
      const p = new THREE.Vector3();
      for (let i = 0; i < 4; i++) {
        let m = 0;
        for (let k = 0; k < 8; k++) {
          p.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).project(this.camera);
          m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
        }
        if (m <= 0.94) break;
        dist *= m / 0.9;
        place();
      }
    }

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const prevShadow = r.shadowMap.enabled;
    r.shadowMap.enabled = false;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.camera);
    const W = SIZE * 2;
    r.readRenderTargetPixels(this.rt, 0, 0, W, W, this.pixels);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.shadowMap.enabled = prevShadow;
    this.scene.remove(fig.root);
    fig.dispose();

    const img = this.ctx.createImageData(W, W);
    for (let y = 0; y < W; y++) img.data.set(this.pixels.subarray((W - 1 - y) * W * 4, (W - y) * W * 4), y * W * 4);
    this.ctx.clearRect(0, 0, W, W);
    this.ctx.putImageData(img, 0, 0);
    return this.canvas.toDataURL('image/webp', 0.9);
  }
}

// a rune-circle placeholder while a portrait renders
export const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="none" stroke="#d8b25a" stroke-opacity=".35" stroke-width="2" stroke-dasharray="4 5"/></svg>`,
);
