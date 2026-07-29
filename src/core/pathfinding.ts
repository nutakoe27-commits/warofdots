/**
 * A* over the tile grid, with per-kind movement costs.
 *
 * Only the bots use this — a human draws the route they want with the mouse. Costs
 * come from `PATH_COST`, so a heavy asking for a route around a forest gets one,
 * and water is legal but priced high enough that it is never chosen casually.
 *
 * Expansion is capped: a hopeless request degrades into a best-effort route toward
 * the closest reachable tile instead of stalling the bot's think budget.
 */

import type { MapRuntime } from './types.ts';
import { PATH_SIMPLIFY_EPS, TILE_SIZE } from './balance.ts';
import { pathCost } from './terrain.ts';
import { rdpSimplify } from './geometry.ts';

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DIAG = Math.SQRT2;

/** Node budget per request. 12k tiles is plenty for a 256² map at operational scale. */
export const DEFAULT_NODE_BUDGET = 12000;

let gScore = new Float32Array(0);
let cameFrom = new Int32Array(0);
let stamp = new Int32Array(0);
let generation = 0;
let heapNode = new Int32Array(4096);
let heapKey = new Float32Array(4096);
let heapSize = 0;

function ensureGrids(cells: number): void {
  if (gScore.length >= cells) return;
  gScore = new Float32Array(cells);
  cameFrom = new Int32Array(cells);
  stamp = new Int32Array(cells);
  generation = 0;
}

function heapSwap(a: number, b: number): void {
  const n = heapNode[a]!;
  const k = heapKey[a]!;
  heapNode[a] = heapNode[b]!;
  heapKey[a] = heapKey[b]!;
  heapNode[b] = n;
  heapKey[b] = k;
}

function heapPush(node: number, key: number): void {
  if (heapSize >= heapNode.length) {
    const nodes = new Int32Array(heapNode.length * 2);
    const keys = new Float32Array(heapKey.length * 2);
    nodes.set(heapNode);
    keys.set(heapKey);
    heapNode = nodes;
    heapKey = keys;
  }
  let i = heapSize++;
  heapNode[i] = node;
  heapKey[i] = key;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapKey[parent]! <= heapKey[i]!) break;
    heapSwap(parent, i);
    i = parent;
  }
}

function heapPop(): number {
  if (heapSize === 0) return -1;
  const top = heapNode[0]!;
  heapSize--;
  if (heapSize > 0) {
    heapNode[0] = heapNode[heapSize]!;
    heapKey[0] = heapKey[heapSize]!;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < heapSize && heapKey[l]! < heapKey[best]!) best = l;
      if (r < heapSize && heapKey[r]! < heapKey[best]!) best = r;
      if (best === i) break;
      heapSwap(best, i);
      i = best;
    }
  }
  return top;
}

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx - dy + DIAG * dy : dy - dx + DIAG * dx;
}

function reconstruct(map: MapRuntime, start: number, goal: number): number[] {
  const tiles: number[] = [];
  let node = goal;
  let guard = 0;
  while (node !== start && guard++ < map.w * map.h) {
    tiles.push(node);
    node = cameFrom[node]!;
  }
  tiles.push(start);
  const pts: number[] = [];
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i]!;
    pts.push(((t % map.w) + 0.5) * TILE_SIZE, (((t / map.w) | 0) + 0.5) * TILE_SIZE);
  }
  return pts;
}

export interface PathResult {
  /** Flat world-space polyline. Empty when no route exists at all. */
  pts: number[];
  /** True when the route ends at the requested tile rather than a best-effort stop. */
  complete: boolean;
  expanded: number;
}

/**
 * Routes from one world-space point to another for a unit of `kind`.
 * Diagonal steps through a blocked orthogonal neighbour are rejected so units
 * never clip a mountain corner.
 */
export function findPath(
  map: MapRuntime,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  kind: number,
  budget = DEFAULT_NODE_BUDGET,
): PathResult {
  const cells = map.w * map.h;
  ensureGrids(cells);
  generation++;
  heapSize = 0;

  const startTile = tileOf(map, sx, sy);
  const goalTile = tileOf(map, gx, gy);
  if (startTile < 0 || goalTile < 0) return { pts: [], complete: false, expanded: 0 };
  if (startTile === goalTile) {
    return { pts: [sx, sy, gx, gy], complete: true, expanded: 0 };
  }

  const gtx = goalTile % map.w;
  const gty = (goalTile / map.w) | 0;
  gScore[startTile] = 0;
  stamp[startTile] = generation;
  cameFrom[startTile] = startTile;
  heapPush(startTile, octile(startTile % map.w, (startTile / map.w) | 0, gtx, gty));

  let expanded = 0;
  let bestTile = startTile;
  let bestH = octile(startTile % map.w, (startTile / map.w) | 0, gtx, gty);

  while (heapSize > 0 && expanded < budget) {
    const node = heapPop();
    if (node === goalTile) {
      return { pts: reconstruct(map, startTile, goalTile), complete: true, expanded };
    }
    expanded++;
    const nx = node % map.w;
    const ny = (node / map.w) | 0;
    const h = octile(nx, ny, gtx, gty);
    if (h < bestH) {
      bestH = h;
      bestTile = node;
    }

    for (let d = 0; d < 8; d++) {
      const tx = nx + DX[d]!;
      const ty = ny + DY[d]!;
      if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
      const next = ty * map.w + tx;
      const step = pathCost(map.terrain[next]!, kind);
      if (!Number.isFinite(step)) continue;
      if (d >= 4) {
        const a = pathCost(map.terrain[ny * map.w + tx]!, kind);
        const b = pathCost(map.terrain[ty * map.w + nx]!, kind);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      }
      const tentative = gScore[node]! + step * (d >= 4 ? DIAG : 1);
      if (stamp[next] === generation && tentative >= gScore[next]!) continue;
      stamp[next] = generation;
      gScore[next] = tentative;
      cameFrom[next] = node;
      heapPush(next, tentative + octile(tx, ty, gtx, gty));
    }
  }

  if (bestTile === startTile) return { pts: [], complete: false, expanded };
  return { pts: reconstruct(map, startTile, bestTile), complete: false, expanded };
}

function tileOf(map: MapRuntime, x: number, y: number): number {
  const tx = (x / TILE_SIZE) | 0;
  const ty = (y / TILE_SIZE) | 0;
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return -1;
  return ty * map.w + tx;
}

/** `findPath` with the result run through RDP, which is what a bot actually issues. */
export function findRoute(
  map: MapRuntime,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  kind: number,
  budget = DEFAULT_NODE_BUDGET,
): number[] {
  const result = findPath(map, sx, sy, gx, gy, kind, budget);
  if (result.pts.length < 4) return [];
  return rdpSimplify(result.pts, PATH_SIMPLIFY_EPS);
}
