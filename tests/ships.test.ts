/**
 * The land/water form change.
 *
 * Water is meant to feel like a mistake, so the test checks both halves of that: the
 * conversion timer runs on the exact schedule `SHIP_CONVERT_SEC` promises, and the
 * water damage never stops — before the change, during it, and after. The unit is
 * parked on its owner's own ground with an enemy just inside `PROXIMITY_R`, so the
 * only thing moving its health bar is the water.
 */

import { describe, expect, it } from 'vitest';
import { Kind, Terrain } from '../src/core/types.ts';
import type { SimEvent } from '../src/core/types.ts';
import {
  KIND_SPEED,
  SHIP_CONVERT_SEC,
  TERRAIN_DAMAGE,
  TERRAIN_SPEED,
  TICK_SEC,
  WATER_DPS,
} from '../src/core/balance.ts';
import { damagePerSec } from '../src/core/combat.ts';
import { speedMul, terrainAt } from '../src/core/terrain.ts';
import { footFormOf, isShip, shipFormOf } from '../src/core/types.ts';
import { tick } from '../src/core/sim.ts';
import { emptyMap, makeWorld, placeLight, runTicks } from './helpers.ts';

/** A lake two coarse cells wide, clear of both capitals' city discs. */
const LAKE = { terrain: 'WATER' as const, x: 20, y: 24, w: 8, h: 16 };
const AFLOAT_X = 88;
const AFLOAT_Y = 130;
/** Dry ground, still inside player 1's territory, ten units away. */
const WATCHER_X = 78;
const ASHORE_X = 60;
const ASHORE_Y = 100;

const CONVERT_TICKS = Math.round(SHIP_CONVERT_SEC / TICK_SEC);

function lakeWorld(): ReturnType<typeof makeWorld> {
  return makeWorld(emptyMap({ id: 'test-lake', rects: [LAKE] }));
}

/** Ticks until `predicate` holds, returning the tick it happened on. */
function runUntil(
  world: ReturnType<typeof makeWorld>,
  cap: number,
  predicate: (events: readonly SimEvent[]) => boolean,
): number {
  for (let i = 0; i < cap; i++) {
    tick(world);
    if (predicate(world.events)) return world.tick;
  }
  return -1;
}

describe('SHIPS', () => {
  it('a unit left in water becomes a ship on schedule and bleeds the whole time', () => {
    const world = lakeWorld();
    const slot = placeLight(world, 1, AFLOAT_X, AFLOAT_Y);
    placeLight(world, 2, WATCHER_X, AFLOAT_Y);

    expect(terrainAt(world.map, AFLOAT_X, AFLOAT_Y)).toBe(Terrain.Water);
    expect(terrainAt(world.map, WATCHER_X, AFLOAT_Y)).not.toBe(Terrain.Water);

    let converted: SimEvent | null = null;
    const at = runUntil(world, CONVERT_TICKS * 2, (events) => {
      converted = events.find((e) => e.t === 'convert') ?? null;
      return converted !== null;
    });

    expect(at).toBeGreaterThanOrEqual(CONVERT_TICKS);
    expect(at).toBeLessThanOrEqual(CONVERT_TICKS + 1);
    expect(converted).not.toBeNull();
    expect(converted!).toMatchObject({ t: 'convert', owner: 1, toShip: true });
    expect(world.units.kind[slot]!).toBe(Kind.LightShip);
    expect(isShip(world.units.kind[slot]!)).toBe(true);
    expect(world.units.waterTime[slot]!).toBe(0);

    // Regeneration is frozen by the watcher, so the drain is pure water damage.
    expect(world.units.encircled[slot]!).toBe(0);
    expect(world.units.hp[slot]!).toBeCloseTo(1 - WATER_DPS * TICK_SEC * at, 5);

    // And it keeps bleeding once afloat — a ship is not a solution to being wet.
    const afterConversion = world.units.hp[slot]!;
    runTicks(world, 20);
    expect(world.units.hp[slot]!).toBeCloseTo(afterConversion - WATER_DPS * TICK_SEC * 20, 5);
  });

  it('a beached ship converts back after the same delay and stops bleeding', () => {
    const world = lakeWorld();
    const slot = placeLight(world, 1, AFLOAT_X, AFLOAT_Y);
    placeLight(world, 2, WATCHER_X, AFLOAT_Y);
    runUntil(world, CONVERT_TICKS * 2, (events) => events.some((e) => e.t === 'convert'));
    expect(world.units.kind[slot]!).toBe(Kind.LightShip);

    // Put it ashore, out of the watcher's reach, and start the clock again.
    world.units.x[slot] = ASHORE_X;
    world.units.y[slot] = ASHORE_Y;
    expect(terrainAt(world.map, ASHORE_X, ASHORE_Y)).toBe(Terrain.Plains);
    const landedHp = world.units.hp[slot]!;
    const landedTick = world.tick;

    const back = runUntil(world, CONVERT_TICKS * 2, (events) =>
      events.some((e) => e.t === 'convert' && !e.toShip),
    );

    expect(back - landedTick).toBeGreaterThanOrEqual(CONVERT_TICKS);
    expect(back - landedTick).toBeLessThanOrEqual(CONVERT_TICKS + 1);
    expect(world.units.kind[slot]!).toBe(Kind.Light);
    expect(isShip(world.units.kind[slot]!)).toBe(false);
    // On land the water damage is gone, so health can only have gone up.
    expect(world.units.hp[slot]!).toBeGreaterThanOrEqual(landedHp);
  });

  it('a ship trades damage for speed, exactly as the tables say', () => {
    const world = lakeWorld();
    // Read before the first tick, while the unit is still untouched by the water.
    const foot = placeLight(world, 1, AFLOAT_X, AFLOAT_Y);
    const footDps = damagePerSec(world, foot);
    expect(footDps).toBeCloseTo(TERRAIN_DAMAGE[Terrain.Water]![Kind.Light]!, 6);

    runUntil(world, CONVERT_TICKS * 2, (events) => events.some((e) => e.t === 'convert'));
    expect(world.units.kind[foot]!).toBe(Kind.LightShip);

    const shipDps = damagePerSec(world, foot);
    const wounded = world.units.hp[foot]!;
    // Same health factor on both sides of the comparison, so only the table differs.
    expect(shipDps / (footDps * Math.sqrt(wounded))).toBeCloseTo(
      TERRAIN_DAMAGE[Terrain.Water]![Kind.LightShip]! / TERRAIN_DAMAGE[Terrain.Water]![Kind.Light]!,
      5,
    );
    expect(shipDps).toBeLessThan(footDps);

    const footSpeed = speedMul(Terrain.Water, Kind.Light) * KIND_SPEED[Kind.Light]!;
    const shipSpeed = speedMul(Terrain.Water, Kind.LightShip) * KIND_SPEED[Kind.LightShip]!;
    expect(shipSpeed).toBeGreaterThan(footSpeed);
    // …and pays for it the moment it touches land.
    expect(TERRAIN_SPEED[Terrain.Plains]![Kind.LightShip]!).toBeLessThan(
      TERRAIN_SPEED[Terrain.Plains]![Kind.Light]!,
    );
  });

  it('the form helpers are idempotent and preserve the light/heavy family', () => {
    expect(shipFormOf(Kind.Light)).toBe(Kind.LightShip);
    expect(shipFormOf(Kind.LightShip)).toBe(Kind.LightShip);
    expect(shipFormOf(Kind.Heavy)).toBe(Kind.HeavyShip);
    expect(footFormOf(Kind.HeavyShip)).toBe(Kind.Heavy);
    expect(footFormOf(Kind.Heavy)).toBe(Kind.Heavy);
    expect(footFormOf(Kind.LightShip)).toBe(Kind.Light);
  });
});
