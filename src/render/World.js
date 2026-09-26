import * as THREE from 'three';
import { createTerrain, makeDataTexture, makeHeightTexture } from './Terrain.js';
import { createStillWaterMaterial, createSea, createLakes, createRivers, buildRiverField, makeWaterLevelTexture } from './Water.js';
import { createVegetation } from './Vegetation.js';
import { createGrass } from './Grass.js';
import { createBridges, createCastles, createSites, createPorts, bridgeDeckAt, structureFootprints } from './Structures.js';
import { Obstacles } from '../game/obstacles.js';
import { createVolcanoFX } from './Volcanoes.js';
import { createSiteFX } from './SiteFX.js';
import { U } from './uniforms.js';
import { NightGlow } from './NightGlow.js';

/** Everything that depends on one generated map. Rebuilt on every generation. */
export class World {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);
    this.map = null;
    this.textures = null;
    this.parts = {};
    this.obstacles = new Obstacles();
    this.glow = new NightGlow(); // lava, castles, shrines and torches light the night
  }

  build(map) {
    this.dispose();
    this.map = map;
    const g = map.grid;
    this.textures = {
      height: makeHeightTexture(map.heights, g.gw, g.gh),
      splatA: makeDataTexture(map.splatA, g.gw, g.gh),
      splatB: makeDataTexture(map.splatB, g.gw, g.gh),
      climate: makeDataTexture(map.climate, g.gw, g.gh),
    };
    const riverField = map.rivers.length ? buildRiverField(map) : null;
    this.textures.waterLevel = makeWaterLevelTexture(map, riverField);
    U.uIceT.value = map.iceThreshold;
    U.uFreezeT.value = map.iceThreshold;

    const p = this.parts;
    p.terrain = createTerrain(map, this.textures);
    const stillWater = createStillWaterMaterial(map, this.textures);
    p.sea = createSea(map, stillWater);
    p.lakes = createLakes(map, stillWater);
    p.rivers = createRivers(map, this.textures, riverField);
    p.vegetation = createVegetation(map);
    p.grass = createGrass(map, this.textures);
    p.bridges = createBridges(map);
    p.castles = createCastles(map);
    p.sites = createSites(map);
    p.ports = createPorts(map);
    p.volcanoFX = createVolcanoFX(map);
    p.siteFX = createSiteFX(map);
    // castles, ruins and shrines armies walk around
    this.obstacles = new Obstacles(structureFootprints(map));
    p.highlight = this._makeHighlight();
    for (const obj of Object.values(p)) if (obj) this.group.add(obj);
    this.glow.setMap(map);
    this.glow.patch(this.group);
  }

  /** Rebuilds the castles from map.cities (after owners or levels changed); razed
   * cities (`razed`) lose their castle. */
  refreshCastles() {
    const old = this.parts.castles;
    if (old) {
      old.traverse((o) => { if (o.isInstancedMesh) { o.material.dispose(); o.dispose(); } });
      old.removeFromParent();
    }
    const castles = createCastles({ ...this.map, cities: this.map.cities.filter((c) => !c.razed) });
    this.parts.castles = castles;
    if (castles) this.group.add(castles);
    this.glow.patch(castles);
    this.glow.rebuildStatic();
  }

  setVisible(name, v) {
    if (this.parts[name]) this.parts[name].visible = v;
  }

  heightAt(x, z) {
    const m = this.map;
    if (!m) return 0;
    const g = m.grid;
    const ci = Math.max(0, Math.min(g.gw - 1.001, (x + g.worldW / 2) / g.cellSize));
    const cj = Math.max(0, Math.min(g.gh - 1.001, (z + g.worldH / 2) / g.cellSize));
    const i = Math.floor(ci), j = Math.floor(cj), fx = ci - i, fy = cj - j;
    const h = m.heights, k = j * g.gw + i;
    return (h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fy) + (h[k + g.gw] * (1 - fx) + h[k + g.gw + 1] * fx) * fy;
  }

  /** Where a walker stands: bridge decks over rivers, the ground elsewhere (never below the sea). */
  walkHeightAt(x, z) {
    const deck = this.map ? bridgeDeckAt(this.map, x, z) : null;
    return deck ?? Math.max(0, this.heightAt(x, z));
  }

  /** Ray-march the heightfield (cheaper and more precise than triangle raycasts). */
  pick(ray) {
    const m = this.map;
    if (!m) return null;
    const g = m.grid;
    const hw = g.worldW / 2, hh = g.worldH / 2;
    const p = new THREE.Vector3();
    let prevT = 0, t = 0;
    const step = 0.4;
    for (let i = 0; i < 2500; i++) {
      ray.at(t, p);
      const ground = Math.max(0, this.heightAt(p.x, p.z));
      if (p.y <= ground) {
        let a = prevT, b = t;
        for (let k = 0; k < 12; k++) {
          const mid = (a + b) / 2;
          ray.at(mid, p);
          if (p.y <= Math.max(0, this.heightAt(p.x, p.z))) b = mid; else a = mid;
        }
        ray.at(b, p);
        if (Math.abs(p.x) > hw || Math.abs(p.z) > hh) return null;
        const tx = Math.floor((p.x + hw) / g.tileSize), ty = Math.floor((p.z + hh) / g.tileSize);
        return { point: p.clone(), tx, ty };
      }
      prevT = t;
      t += step * (1 + t * 0.01);
      if (p.y < -20) break;
    }
    return null;
  }

  _makeHighlight() {
    const n = 4 * 8;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(3, 2.6, 1.4), transparent: true, opacity: 0.9, depthTest: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 20;
    line.visible = false;
    line.frustumCulled = false;
    return line;
  }

  highlightTile(tx, ty) {
    const hl = this.parts.highlight;
    const m = this.map;
    if (!hl || !m || tx < 0 || ty < 0 || tx >= m.grid.tilesW || ty >= m.grid.tilesH) {
      if (hl) hl.visible = false;
      return;
    }
    const g = m.grid;
    const x0 = tx * g.tileSize - g.worldW / 2, z0 = ty * g.tileSize - g.worldH / 2, s = g.tileSize;
    const corners = [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s], [x0, z0]];
    const pos = hl.geometry.attributes.position;
    let idx = 0;
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 8; k++) {
        const t = k / 8;
        const x = corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t;
        const z = corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t;
        pos.setXYZ(idx++, x, Math.max(0.02, this.heightAt(x, z)) + 0.06, z);
      }
    }
    pos.setXYZ(idx, x0, Math.max(0.02, this.heightAt(x0, z0)) + 0.06, z0);
    pos.needsUpdate = true;
    hl.visible = true;
  }

  /** Per frame: `camera` and its `focus` (the point it orbits) steer the close-up detail;
   * `viewH` is the view's height in CSS pixels. */
  update(t, camera, focus, viewH = innerHeight) {
    this.parts.volcanoFX?.userData.update(t);
    if (camera) {
      this.parts.grass?.userData.update(camera, focus);
      this.parts.vegetation?.userData.update?.(camera, viewH);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      if (o.isInstancedMesh) o.dispose();
    });
    this.group.clear();
    if (this.textures) Object.values(this.textures).forEach((t) => t.dispose());
    this.textures = null;
    this.parts = {};
  }
}
