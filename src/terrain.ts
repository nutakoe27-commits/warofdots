/**
 * The map: a tile grid plus the cities on it.
 *
 * Tiles are painted at one pixel each into an offscreen bitmap and blown up with
 * smoothing off, which is where the stair-stepped edges in the reference shots come
 * from. Keeping the grid coarse is the whole look.
 */

import { makeRng, rand, range } from './rng.ts';
import type { Rng } from './rng.ts';

export const Terrain = {
  Plains: 0,
  Forest: 1,
  Hills: 2,
  Mountain: 3,
  Water: 4,
  Bridge: 5,
} as const;
export type TerrainId = (typeof Terrain)[keyof typeof Terrain];

export const TERRAIN_COLORS: readonly string[] = [
  '#a4ce3e', // plains
  '#2f8f2f', // forest
  '#a8a8a8', // hills
  '#7d7d7d', // mountain
  '#33a5f5', // water
  '#7b4a1e', // bridge
];

/** Tile edge in world units. The world is `w * TILE` by `h * TILE`. */
export const TILE = 8;

export interface City {
  x: number;
  y: number;
  capital: boolean;
}

export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  cities: City[];
  worldW: number;
  worldH: number;
}

function set(map: GameMap, x: number, y: number, t: TerrainId): void {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return;
  map.tiles[y * map.w + x] = t;
}

export function tileAt(map: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return Terrain.Mountain;
  return map.tiles[ty * map.w + tx]!;
}

/** Terrain under a world-space point. */
export function terrainAt(map: GameMap, x: number, y: number): number {
  return tileAt(map, Math.floor(x / TILE), Math.floor(y / TILE));
}

export function isBlocked(t: number): boolean {
  return t === Terrain.Mountain || t === Terrain.Water;
}

/** A circle whose radius wobbles with a few harmonics, so nothing looks stamped. */
function blob(map: GameMap, r: Rng, cx: number, cy: number, radius: number, t: TerrainId): void {
  const p1 = rand(r) * Math.PI * 2;
  const p2 = rand(r) * Math.PI * 2;
  const a1 = range(r, 0.12, 0.3);
  const a2 = range(r, 0.06, 0.18);
  const max = radius * (1 + a1 + a2);
  for (let y = Math.floor(cy - max); y <= Math.ceil(cy + max); y++) {
    for (let x = Math.floor(cx - max); x <= Math.ceil(cx + max); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > max) continue;
      const ang = Math.atan2(dy, dx);
      if (d <= radius * (1 + a1 * Math.sin(ang * 2 + p1) + a2 * Math.sin(ang * 3 + p2))) {
        set(map, x, y, t);
      }
    }
  }
}

function disc(map: GameMap, cx: number, cy: number, radius: number, t: TerrainId): void {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) set(map, x, y, t);
    }
  }
}

/** Midpoint-displaced polyline, used for river courses. */
function meander(r: Rng, ax: number, ay: number, bx: number, by: number, amp: number): number[] {
  let pts = [ax, ay, bx, by];
  for (let pass = 0; pass < 5; pass++) {
    const next: number[] = [pts[0]!, pts[1]!];
    const a = amp / (pass + 1);
    for (let i = 2; i < pts.length; i += 2) {
      const x0 = pts[i - 2]!;
      const y0 = pts[i - 1]!;
      const x1 = pts[i]!;
      const y1 = pts[i + 1]!;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const off = range(r, -a, a);
      next.push((x0 + x1) / 2 + (-dy / len) * off, (y0 + y1) / 2 + (dx / len) * off, x1, y1);
    }
    pts = next;
  }
  return pts;
}

function stampPath(map: GameMap, pts: number[], width: number, t: TerrainId): void {
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2]!;
    const y0 = pts[i - 1]!;
    const x1 = pts[i]!;
    const y1 = pts[i + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const k = s / steps;
      disc(map, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, width / 2, t);
    }
  }
}

/** Lays a bridge across the water at the point of `pts` nearest the sample index. */
function bridgeAt(map: GameMap, pts: number[], index: number, span: number): void {
  const i = Math.min(Math.max(index, 1), (pts.length >> 1) - 1) * 2;
  const x = pts[i]!;
  const y = pts[i + 1]!;
  const dx = pts[i]! - pts[i - 2]!;
  const dy = pts[i + 1]! - pts[i - 1]!;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular to the river's course, so the deck always crosses it squarely.
  const nx = -dy / len;
  const ny = dx / len;
  for (let s = -span; s <= span; s += 0.5) {
    disc(map, x + nx * s, y + ny * s, 1.6, Terrain.Bridge);
  }
}

export function createMap(seed = 20240823): GameMap {
  const w = 240;
  const h = 135;
  const map: GameMap = {
    w,
    h,
    tiles: new Uint8Array(w * h).fill(Terrain.Plains),
    cities: [],
    worldW: w * TILE,
    worldH: h * TILE,
  };
  const r = makeRng(seed);

  for (const [cx, cy, rad] of [
    [42, 104, 13],
    [206, 30, 14],
    [188, 112, 11],
    [64, 24, 10],
  ] as const) {
    blob(map, r, cx, cy, rad, Terrain.Forest);
  }

  // Hills with darker cores, so ridges read as high ground rather than flat grey.
  for (const [cx, cy, rad] of [
    [150, 34, 20],
    [176, 60, 16],
    [96, 96, 15],
    [128, 118, 13],
  ] as const) {
    blob(map, r, cx, cy, rad, Terrain.Hills);
    blob(map, r, cx + range(r, -3, 3), cy + range(r, -3, 3), rad * 0.5, Terrain.Mountain);
  }

  const main = meander(r, 118, -6, 126, h + 6, 26);
  stampPath(map, main, 7, Terrain.Water);
  const branch = meander(r, 126, 62, -6, 46, 18);
  stampPath(map, branch, 5.5, Terrain.Water);

  const mainPoints = main.length >> 1;
  bridgeAt(map, main, Math.floor(mainPoints * 0.22), 7);
  bridgeAt(map, main, Math.floor(mainPoints * 0.55), 7);
  bridgeAt(map, main, Math.floor(mainPoints * 0.84), 7);
  bridgeAt(map, branch, Math.floor((branch.length >> 1) * 0.45), 6);

  map.cities = [
    { x: 22, y: 68, capital: true },
    { x: 218, y: 68, capital: true },
    { x: 70, y: 40, capital: false },
    { x: 62, y: 100, capital: false },
    { x: 104, y: 20, capital: false },
    { x: 100, y: 112, capital: false },
    { x: 152, y: 96, capital: false },
    { x: 160, y: 18, capital: false },
    { x: 196, y: 84, capital: false },
    { x: 186, y: 46, capital: false },
  ];
  // A city sitting in a river or on a cliff would be unreachable, so clear its ground.
  for (const c of map.cities) disc(map, c.x, c.y, 3, Terrain.Plains);

  return map;
}
