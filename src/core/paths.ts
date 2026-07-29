/**
 * Pooled, reference-counted polylines.
 *
 * A drawn path is shared by every unit in the selection rather than copied per
 * unit, so ordering 300 units allocates one `Float32Array` instead of 300.
 * Formation spread is a per-unit lateral offset applied against the local normal.
 */

import type { PathPool } from './types.ts';
import { polylineLength } from './geometry.ts';
import { PATH_MAX_POINTS } from './balance.ts';

export function createPathPool(capacity = 256): PathPool {
  return {
    pts: new Array<Float32Array | null>(capacity).fill(null),
    cum: new Array<Float32Array | null>(capacity).fill(null),
    refs: new Int32Array(capacity),
    free: Array.from({ length: capacity }, (_, i) => capacity - 1 - i),
    capacity,
  };
}

function grow(pool: PathPool): void {
  const next = pool.capacity * 2;
  const refs = new Int32Array(next);
  refs.set(pool.refs);
  pool.refs = refs;
  for (let i = pool.capacity; i < next; i++) {
    pool.pts.push(null);
    pool.cum.push(null);
    pool.free.push(next - 1 - (i - pool.capacity));
  }
  pool.capacity = next;
}

/** Copies `pts` into the pool with refcount 0. Returns the slot, or -1 if degenerate. */
export function allocPath(pool: PathPool, pts: ArrayLike<number>): number {
  const n = pts.length >> 1;
  if (n < 2) return -1;
  const count = Math.min(n, PATH_MAX_POINTS);
  if (pool.free.length === 0) grow(pool);
  const idx = pool.free.pop()!;

  const arr = new Float32Array(count * 2);
  for (let i = 0; i < count * 2; i++) arr[i] = pts[i]!;
  const cum = new Float32Array(count);
  for (let i = 1; i < count; i++) {
    const dx = arr[i * 2]! - arr[i * 2 - 2]!;
    const dy = arr[i * 2 + 1]! - arr[i * 2 - 1]!;
    cum[i] = cum[i - 1]! + Math.hypot(dx, dy);
  }
  if (cum[count - 1]! <= 0) {
    pool.free.push(idx);
    return -1;
  }

  pool.pts[idx] = arr;
  pool.cum[idx] = cum;
  pool.refs[idx] = 0;
  return idx;
}

export function retainPath(pool: PathPool, idx: number): void {
  if (idx < 0) return;
  pool.refs[idx]!++;
}

export function releasePath(pool: PathPool, idx: number): void {
  if (idx < 0) return;
  const left = --pool.refs[idx]!;
  if (left > 0) return;
  pool.refs[idx] = 0;
  if (pool.pts[idx] !== null) {
    pool.pts[idx] = null;
    pool.cum[idx] = null;
    pool.free.push(idx);
  }
}

export function pathLength(pool: PathPool, idx: number): number {
  const cum = pool.cum[idx];
  return cum ? cum[cum.length - 1]! : 0;
}

export function pathPointCount(pool: PathPool, idx: number): number {
  const pts = pool.pts[idx];
  return pts ? pts.length >> 1 : 0;
}

export interface PathSample {
  x: number;
  y: number;
  /** Unit tangent. */
  tx: number;
  ty: number;
  /** True when `s` is at or past the end of the polyline. */
  done: boolean;
}

/**
 * Point at arc length `s` along path `idx`, with the local tangent.
 * Segment search is a linear scan from a hint index because units advance
 * monotonically — binary search would be slower in the common case.
 */
export function samplePath(pool: PathPool, idx: number, s: number, out: PathSample): void {
  const pts = pool.pts[idx];
  const cum = pool.cum[idx];
  if (!pts || !cum) {
    out.x = 0;
    out.y = 0;
    out.tx = 0;
    out.ty = 0;
    out.done = true;
    return;
  }
  const n = cum.length;
  const total = cum[n - 1]!;
  const clamped = s < 0 ? 0 : s > total ? total : s;

  let seg = 1;
  while (seg < n - 1 && cum[seg]! < clamped) seg++;
  const s0 = cum[seg - 1]!;
  const s1 = cum[seg]!;
  const t = s1 > s0 ? (clamped - s0) / (s1 - s0) : 0;

  const ax = pts[(seg - 1) * 2]!;
  const ay = pts[(seg - 1) * 2 + 1]!;
  const bx = pts[seg * 2]!;
  const by = pts[seg * 2 + 1]!;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;

  out.x = ax + dx * t;
  out.y = ay + dy * t;
  out.tx = dx / len;
  out.ty = dy / len;
  out.done = clamped >= total;
}

export function makePathSample(): PathSample {
  return { x: 0, y: 0, tx: 0, ty: 0, done: false };
}

/** Total length of a raw flat point list, before it enters the pool. */
export function rawLength(pts: ArrayLike<number>): number {
  return polylineLength(pts);
}
