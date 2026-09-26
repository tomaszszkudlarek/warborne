// Solid structures on the map (castles, ruins, shrines) as footprints that armies walk
// around and stand beside. Pure data, no three.js.
//
// A footprint is a rounded, oriented rectangle { x, z, yaw, hx, hz, r, top }: centre, turn
// about +Y, half-extents along its local x / z, the corner radius (r <= min(hx, hz)) and the
// height of the structure's highest point.

const CELL = 4; // spatial hash cell, world units

export class Obstacles {
  constructor(footprints = []) {
    this.list = footprints.map((f) => ({ ...f, c: Math.cos(f.yaw), s: Math.sin(f.yaw), reach: Math.hypot(f.hx, f.hz) }));
    this.cells = new Map();
    for (const o of this.list) {
      const R = o.reach + 2; // + the widest figure's radius
      for (let cx = Math.floor((o.x - R) / CELL); cx <= Math.floor((o.x + R) / CELL); cx++) {
        for (let cz = Math.floor((o.z - R) / CELL); cz <= Math.floor((o.z + R) / CELL); cz++) {
          const k = cx * 73856093 ^ cz * 19349663;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k).push(o);
        }
      }
    }
    this._near = { d: 0, nx: 0, nz: 0, o: null };
  }

  get empty() { return this.list.length === 0; }

  /** Footprints that may lie within ~2 units of (x, z). */
  _around(x, z) {
    return this.cells.get(Math.floor(x / CELL) * 73856093 ^ Math.floor(z / CELL) * 19349663);
  }

  /**
   * Signed distance from (x, z) to the nearest footprint's outline (negative inside) and
   * the outward normal there: { d, nx, nz, o } (o = null and d = Infinity far from all).
   * The object returned is reused between calls.
   */
  nearest(x, z) {
    const out = this._near;
    out.d = Infinity; out.o = null;
    const list = this._around(x, z);
    if (!list) return out;
    for (const o of list) {
      // into the footprint's frame
      const dx = x - o.x, dz = z - o.z;
      const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
      const qx = Math.abs(lx) - (o.hx - o.r), qz = Math.abs(lz) - (o.hz - o.r);
      let d, gx, gz;
      if (qx > 0 && qz > 0) {
        const l = Math.hypot(qx, qz);
        d = l - o.r; gx = qx / l; gz = qz / l;
      } else if (qx > qz) {
        d = qx - o.r; gx = 1; gz = 0;
      } else {
        d = qz - o.r; gx = 0; gz = 1;
      }
      if (d >= out.d) continue;
      gx *= Math.sign(lx) || 1;
      gz *= Math.sign(lz) || 1;
      out.d = d;
      // back to world
      out.nx = gx * o.c + gz * o.s;
      out.nz = -gx * o.s + gz * o.c;
      out.o = o;
    }
    return out;
  }

  /** Height a flyer of `radius` at (x, z) must clear: the top of any structure under it,
   * or -Infinity. */
  topAt(x, z, radius) {
    let top = -Infinity;
    const list = this._around(x, z);
    if (!list) return top;
    for (const o of list) {
      const dx = x - o.x, dz = z - o.z;
      const lx = Math.abs(dx * o.c - dz * o.s), lz = Math.abs(dx * o.s + dz * o.c);
      if (lx < o.hx + radius && lz < o.hz + radius) top = Math.max(top, o.top);
    }
    return top;
  }

  /** (x, z) moved just outside every footprint, `radius` clear of its outline: {x, z}. */
  pushOut(x, z, radius, out = { x, z }) {
    out.x = x; out.z = z;
    for (let i = 0; i < 4; i++) {
      const n = this.nearest(out.x, out.z);
      if (n.d >= radius) break;
      const k = radius - n.d + 1e-3;
      out.x += n.nx * k;
      out.z += n.nz * k;
    }
    return out;
  }

  /**
   * Heading for a walker at (x, z) with `radius` that wants to go along the unit vector
   * (dx, dz): near a footprint the part of it that leads into the wall turns into a
   * slide along the wall, so the walker skirts the structure rather than walking through it.
   * `state.side` (±1) remembers which way it goes round when it meets a wall head-on;
   * (gx, gz): where it is going, to choose that side; a goal it reaches before it would
   * touch the wall needs no turn at all.
   * Returns the new heading in out {x, z} (unit length, or zero if blocked).
   */
  steer(x, z, dx, dz, radius, state, gx, gz, out = { x: 0, z: 0 }) {
    out.x = dx; out.z = dz;
    const n = this.nearest(x, z);
    const BAND = 0.5 + radius; // start turning this far out from the wall
    const gap = n.d - radius;
    if (gap > BAND) { state.side = 0; return out; }
    const into = dx * n.nx + dz * n.nz;
    if (into >= 0) return out; // already heading away
    // the goal comes before the wall (e.g. its stand beside the wall): straight on
    const touch = Math.max(0, n.d - radius * 0.9) / -into;
    if (Math.hypot(gx - x, gz - z) <= touch + 0.02) return out;
    // tangent along the wall, toward the goal's side
    let tx = -n.nz, tz = n.nx;
    if (!state.side) {
      const o = n.o;
      // go round the side the goal lies on (seen from the footprint's centre)
      const cross = (x - o.x) * (gz - o.z) - (z - o.z) * (gx - o.x);
      state.side = cross >= 0 ? 1 : -1;
      if (Math.abs(dx * tx + dz * tz) > 0.3) state.side = dx * tx + dz * tz > 0 ? 1 : -1;
    }
    tx *= state.side; tz *= state.side;
    // blend from the wanted heading to the slide as the wall comes close
    const w = Math.min(1, Math.max(0, 1 - gap / BAND));
    const k = w * w * (3 - 2 * w);
    const sx = dx - into * n.nx, sz = dz - into * n.nz; // wanted heading with the push into the wall removed
    const sl = Math.hypot(sx, sz);
    // head-on, the slide keeps the full pace along the chosen side
    const ax = sl > 0.35 ? sx / sl : tx, az = sl > 0.35 ? sz / sl : tz;
    out.x = dx + (ax - dx) * k;
    out.z = dz + (az - dz) * k;
    const l = Math.hypot(out.x, out.z);
    if (l > 1e-6) { out.x /= l; out.z /= l; }
    return out;
  }
}
