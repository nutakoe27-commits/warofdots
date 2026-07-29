/**
 * Seeded PRNG (mulberry32). The only source of randomness anywhere in the
 * simulation — `Math.random` is an ESLint error inside `src/core` and `src/ai`.
 *
 * The state is a single uint32 so it serialises into a replay for free.
 */

import type { RngState } from './types.ts';

export function makeRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

export function cloneRng(r: RngState): RngState {
  return { s: r.s };
}

/** Derives an independent stream from a base seed, so bots cannot desync the world. */
export function deriveRng(seed: number, salt: number): RngState {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (salt + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return { s: h };
}

export function nextU32(r: RngState): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Uniform in [0, 1). */
export function rand(r: RngState): number {
  return nextU32(r) / 4294967296;
}

/** Uniform in [lo, hi). */
export function randRange(r: RngState, lo: number, hi: number): number {
  return lo + rand(r) * (hi - lo);
}

/** Uniform integer in [0, n). */
export function randInt(r: RngState, n: number): number {
  return n <= 0 ? 0 : nextU32(r) % n;
}

export function chance(r: RngState, p: number): boolean {
  return rand(r) < p;
}

/** Uniform point in the disc of radius `radius`, returned through `out`. */
export function randInDisc(r: RngState, radius: number, out: { x: number; y: number }): void {
  const a = rand(r) * Math.PI * 2;
  const d = Math.sqrt(rand(r)) * radius;
  out.x = Math.cos(a) * d;
  out.y = Math.sin(a) * d;
}

/** In-place Fisher–Yates. Deterministic given the stream. */
export function shuffle<T>(r: RngState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(r, i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
