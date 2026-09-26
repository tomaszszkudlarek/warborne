// Particle-based hydraulic erosion. Droplets run downhill, pick up sediment on
// steep ground and drop it where they slow down — carving gullies into
// mountains and building alluvial fans at their feet.

export function erode(g, h, strength, rng, onProgress) {
  if (strength <= 0) return;
  const { gw, gh, cellSize } = g;
  const droplets = Math.floor(g.n * (0.25 + strength * 0.9));
  const inertia = 0.1;
  const capacityFactor = 2.0;
  const minCapacity = 0.01;
  const erodeRate = 0.04 + 0.08 * strength;
  const depositRate = 0.25;
  const evaporate = 0.025;
  const gravity = 6;
  const maxSteps = 48;
  const radius = 2;

  // Precomputed erosion brush (normalized weights).
  const bOff = [], bW = [];
  let wSum = 0;
  for (let dj = -radius; dj <= radius; dj++) {
    for (let di = -radius; di <= radius; di++) {
      const d = Math.hypot(di, dj);
      if (d > radius) continue;
      const w = 1 - d / (radius + 0.5);
      bOff.push([di, dj]); bW.push(w); wSum += w;
    }
  }
  for (let b = 0; b < bW.length; b++) bW[b] /= wSum;

  // Heights in cell units so slope magnitudes are resolution independent.
  const inv = 1 / cellSize;
  const H = new Float32Array(g.n);
  for (let k = 0; k < g.n; k++) H[k] = h[k] * inv;

  const heightGrad = (x, y, out) => {
    const i = x | 0, j = y | 0;
    const fx = x - i, fy = y - j;
    const k = j * gw + i;
    const a = H[k], b = H[k + 1], c = H[k + gw], d = H[k + gw + 1];
    out[0] = (b - a) * (1 - fy) + (d - c) * fy;
    out[1] = (c - a) * (1 - fx) + (d - b) * fx;
    out[2] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };

  const g0 = [0, 0, 0], g1 = [0, 0, 0];
  const reportEvery = Math.max(1, Math.floor(droplets / 20));
  for (let n = 0; n < droplets; n++) {
    if (onProgress && n % reportEvery === 0) onProgress(n / droplets);
    let x = 1 + rng() * (gw - 3), y = 1 + rng() * (gh - 3);
    if (H[(y | 0) * gw + (x | 0)] < 0) continue; // only rain on land
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;

    for (let step = 0; step < maxSteps; step++) {
      const ci = x | 0, cj = y | 0;
      const fx = x - ci, fy = y - cj;
      heightGrad(x, y, g0);
      dx = dx * inertia - g0[0] * (1 - inertia);
      dy = dy * inertia - g0[1] * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-8) break;
      dx /= len; dy /= len;
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= gw - 2 || ny >= gh - 2) break;
      heightGrad(nx, ny, g1);
      const dh = g1[2] - g0[2];

      const capacity = Math.max(-dh * speed * water * capacityFactor, minCapacity);
      const k = cj * gw + ci;
      if (sediment > capacity || dh > 0) {
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositRate;
        sediment -= amount;
        H[k] += amount * (1 - fx) * (1 - fy);
        H[k + 1] += amount * fx * (1 - fy);
        H[k + gw] += amount * (1 - fx) * fy;
        H[k + gw + 1] += amount * fx * fy;
      } else {
        const amount = Math.min((capacity - sediment) * erodeRate, -dh);
        for (let b = 0; b < bOff.length; b++) {
          const bi = ci + bOff[b][0], bj = cj + bOff[b][1];
          if (bi < 0 || bj < 0 || bi >= gw || bj >= gh) continue;
          const bk = bj * gw + bi;
          const e = amount * bW[b];
          H[bk] -= e;
          sediment += e;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity));
      water *= 1 - evaporate;
      x = nx; y = ny;
      if (g1[2] < -0.3 * inv) break; // reached the sea: drop the rest in the delta
    }
  }

  for (let k = 0; k < g.n; k++) h[k] = H[k] * cellSize;
}

// Thermal relaxation: limits slopes to a talus angle, softening noise spikes.
export function thermal(g, h, iterations = 2, talus = 1.6) {
  const { gw, gh, cellSize } = g;
  const maxDiff = talus * cellSize;
  for (let it = 0; it < iterations; it++) {
    for (let j = 1; j < gh - 1; j++) {
      for (let i = 1; i < gw - 1; i++) {
        const k = j * gw + i;
        const nbs = [k - 1, k + 1, k - gw, k + gw];
        for (const nk of nbs) {
          const d = h[k] - h[nk];
          if (d > maxDiff) {
            const move = (d - maxDiff) * 0.25;
            h[k] -= move; h[nk] += move;
          }
        }
      }
    }
  }
}
