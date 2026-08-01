/** World state: map, units, selection, and the orders waiting to be confirmed. */

import { TILE, Terrain, terrainAt } from './terrain.ts';
import type { GameMap } from './terrain.ts';
import { createMap } from './levels.ts';
import { resetFront } from './frontline.ts';
import type { Level } from './levels.ts';
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
  /** Ticks spent going nowhere. Past a threshold the unit asks for a way round. */
  stuck: number;
}

export interface Settings {
  level: Level;
  /** Index into DIFFICULTIES. */
  difficulty: number;
  perSide: number;
}

export interface World {
  settings: Settings;
  map: GameMap;
  units: Unit[];
  rng: Rng;
  front: number[][];
  tick: number;
  time: number;
  /** Selected unit ids (player side only). */
  selection: Set<number>;
  casualties: [number, number];
  /** -1 while the match is running, otherwise the winning side. */
  winner: number;
  /** Counted up by the simulation, read and cleared by the sound layer. */
  events: { deaths: number; captured: number };
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
    stuck: 0,
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

/**
 * Nobody starts inside anybody's engagement range. The banks run close together
 * on purpose, and at a few latitudes that put a pair within fighting distance, so
 * the match opened with a skirmish already under way and the casualty counters
 * ticking before the player had touched anything.
 */
const SPAWN_CLEAR = 40;

/** Gap between neighbours along the deployment line, world units. */
const LANE_SPACING = 28;

/**
 * Pins a unit to its own bank of the water at the latitude it actually ended up
 * at, not the one it was aimed at.
 *
 * The bank was worked out for the lane, then the scatter moved the unit a couple
 * of tiles north or south — and where the tributary joins, a couple of tiles is
 * the difference between an eight-tile channel and a twenty-five-tile one. Four
 * units a match landed mid-river on the wrong side of the border, which used to
 * be cosmetic and, now that being cut off starves you, killed them.
 */
function ownBank(w: World, spot: { x: number; y: number }, side: number): { x: number; y: number } {
  const { blue, red } = w.settings.level.front(w.map, Math.round(spot.y / TILE));
  const limit = (side === BLUE ? blue : red) * TILE;
  const x = side === BLUE ? Math.min(spot.x, limit) : Math.max(spot.x, limit);
  if (terrainAt(w.map, x, spot.y) === Terrain.Mountain) return spot;
  return { x, y: spot.y };
}

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

export function createWorld(settings: Settings): World {
  resetFront();
  const level = settings.level;
  const w: World = {
    settings,
    map: createMap(level),
    units: [],
    rng: makeRng(level.seed ^ 0x5eed),
    front: [],
    tick: 0,
    time: 0,
    selection: new Set(),
    casualties: [0, 0],
    winner: -1,
    events: { deaths: 0, captured: 0 },
  };

  // Both armies form up along the level's front, each on its own side of it, so
  // the opening frame already looks like a battle: two lines with the border
  // threaded between them.
  const n = settings.perSide;
  // Same spacing between neighbours whatever the army size, so a small army forms
  // a short dense line rather than the full-length one with holes in it. Spread
  // thirty-two men across a front meant for ninety-six and the gaps come out wider
  // than the distance at which anyone can fight: the two armies walk through each
  // other's line without touching and the battle never resolves at all.
  const want = ((n - 1) * LANE_SPACING) / (level.h * TILE);
  const mid = (level.span[0] + level.span[1]) / 2;
  const half = Math.min((level.span[1] - level.span[0]) / 2, want / 2);
  const from = mid - half;
  const to = mid + half;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const heavy = i % 4 === 1;
    const ty = (from + t * (to - from)) * level.h;
    const line = level.front(w.map, Math.round(ty));
    const laneY = ty * TILE;
    const b = pushClear(w, ownBank(w, openSpot(w, (line.blue + range(w.rng, -2, 0)) * TILE, laneY, 2 * TILE), BLUE), BLUE);
    spawn(w, BLUE, b.x, b.y, heavy);
    const r = pushClear(w, ownBank(w, openSpot(w, (line.red + range(w.rng, 0, 2)) * TILE, laneY, 2 * TILE), RED), RED);
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
    if (!u || u.side !== BLUE) w.selection.delete(id);
  }
}

export function randomJitter(w: World): number {
  return rand(w.rng);
}
