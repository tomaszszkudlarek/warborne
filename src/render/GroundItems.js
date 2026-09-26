import * as THREE from 'three';
import { U } from './uniforms.js';

// What a fallen hero leaves on the map (Game.s.ground): a small iron-bound chest with the
// hero's sword planted beside it, and a soft golden shimmer over it so it shows from afar.
// Built once and cloned per spot; it sits off the tile's centre, clear of an army there.

let proto = null;

function makeProto() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a1e, roughness: 0.85 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.8 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd9a54a, roughness: 0.35, metalness: 0.9, emissive: 0x3a2400 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.3, metalness: 0.95 });
  const add = (geo, mat, x, y, z, rz = 0, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  // the chest: body, a rounded lid, iron bands and a gold lock
  add(new THREE.BoxGeometry(0.42, 0.24, 0.28), wood, 0, 0.12, 0);
  add(new THREE.CylinderGeometry(0.14, 0.14, 0.42, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2), wood, 0, 0.24, 0);
  for (const x of [-0.15, 0.15]) add(new THREE.BoxGeometry(0.04, 0.25, 0.3), iron, x, 0.125, 0);
  add(new THREE.BoxGeometry(0.07, 0.08, 0.02), gold, 0, 0.2, 0.145);
  // the sword, thrust into the ground beside it, leaning a little
  const sword = new THREE.Group();
  sword.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.012), steel).translateY(0.2));
  sword.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.04), gold).translateY(0.46));
  sword.add(new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 6), wood).translateY(0.53));
  sword.add(new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), gold).translateY(0.6));
  sword.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  sword.position.set(0.32, -0.04, -0.08);
  sword.rotation.set(0.12, 0.5, -0.18);
  g.add(sword);
  // the shimmer: an additive glow sprite that breathes
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xffcf6a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6,
  }));
  glow.name = 'glow';
  glow.scale.setScalar(1.1);
  glow.position.y = 0.3;
  g.add(glow);
  return g;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class GroundItemsView {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'ground-items';
    parent.add(this.group);
    this.key = '';
  }

  /** spots: [{ t, x, z, y }] where items lie in view. Rebuilds only when they change. */
  set(spots) {
    const key = spots.map((s) => s.t).join(',');
    if (key === this.key) return;
    this.key = key;
    this.clear(false);
    proto ??= makeProto();
    for (const s of spots) {
      const m = proto.clone();
      m.position.set(s.x, s.y, s.z);
      m.rotation.y = (s.t * 2.39996) % 6.283; // each its own way round
      m.scale.setScalar(0.75);
      m.userData.phase = s.t * 1.7;
      const glow = m.getObjectByName('glow');
      glow.material = glow.material.clone();
      this.group.add(m);
    }
  }

  update() {
    const t = U.uTime.value;
    for (const m of this.group.children) {
      const glow = m.getObjectByName('glow');
      if (glow) glow.material.opacity = 0.35 + 0.25 * Math.sin(t * 2.2 + m.userData.phase);
    }
  }

  clear(resetKey = true) {
    for (const m of this.group.children) m.getObjectByName('glow')?.material.dispose();
    this.group.clear();
    if (resetKey) this.key = '';
  }
}
