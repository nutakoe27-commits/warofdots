/**
 * Income, upkeep, supply, starvation — and the two ways a unit can be cut off.
 *
 * Encirclement and starvation are easy to confuse in a test, because both show up
 * as HP quietly draining. They are separated here by geometry: a starving unit is
 * inside a working pocket and merely over its cap, an encircled one is in no pocket
 * at all. Both fixtures park an enemy just inside `PROXIMITY_R` so regeneration
 * cannot creep back in and blur the rate being measured.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPITAL_INCOME_MULT,
  CITY_INCOME,
  ENCIRCLED_DPS,
  START_ECO,
  STARVE_DPS,
  SUPPLY_PER_CITY,
  TICK_SEC,
  UPKEEP,
} from '../src/core/balance.ts';
import { ecoRateOf, supplyOf } from '../src/core/economy.ts';
import { pocketOfUnit, pocketsOf } from '../src/core/pockets.ts';
import { playerEco } from '../src/core/world.ts';
import { isInsideCity } from '../src/core/terrain.ts';
import {
  emptyMap,
  makeWorld,
  placeLight,
  runTicks,
  seconds,
  slotsOf,
  splitMap,
} from './helpers.ts';

/** Player 1's ground, clear of the capital's radius. */
const HOME_X = 100;
const HOME_Y = 130;
/** Wider than separation (5.2) so nothing drifts, narrower than nothing else. */
const RANK = 6;

/** Player 2's ground, clear of its capital so no capture starts. */
const EXILE_X = 170;
const BLOCKER_GAP = 10;

function garrison(world: ReturnType<typeof makeWorld>, n: number, insideCity: boolean): number[] {
  const city = world.cities[0]!;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (insideCity) out.push(placeLight(world, 1, city.x + (i - (n - 1) / 2) * RANK, city.y));
    else out.push(placeLight(world, 1, HOME_X, HOME_Y + i * RANK));
  }
  return out;
}

describe('ECONOMY', () => {
  it('six units on one city leaves exactly one starving', () => {
    const world = makeWorld(emptyMap());
    const units = garrison(world, SUPPLY_PER_CITY + 1, false);

    // One tick from full HP: nobody is eligible for regeneration yet, so the only
    // thing that can move a health bar is the single unit over the cap.
    runTicks(world, 1);

    const pocket = pocketOfUnit(world, units[0]!);
    expect(pocket).not.toBeNull();
    expect(pocket!.cities.length).toBe(1);
    expect(pocket!.supplyCap).toBe(SUPPLY_PER_CITY);
    expect(pocket!.supplyUsed).toBe(SUPPLY_PER_CITY + 1);
    expect(pocket!.supplyUsed - pocket!.supplyCap).toBe(1);
    expect(supplyOf(world, 1)).toEqual({ cap: SUPPLY_PER_CITY, used: SUPPLY_PER_CITY + 1 });

    const hungry = units.filter((s) => world.units.hp[s]! < 1);
    expect(hungry.length).toBe(1);
    // `healthiestFirst` breaks the all-full-HP tie on unit id, so it is the eldest.
    expect(world.units.id[hungry[0]!]!).toBe(Math.min(...units.map((s) => world.units.id[s]!)));
    expect(world.units.hp[hungry[0]!]!).toBeCloseTo(1 - STARVE_DPS * TICK_SEC, 6);
    for (const s of units) expect(world.units.encircled[s]!).toBe(0);
  });

  it('weakestFirst keeps the same unit hungry, at exactly STARVE_DPS', () => {
    const world = makeWorld(emptyMap(), { starveStrategy: 'weakestFirst' });
    const units = garrison(world, SUPPLY_PER_CITY + 1, false);
    // Sits inside PROXIMITY_R of the unit that starves and outside contact range,
    // so regeneration cannot claw back part of the drain.
    placeLight(world, 2, HOME_X, HOME_Y - BLOCKER_GAP - 1);

    const ticks = seconds(6);
    runTicks(world, ticks);

    const hungry = units.filter((s) => world.units.hp[s]! < 1);
    expect(hungry.length).toBe(1);
    expect(hungry[0]!).toBe(units[0]!);
    expect(world.units.hp[units[0]!]!).toBeCloseTo(1 - STARVE_DPS * TICK_SEC * ticks, 5);
  });

  it('healthiestFirst spreads the loss instead of concentrating it', () => {
    const worst = (strategy: 'healthiestFirst' | 'weakestFirst'): number => {
      const world = makeWorld(emptyMap(), { starveStrategy: strategy });
      const units = garrison(world, SUPPLY_PER_CITY + 1, false);
      runTicks(world, seconds(20));
      return Math.max(...units.map((s) => 1 - world.units.hp[s]!));
    };

    const spread = worst('healthiestFirst');
    const concentrated = worst('weakestFirst');
    expect(spread).toBeLessThan(concentrated);
    expect(spread).toBeLessThan(concentrated / 10);
  });

  it('five units on one city leaves nobody starving', () => {
    const world = makeWorld(emptyMap());
    const units = garrison(world, SUPPLY_PER_CITY, false);
    runTicks(world, seconds(4));

    expect(supplyOf(world, 1).used).toBe(SUPPLY_PER_CITY);
    for (const s of units) expect(world.units.hp[s]!).toBe(1);
  });

  it('income, the capital multiplier and upkeep add up to the expected ECO/sec', () => {
    const world = makeWorld(emptyMap());
    const outside = garrison(world, 4, false);
    runTicks(world, seconds(1));

    const capitalIncome = CITY_INCOME * CAPITAL_INCOME_MULT;
    const expected = capitalIncome - outside.length * UPKEEP;
    expect(pocketsOf(world, 1).length).toBe(1);
    expect(pocketsOf(world, 1)[0]!.ecoRate).toBeCloseTo(expected, 6);
    expect(ecoRateOf(world, 1)).toBeCloseTo(expected, 6);

    const ticks = seconds(10);
    const before = playerEco(world, 1);
    runTicks(world, ticks);
    expect(playerEco(world, 1)).toBeCloseTo(before + expected * TICK_SEC * ticks, 3);
  });

  it('units inside a city cost no upkeep', () => {
    const world = makeWorld(emptyMap());
    const inside = garrison(world, 4, true);
    runTicks(world, seconds(1));
    for (const s of inside) {
      expect(isInsideCity(world.map, world.units.x[s]!, world.units.y[s]!)).toBe(true);
    }

    const capitalIncome = CITY_INCOME * CAPITAL_INCOME_MULT;
    expect(ecoRateOf(world, 1)).toBeCloseTo(capitalIncome, 6);

    const ticks = seconds(10);
    const before = playerEco(world, 1);
    runTicks(world, ticks);
    expect(playerEco(world, 1)).toBeCloseTo(before + capitalIncome * TICK_SEC * ticks, 3);
    expect(playerEco(world, 1)).toBeGreaterThan(START_ECO);
  });
});

describe('ENCIRCLEMENT', () => {
  it('a unit cut off from its cities bleeds at ENCIRCLED_DPS', () => {
    const world = makeWorld(emptyMap());
    const stranded = placeLight(world, 1, EXILE_X, HOME_Y);
    const watcher = placeLight(world, 2, EXILE_X + BLOCKER_GAP, HOME_Y);

    const ticks = seconds(6);
    runTicks(world, ticks);

    expect(world.units.encircled[stranded]!).toBe(1);
    expect(world.units.supplied[stranded]!).toBe(0);
    expect(world.units.pocket[stranded]!).toBe(-1);
    expect(pocketOfUnit(world, stranded)).toBeNull();
    expect(world.units.inCombat[stranded]!).toBe(0);
    expect(world.units.hp[stranded]!).toBeCloseTo(1 - ENCIRCLED_DPS * TICK_SEC * ticks, 5);

    // The unit standing on its own ground ten units away is untouched.
    expect(world.units.encircled[watcher]!).toBe(0);
    expect(world.units.supplied[watcher]!).toBe(1);
    expect(world.units.hp[watcher]!).toBe(1);
  });

  it('encirclement bites harder than starvation', () => {
    expect(ENCIRCLED_DPS).toBeGreaterThan(STARVE_DPS);
  });
});

describe('POCKETS', () => {
  it('a lobe cut off with its own city keeps its own economy, supply and treasury', () => {
    const world = makeWorld(splitMap());
    const capital = world.cities[0]!;
    const outpost = world.cities[1]!;
    expect(capital.capital).toBe(true);
    expect(outpost.capital).toBe(false);
    expect(outpost.owner).toBe(1);

    const homeUnits = [
      placeLight(world, 1, HOME_X, HOME_Y),
      placeLight(world, 1, HOME_X, HOME_Y + RANK),
    ];
    const cutOff = [
      placeLight(world, 1, outpost.x, outpost.y - 30),
      placeLight(world, 1, outpost.x, outpost.y - 36),
      placeLight(world, 1, outpost.x, outpost.y - 42),
    ];

    runTicks(world, seconds(1));

    const pockets = pocketsOf(world, 1);
    expect(pockets.length).toBe(2);
    const home = pockets.find((p) => p.cities.includes(capital.index))!;
    const east = pockets.find((p) => p.cities.includes(outpost.index))!;
    expect(home).toBeDefined();
    expect(east).toBeDefined();
    expect(home.id).not.toBe(east.id);
    expect(home.cities.length).toBe(1);
    expect(east.cities.length).toBe(1);

    // The cut-off group still earns, still supplies, and is not encircled.
    for (const s of cutOff) {
      expect(world.units.encircled[s]!).toBe(0);
      expect(world.units.supplied[s]!).toBe(1);
      expect(world.units.pocket[s]!).toBe(east.id);
    }
    expect(east.supplyCap).toBe(SUPPLY_PER_CITY);
    expect(east.supplyUsed).toBe(cutOff.length);
    expect(east.ecoRate).toBeCloseTo(CITY_INCOME - cutOff.length * UPKEEP, 6);

    for (const s of homeUnits) expect(world.units.pocket[s]!).toBe(home.id);
    expect(home.ecoRate).toBeCloseTo(
      CITY_INCOME * CAPITAL_INCOME_MULT - homeUnits.length * UPKEEP,
      6,
    );
    // Same city income on both sides of the wall; only the capital bonus differs.
    expect(
      (home.ecoRate + homeUnits.length * UPKEEP) / (east.ecoRate + cutOff.length * UPKEEP),
    ).toBeCloseTo(CAPITAL_INCOME_MULT, 6);

    // Two treasuries, filling at their own rates from the same starting split.
    const share = START_ECO / 2;
    expect(capital.eco).toBeCloseTo(share + home.ecoRate * TICK_SEC * world.tick, 3);
    expect(outpost.eco).toBeCloseTo(share + east.ecoRate * TICK_SEC * world.tick, 3);

    const ticks = seconds(20);
    const homeBefore = capital.eco;
    const eastBefore = outpost.eco;
    runTicks(world, ticks);
    expect(capital.eco).toBeCloseTo(homeBefore + home.ecoRate * TICK_SEC * ticks, 3);
    expect(outpost.eco).toBeCloseTo(eastBefore + east.ecoRate * TICK_SEC * ticks, 3);
    expect(capital.eco - homeBefore).toBeGreaterThan(outpost.eco - eastBefore);
    expect(playerEco(world, 1)).toBeCloseTo(capital.eco + outpost.eco, 6);

    // Nobody starves: each lobe is under its own cap, not the player's total.
    for (const s of [...homeUnits, ...cutOff]) expect(world.units.hp[s]!).toBe(1);
    expect(supplyOf(world, 1).cap).toBe(2 * SUPPLY_PER_CITY);
  });

  it('a lobe cut off without a city is just an encircled bag of units', () => {
    const world = makeWorld(splitMap());
    const outpost = world.cities[1]!;
    outpost.owner = 0;
    const stranded = slotsOf(world, 1);
    expect(stranded.length).toBe(0);

    const marooned = placeLight(world, 1, outpost.x, outpost.y - 30);
    runTicks(world, seconds(1));

    expect(pocketsOf(world, 1).length).toBe(1);
    expect(world.units.encircled[marooned]!).toBe(1);
    expect(world.units.supplied[marooned]!).toBe(0);
  });
});
