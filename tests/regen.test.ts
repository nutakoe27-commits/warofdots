/**
 * Out-of-combat recovery, and the switching cost that makes cycling interesting.
 *
 * The rule under test is the awkward one: an enemy inside `PROXIMITY_R` freezes HP
 * regeneration even with no contact, so pulling a wounded unit one step out of the
 * melee buys nothing. Every fixture here parks the healing unit inside its owner's
 * own territory, because `ENCIRCLED_DPS` is eight times `HP_REGEN` and would drown
 * the signal completely.
 */

import { describe, expect, it } from 'vitest';
import {
  HP_REGEN,
  HP_REGEN_CITY_MULT,
  MORALE_DRAIN,
  MORALE_REGEN,
  PROXIMITY_R,
  TICK_SEC,
} from '../src/core/balance.ts';
import { isInsideCity } from '../src/core/terrain.ts';
import { emptyMap, makeWorld, placeLight, runTicks, seconds } from './helpers.ts';

/** Deep enough inside player 1's territory to be supplied, clear of the city. */
const HOME_X = 100;
const HOME_Y = 130;
const WOUNDED = 0.5;

const INSIDE = PROXIMITY_R - 1;
const OUTSIDE = PROXIMITY_R + 1;

function woundedWorld(enemyGap: number | null): {
  world: ReturnType<typeof makeWorld>;
  slot: number;
} {
  const world = makeWorld(emptyMap());
  const slot = placeLight(world, 1, HOME_X, HOME_Y);
  world.units.hp[slot] = WOUNDED;
  if (enemyGap !== null) placeLight(world, 2, HOME_X + enemyGap, HOME_Y);
  return { world, slot };
}

describe('REGENERATION', () => {
  it('an enemy 11 units away freezes HP regeneration', () => {
    const { world, slot } = woundedWorld(INSIDE);
    runTicks(world, seconds(5));

    expect(world.units.encircled[slot]!).toBe(0);
    expect(world.units.inCombat[slot]!).toBe(0);
    expect(world.units.hp[slot]!).toBe(WOUNDED);
  });

  it('an enemy 13 units away does not, and the unit heals at HP_REGEN', () => {
    const { world, slot } = woundedWorld(OUTSIDE);
    const ticks = seconds(5);
    runTicks(world, ticks);

    expect(world.units.inCombat[slot]!).toBe(0);
    expect(world.units.hp[slot]!).toBeCloseTo(WOUNDED + HP_REGEN * TICK_SEC * ticks, 4);
  });

  it('a city doubles the rate', () => {
    const ticks = seconds(20);

    const field = woundedWorld(null);
    runTicks(field.world, ticks);
    const openGain = field.world.units.hp[field.slot]! - WOUNDED;

    const inTown = makeWorld(emptyMap());
    const capital = inTown.cities[0]!;
    const slot = placeLight(inTown, 1, capital.x, capital.y);
    inTown.units.hp[slot] = WOUNDED;
    expect(isInsideCity(inTown.map, capital.x, capital.y)).toBe(true);
    runTicks(inTown, ticks);
    const townGain = inTown.units.hp[slot]! - WOUNDED;

    expect(openGain).toBeCloseTo(HP_REGEN * TICK_SEC * ticks, 4);
    expect(townGain).toBeCloseTo(HP_REGEN * HP_REGEN_CITY_MULT * TICK_SEC * ticks, 4);
    expect(townGain / openGain).toBeCloseTo(HP_REGEN_CITY_MULT, 3);
  });

  it('morale recovers out of combat and drains in it', () => {
    const ticks = seconds(3);

    const quiet = makeWorld(emptyMap());
    const resting = placeLight(quiet, 1, HOME_X, HOME_Y);
    quiet.units.morale[resting] = 0.4;
    runTicks(quiet, ticks);
    expect(quiet.units.morale[resting]!).toBeCloseTo(0.4 + MORALE_REGEN * TICK_SEC * ticks, 4);

    // Morale is capped, so a full unit standing around stays full.
    const full = placeLight(quiet, 1, HOME_X, HOME_Y - 40);
    runTicks(quiet, seconds(1));
    expect(quiet.units.morale[full]!).toBe(1);

    const melee = makeWorld(emptyMap());
    const fighter = placeLight(melee, 1, HOME_X, HOME_Y);
    const rival = placeLight(melee, 2, HOME_X + 5.25, HOME_Y);
    const short = seconds(0.5);
    runTicks(melee, short);
    expect(melee.units.inCombat[fighter]!).toBe(1);
    expect(melee.units.morale[fighter]!).toBeCloseTo(1 - MORALE_DRAIN * TICK_SEC * short, 4);
    expect(melee.units.morale[rival]!).toBeCloseTo(1 - MORALE_DRAIN * TICK_SEC * short, 4);
  });

  it('a unit at full HP is not credited with regeneration it cannot use', () => {
    const world = makeWorld(emptyMap());
    const slot = placeLight(world, 1, HOME_X, HOME_Y);
    runTicks(world, seconds(2));
    expect(world.units.hp[slot]!).toBe(1);
  });
});
