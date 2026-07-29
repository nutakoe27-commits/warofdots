/**
 * Terrain queries and the authoring palette.
 *
 * The palette is the contract between a hand-drawn PNG mask and the simulation:
 * pixel colour → terrain type. Decoding snaps to the nearest palette entry so a
 * PNG that picked up a colour profile on the way out of an image editor still
 * loads correctly.
 */

import { TERRAIN_KEYS, Terrain, baseKindOf } from './types.ts';
import type { MapRuntime, TerrainId, TerrainKey } from './types.ts';
import { TILE_SIZE, TERRAIN_SPEED, TERRAIN_DAMAGE, PATH_COST } from './balance.ts';

/** Authoring colours, indexed by `TerrainId`. */
export const TERRAIN_MASK_COLORS: readonly [number, number, number][] = [
  [143, 191, 106], // PLAINS
  [47, 107, 52], // FOREST
  [165, 139, 90], // HILLS
  [232, 212, 138], // SAND
  [242, 246, 250], // SNOW
  [107, 86, 54], // MUD
  [63, 127, 208], // WATER
  [74, 74, 82], // MOUNTAIN
];

export function terrainKeyToId(key: string): TerrainId {
  const i = TERRAIN_KEYS.indexOf(key as TerrainKey);
  if (i < 0) throw new Error(`unknown terrain key: ${key}`);
  return i as TerrainId;
}

export function terrainIdToKey(id: number): TerrainKey {
  const key = TERRAIN_KEYS[id];
  if (!key) throw new Error(`unknown terrain id: ${id}`);
  return key;
}

/** Nearest palette entry for an RGB triple. */
export function terrainFromRgb(r: number, g: number, b: number): TerrainId {
  let best: TerrainId = Terrain.Plains;
  let bestD = Infinity;
  for (let i = 0; i < TERRAIN_MASK_COLORS.length; i++) {
    const c = TERRAIN_MASK_COLORS[i]!;
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i as TerrainId;
    }
  }
  return best;
}

/** Decodes an RGBA byte buffer (canvas `ImageData.data` layout) into a terrain grid. */
export function decodeTerrainMask(rgba: Uint8Array | Uint8ClampedArray, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = terrainFromRgb(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── queries ──

export function tileIndex(map: MapRuntime, tx: number, ty: number): number {
  return ty * map.w + tx;
}

export function inBoundsTile(map: MapRuntime, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < map.w && ty < map.h;
}

export function terrainAtTile(map: MapRuntime, tx: number, ty: number): number {
  if (!inBoundsTile(map, tx, ty)) return Terrain.Mountain;
  return map.terrain[ty * map.w + tx]!;
}

/** Terrain under a world-space point. Out-of-bounds reads as impassable mountain. */
export function terrainAt(map: MapRuntime, wx: number, wy: number): number {
  const tx = (wx / TILE_SIZE) | 0;
  const ty = (wy / TILE_SIZE) | 0;
  if (wx < 0 || wy < 0 || tx >= map.w || ty >= map.h) return Terrain.Mountain;
  return map.terrain[ty * map.w + tx]!;
}

export function speedMul(terrain: number, kind: number): number {
  return TERRAIN_SPEED[terrain]![kind]!;
}

export function damageMul(terrain: number, kind: number): number {
  return TERRAIN_DAMAGE[terrain]![kind]!;
}

export function pathCost(terrain: number, kind: number): number {
  return PATH_COST[terrain]![baseKindOf(kind)]!;
}

export function isWater(terrain: number): boolean {
  return terrain === Terrain.Water;
}

export function isMountain(terrain: number): boolean {
  return terrain === Terrain.Mountain;
}

/** City index under a world point, or -1. City ground is always safe and plains-like. */
export function cityAt(map: MapRuntime, wx: number, wy: number): number {
  const tx = (wx / TILE_SIZE) | 0;
  const ty = (wy / TILE_SIZE) | 0;
  if (wx < 0 || wy < 0 || tx >= map.w || ty >= map.h) return -1;
  return map.cityAt[ty * map.w + tx]! - 1;
}

export function isInsideCity(map: MapRuntime, wx: number, wy: number): boolean {
  return cityAt(map, wx, wy) >= 0;
}

export function worldToTile(v: number): number {
  return (v / TILE_SIZE) | 0;
}

export function tileToWorldCenter(t: number): number {
  return (t + 0.5) * TILE_SIZE;
}

/** Fraction of the map covered by each terrain type. Bots use it to pick a unit mix. */
export function terrainHistogram(map: MapRuntime): number[] {
  const counts = new Array<number>(TERRAIN_KEYS.length).fill(0);
  for (let i = 0; i < map.terrain.length; i++) counts[map.terrain[i]!]!++;
  const total = map.terrain.length || 1;
  return counts.map((c) => c / total);
}
