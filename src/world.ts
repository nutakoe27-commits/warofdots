/** World state: map, units, selection, and the orders waiting to be confirmed. */

import { createMap, TILE, Terrain, terrainAt, tileAt } from './terrain.ts';
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

/**
 * The two banks of the river at this latitude, in tiles.
 *
 * Both armies line up on their own bank, close enough to be looking at each other.
 * The border only ever sits where somebody is standing, so if the two sides start a
 * third of the map apart the line starts a sixth of the map from either of them —
 * which is exactly what it used to look like, and wrong.
 */
function banks(m: GameMap, ty: number): { west: number; east: number } {
  let run = -1;
  let bestStart = -1;
  let bestEnd = -1;
  let bestOff = Infinity;
  for (let x = 140; x <= 270; x++) {
    // Bridges count as part of the river, or the span either side of one reads as
    // two separate rivers and the banks come out on the wrong sides.
    const t = tileAt(m, x, ty);
    const wet = t === Terrain.Water || t === Terrain.Bridge;
    if (wet && run < 0) run = x;
    if (run >= 0 && (!wet || x === 270)) {
      const end = wet ? x : x - 1;
      const off = Math.abs((run + end) / 2 - 200);
      if (off < bestOff) {
        bestOff = off;
        bestStart = run;
        bestEnd = end;
      }
      run = -1;
    }
  }
  if (bestStart < 0) return { west: 196, east: 204 };
  return { west: bestStart - 2, east: bestEnd + 2 };
}

/**
 * Nobody starts inside anybody's engagement range. The banks run close together
 * on purpose, and at a few latitudes that put a pair within fighting distance, so
 * the match opened with a skirmish already under way and the casualty counters
 * ticking before the player had touched anything.
 */
const SPAWN_CLEAR = 40;

function pushClear(w: World, spot: { x: number; y: number }, side: number): { x: number; y: number } {
  const y = spot.y;
  let x = spot.x;
  for (let guard = 0; guard < 8; guard++) {
    if (!w.units.some((u) => u.side !== side && Math.hypot(u.x - x, u.y - y) < SPAWN_CLEAR)) break;
    const next = x + (side === BLUE ? -TILE : TILE);
    const t = terrainAt(w.map, next, y);
    // Backing into a cliff is worse than starting a little close — a unit that
    // spawns inside a mountain can never take a step.
    if (t === Terrain.Mountain) break;
    x = next;
  }
  return { x, y };
}

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

  // Both armies stand along the river, each on its own bank, so the opening frame
  // already looks like a front: a chain of troops with the line threaded past them.
  for (let i = 0; i < PER_SIDE; i++) {
    const t = i / (PER_SIDE - 1);
    const heavy = i % 4 === 1;
    const ty = 24 + t * 177;
    const { west, east } = banks(w.map, Math.round(ty));
    const laneY = ty * TILE;
    const b = pushClear(w, openSpot(w, (west + range(w.rng, -2, 0)) * TILE, laneY, 2 * TILE), BLUE);
    spawn(w, BLUE, b.x, b.y, heavy);
    const r = pushClear(w, openSpot(w, (east + range(w.rng, 0, 2)) * TILE, laneY, 2 * TILE), RED);
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
