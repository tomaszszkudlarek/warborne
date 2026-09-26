import * as THREE from 'three';

// Wooden fingerposts at road forks (game/signposts.js): a weathered post beside the road with
// a pointed board per way, each turned down the road it names, stacked one above another.
const POST_H = 1.5;
const BOARD_L = 0.72;

export class SignpostView {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'signposts';
    parent.add(this.group);
    this.postGeo = new THREE.CylinderGeometry(0.05, 0.065, POST_H, 7);
    this.postGeo.translate(0, POST_H / 2, 0);
    this.capGeo = new THREE.ConeGeometry(0.085, 0.11, 7);
    // a board with a pointed end, along +z
    const shape = new THREE.Shape();
    const w = 0.08;
    shape.moveTo(-w, 0); shape.lineTo(w, 0); shape.lineTo(w, BOARD_L - 0.12); shape.lineTo(0, BOARD_L); shape.lineTo(-w, BOARD_L - 0.12); shape.lineTo(-w, 0);
    this.boardGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
    // lay it on its side: the width vertical, the length along +z
    this.boardGeo.rotateX(Math.PI / 2);
    this.boardGeo.rotateZ(Math.PI / 2);
    this.boardGeo.translate(-0.015, 0, 0.05);
    this.postMat = new THREE.MeshStandardMaterial({ color: 0x4a3622, roughness: 0.95 });
    this.boardMat = new THREE.MeshStandardMaterial({ color: 0xc0925a, roughness: 0.8 });
  }

  /** posts: makeSignposts(map); tileCenter(t) -> {x, z}; heightAt(x, z); tileSize. */
  build(posts, { tileCenter, heightAt, tileSize }) {
    this.clear();
    for (const p of posts) {
      const c = tileCenter(p.t);
      const x = c.x + p.side[0] * tileSize * 0.27, z = c.z + p.side[1] * tileSize * 0.27;
      const y = heightAt(x, z) - 0.03;
      const g = new THREE.Group();
      g.position.set(x, y, z);
      const post = new THREE.Mesh(this.postGeo, this.postMat);
      post.castShadow = true;
      g.add(post);
      const cap = new THREE.Mesh(this.capGeo, this.postMat);
      cap.position.y = POST_H + 0.04;
      g.add(cap);
      p.boards.forEach((b, i) => {
        const m = new THREE.Mesh(this.boardGeo, this.boardMat);
        m.position.y = POST_H - 0.16 - i * 0.21;
        m.rotation.y = Math.atan2(b.dx, b.dy) + (i % 2 ? 0.04 : -0.04); // a little askew
        m.castShadow = true;
        g.add(m);
      });
      g.rotation.z = (((p.t * 7919) % 11) - 5) * 0.004; // leaning with age
      this.group.add(g);
    }
  }

  /** Clears the trees that would hide the posts (vegetation: InstancedMeshes). */
  clearTrees(vegetation, r = 1.0, pts = this.group.children.map((g) => g.position)) {
    if (!vegetation || !pts.length) return;
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    vegetation.traverse((o) => {
      if (!o.isInstancedMesh) return;
      let changed = false;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        if (pts.some((q) => (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < r * r)) { o.setMatrixAt(i, zero); changed = true; }
      }
      if (changed) { o.instanceMatrix.needsUpdate = true; o.computeBoundingSphere?.(); }
    });
  }

  clear() { this.group.clear(); }
}
