/**
 * Uniform-grid spatial hash, rebuilt from scratch every tick with a counting sort.
 *
 * Rebuilding is cheaper than maintaining incremental buckets at these unit counts
 * and, more importantly, it is order-independent: the bucket contents depend only
 * on positions, never on the order in which units happened to move.
 */

import type { SpatialHash, UnitStore } from './types.ts';
import { HASH_CELL } from './balance.ts';

export function createSpatialHash(
  worldW: number,
  worldH: number,
  capacity: number,
  cellSize = HASH_CELL,
): SpatialHash {
  const gw = Math.max(1, Math.ceil(worldW / cellSize));
  const gh = Math.max(1, Math.ceil(worldH / cellSize));
  return {
    cellSize,
    gw,
    gh,
    start: new Int32Array(gw * gh + 1),
    items: new Int32Array(capacity),
    counts: new Int32Array(gw * gh),
    capacity,
  };
}

function cellOf(h: SpatialHash, x: number, y: number): number {
  let cx = (x / h.cellSize) | 0;
  let cy = (y / h.cellSize) | 0;
  if (cx < 0) cx = 0;
  else if (cx >= h.gw) cx = h.gw - 1;
  if (cy < 0) cy = 0;
  else if (cy >= h.gh) cy = h.gh - 1;
  return cy * h.gw + cx;
}

export function rebuildSpatial(h: SpatialHash, u: UnitStore): void {
  h.counts.fill(0);
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    h.counts[cellOf(h, u.x[i]!, u.y[i]!)]!++;
  }
  let acc = 0;
  const cells = h.gw * h.gh;
  for (let c = 0; c < cells; c++) {
    h.start[c] = acc;
    acc += h.counts[c]!;
  }
  h.start[cells] = acc;

  // `counts` doubles as the per-cell write cursor during the scatter pass.
  h.counts.fill(0);
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    const c = cellOf(h, u.x[i]!, u.y[i]!);
    h.items[h.start[c]! + h.counts[c]!] = i;
    h.counts[c]!++;
  }
}

export interface CellRange {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function cellRange(h: SpatialHash, x: number, y: number, r: number, out: CellRange): void {
  out.x0 = Math.max(0, ((x - r) / h.cellSize) | 0);
  out.x1 = Math.min(h.gw - 1, ((x + r) / h.cellSize) | 0);
  out.y0 = Math.max(0, ((y - r) / h.cellSize) | 0);
  out.y1 = Math.min(h.gh - 1, ((y + r) / h.cellSize) | 0);
}

export function makeCellRange(): CellRange {
  return { x0: 0, x1: 0, y0: 0, y1: 0 };
}

/**
 * Fills `out` with the slots of every unit in the cells overlapping the query
 * disc — candidates, not an exact radius test. Returns how many were written.
 */
export function queryInto(
  h: SpatialHash,
  x: number,
  y: number,
  r: number,
  out: Int32Array,
  range: CellRange,
): number {
  cellRange(h, x, y, r, range);
  let n = 0;
  for (let cy = range.y0; cy <= range.y1; cy++) {
    const row = cy * h.gw;
    for (let cx = range.x0; cx <= range.x1; cx++) {
      const c = row + cx;
      const end = h.start[c + 1]!;
      for (let k = h.start[c]!; k < end; k++) {
        if (n >= out.length) return n;
        out[n++] = h.items[k]!;
      }
    }
  }
  return n;
}

/**
 * True when any living unit not owned by `owner` sits within `r`.
 * Used by the regeneration rule, which only needs existence, not the nearest.
 */
export function anyEnemyWithin(
  h: SpatialHash,
  u: UnitStore,
  owner: number,
  x: number,
  y: number,
  r: number,
  range: CellRange,
): boolean {
  cellRange(h, x, y, r, range);
  const r2 = r * r;
  for (let cy = range.y0; cy <= range.y1; cy++) {
    const row = cy * h.gw;
    for (let cx = range.x0; cx <= range.x1; cx++) {
      const c = row + cx;
      const end = h.start[c + 1]!;
      for (let k = h.start[c]!; k < end; k++) {
        const j = h.items[k]!;
        if (u.owner[j] === owner) continue;
        const dx = u.x[j]! - x;
        const dy = u.y[j]! - y;
        if (dx * dx + dy * dy <= r2) return true;
      }
    }
  }
  return false;
}
