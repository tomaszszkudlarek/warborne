// Deterministic PRNG (mulberry32) — every generator step draws from seeded streams
// so the same seed + params always yields the same map.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive an independent stream for a named subsystem.
export function subRng(seed, name) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  }
  return mulberry32(h >>> 0);
}

export const rrange = (rng, a, b) => a + (b - a) * rng();
export const rint = (rng, a, b) => Math.floor(rrange(rng, a, b + 1));
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
