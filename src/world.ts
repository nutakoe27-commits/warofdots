/** World state: the map, the two armies, and the derived front line. */

import { createMap, TILE, Terrain, terrainAt } from './terrain.ts';
import type { GameMap } from './terrain.ts';
import { makeRng, rand, range } from './rng.ts';
import type { Rng } from './rng.ts';

export const BLUE = 0;
export const RED = 1;

export interface Unit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  side: number;
  heavy: boolean;
  /** 0..1. */
  hp: number;
  alive: boolean;
  /** Where this unit is currently headed, in world units. */
  tx: number;
  ty: number;
  inCombat: boolean;
}

export interface World {
  map: GameMap;
  units: Unit[];
  rng: Rng;
  /** Front-line polylines in world space, rebuilt a few times a second. */
  front: number[][];
  tick: number;
  /** Seconds until each side sends its next reinforcements. */
  reinforce: [number, number];
}

const START_PER_SIDE = 26;

function spawnUnit(w: World, side: number, x: number, y: number, heavy: boolean): void {
  w.units.push({ x, y, vx: 0, vy: 0, side, heavy, hp: 1, alive: true, tx: x, ty: y, inCombat: false });
}

/** Finds open ground near a point, so nothing starts inside a river or a cliff. */
export function findOpenSpot(w: World, x: number, y: number, spread: number): { x: number; y: number } {
  for (let attempt = 0; attempt < 40; attempt++) {
    const px = x + range(w.rng, -spread, spread);
    const py = y + range(w.rng, -spread, spread);
    if (px < 8 || py < 8 || px > w.map.worldW - 8 || py > w.map.worldH - 8) continue;
    const t = terrainAt(w.map, px, py);
    if (t !== Terrain.Water && t !== Terrain.Mountain) return { x: px, y: py };
  }
  return { x, y };
}

export function createWorld(): World {
  const map = createMap();
  const w: World = {
    map,
    units: [],
    rng: makeRng(7),
    front: [],
    tick: 0,
    reinforce: [8, 8],
  };

  // Both armies start part-way in, so the two lines meet almost immediately and
  // there is something to look at on the first frame.
  const lanes = [34, 52, 68, 84, 100];
  for (let i = 0; i < START_PER_SIDE; i++) {
    const lane = lanes[i % lanes.length]!;
    const heavy = i % 4 === 0;
    const bl = findOpenSpot(w, 84 * TILE, lane * TILE + range(w.rng, -14, 14), 5 * TILE);
    spawnUnit(w, BLUE, bl.x, bl.y, heavy);
    const rd = findOpenSpot(w, 156 * TILE, lane * TILE + range(w.rng, -14, 14), 5 * TILE);
    spawnUnit(w, RED, rd.x, rd.y, heavy);
  }
  return w;
}

/** Sends a fresh wave from a side's capital, so the front keeps moving. */
export function reinforce(w: World, side: number, count: number): void {
  const capital = w.map.cities[side === BLUE ? 0 : 1]!;
  for (let i = 0; i < count; i++) {
    const spot = findOpenSpot(w, capital.x * TILE, capital.y * TILE, 9 * TILE);
    spawnUnit(w, side, spot.x, spot.y, rand(w.rng) < 0.28);
  }
}

export function livingUnits(w: World): Unit[] {
  return w.units.filter((u) => u.alive);
}
