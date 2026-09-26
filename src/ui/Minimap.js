import * as THREE from 'three';
import { TileInfo, Flag, Factions, NEUTRAL_COLOR, Tile } from '../generator/terrainTypes.js';

/** Warlords-style strategic minimap with the camera footprint; click to travel. */
export class Minimap {
  constructor(container, onNavigate) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.onNavigate = onNavigate;
    this.map = null;
    let dragging = false;
    const nav = (e) => {
      if (!this.map) return;
      const r = this.canvas.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      const g = this.map.grid;
      this.onNavigate((u - 0.5) * g.worldW, (v - 0.5) * g.worldH);
    };
    this.canvas.addEventListener('pointerdown', (e) => { dragging = true; this.canvas.setPointerCapture(e.pointerId); nav(e); });
    this.canvas.addEventListener('pointermove', (e) => dragging && nav(e));
    this.canvas.addEventListener('pointerup', () => (dragging = false));
  }

  setMap(map) {
    this.map = map;
    const { tilesW: W, tilesH: H } = map.grid;
    const S = Math.max(2, Math.floor(240 / W));
    this.scale = S;
    this.base.width = W * S; this.base.height = H * S;
    this.canvas.width = W * S; this.canvas.height = H * S;
    const c = this.base.getContext('2d');
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        const t = ty * W + tx;
        const f = map.flags[t];
        let color = TileInfo[map.tiles[t]].color;
        if (map.tiles[t] === Tile.WATER && f & Flag.FROZEN) color = '#c9dbe6';
        c.fillStyle = color;
        c.fillRect(tx * S, ty * S, S, S);
        if (f & Flag.LAVA) { c.fillStyle = '#ff6a1a'; c.fillRect(tx * S, ty * S, S, S); }
      }
    }
    const g = map.grid;
    const toPx = (x, z) => [((x + g.worldW / 2) / g.tileSize) * S, ((z + g.worldH / 2) / g.tileSize) * S];
    c.lineCap = 'round';
    c.strokeStyle = '#3b7fc4';
    for (const r of map.rivers) {
      c.lineWidth = Math.max(1, S * 0.45);
      c.beginPath();
      for (let p = 0; p < r.x.length; p += 2) {
        const [x, y] = toPx(r.x[p], r.z[p]);
        p ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.stroke();
    }
    c.strokeStyle = '#9a7a4e';
    c.lineWidth = Math.max(1, S * 0.3);
    for (const l of map.roadLines) {
      c.beginPath();
      l.x.forEach((x, i) => { const [px, py] = toPx(x, l.z[i]); i ? c.lineTo(px, py) : c.moveTo(px, py); });
      c.stroke();
    }
    // ruins: dark diamonds; shrines: pale-blue diamonds
    for (const site of map.sites) {
      const [x, y] = toPx(site.x, site.z);
      const r = Math.max(2, S * 0.9);
      c.fillStyle = site.kind === 'ruin' ? '#3a2a1c' : '#9fe0ff';
      c.strokeStyle = site.kind === 'ruin' ? '#d8c08a' : '#1b3a4a';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y);
      c.closePath();
      c.fill();
      c.stroke();
    }
    // ports: small anchors (a ring on a shank)
    for (const port of map.ports ?? []) {
      const [x, y] = toPx(port.x, port.z);
      const r = Math.max(2, S * 0.8);
      for (const col of ['#1c1206', '#f1dca4']) {
        c.strokeStyle = col;
        c.lineWidth = col === '#1c1206' ? Math.max(2.5, S * 0.55) : Math.max(1, S * 0.22);
        c.beginPath();
        c.moveTo(x, y - r); c.lineTo(x, y + r);
        c.moveTo(x - r, y + r * 0.2); c.quadraticCurveTo(x - r * 0.8, y + r * 1.1, x, y + r); c.quadraticCurveTo(x + r * 0.8, y + r * 1.1, x + r, y + r * 0.2);
        c.stroke();
      }
    }
    for (const city of map.cities) {
      const [x, y] = toPx(city.x, city.z);
      c.fillStyle = city.owner >= 0 ? Factions[city.owner].color : NEUTRAL_COLOR;
      c.strokeStyle = '#111';
      c.lineWidth = 1;
      c.fillRect(x - S, y - S, S * 2, S * 2);
      c.strokeRect(x - S, y - S, S * 2, S * 2);
    }
  }

  draw(camera) {
    if (!this.map) return;
    const { ctx } = this;
    ctx.drawImage(this.base, 0, 0);
    // camera footprint on the ground plane
    const g = this.map.grid;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
      const v = new THREE.Vector3(x, y, 0.5).unproject(camera);
      const dir = v.sub(camera.position).normalize();
      let t = dir.y < -0.01 ? -camera.position.y / dir.y : 400;
      t = Math.min(t, 400);
      const p = camera.position.clone().addScaledVector(dir, t);
      return [((p.x + g.worldW / 2) / g.tileSize) * this.scale, ((p.z + g.worldH / 2) / g.tileSize) * this.scale];
    });
    ctx.strokeStyle = 'rgba(255,245,210,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
}
