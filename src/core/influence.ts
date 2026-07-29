/**
 * The influence field and the territory it produces.
 *
 * Cities and units project a value that decays with the accumulated terrain cost
 * of getting there — a multi-source, max-value Dijkstra per player over the coarse
 * grid. Whoever ends up highest in a cell owns it. That single field gives the
 * coloured map, the front line, supply connectivity and encirclement.
 *
 * Recomputed every `INFLUENCE_INTERVAL` ticks (4 Hz), not every tick.
 */

import type { World } from './types.ts';
import {
  CAPITAL_POWER_MULT,
  COARSE_SIZE,
  INFLUENCE_CLAIM_MIN,
  INFLUENCE_CONTEST_MARGIN,
  INFLUENCE_DIAG,
  INFLUENCE_STEP_COST,
  B,
} from './balance.ts';
import { clamp } from './geometry.ts';

// ─────────────────────────────────────────────── max-heap (module scratch) ──

let heapCell = new Int32Array(1024);
let heapKey = new Float32Array(1024);
let heapSize = 0;

function heapReset(minCapacity: number): void {
  if (heapCell.length < minCapacity) {
    heapCell = new Int32Array(minCapacity);
    heapKey = new Float32Array(minCapacity);
  }
  heapSize = 0;
}

function heapPush(cell: number, key: number): void {
  if (heapSize >= heapCell.length) {
    const cells = new Int32Array(heapCell.length * 2);
    const keys = new Float32Array(heapKey.length * 2);
    cells.set(heapCell);
    keys.set(heapKey);
    heapCell = cells;
    heapKey = keys;
  }
  let i = heapSize++;
  heapCell[i] = cell;
  heapKey[i] = key;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapKey[parent]! >= heapKey[i]!) break;
    swapHeap(parent, i);
    i = parent;
  }
}

function swapHeap(a: number, b: number): void {
  const c = heapCell[a]!;
  const k = heapKey[a]!;
  heapCell[a] = heapCell[b]!;
  heapKey[a] = heapKey[b]!;
  heapCell[b] = c;
  heapKey[b] = k;
}

/** Pops the highest-value entry, returning the cell (-1 when empty). */
function heapPop(): number {
  if (heapSize === 0) return -1;
  const top = heapCell[0]!;
  heapSize--;
  if (heapSize > 0) {
    heapCell[0] = heapCell[heapSize]!;
    heapKey[0] = heapKey[heapSize]!;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < heapSize && heapKey[l]! > heapKey[best]!) best = l;
      if (r < heapSize && heapKey[r]! > heapKey[best]!) best = r;
      if (best === i) break;
      swapHeap(best, i);
      i = best;
    }
  }
  return top;
}

// ────────────────────────────────────────────────────────────────── field ──

/** Coarse cell index for a world-space point. */
export function cellAt(world: World, x: number, y: number): number {
  const inf = world.influence;
  const cx = clamp((x / COARSE_SIZE) | 0, 0, inf.cw - 1);
  const cy = clamp((y / COARSE_SIZE) | 0, 0, inf.ch - 1);
  return cy * inf.cw + cx;
}

export function cellCenterX(world: World, cell: number): number {
  return ((cell % world.influence.cw) + 0.5) * COARSE_SIZE;
}

export function cellCenterY(world: World, cell: number): number {
  return (((cell / world.influence.cw) | 0) + 0.5) * COARSE_SIZE;
}

function seedSources(world: World, player: number, field: Float32Array, base: number): void {
  for (const c of world.cities) {
    if (c.owner !== player) continue;
    const cell = cellAt(world, c.x, c.y);
    const power = B.CITY_POWER * (c.capital ? CAPITAL_POWER_MULT : 1);
    if (power > field[base + cell]!) {
      field[base + cell] = power;
      heapPush(cell, power);
    }
  }
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== player) continue;
    const cell = cellAt(world, u.x[i]!, u.y[i]!);
    // Units stack: several in one cell project more than one alone, with
    // diminishing returns so a doomstack cannot out-project a city.
    const current = field[base + cell]!;
    const next = current > 0 ? current + B.UNIT_POWER * 0.35 : B.UNIT_POWER;
    field[base + cell] = next;
    heapPush(cell, next);
  }
}

/** Max-value Dijkstra outward from every source of one player. */
function spreadPlayer(world: World, player: number): void {
  const inf = world.influence;
  const cells = inf.cw * inf.ch;
  const base = player * cells;
  const field = inf.field;
  field.fill(0, base, base + cells);

  heapReset(cells * 4);
  seedSources(world, player, field, base);

  const coarse = world.map.coarseTerrain;
  while (heapSize > 0) {
    const cell = heapPop();
    const value = field[base + cell]!;
    const cx = cell % inf.cw;
    const cy = (cell / inf.cw) | 0;

    for (let d = 0; d < 8; d++) {
      const nx = cx + NEIGH_DX[d]!;
      const ny = cy + NEIGH_DY[d]!;
      if (nx < 0 || ny < 0 || nx >= inf.cw || ny >= inf.ch) continue;
      const ncell = ny * inf.cw + nx;
      const step = INFLUENCE_STEP_COST[coarse[ncell]!]!;
      if (!Number.isFinite(step)) continue;
      const next = value - step * (d < 4 ? 1 : INFLUENCE_DIAG);
      if (next <= INFLUENCE_CLAIM_MIN || next <= field[base + ncell]!) continue;
      field[base + ncell] = next;
      heapPush(ncell, next);
    }
  }
}

const NEIGH_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGH_DY = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * Resolves the per-player fields into a single ownership grid. A cell where the
 * leader's margin over the runner-up is thin stays neutral, which is what draws
 * the no-man's-land band along a contested front instead of a jittering seam.
 */
function resolveOwners(world: World): void {
  const inf = world.influence;
  const cells = inf.cw * inf.ch;
  const players = world.map.playerCount;

  for (let cell = 0; cell < cells; cell++) {
    let bestP = 0;
    let best = 0;
    let second = 0;
    for (let p = 1; p <= players; p++) {
      const v = inf.field[p * cells + cell]!;
      if (v > best) {
        second = best;
        best = v;
        bestP = p;
      } else if (v > second) {
        second = v;
      }
    }
    if (best <= INFLUENCE_CLAIM_MIN) {
      inf.owner[cell] = 0;
      inf.strength[cell] = 0;
      continue;
    }
    if (second > 0 && (best - second) / best < INFLUENCE_CONTEST_MARGIN) {
      inf.owner[cell] = 0;
      inf.strength[cell] = 0;
      continue;
    }
    inf.owner[cell] = bestP;
    inf.strength[cell] = best;
  }
}

/** Recomputes the influence field and the ownership grid. */
export function computeInfluence(world: World): void {
  for (let p = 1; p <= world.map.playerCount; p++) spreadPlayer(world, p);
  resolveOwners(world);
  world.influence.lastTick = world.tick;
}

/** Share of claimable cells owned by each player, indexed by player id. */
export function territoryShares(world: World): number[] {
  const inf = world.influence;
  const shares = new Array<number>(world.players.length).fill(0);
  let claimable = 0;
  for (let cell = 0; cell < inf.owner.length; cell++) {
    if (!Number.isFinite(INFLUENCE_STEP_COST[world.map.coarseTerrain[cell]!]!)) continue;
    claimable++;
    shares[inf.owner[cell]!]!++;
  }
  if (claimable === 0) return shares;
  for (let i = 0; i < shares.length; i++) shares[i] = shares[i]! / claimable;
  return shares;
}
