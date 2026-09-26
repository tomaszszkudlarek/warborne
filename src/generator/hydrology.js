import { MinHeap } from '../core/heap.js';
import { toWorldX, toWorldZ, rasterizePolyline, chaikin } from './grid.js';

const D8X = [-1, 1, 0, 0, -1, 1, -1, 1];
const D8Y = [0, 0, -1, 1, -1, -1, 1, 1];
const D8D = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Priority-flood depression filling (Barnes et al.). Produces a surface where
 * every land cell drains to the sea, plus the processing order (low → high).
 */
export function priorityFlood(g, h) {
  const { gw, gh, n } = g;
  const eps = 1e-4;
  const filled = Float32Array.from(h);
  const visited = new Uint8Array(n);
  const order = new Int32Array(n);
  let oc = 0;
  const heap = new MinHeap(n >> 2);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      if (h[k] < 0 || i === 0 || j === 0 || i === gw - 1 || j === gh - 1) {
        visited[k] = 1;
        heap.push(h[k], k);
      }
    }
  }
  while (heap.size) {
    const c = heap.pop();
    order[oc++] = c;
    const ci = c % gw, cj = (c / gw) | 0;
    for (let d = 0; d < 8; d++) {
      const i = ci + D8X[d], j = cj + D8Y[d];
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const k = j * gw + i;
      if (visited[k]) continue;
      visited[k] = 1;
      filled[k] = Math.max(h[k], filled[c] + eps);
      heap.push(filled[k], k);
    }
  }
  return { filled, order: order.subarray(0, oc) };
}

/** Steepest-descent receivers on the filled surface and weighted flow accumulation. */
export function flowAccumulation(g, h, filled, order, rain) {
  const { gw, gh, n } = g;
  const recv = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    if (h[k] < 0) continue;
    const ci = k % gw, cj = (k / gw) | 0;
    let best = -1, bestSlope = 0;
    for (let d = 0; d < 8; d++) {
      const i = ci + D8X[d], j = cj + D8Y[d];
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const nk = j * gw + i;
      const s = (filled[k] - filled[nk]) / D8D[d];
      if (s > bestSlope) { bestSlope = s; best = nk; }
    }
    recv[k] = best;
  }
  const acc = new Float32Array(n);
  for (let k = 0; k < n; k++) acc[k] = h[k] >= 0 ? rain[k] : 0;
  for (let o = order.length - 1; o >= 0; o--) {
    const k = order[o];
    const r = recv[k];
    if (r >= 0) acc[r] += acc[k];
  }
  return { recv, acc };
}

/**
 * Digs a few irregular basins in low/mid land; priority flood later turns
 * them into lakes that rivers flow into and out of.
 */
export function digLakeBasins(g, h, amount, rng) {
  const { gw, gh, cellSize } = g;
  const sizeFactor = Math.sqrt((g.tilesW * g.tilesH) / (72 * 54));
  const count = Math.round(amount * 9 * sizeFactor);
  const placed = [];
  for (let a = 0; a < 800 && placed.length < count; a++) {
    const i = Math.floor((0.08 + rng() * 0.84) * gw), j = Math.floor((0.08 + rng() * 0.84) * gh);
    const k = j * gw + i;
    if (h[k] < 0.6 || h[k] > 6) continue;
    const R = (2.2 + rng() * 3.2) * (0.7 + amount * 0.6);
    // keep off the coast so the basin can hold water
    let ok = true;
    const rc = Math.ceil((R * 1.8) / cellSize);
    for (let dj = -rc; dj <= rc && ok; dj += 2) for (let di = -rc; di <= rc; di += 2) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= gw || jj >= gh || h[jj * gw + ii] < 0.1) { ok = false; break; }
    }
    if (!ok || placed.some((p) => Math.hypot(p[0] - i, p[1] - j) * cellSize < 14)) continue;
    placed.push([i, j]);
    const depth = 1.2 + rng() * 1.3;
    const lobes = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
    const ex = 0.7 + rng() * 0.6;
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
      const ang = Math.atan2(dj, di);
      const wob = 1 + 0.22 * Math.sin(ang * 2 + lobes[0]) + 0.14 * Math.sin(ang * 3 + lobes[1]) + 0.08 * Math.sin(ang * 5 + lobes[2]);
      const d = (Math.hypot(di * ex, dj / ex) * cellSize) / (R * wob);
      if (d >= 1.8) continue;
      const bowl = d < 1 ? 1 - d * d * 0.35 : 0.65 * (1 - smoothstep(1, 1.8, d));
      h[jj * gw + ii] -= depth * bowl;
    }
  }
}

/** Finds depressions deep and large enough to hold a lake. */
export function findLakes(g, h, filled, amount) {
  const { gw, gh, n } = g;
  const lakeId = new Int32Array(n).fill(-1);
  const lakes = [];
  if (amount <= 0) return { lakeId, lakes };
  const detailScale = (g.detail * g.detail) / 25;
  const minDepth = 0.45;
  const minSize = Math.max(6, 18 * detailScale);
  const seen = new Uint8Array(n);
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || h[s] < 0 || filled[s] - h[s] < 0.03) continue;
    const cells = [];
    let maxDepth = 0, level = -Infinity;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      maxDepth = Math.max(maxDepth, filled[c] - h[c]);
      level = Math.max(level, filled[c]);
      const ci = c % gw, cj = (c / gw) | 0;
      for (let d = 0; d < 4; d++) {
        const i = ci + D8X[d], j = cj + D8Y[d];
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const k = j * gw + i;
        if (seen[k] || h[k] < 0 || filled[k] - h[k] < 0.03) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    if (maxDepth >= minDepth && cells.length >= minSize) {
      const id = lakes.length;
      for (const c of cells) lakeId[c] = id;
      lakes.push({ id, level: level - 0.02, size: cells.length, cells });
    }
  }
  return { lakeId, lakes };
}

/**
 * Extracts the river network as polylines (source → mouth), keeping the
 * largest `maxRivers` drainage systems. Each branch is smoothed and given a
 * water-surface profile that never flows uphill.
 */
export function extractRivers(g, h, filled, order, recv, acc, lakeId, lakes, params) {
  const { gw, gh, n } = g;
  const cellArea = (5 / g.detail) ** 2; // normalize catchment to detail 5
  const T = (900 - params.rivers * 780) / cellArea;
  const isRiver = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (h[k] >= 0 && lakeId[k] < 0 && acc[k] >= T) isRiver[k] = 1;
  }
  // Longest upstream river length, used to pick the main stem at confluences.
  const L = new Float32Array(n);
  for (let o = order.length - 1; o >= 0; o--) {
    const k = order[o];
    if (!isRiver[k]) continue;
    L[k] += 1;
    const r = recv[k];
    if (r >= 0 && isRiver[r]) L[r] = Math.max(L[r], L[k]);
  }
  const outlets = [];
  for (let k = 0; k < n; k++) {
    if (isRiver[k] && (recv[k] < 0 || !isRiver[recv[k]])) outlets.push(k);
  }
  outlets.sort((a, b) => acc[b] - acc[a]);

  const upstream = (c) => {
    const ci = c % gw, cj = (c / gw) | 0;
    const ups = [];
    for (let d = 0; d < 8; d++) {
      const i = ci + D8X[d], j = cj + D8Y[d];
      if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
      const k = j * gw + i;
      if (isRiver[k] && recv[k] === c) ups.push(k);
    }
    return ups;
  };

  const minMain = g.detail * 4;
  const minTrib = g.detail * 3;
  const branches = [];
  let systems = 0;
  for (const outlet of outlets) {
    if (systems >= params.maxRivers) break;
    if (L[outlet] < minMain) continue;
    systems++;
    const queue = [{ start: outlet, end: recv[outlet], main: true }];
    while (queue.length) {
      const br = queue.shift();
      const path = [br.start];
      const children = [];
      let c = br.start;
      for (;;) {
        const ups = upstream(c);
        if (!ups.length) break;
        let main = ups[0];
        for (const u of ups) if (L[u] > L[main]) main = u;
        for (const u of ups) if (u !== main) children.push({ start: u, end: c, main: false });
        path.push(main);
        c = main;
      }
      if (path.length < (br.main ? minMain : minTrib)) continue;
      path.reverse();
      if (br.end >= 0) path.push(br.end);
      branches.push({ cells: path, system: systems - 1, endsInSea: br.end >= 0 && h[br.end] < 0, main: br.main });
      queue.push(...children);
    }
  }

  // Convert to smoothed world-space polylines with surface heights and widths.
  const rivers = [];
  for (const br of branches) {
    const xs = [], zs = [], ss = [], ws = [];
    for (let p = 0; p < br.cells.length; p++) {
      const k = br.cells[p];
      const i = k % gw, j = (k / gw) | 0;
      xs.push(toWorldX(g, i));
      zs.push(toWorldZ(g, j));
      let s = filled[k];
      if (h[k] < 0) s = 0;
      if (lakeId[k] >= 0) s = lakes[lakeId[k]].level;
      // enforce monotonic descent
      if (p > 0) s = Math.min(s, ss[p - 1]);
      ss.push(s);
      const flow = acc[k] / T;
      const taper = 0.55 + 0.45 * Math.min(1, p / (g.detail * 2));
      const w = params.riverWidth * Math.min(3.2, 0.75 + 0.32 * Math.sqrt(flow)) * taper;
      ws.push(Math.max(g.cellSize * 2.3, w));
    }
    // Extend the mouth a little into the sea so the ribbon fades under the surf.
    if (br.endsInSea && xs.length > 1) {
      const m = xs.length - 1;
      const dx = xs[m] - xs[m - 1], dz = zs[m] - zs[m - 1];
      const l = Math.hypot(dx, dz) || 1;
      xs.push(xs[m] + (dx / l) * 1.5);
      zs.push(zs[m] + (dz / l) * 1.5);
      ss.push(0);
      ws.push(ws[m] * 1.3);
    }
    const [X, Z, S, W] = chaikin([xs, zs, ss, ws], 3);
    rivers.push({ x: X, z: Z, s: S, w: W, system: br.system, main: br.main, endsInSea: br.endsInSea });
  }
  return { rivers, isRiverCell: isRiver, threshold: T };
}

/**
 * Carves river channels into the terrain and flattens a floodplain around
 * them. Returns per-cell normalized distance to the nearest river (in river
 * radii) which later drives wet soil, vegetation exclusion and tile flags.
 */
export function carveRivers(g, h, rivers, lakeId) {
  const { n, cellSize } = g;
  const rDist = new Float32Array(n).fill(1e9);
  const rS = new Float32Array(n);
  const rRad = new Float32Array(n);
  const OUTER = 2.6;
  for (const r of rivers) {
    let maxR = 0;
    for (const w of r.w) maxR = Math.max(maxR, w / 2);
    rasterizePolyline(g, r.x, r.z, maxR * OUTER + cellSize, (k, d, seg, t) => {
      const radius = (r.w[seg] * (1 - t) + r.w[seg + 1] * t) / 2;
      const dn = d / radius;
      if (dn < rDist[k]) {
        rDist[k] = dn;
        rS[k] = r.s[seg] * (1 - t) + r.s[seg + 1] * t;
        rRad[k] = radius;
      }
    });
  }
  for (let k = 0; k < n; k++) {
    const t = rDist[k];
    if (t > OUTER || lakeId[k] >= 0) continue;
    const s = rS[k];
    const depth = Math.min(0.9, 0.22 + rRad[k] * 0.35);
    if (t < 1) {
      const bed = s - depth * (1 - t * t);
      if (h[k] >= 0 || bed < h[k]) h[k] = bed;
    } else if (h[k] >= 0) {
      const u = (t - 1) / (OUTER - 1);
      const target = s + 0.02 + 0.35 * u;
      h[k] = target + (h[k] - target) * smoothstep(0, 1, u);
    }
  }
  return rDist;
}

/** Traces lava flows downhill from each crater rim. */
export function traceLava(g, h, volcanoes, rng) {
  const { gw, gh } = g;
  const flows = [];
  for (const v of volcanoes) {
    const nFlows = 2 + Math.floor(rng() * 3);
    for (let f = 0; f < nFlows; f++) {
      const ang = rng() * Math.PI * 2;
      let ci = Math.round(v.ci + Math.cos(ang) * (v.craterR / g.cellSize) * 1.8);
      let cj = Math.round(v.cj + Math.sin(ang) * (v.craterR / g.cellSize) * 1.8);
      const xs = [], zs = [];
      const maxLen = Math.floor((v.radius * (1.2 + rng() * 0.9)) / g.cellSize);
      for (let s = 0; s < maxLen; s++) {
        if (ci < 1 || cj < 1 || ci >= gw - 1 || cj >= gh - 1) break;
        const k = cj * gw + ci;
        if (h[k] < 0.2) break;
        xs.push(toWorldX(g, ci)); zs.push(toWorldZ(g, cj));
        // steepest descent with a little meander
        let best = -1, bestV = Infinity;
        for (let d = 0; d < 8; d++) {
          const nk = (cj + D8Y[d]) * gw + ci + D8X[d];
          const val = h[nk] + rng() * 0.08;
          if (val < bestV) { bestV = val; best = d; }
        }
        if (best < 0) break;
        ci += D8X[best]; cj += D8Y[best];
      }
      if (xs.length > 3) {
        const [X, Z] = chaikin([xs, zs], 2);
        flows.push({ x: X, z: Z, width: 0.45 + rng() * 0.35 });
      }
    }
  }
  return flows;
}
