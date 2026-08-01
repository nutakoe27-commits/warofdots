/**
 * The tile grid, the terrain rules, and the brushes for painting a map.
 *
 * Tiles are painted one pixel each into an offscreen bitmap and blown up with
 * smoothing off — that is where the stair-stepped edges of the original come from.
 * What gets painted where is not in here: each battlefield is a script in
 * levels.ts that calls these brushes.
 */

import { rand, range } from './rng.ts';
import type { Rng } from './rng.ts';

export const Terrain = {
  Plains: 0,
  Forest: 1,
  Hills: 2,
  Mountain: 3,
  Water: 4,
  Bridge: 5,
  Sand: 6,
} as const;
export type TerrainId = (typeof Terrain)[keyof typeof Terrain];

export const TERRAIN_COLORS: readonly string[] = [
  '#a4ce3e', // plains
  '#2f8f2f', // forest
  '#a8a8a8', // hills
  '#7d7d7d', // mountain
  '#33a5f5', // water
  '#7b4a1e', // bridge
  '#e8d48a', // sand
];

/** Per-terrain movement multiplier for [light, heavy], straight from the in-game guide. */
export const TERRAIN_SPEED: readonly (readonly [number, number])[] = [
  [1, 1], // plains: normal
  [1, 0.58], // forest: light normal, heavy slower
  [1, 0.62], // hills: same
  [0, 0], // mountain: impassable
  [0.4, 0.34], // water: slows all
  [1, 1], // bridge: acts like plains
  [0.7, 1], // sand: slows light only
];

/** Per-terrain damage multiplier for [light, heavy]. */
export const TERRAIN_DAMAGE: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, 0.5], // forest: heavy weaker
  [1, 0.55], // hills: heavy weaker
  [0, 0],
  [0.5, 0.5], // water: lowers damage
  [1, 1],
  [1, 1],
];

/** Tile edge in world units. */
export const TILE = 10;

export interface City {
  x: number;
  y: number;
  capital: boolean;
  /** -1 neutral, 0 blue, 1 red. */
  owner: number;
}

export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  cities: City[];
  worldW: number;
  worldH: number;
}

export function set(m: GameMap, x: number, y: number, t: TerrainId): void {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return;
  m.tiles[y * m.w + x] = t;
}

export function tileAt(m: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return Terrain.Mountain;
  return m.tiles[ty * m.w + tx]!;
}

export function terrainAt(m: GameMap, x: number, y: number): number {
  return tileAt(m, Math.floor(x / TILE), Math.floor(y / TILE));
}

export function passable(m: GameMap, x: number, y: number): boolean {
  return terrainAt(m, x, y) !== Terrain.Mountain;
}

export function blob(m: GameMap, r: Rng, cx: number, cy: number, radius: number, t: TerrainId): void {
  const p1 = rand(r) * Math.PI * 2;
  const p2 = rand(r) * Math.PI * 2;
  const a1 = range(r, 0.14, 0.32);
  const a2 = range(r, 0.07, 0.2);
  const max = radius * (1 + a1 + a2);
  for (let y = Math.floor(cy - max); y <= Math.ceil(cy + max); y++) {
    for (let x = Math.floor(cx - max); x <= Math.ceil(cx + max); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d > max) continue;
      const a = Math.atan2(dy, dx);
      if (d <= radius * (1 + a1 * Math.sin(a * 2 + p1) + a2 * Math.sin(a * 3 + p2))) set(m, x, y, t);
    }
  }
}

export function disc(m: GameMap, cx: number, cy: number, radius: number, t: TerrainId): void {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) set(m, x, y, t);
    }
  }
}

export function meander(r: Rng, ax: number, ay: number, bx: number, by: number, amp: number): number[] {
  let pts = [ax, ay, bx, by];
  for (let pass = 0; pass < 6; pass++) {
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

export function stampPath(m: GameMap, pts: number[], width: number, t: TerrainId): void {
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2]!;
    const y0 = pts[i - 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(pts[i]! - x0, pts[i + 1]! - y0)));
    for (let s = 0; s <= steps; s++) {
      const k = s / steps;
      disc(m, x0 + (pts[i]! - x0) * k, y0 + (pts[i + 1]! - y0) * k, width / 2, t);
    }
  }
}

export function bridge(m: GameMap, pts: number[], frac: number, span: number): void {
  const i = Math.max(1, Math.min(Math.floor((pts.length >> 1) * frac), (pts.length >> 1) - 1)) * 2;
  const x = pts[i]!;
  const y = pts[i + 1]!;
  const dx = x - pts[i - 2]!;
  const dy = pts[i + 1]! - pts[i - 1]!;
  const len = Math.hypot(dx, dy) || 1;
  for (let s = -span; s <= span; s += 0.5) {
    disc(m, x + (-dy / len) * s, y + (dx / len) * s, 2, Terrain.Bridge);
  }
}
