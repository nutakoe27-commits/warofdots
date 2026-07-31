/** Seeded PRNG (mulberry32), so the map and the opening are the same every reload. */

export interface Rng {
  s: number;
}

export function makeRng(seed: number): Rng {
  return { s: seed >>> 0 };
}

export function rand(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function range(r: Rng, lo: number, hi: number): number {
  return lo + rand(r) * (hi - lo);
}

export function pick<T>(r: Rng, items: readonly T[]): T {
  return items[Math.floor(rand(r) * items.length)]!;
}
