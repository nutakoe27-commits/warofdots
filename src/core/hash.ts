/**
 * FNV-1a hash of the whole simulation state.
 *
 * This is the backbone of the determinism test: two runs of the same match with
 * the same seed and the same command log must produce the same hash at every
 * tick. When someone slips a `Math.random()` into the core, this is what fails.
 */

import type { World } from './types.ts';

const OFFSET = 0x811c9dc5;

export function fnv1a(h: number, byte: number): number {
  h ^= byte & 0xff;
  return Math.imul(h, 0x01000193) >>> 0;
}

function hashU32(h: number, v: number): number {
  const x = v >>> 0;
  h = fnv1a(h, x);
  h = fnv1a(h, x >>> 8);
  h = fnv1a(h, x >>> 16);
  return fnv1a(h, x >>> 24);
}

/**
 * Floats are quantised before hashing. Bit-exact float comparison would also be
 * deterministic, but quantising keeps the hash stable across the `Math.fround`
 * rounding that happens when values move in and out of `Float32Array`, so the
 * test reports genuine divergence rather than representation noise.
 */
function hashF(h: number, v: number): number {
  return hashU32(h, Math.round(v * 4096) | 0);
}

function hashIntArray(h: number, a: ArrayLike<number>, n: number): number {
  for (let i = 0; i < n; i++) h = hashU32(h, a[i]!);
  return h;
}

function hashFloatArray(h: number, a: ArrayLike<number>, n: number): number {
  for (let i = 0; i < n; i++) h = hashF(h, a[i]!);
  return h;
}

function hashString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = hashU32(h, s.charCodeAt(i));
  return h;
}

function hashUnits(h: number, w: World): number {
  const u = w.units;
  h = hashU32(h, u.count);
  h = hashU32(h, u.nextId);
  // Iterate the whole capacity: a stale value in a freed slot that leaks back
  // into play is exactly the class of bug this hash exists to catch.
  const n = u.capacity;
  h = hashIntArray(h, u.id, n);
  h = hashIntArray(h, u.owner, n);
  h = hashIntArray(h, u.kind, n);
  h = hashIntArray(h, u.alive, n);
  h = hashIntArray(h, u.inCombat, n);
  h = hashIntArray(h, u.supplied, n);
  h = hashIntArray(h, u.encircled, n);
  h = hashIntArray(h, u.pathIdx, n);
  h = hashIntArray(h, u.target, n);
  h = hashFloatArray(h, u.x, n);
  h = hashFloatArray(h, u.y, n);
  h = hashFloatArray(h, u.vx, n);
  h = hashFloatArray(h, u.vy, n);
  h = hashFloatArray(h, u.hp, n);
  h = hashFloatArray(h, u.morale, n);
  h = hashFloatArray(h, u.pathPos, n);
  h = hashFloatArray(h, u.waterTime, n);
  h = hashFloatArray(h, u.lateral, n);
  return h;
}

function hashCities(h: number, w: World): number {
  for (const c of w.cities) {
    h = hashString(h, c.id);
    h = hashU32(h, c.owner);
    h = hashU32(h, c.active ? 1 : 0);
    h = hashF(h, c.eco);
    h = hashF(h, c.captureProgress);
    h = hashU32(h, c.capturingPlayer + 1);
    h = hashF(h, c.spawnCooldown);
  }
  return h;
}

export function hashWorld(w: World): number {
  let h = OFFSET;
  h = hashU32(h, w.tick);
  h = hashU32(h, w.rng.s);
  h = hashUnits(h, w);
  h = hashCities(h, w);

  for (const p of w.players) {
    h = hashU32(h, p.alive ? 1 : 0);
    h = hashF(h, p.threshold);
    h = hashF(h, p.heavyShare);
  }

  const inf = w.influence;
  h = hashU32(h, inf.lastTick);
  h = hashIntArray(h, inf.owner, inf.owner.length);
  h = hashIntArray(h, inf.supplied, inf.supplied.length);
  h = hashU32(h, inf.pockets.length);
  for (const pocket of inf.pockets) {
    h = hashU32(h, pocket.player);
    h = hashU32(h, pocket.cells);
    h = hashF(h, pocket.eco);
    h = hashU32(h, pocket.supplyCap);
  }

  for (const s of w.stats.players) {
    h = hashU32(h, s.produced);
    h = hashU32(h, s.lost);
    h = hashU32(h, s.captured);
  }

  h = hashU32(h, w.outcome ? w.outcome.team + 2 : 0);
  return h >>> 0;
}

export function hashHex(w: World): string {
  return hashWorld(w).toString(16).padStart(8, '0');
}
