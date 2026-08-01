/**
 * Route finding.
 *
 * A unit walks straight at whatever it was told to walk at and slides along
 * anything it bumps into. That works against the side of a hill and fails
 * completely in a bay: the unit presses into the dead end and stays there. So
 * when the straight line is blocked, it asks for a real route instead.
 *
 * A* over the tile grid, weighted by terrain, then pulled straight. Weighted
 * because "optimal" is not "shortest" here — fording a river is slower than
 * walking twice as far to a bridge, and the route should know that.
 */

import { TILE, Terrain, tileAt } from './terrain.ts';
import type { GameMap } from './terrain.ts';

/** Seconds-per-tile relative to open plains. 0 means you cannot go there at all. */
const STEP_COST = [1, 1.15, 1.15, 0, 2.5, 1, 1.3];

const SQRT2 = Math.SQRT2;

/**
 * Weighted A*. The heuristic can only assume the cheapest terrain, so on a map
 * where most ground costs more than plains it badly underestimates and the search
 * spreads out into something close to Dijkstra — a cross-map route took 30ms.
 * Leaning on the heuristic gives that back. Routes can come out a few percent
 * longer than the true optimum, which nobody will ever see.
 */
const H_WEIGHT = 1.35;
/**
 * Give up after this many tiles. Long routes through broken country are the ones
 * that cost, and a caller that gets nothing back still walks straight and slides
 * along whatever it meets — worse, but never a stalled frame.
 */
const MAX_EXPAND = 12000;

let gw = 0;
let gh = 0;
let gScore = new Float32Array(0);
let came = new Int32Array(0);
/** Which search last touched a tile, so nothing has to be cleared between calls. */
let seen = new Int32Array(0);
/** Same trick for tiles already expanded. */
let closed = new Int32Array(0);
/** Where a tile sits in the heap, or -1 when it is not in it. */
let slot = new Int32Array(0);
let heap = new Int32Array(0);
let heapKey = new Float32Array(0);
let heapN = 0;
let run = 0;

function ensure(m: GameMap): void {
  if (gw === m.w && gh === m.h) return;
  gw = m.w;
  gh = m.h;
  const n = gw * gh;
  gScore = new Float32Array(n);
  came = new Int32Array(n);
  seen = new Int32Array(n);
  closed = new Int32Array(n);
  slot = new Int32Array(n);
  // A real decrease-key, so a tile is in the heap at most once and the heap can
  // never be longer than the grid. The first version left stale copies in and
  // sized the array by guesswork; it overflowed and reported "no route" for
  // journeys as ordinary as walking round a hill.
  heap = new Int32Array(n);
  heapKey = new Float32Array(n);
  run = 0;
}

function siftUp(from: number): void {
  let i = from;
  const idx = heap[i]!;
  const key = heapKey[i]!;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapKey[p]! <= key) break;
    heap[i] = heap[p]!;
    heapKey[i] = heapKey[p]!;
    slot[heap[i]!] = i;
    i = p;
  }
  heap[i] = idx;
  heapKey[i] = key;
  slot[idx] = i;
}

function siftDown(from: number): void {
  let i = from;
  const idx = heap[i]!;
  const key = heapKey[i]!;
  for (;;) {
    const l = i * 2 + 1;
    if (l >= heapN) break;
    const r = l + 1;
    const c = r < heapN && heapKey[r]! < heapKey[l]! ? r : l;
    if (heapKey[c]! >= key) break;
    heap[i] = heap[c]!;
    heapKey[i] = heapKey[c]!;
    slot[heap[i]!] = i;
    i = c;
  }
  heap[i] = idx;
  heapKey[i] = key;
  slot[idx] = i;
}

function offer(idx: number, key: number): void {
  const at = slot[idx]!;
  if (at >= 0) {
    if (key >= heapKey[at]!) return;
    heapKey[at] = key;
    siftUp(at);
    return;
  }
  heap[heapN] = idx;
  heapKey[heapN] = key;
  siftUp(heapN++);
}

function take(): number {
  const top = heap[0]!;
  slot[top] = -1;
  heapN--;
  if (heapN > 0) {
    heap[0] = heap[heapN]!;
    heapKey[0] = heapKey[heapN]!;
    siftDown(0);
  }
  return top;
}

function cost(m: GameMap, tx: number, ty: number): number {
  return STEP_COST[tileAt(m, tx, ty)] ?? 0;
}

/** True if a unit can walk the straight line between two world points. */
export function clearLine(m: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len / (TILE * 0.4));
  for (let i = 0; i <= steps; i++) {
    const k = steps === 0 ? 0 : i / steps;
    const tx = Math.floor((x0 + dx * k) / TILE);
    const ty = Math.floor((y0 + dy * k) / TILE);
    if (tileAt(m, tx, ty) === Terrain.Mountain) return false;
  }
  return true;
}

/** Nearest tile you can actually stand on — the destination may be a cliff. */
function reachableGoal(m: GameMap, tx: number, ty: number): number {
  if (cost(m, tx, ty) > 0) return ty * gw + tx;
  for (let r = 1; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        if (cost(m, x, y) > 0) return y * gw + x;
      }
    }
  }
  return -1;
}

/**
 * Drops every waypoint the unit can see past. A* returns a tile-by-tile staircase;
 * without this the unit walks it literally, in little diagonal steps.
 */
function pullStraight(m: GameMap, pts: number[]): number[] {
  if (pts.length < 6) return pts;
  const out = [pts[0]!, pts[1]!];
  let anchor = 0;
  for (let i = 2; i < pts.length / 2; i++) {
    if (clearLine(m, pts[anchor * 2]!, pts[anchor * 2 + 1]!, pts[i * 2]!, pts[i * 2 + 1]!)) continue;
    out.push(pts[(i - 1) * 2]!, pts[(i - 1) * 2 + 1]!);
    anchor = i - 1;
  }
  out.push(pts[pts.length - 2]!, pts[pts.length - 1]!);
  return out;
}

/**
 * A walkable route in world coordinates, starting at the unit and ending at the
 * destination, or null if there is no way through within the search ceiling.
 */
export function findPath(m: GameMap, x0: number, y0: number, x1: number, y1: number): number[] | null {
  ensure(m);
  const sx = Math.min(Math.max(Math.floor(x0 / TILE), 0), gw - 1);
  const sy = Math.min(Math.max(Math.floor(y0 / TILE), 0), gh - 1);
  const gx = Math.min(Math.max(Math.floor(x1 / TILE), 0), gw - 1);
  const gy = Math.min(Math.max(Math.floor(y1 / TILE), 0), gh - 1);
  const start = sy * gw + sx;
  const goal = reachableGoal(m, gx, gy);
  if (goal < 0) return null;
  // The destination may be a cliff the player clicked on; we walk to the nearest
  // spot beside it instead, and must not then tack the cliff itself back on.
  const exact = goal === gy * gw + gx;
  if (start === goal) return exact ? [x0, y0, x1, y1] : [x0, y0];
  // Nothing in the way is the common case by far, and it costs one line scan.
  if (exact && clearLine(m, x0, y0, x1, y1)) return [x0, y0, x1, y1];

  run++;
  heapN = 0;
  const goalX = goal % gw;
  const goalY = (goal / gw) | 0;
  const h = (x: number, y: number): number => {
    const dx = Math.abs(x - goalX);
    const dy = Math.abs(y - goalY);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };

  seen[start] = run;
  gScore[start] = 0;
  came[start] = -1;
  slot[start] = -1;
  offer(start, h(sx, sy) * H_WEIGHT);

  let found = false;
  let expanded = 0;
  while (heapN > 0) {
    if (expanded++ > MAX_EXPAND) return null;
    const cur = take();
    if (cur === goal) {
      found = true;
      break;
    }
    closed[cur] = run;
    const cx = cur % gw;
    const cy = (cur / gw) | 0;
    const base = gScore[cur]!;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const c = cost(m, nx, ny);
        if (c === 0) continue;
        // No slipping through the corner where two cliffs meet.
        if (dx !== 0 && dy !== 0 && (cost(m, cx + dx, cy) === 0 || cost(m, cx, cy + dy) === 0)) continue;

        const ni = ny * gw + nx;
        if (closed[ni] === run) continue;
        const next = base + c * (dx !== 0 && dy !== 0 ? SQRT2 : 1);
        if (seen[ni] === run && gScore[ni]! <= next) continue;
        if (seen[ni] !== run) {
          seen[ni] = run;
          slot[ni] = -1;
        }
        gScore[ni] = next;
        came[ni] = cur;
        offer(ni, next + h(nx, ny) * H_WEIGHT);
      }
    }
  }
  if (!found) return null;

  const back: number[] = [];
  for (let i = goal; i !== -1; i = came[i]!) back.push(i);

  const pts: number[] = [x0, y0];
  for (let i = back.length - 1; i >= 0; i--) {
    const t = back[i]!;
    pts.push((t % gw) * TILE + TILE / 2, ((t / gw) | 0) * TILE + TILE / 2);
  }
  if (exact) pts.push(x1, y1);
  return pullStraight(m, pts);
}
