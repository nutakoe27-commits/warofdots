/** World state: map, units, selection, and the orders waiting to be confirmed. */

import { createMap, TILE, Terrain, terrainAt } from './terrain.ts';
import type { GameMap } from './terrain.ts';
import { makeRng, rand, range } from './rng.ts';
import type { Rng } from './rng.ts';

export const BLUE = 0;
export const RED = 1;

export interface Unit {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  side: number;
  heavy: boolean;
  /** 0..1 — the green bar. */
  hp: number;
  /** 0..1 — the blue bar. */
  morale: number;
  alive: boolean;
  /** Confirmed route: flat world coords. Null when holding position. */
  path: number[] | null;
  /** Index of the vertex being walked toward. */
  leg: number;
  /** Offset from the route's centreline, so a group walks abreast. */
  lateral: number;
  inCombat: boolean;
  /** Set while the unit is the one advancing — it hits harder and takes more. */
  attacking: boolean;
}

/** An order that has been drawn but not yet confirmed with Enter. */
export interface PendingOrder {
  unitId: number;
  path: number[];
  lateral: number;
}

export interface World {
  map: GameMap;
  units: Unit[];
  rng: Rng;
  front: number[][];
  tick: number;
  time: number;
  /** Selected unit ids (player side only). */
  selection: Set<number>;
  pending: Map<number, PendingOrder>;
  casualties: [number, number];
}

let nextId = 1;

function spawn(w: World, side: number, x: number, y: number, heavy: boolean): Unit {
  const u: Unit = {
    id: nextId++,
    x,
    y,
    vx: 0,
    vy: 0,
    side,
    heavy,
    hp: 1,
    morale: 1,
    alive: true,
    path: null,
    leg: 0,
    lateral: 0,
    inCombat: false,
    attacking: false,
  };
  w.units.push(u);
  return u;
}

/** Open ground near a point — nothing should start inside a river or a cliff. */
export function openSpot(w: World, x: number, y: number, spread: number): { x: number; y: number } {
  for (let i = 0; i < 60; i++) {
    const px = x + range(w.rng, -spread, spread);
    const py = y + range(w.rng, -spread, spread);
    if (px < 20 || py < 20 || px > w.map.worldW - 20 || py > w.map.worldH - 20) continue;
    const t = terrainAt(w.map, px, py);
    if (t !== Terrain.Water && t !== Terrain.Mountain) return { x: px, y: py };
  }
  return { x, y };
}

const PER_SIDE = 64;

export function createWorld(): World {
  const w: World = {
    map: createMap(),
    units: [],
    rng: makeRng(11),
    front: [],
    tick: 0,
    time: 0,
    selection: new Set(),
    pending: new Map(),
    casualties: [0, 0],
  };

  // Both armies stand off either side of the river, so the opening frame already
  // looks like a front rather than two blobs in opposite corners.
  for (let i = 0; i < PER_SIDE; i++) {
    const t = i / (PER_SIDE - 1);
    const heavy = i % 4 === 1;
    const laneY = (25 + t * 175) * TILE;
    const b = openSpot(w, (150 + range(w.rng, -22, 22)) * TILE, laneY, 4 * TILE);
    spawn(w, BLUE, b.x, b.y, heavy);
    const r = openSpot(w, (250 + range(w.rng, -22, 22)) * TILE, laneY, 4 * TILE);
    spawn(w, RED, r.x, r.y, heavy);
  }
  return w;
}

export function unitById(w: World, id: number): Unit | undefined {
  return w.units.find((u) => u.id === id && u.alive);
}

export function selectedUnits(w: World): Unit[] {
  const out: Unit[] = [];
  for (const id of w.selection) {
    const u = unitById(w, id);
    if (u && u.side === BLUE) out.push(u);
  }
  return out;
}

/** Drops dead or foreign units from the selection. */
export function pruneSelection(w: World): void {
  for (const id of [...w.selection]) {
    const u = unitById(w, id);
    if (!u || u.side !== BLUE) {
      w.selection.delete(id);
      w.pending.delete(id);
    }
  }
}

export function randomJitter(w: World): number {
  return rand(w.rng);
}
