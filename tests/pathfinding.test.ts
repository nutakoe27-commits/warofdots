/**
 * A* over the tile grid — the bots' route planner.
 *
 * The "no route at all" case is subtler than it looks. `findPath` degrades into a
 * best-effort route toward the closest tile it could reach, so an empty result only
 * comes back when the start itself is already the closest reachable tile to the
 * goal. That is exactly the shape of a target behind a sealed wall, and it is what
 * this fixture builds.
 */

import { describe, expect, it } from 'vitest';
import { Kind, Terrain } from '../src/core/types.ts';
import type { MapRuntime } from '../src/core/types.ts';
import { TILE_SIZE } from '../src/core/balance.ts';
import { buildMapRuntime } from '../src/core/map.ts';
import { DEFAULT_NODE_BUDGET, findPath, findRoute } from '../src/core/pathfinding.ts';
import { polylineLength } from '../src/core/geometry.ts';
import { terrainAt } from '../src/core/terrain.ts';
import { emptyMapDef, tileCentre } from './helpers.ts';

/** A range with a gap along the bottom, so the two halves stay connected on foot. */
const WALL_GAP_Y = 48;
const GAPPED_WALL = () =>
  buildMapRuntime(
    emptyMapDef({
      id: 'pf-gapped-wall',
      rects: [{ terrain: 'MOUNTAIN', x: 30, y: 0, w: 4, h: WALL_GAP_Y }],
      cities: [
        { id: 'w', x: 10, y: 10, capital: true, owner: 1, radius: 6 },
        { id: 'e', x: 50, y: 10, capital: true, owner: 2, radius: 6 },
      ],
    }),
  );

/** A range with no gap at all, and both capitals on the near side of it. */
const SEALED_WALL = () =>
  buildMapRuntime(
    emptyMapDef({
      id: 'pf-sealed-wall',
      w: 32,
      h: 32,
      rects: [{ terrain: 'MOUNTAIN', x: 20, y: 0, w: 4, h: 32 }],
      cities: [
        { id: 'a', x: 4, y: 16, capital: true, owner: 1, radius: 4 },
        { id: 'b', x: 12, y: 16, capital: true, owner: 2, radius: 4 },
      ],
    }),
  );

/** A forest block a heavy would rather walk around than through. */
const FOREST_BLOCK = () =>
  buildMapRuntime(
    emptyMapDef({
      id: 'pf-forest-block',
      rects: [{ terrain: 'FOREST', x: 30, y: 28, w: 10, h: 8 }],
      cities: [
        { id: 'a', x: 6, y: 32, capital: true, owner: 1, radius: 5 },
        { id: 'b', x: 57, y: 32, capital: true, owner: 2, radius: 5 },
      ],
    }),
  );

/** Terrain tally along a route, densely sampled so simplified segments still count. */
function terrainAlong(map: MapRuntime, pts: number[]): Map<number, number> {
  const tally = new Map<number, number>();
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2]!;
    const ay = pts[i - 1]!;
    const bx = pts[i]!;
    const by = pts[i + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const terrain = terrainAt(map, ax + (bx - ax) * t, ay + (by - ay) * t);
      tally.set(terrain, (tally.get(terrain) ?? 0) + 1);
    }
  }
  return tally;
}

describe('PATHFINDING', () => {
  it('routes around a mountain range instead of through it', () => {
    const map = GAPPED_WALL();
    const sx = tileCentre(10);
    const sy = tileCentre(10);
    const gx = tileCentre(50);
    const gy = tileCentre(10);

    const exact = findPath(map, sx, sy, gx, gy, Kind.Light);
    expect(exact.complete).toBe(true);
    expect(exact.expanded).toBeGreaterThan(0);
    // Tile centres, so every vertex is a tile the unit may legally stand on.
    for (let i = 0; i < exact.pts.length; i += 2) {
      expect(terrainAt(map, exact.pts[i]!, exact.pts[i + 1]!)).not.toBe(Terrain.Mountain);
    }

    const route = findRoute(map, sx, sy, gx, gy, Kind.Light);
    expect(route.length).toBeGreaterThanOrEqual(4);
    expect(route[0]).toBeCloseTo(sx, 6);
    expect(route[1]).toBeCloseTo(sy, 6);
    expect(route[route.length - 2]).toBeCloseTo(gx, 6);
    expect(route[route.length - 1]).toBeCloseTo(gy, 6);

    // The only way past is the gap along the bottom, so the detour is unmistakable.
    let deepest = 0;
    for (let i = 1; i < route.length; i += 2) deepest = Math.max(deepest, route[i]!);
    expect(deepest).toBeGreaterThanOrEqual(WALL_GAP_Y * TILE_SIZE);

    const straight = Math.hypot(gx - sx, gy - sy);
    expect(polylineLength(route)).toBeGreaterThan(straight * 1.5);
    expect(terrainAlong(map, route).get(Terrain.Mountain) ?? 0).toBe(0);
  });

  it('returns no route when the target is sealed off', () => {
    const map = SEALED_WALL();
    // The last dry tile before the range, aimed at a tile behind it.
    const sx = tileCentre(19);
    const sy = tileCentre(16);
    const gx = tileCentre(28);
    const gy = tileCentre(16);
    expect(terrainAt(map, sx, sy)).toBe(Terrain.Plains);
    expect(terrainAt(map, gx, gy)).toBe(Terrain.Plains);

    const exact = findPath(map, sx, sy, gx, gy, Kind.Light);
    expect(exact.complete).toBe(false);
    expect(exact.pts).toEqual([]);
    expect(exact.expanded).toBeGreaterThan(0);
    expect(findRoute(map, sx, sy, gx, gy, Kind.Light)).toEqual([]);

    // Reachable targets on the near side still work, so the wall is the only thing
    // stopping it — not a broken search.
    const near = findRoute(map, sx, sy, tileCentre(4), tileCentre(4), Kind.Light);
    expect(near.length).toBeGreaterThanOrEqual(4);
  });

  it('a best-effort route is returned when the goal is unreachable but ground is not', () => {
    const map = SEALED_WALL();
    const result = findPath(
      map,
      tileCentre(4),
      tileCentre(4),
      tileCentre(28),
      tileCentre(16),
      Kind.Light,
    );
    expect(result.complete).toBe(false);
    expect(result.pts.length).toBeGreaterThanOrEqual(4);
    // It walks up to the wall rather than giving up where it stood.
    const lastX = result.pts[result.pts.length - 2]!;
    expect(lastX).toBeGreaterThan(tileCentre(4));
  });

  it('per-kind costs make a heavy walk around a forest a light walks through', () => {
    const map = FOREST_BLOCK();
    const sx = tileCentre(25);
    const sy = tileCentre(32);
    const gx = tileCentre(45);
    const gy = tileCentre(32);

    const light = findRoute(map, sx, sy, gx, gy, Kind.Light);
    const heavy = findRoute(map, sx, sy, gx, gy, Kind.Heavy);
    expect(light.length).toBeGreaterThanOrEqual(4);
    expect(heavy.length).toBeGreaterThanOrEqual(4);

    const lightForest = terrainAlong(map, light).get(Terrain.Forest) ?? 0;
    const heavyForest = terrainAlong(map, heavy).get(Terrain.Forest) ?? 0;
    expect(lightForest).toBeGreaterThan(0);
    expect(heavyForest).toBeLessThan(lightForest);
    // Paying in distance to avoid the trees is the whole point.
    expect(polylineLength(heavy)).toBeGreaterThan(polylineLength(light));
  });

  it('degenerate requests are answered without a search', () => {
    const map = GAPPED_WALL();
    const x = tileCentre(10);
    const y = tileCentre(10);
    const same = findPath(map, x, y, x + 1, y + 1, Kind.Light);
    expect(same.complete).toBe(true);
    expect(same.expanded).toBe(0);
    expect(same.pts).toEqual([x, y, x + 1, y + 1]);

    const offMap = findPath(map, -10, -10, x, y, Kind.Light);
    expect(offMap.complete).toBe(false);
    expect(offMap.pts).toEqual([]);
    expect(DEFAULT_NODE_BUDGET).toBeGreaterThan(map.w * map.h * 0.5);
  });
});
