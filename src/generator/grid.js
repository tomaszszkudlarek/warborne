// Heightfield grid helpers. Cells are the vertices of the terrain mesh:
// cell (i, j) sits at world (i * cellSize - worldW / 2, j * cellSize - worldH / 2).

export function makeGrid(params) {
  const detail = Math.max(3, Math.min(8, Math.round(params.detail)));
  const tileSize = 2;
  const cellSize = tileSize / detail;
  const gw = params.tilesW * detail + 1;
  const gh = params.tilesH * detail + 1;
  return {
    tilesW: params.tilesW,
    tilesH: params.tilesH,
    detail,
    tileSize,
    cellSize,
    gw,
    gh,
    n: gw * gh,
    worldW: (gw - 1) * cellSize,
    worldH: (gh - 1) * cellSize,
  };
}

export const toWorldX = (g, i) => i * g.cellSize - g.worldW / 2;
export const toWorldZ = (g, j) => j * g.cellSize - g.worldH / 2;
export const toCellX = (g, x) => (x + g.worldW / 2) / g.cellSize;
export const toCellZ = (g, z) => (z + g.worldH / 2) / g.cellSize;

export function sampleBilinear(g, arr, ci, cj) {
  const x = Math.max(0, Math.min(g.gw - 1.0001, ci));
  const y = Math.max(0, Math.min(g.gh - 1.0001, cj));
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const k = j * g.gw + i;
  const a = arr[k], b = arr[k + 1], c = arr[k + g.gw], d = arr[k + g.gw + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// Slope magnitude (rise over run, world units) via central differences.
export function computeSlope(g, h) {
  const { gw, gh, cellSize } = g;
  const s = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const jm = Math.max(0, j - 1), jp = Math.min(gh - 1, j + 1);
    for (let i = 0; i < gw; i++) {
      const im = Math.max(0, i - 1), ip = Math.min(gw - 1, i + 1);
      const dx = (h[j * gw + ip] - h[j * gw + im]) / ((ip - im) * cellSize);
      const dz = (h[jp * gw + i] - h[jm * gw + i]) / ((jp - jm) * cellSize);
      s[j * gw + i] = Math.sqrt(dx * dx + dz * dz);
    }
  }
  return s;
}

// Two-pass chamfer distance transform (in cells) from cells where seed(k) is true.
export function distanceField(g, seed) {
  const { gw, gh } = g;
  const INF = 1e9;
  const d = new Float32Array(gw * gh);
  for (let k = 0; k < d.length; k++) d[k] = seed(k) ? 0 : INF;
  const A = 1, B = Math.SQRT2;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + A);
      if (j > 0) {
        v = Math.min(v, d[k - gw] + A);
        if (i > 0) v = Math.min(v, d[k - gw - 1] + B);
        if (i < gw - 1) v = Math.min(v, d[k - gw + 1] + B);
      }
      d[k] = v;
    }
  }
  for (let j = gh - 1; j >= 0; j--) {
    for (let i = gw - 1; i >= 0; i--) {
      const k = j * gw + i;
      let v = d[k];
      if (i < gw - 1) v = Math.min(v, d[k + 1] + A);
      if (j < gh - 1) {
        v = Math.min(v, d[k + gw] + A);
        if (i < gw - 1) v = Math.min(v, d[k + gw + 1] + B);
        if (i > 0) v = Math.min(v, d[k + gw - 1] + B);
      }
      d[k] = v;
    }
  }
  return d;
}

// Separable box blur, in place, for `channels` interleaved float channels.
export function boxBlur(g, data, channels, radius, passes = 1) {
  const { gw, gh } = g;
  const tmp = new Float32Array(data.length);
  const win = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < gh; j++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let o = -radius; o <= radius; o++) {
          const i = Math.max(0, Math.min(gw - 1, o));
          acc += data[(j * gw + i) * channels + c];
        }
        for (let i = 0; i < gw; i++) {
          tmp[(j * gw + i) * channels + c] = acc / win;
          const iOut = Math.max(0, i - radius);
          const iIn = Math.min(gw - 1, i + radius + 1);
          acc += data[(j * gw + iIn) * channels + c] - data[(j * gw + iOut) * channels + c];
        }
      }
    }
    for (let i = 0; i < gw; i++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let o = -radius; o <= radius; o++) {
          const j = Math.max(0, Math.min(gh - 1, o));
          acc += tmp[(j * gw + i) * channels + c];
        }
        for (let j = 0; j < gh; j++) {
          data[(j * gw + i) * channels + c] = acc / win;
          const jOut = Math.max(0, j - radius);
          const jIn = Math.min(gh - 1, j + radius + 1);
          acc += tmp[(jIn * gw + i) * channels + c] - tmp[(jOut * gw + i) * channels + c];
        }
      }
    }
  }
  return data;
}

// Rasterize a world-space polyline: calls fn(k, dist, segIndex, t) for every
// cell within `reach` world units of the line.
export function rasterizePolyline(g, xs, zs, reach, fn) {
  const { gw, gh, cellSize } = g;
  for (let s = 0; s < xs.length - 1; s++) {
    const ax = xs[s], az = zs[s], bx = xs[s + 1], bz = zs[s + 1];
    const i0 = Math.max(0, Math.floor(toCellX(g, Math.min(ax, bx) - reach)));
    const i1 = Math.min(gw - 1, Math.ceil(toCellX(g, Math.max(ax, bx) + reach)));
    const j0 = Math.max(0, Math.floor(toCellZ(g, Math.min(az, bz) - reach)));
    const j1 = Math.min(gh - 1, Math.ceil(toCellZ(g, Math.max(az, bz) + reach)));
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const z = j * cellSize - g.worldH / 2;
      for (let i = i0; i <= i1; i++) {
        const x = i * cellSize - g.worldW / 2;
        let t = ((x - ax) * dx + (z - az) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t - x, pz = az + dz * t - z;
        const d = Math.sqrt(px * px + pz * pz);
        if (d <= reach) fn(j * gw + i, d, s, t);
      }
    }
  }
}

// Chaikin corner cutting on parallel arrays; keeps endpoints fixed.
export function chaikin(arrays, iterations = 2) {
  let cur = arrays;
  for (let it = 0; it < iterations; it++) {
    const n = cur[0].length;
    if (n < 3) return cur;
    const out = cur.map(() => []);
    for (let a = 0; a < cur.length; a++) out[a].push(cur[a][0]);
    for (let p = 0; p < n - 1; p++) {
      for (let a = 0; a < cur.length; a++) {
        const v0 = cur[a][p], v1 = cur[a][p + 1];
        out[a].push(0.75 * v0 + 0.25 * v1, 0.25 * v0 + 0.75 * v1);
      }
    }
    for (let a = 0; a < cur.length; a++) out[a].push(cur[a][n - 1]);
    cur = out;
  }
  return cur;
}
