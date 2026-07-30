/**
 * Terrain, the shipped maps, and the loader's refusal to accept a broken one.
 *
 * The reachability check is written out here rather than borrowed from `map.ts`, so
 * the test is an independent opinion about the maps instead of a restatement of the
 * validator. It checks every city against every other, not just against the first
 * capital, which is the property a match actually needs.
 */

import { describe, expect, it } from 'vitest';
import { Terrain, TERRAIN_KEYS } from '../src/core/types.ts';
import type { MapDef, MapRuntime } from '../src/core/types.ts';
import { COARSE, TILE_SIZE } from '../src/core/balance.ts';
import { buildMapRuntime, parseMapDef, validateMap } from '../src/core/map.ts';
import {
  cityAt,
  isInsideCity,
  terrainAt,
  terrainAtTile,
  terrainFromRgb,
  terrainHistogram,
  terrainIdToKey,
  terrainKeyToId,
  TERRAIN_MASK_COLORS,
} from '../src/core/terrain.ts';
import { getMapRuntime, listMapDefs } from '../src/content/registry.ts';
import { loadMapsFromDisk } from '../tools/maps.ts';
import { emptyMapDef, mirroredCapitals } from './helpers.ts';

loadMapsFromDisk();
const SHIPPED = listMapDefs();

/** Tiles reachable on foot — mountains are the only hard block. */
function reachableFrom(map: MapRuntime, tx: number, ty: number): Uint8Array {
  const seen = new Uint8Array(map.w * map.h);
  const queue: number[] = [ty * map.w + tx];
  seen[queue[0]!] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const x = i % map.w;
    const y = (i / map.w) | 0;
    const steps = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of steps) {
      if (nx! < 0 || ny! < 0 || nx! >= map.w || ny! >= map.h) continue;
      const ni = ny! * map.w + nx!;
      if (seen[ni] || map.terrain[ni] === Terrain.Mountain) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

describe('MAPS', () => {
  it('finds the shipped maps on disk', () => {
    expect(SHIPPED.length).toBeGreaterThanOrEqual(2);
    expect(SHIPPED.map((d) => d.id)).toContain('crossing');
  });

  it.each(SHIPPED.map((d) => d.id))('%s loads, validates and is playable', (id) => {
    const map = getMapRuntime(id);
    validateMap(map);

    expect(map.w).toBe(map.def.size.w);
    expect(map.h).toBe(map.def.size.h);
    expect(map.worldW).toBe(map.w * TILE_SIZE);
    expect(map.worldH).toBe(map.h * TILE_SIZE);
    expect(map.cw).toBe(Math.ceil(map.w / COARSE));
    expect(map.ch).toBe(Math.ceil(map.h / COARSE));
    expect(map.terrain.length).toBe(map.w * map.h);
    expect(map.coarseTerrain.length).toBe(map.cw * map.ch);
    expect(map.coarseClaimable).toBeGreaterThan(0);
    expect(map.coarseClaimable).toBeLessThanOrEqual(map.cw * map.ch);
    expect(map.playerCount).toBeGreaterThanOrEqual(2);
    expect(map.playerCount).toBeLessThanOrEqual(4);

    // A capital each, and no city buried in a mountain.
    const capitals = new Map<number, number>();
    for (const c of map.def.cities) {
      if (!c.capital) continue;
      capitals.set(c.owner ?? 0, (capitals.get(c.owner ?? 0) ?? 0) + 1);
    }
    for (let p = 1; p <= map.playerCount; p++) expect(capitals.get(p)).toBeGreaterThanOrEqual(1);
    for (const c of map.def.cities) {
      expect(terrainAtTile(map, c.x, c.y)).not.toBe(Terrain.Mountain);
      expect(cityAt(map, (c.x + 0.5) * TILE_SIZE, (c.y + 0.5) * TILE_SIZE)).toBeGreaterThanOrEqual(
        0,
      );
    }

    // Every city can reach every other city on foot.
    for (const from of map.def.cities) {
      const seen = reachableFrom(map, from.x, from.y);
      for (const to of map.def.cities) {
        expect(seen[to.y * map.w + to.x]).toBe(1);
      }
    }

    // Starting units are on legal ground.
    for (const s of map.def.startUnits ?? []) {
      expect(terrainAtTile(map, Math.round(s.x), Math.round(s.y))).not.toBe(Terrain.Mountain);
      expect(s.owner).toBeGreaterThanOrEqual(1);
      expect(s.owner).toBeLessThanOrEqual(map.playerCount);
    }

    const histogram = terrainHistogram(map);
    expect(histogram.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(histogram[Terrain.Mountain]!).toBeLessThan(0.5);
  });

  it('building the same map twice gives identical terrain', () => {
    const def = SHIPPED[0]!;
    const a = buildMapRuntime(def);
    const b = buildMapRuntime(def);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(Array.from(a.coarseTerrain)).toEqual(Array.from(b.coarseTerrain));
  });

  it('terrain lookups clamp, and city ground reads as safe', () => {
    const map = buildMapRuntime(emptyMapDef({ id: 'test-lookups' }));
    expect(terrainAt(map, 10, 10)).toBe(Terrain.Plains);
    // Out of bounds reads as an impassable wall rather than throwing.
    expect(terrainAt(map, -1, 10)).toBe(Terrain.Mountain);
    expect(terrainAt(map, map.worldW + 1, 10)).toBe(Terrain.Mountain);
    expect(terrainAtTile(map, -1, 0)).toBe(Terrain.Mountain);

    const capital = map.def.cities[0]!;
    const cx = (capital.x + 0.5) * TILE_SIZE;
    const cy = (capital.y + 0.5) * TILE_SIZE;
    expect(isInsideCity(map, cx, cy)).toBe(true);
    expect(isInsideCity(map, cx + capital.radius! * TILE_SIZE * 2, cy)).toBe(false);
    expect(cityAt(map, cx, cy)).toBe(0);
    expect(cityAt(map, -5, -5)).toBe(-1);
  });

  it('the terrain palette round-trips and snaps to the nearest colour', () => {
    for (let i = 0; i < TERRAIN_KEYS.length; i++) {
      const key = terrainIdToKey(i);
      expect(terrainKeyToId(key)).toBe(i);
      const c = TERRAIN_MASK_COLORS[i]!;
      expect(terrainFromRgb(c[0], c[1], c[2])).toBe(i);
      // A colour nudged by a profile conversion still lands on the same terrain.
      expect(terrainFromRgb(c[0] + 3, c[1] - 3, c[2] + 2)).toBe(i);
    }
    expect(() => terrainKeyToId('SWAMP')).toThrow(/unknown terrain key/);
    expect(() => terrainIdToKey(99)).toThrow(/unknown terrain id/);
  });
});

describe('MAP VALIDATION', () => {
  const build =
    (def: MapDef): (() => MapRuntime) =>
    () =>
      buildMapRuntime(def);

  it('rejects a player with no capital', () => {
    const def = emptyMapDef({
      id: 'bad-no-capital',
      cities: [
        { id: 'a', x: 12, y: 32, capital: true, owner: 1, radius: 5 },
        { id: 'b', x: 51, y: 32, owner: 2, radius: 5 },
      ],
    });
    expect(build(def)).toThrow(/player 2 has no capital/);
  });

  it('rejects a capital owned by nobody', () => {
    const def = emptyMapDef({
      id: 'bad-neutral-capital',
      cities: [
        { id: 'a', x: 12, y: 32, capital: true, owner: 1, radius: 5 },
        { id: 'b', x: 51, y: 32, capital: true, owner: 0, radius: 5 },
      ],
    });
    expect(build(def)).toThrow(/has no owner/);
  });

  it('rejects a city walled into an unreachable pocket', () => {
    // The mountain block is wide enough that the city's own plains disc — cities
    // convert the ground under them — cannot touch the rest of the map.
    const def = emptyMapDef({
      id: 'bad-unreachable',
      rects: [{ terrain: 'MOUNTAIN', x: 34, y: 20, w: 20, h: 24 }],
      cities: [
        { id: 'a', x: 12, y: 32, capital: true, owner: 1, radius: 5 },
        { id: 'b', x: 20, y: 32, capital: true, owner: 2, radius: 5 },
        { id: 'walled-in', x: 44, y: 32, owner: 0, radius: 2 },
      ],
    });
    expect(build(def)).toThrow(/unreachable/);
  });

  it('rejects start units spawned inside a mountain', () => {
    const def = emptyMapDef({
      id: 'bad-start-units',
      rects: [{ terrain: 'MOUNTAIN', x: 34, y: 20, w: 20, h: 24 }],
      startUnits: [{ owner: 1, kind: 'light', count: 4, x: 44, y: 32, spread: 2 }],
    });
    expect(build(def)).toThrow(/spawns inside a mountain/);
  });

  it('rejects duplicate city ids, out-of-range owners and too few cities', () => {
    expect(
      build(
        emptyMapDef({
          id: 'bad-duplicate',
          cities: [
            { id: 'same', x: 12, y: 32, capital: true, owner: 1, radius: 5 },
            { id: 'same', x: 51, y: 32, capital: true, owner: 2, radius: 5 },
          ],
        }),
      ),
    ).toThrow(/duplicate city id/);

    expect(
      build(
        emptyMapDef({
          id: 'bad-owner',
          cities: [...mirroredCapitals(64, 64), { id: 'ghost', x: 32, y: 32, owner: 7, radius: 5 }],
        }),
      ),
    ).toThrow(/has owner 7/);

    expect(
      build(
        emptyMapDef({
          id: 'bad-count',
          players: 3,
          cities: [
            { id: 'a', x: 12, y: 32, capital: true, owner: 1, radius: 5 },
            { id: 'b', x: 51, y: 32, capital: true, owner: 2, radius: 5 },
          ],
        }),
      ),
    ).toThrow(/at least one city per player/);
  });

  it('rejects a map that is too small or has no terrain source', () => {
    expect(build(emptyMapDef({ id: 'bad-size', w: 8, h: 8 }))).toThrow(/size must be integers/);
    const noTerrain: MapDef = { ...emptyMapDef({ id: 'bad-terrain' }) };
    delete noTerrain.terrainGen;
    expect(build(noTerrain)).toThrow(/terrainMask or a terrainGen recipe/);
  });

  it('parseMapDef insists on the required fields', () => {
    expect(() => parseMapDef(null)).toThrow(/must be an object/);
    expect(() => parseMapDef({ name: 'x', size: { w: 32, h: 32 }, cities: [] })).toThrow(/"id"/);
    expect(() => parseMapDef({ id: 'x', name: 'x', size: { w: 32, h: 32 } })).toThrow(/"cities"/);
    expect(() =>
      parseMapDef({
        id: 'x',
        name: 'x',
        size: { w: 32, h: 32 },
        cities: [],
        terrainGen: { seed: 1, features: [{ type: 'fill', terrain: 'LAVA' }] },
      }),
    ).toThrow(/unknown terrain key/);
    // A well-formed definition comes back unchanged.
    const good = emptyMapDef({ id: 'good' });
    expect(parseMapDef(good).id).toBe('good');
  });
});
