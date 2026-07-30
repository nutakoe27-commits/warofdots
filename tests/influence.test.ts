/**
 * The influence field, and the two things it is really for: territory and walls.
 *
 * Mountain blocking is asserted by comparison rather than by inspecting the field,
 * because the interesting claim is not "the wall cells are unowned" — that falls out
 * of an `Infinity` step cost — but "a player projects less power when a range is in
 * the way". So the same map is built twice, once with the wall and once without, and
 * the owned-cell counts are compared.
 */

import { describe, expect, it } from 'vitest';
import { Terrain } from '../src/core/types.ts';
import { CITY_POWER, COARSE_SIZE, INFLUENCE_INTERVAL, UNIT_POWER } from '../src/core/balance.ts';
import { cellAt, cellCenterX, cellCenterY, territoryShares } from '../src/core/influence.ts';
import { pocketsOf } from '../src/core/pockets.ts';
import { loadMapsFromDisk } from '../tools/maps.ts';
import { getMapRuntime, listMapDefs } from '../src/content/registry.ts';
import {
  emptyMap,
  emptyMapDef,
  makeWorld,
  mirroredCapitals,
  ownedCells,
  placeLight,
  runTicks,
  SPLIT_WALL_W,
  SPLIT_WALL_X,
  splitMap,
  TEST_MAP_TILES,
  town,
} from './helpers.ts';
import { buildMapRuntime } from '../src/core/map.ts';

/** Long enough for the staggered field passes to complete and resolve twice over. */
const RESOLVE_TICKS = INFLUENCE_INTERVAL * 3;

const THREE_CITY_MAP = () =>
  buildMapRuntime(
    emptyMapDef({
      id: 'test-three-cities',
      cities: [...mirroredCapitals(TEST_MAP_TILES, TEST_MAP_TILES), town('north-east', 51, 8, 2)],
    }),
  );

const WALLED_MAP = () =>
  buildMapRuntime(
    emptyMapDef({
      id: 'test-walled',
      rects: [
        { terrain: 'MOUNTAIN', x: SPLIT_WALL_X, y: 0, w: SPLIT_WALL_W, h: TEST_MAP_TILES },
        { terrain: 'PLAINS', x: SPLIT_WALL_X, y: TEST_MAP_TILES >> 1, w: SPLIT_WALL_W, h: 1 },
      ],
    }),
  );

describe('INFLUENCE', () => {
  it('a change of city owner moves the ownership grid the expected way', () => {
    const world = makeWorld(THREE_CITY_MAP());
    runTicks(world, RESOLVE_TICKS);

    const before = territoryShares(world);
    const beforeCells = [ownedCells(world, 1), ownedCells(world, 2)];
    expect(before[1]!).toBeGreaterThan(0);
    expect(before[2]!).toBeGreaterThan(0);

    const seized = world.cities[1]!;
    const seizedCell = cellAt(world, seized.x, seized.y);
    expect(world.influence.owner[seizedCell]!).toBe(2);

    seized.owner = 1;
    runTicks(world, RESOLVE_TICKS);

    const after = territoryShares(world);
    expect(world.influence.owner[seizedCell]!).toBe(1);
    expect(after[1]!).toBeGreaterThan(before[1]!);
    expect(after[2]!).toBeLessThan(before[2]!);
    expect(ownedCells(world, 1)).toBeGreaterThan(beforeCells[0]!);
    expect(ownedCells(world, 2)).toBeLessThan(beforeCells[1]!);
    // Player 2 keeps one city, so it keeps a foothold rather than vanishing.
    expect(after[2]!).toBeGreaterThan(0);
    expect(world.players[2]!.alive).toBe(true);
  });

  it('mountains block influence and can cut a player in two', () => {
    const open = makeWorld(emptyMap());
    runTicks(open, RESOLVE_TICKS);
    const walled = makeWorld(WALLED_MAP());
    runTicks(walled, RESOLVE_TICKS);

    expect(ownedCells(walled, 1)).toBeGreaterThan(0);
    expect(ownedCells(walled, 1)).toBeLessThan(ownedCells(open, 1));
    expect(ownedCells(walled, 2)).toBeLessThan(ownedCells(open, 2));

    // Every cell of the range is impassable to influence, and therefore unowned.
    const inf = walled.influence;
    let wallCells = 0;
    for (let cell = 0; cell < inf.owner.length; cell++) {
      if (walled.map.coarseTerrain[cell] !== Terrain.Mountain) continue;
      wallCells++;
      expect(walled.map.coarseCost[cell]!).toBe(Infinity);
      expect(inf.owner[cell]!).toBe(0);
      for (let p = 1; p <= walled.map.playerCount; p++) {
        expect(inf.field[p * inf.owner.length + cell]!).toBe(0);
      }
    }
    expect(wallCells).toBe(2 * walled.influence.ch);

    // With a second city on the far side, the wall splits one player into two pockets.
    const split = makeWorld(splitMap());
    runTicks(split, RESOLVE_TICKS);
    expect(pocketsOf(split, 1).length).toBe(2);
  });

  it('territory shares never add up to more than the whole map', () => {
    loadMapsFromDisk();
    const worlds = [makeWorld(emptyMap()), makeWorld(splitMap())];
    for (const def of listMapDefs()) worlds.push(makeWorld(getMapRuntime(def.id)));

    for (const world of worlds) {
      runTicks(world, RESOLVE_TICKS);
      const shares = territoryShares(world);
      expect(shares[0]!).toBe(0);
      let sum = 0;
      for (let p = 1; p <= world.map.playerCount; p++) {
        expect(shares[p]!).toBeGreaterThanOrEqual(0);
        sum += shares[p]!;
      }
      expect(sum).toBeLessThanOrEqual(1 + 1e-9);
      expect(sum).toBeGreaterThan(0);
      expect(world.stats.players[1]!.territory).toBeCloseTo(shares[1]!, 10);
    }
  });

  it('a lone raider cannot out-project a city', () => {
    const quiet = makeWorld(emptyMap());
    runTicks(quiet, RESOLVE_TICKS);
    const baseline = ownedCells(quiet, 2);

    const raided = makeWorld(emptyMap());
    const deepX = 80;
    const deepY = 130;
    placeLight(raided, 2, deepX, deepY);
    runTicks(raided, RESOLVE_TICKS);

    // `UNIT_POWER` is a fifth of `CITY_POWER`: the cell the raider stands on stays
    // enemy ground, and the map barely notices it is there.
    expect(UNIT_POWER).toBeLessThan(CITY_POWER);
    expect(raided.influence.owner[cellAt(raided, deepX, deepY)]!).toBe(1);
    expect(ownedCells(raided, 2)).toBeLessThanOrEqual(baseline + 2);
  });

  it('cell lookups and cell centres agree', () => {
    const world = makeWorld(emptyMap());
    const cell = cellAt(world, 100, 130);
    expect(cell).toBe(((130 / COARSE_SIZE) | 0) * world.influence.cw + ((100 / COARSE_SIZE) | 0));
    expect(cellAt(world, cellCenterX(world, cell), cellCenterY(world, cell))).toBe(cell);
    // Out-of-bounds reads clamp instead of throwing.
    expect(cellAt(world, -50, -50)).toBe(0);
    expect(cellAt(world, 1e6, 1e6)).toBe(world.influence.cw * world.influence.ch - 1);
  });
});
