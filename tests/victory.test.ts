/**
 * The three victory modes, and the precise tick each one fires on.
 *
 * The default mode is the interesting one because it is a conjunction, and the
 * cheapest way to get it subtly wrong is to fire on either half. So the fixture
 * builds three near-miss states — majority without an enemy capital, an enemy
 * capital without majority, and the real thing — and drives the last one through an
 * actual city capture so the outcome tick can be pinned to the tick the flag came
 * down rather than to a hand-set flag.
 */

import { describe, expect, it } from 'vitest';
import { VictoryMode } from '../src/core/types.ts';
import {
  CAPTURE_SEC,
  SCORE_PER_CITY,
  SCORE_PER_UNIT,
  SCORE_TERRITORY,
  TICK_SEC,
} from '../src/core/balance.ts';
import { tick } from '../src/core/sim.ts';
import { teamScore } from '../src/core/stats.ts';
import { armySize } from '../src/core/units.ts';
import {
  emptyMap,
  emptyMapDef,
  makeWorld,
  mirroredCapitals,
  placeLight,
  runTicks,
  seconds,
  town,
} from './helpers.ts';
import { buildMapRuntime } from '../src/core/map.ts';

const FIVE_CITY_MAP = () =>
  buildMapRuntime(
    emptyMapDef({
      id: 'test-five-cities',
      cities: [
        ...mirroredCapitals(64, 64),
        town('north-west', 12, 12, 1),
        town('south-mid', 32, 52, 1),
        town('north-east', 51, 12, 2),
      ],
    }),
  );

/** Player 1 needs four of the five cities to clear an 80% majority. */
const MAJORITY = 0.8;

function ownershipOf(world: ReturnType<typeof makeWorld>): number[] {
  return world.cities.map((c) => c.owner);
}

describe('VICTORY', () => {
  it('CAPITAL_AND_MAJORITY needs both halves: majority alone is not enough', () => {
    const world = makeWorld(FIVE_CITY_MAP(), { majorityShare: MAJORITY });
    // Four of five, but the one city player 1 does not hold is the enemy capital.
    world.cities[4]!.owner = 1;
    expect(ownershipOf(world)).toEqual([1, 2, 1, 1, 1]);

    runTicks(world, seconds(10));
    expect(world.outcome).toBeNull();
    expect(world.players[2]!.alive).toBe(true);
  });

  it('CAPITAL_AND_MAJORITY needs both halves: a captured capital alone is not enough', () => {
    const world = makeWorld(FIVE_CITY_MAP(), { majorityShare: MAJORITY });
    world.cities[1]!.owner = 1;
    world.cities[2]!.owner = 2;
    world.cities[3]!.owner = 2;
    // Two of five — the enemy capital is in hand but the map is not.
    expect(ownershipOf(world)).toEqual([1, 1, 2, 2, 2]);

    runTicks(world, seconds(10));
    expect(world.outcome).toBeNull();
  });

  it('CAPITAL_AND_MAJORITY fires on the exact tick the enemy capital flips', () => {
    const world = makeWorld(FIVE_CITY_MAP(), { majorityShare: MAJORITY });
    const enemyCapital = world.cities[1]!;
    expect(enemyCapital.capital).toBe(true);
    expect(enemyCapital.owner).toBe(2);
    // Three of five before the capture, four after — the majority arrives with the
    // capital, so both halves of the condition land on the same tick.
    const before = world.cities.filter((c) => c.owner === 1).length;
    expect(before / world.cities.length).toBeLessThan(MAJORITY);
    expect((before + 1) / world.cities.length).toBeGreaterThanOrEqual(MAJORITY);

    placeLight(world, 1, enemyCapital.x, enemyCapital.y);

    let flipTick = -1;
    for (let i = 0; i < seconds(30); i++) {
      tick(world);
      if (flipTick < 0 && enemyCapital.owner === 1) flipTick = world.tick;
      // Nothing may fire while the flag is still enemy-held.
      if (enemyCapital.owner === 2) expect(world.outcome).toBeNull();
      if (world.outcome) break;
    }

    // Capture progress accumulates `dt / CAPTURE_SEC`, which is not a dyadic
    // fraction, so the last increment can land a hair under 1 and cost one tick.
    const nominal = Math.round(CAPTURE_SEC / TICK_SEC);
    expect(flipTick).toBeGreaterThanOrEqual(nominal);
    expect(flipTick).toBeLessThanOrEqual(nominal + 1);
    expect(world.outcome).not.toBeNull();
    expect(world.outcome!.reason).toBe('capital');
    expect(world.outcome!.tick).toBe(flipTick);
    expect(world.outcome!.team).toBe(world.players[1]!.team);
    expect(world.outcome!.winners).toEqual([1]);
    // The loser is still standing — this is a win on objectives, not annihilation.
    expect(world.players[2]!.alive).toBe(true);
  });

  it('ANNIHILATION waits for the last enemy unit, not the last enemy city', () => {
    const world = makeWorld(emptyMap(), { victory: VictoryMode.Annihilation });
    world.cities[1]!.owner = 0;

    const doomed = placeLight(world, 2, 100, 130);
    placeLight(world, 1, 100 - 5.5, 130);
    placeLight(world, 1, 100 + 5.5, 130);
    placeLight(world, 1, 100, 130 + 5.5);

    // Cityless but not beaten: the single unit keeps player 2 in the match.
    for (let i = 0; i < seconds(30); i++) {
      const stillThere = world.units.alive[doomed] === 1;
      tick(world);
      if (stillThere && world.units.alive[doomed] === 1) expect(world.outcome).toBeNull();
      if (world.outcome) break;
    }

    expect(armySize(world, 2)).toBe(0);
    expect(world.players[2]!.alive).toBe(false);
    expect(world.outcome).not.toBeNull();
    expect(world.outcome!.reason).toBe('annihilation');
    expect(world.outcome!.team).toBe(world.players[1]!.team);
    expect(armySize(world, 1)).toBeGreaterThan(0);
  });

  it('TIMED_SCORE stops at the time limit and awards it on score', () => {
    const limit = 5;
    const world = makeWorld(FIVE_CITY_MAP(), {
      victory: VictoryMode.TimedScore,
      timeLimitSec: limit,
    });
    placeLight(world, 1, 100, 130);
    runTicks(world, seconds(limit) + 5);

    expect(world.outcome).not.toBeNull();
    expect(world.outcome!.reason).toBe('timeout');
    expect(world.outcome!.tick).toBeGreaterThanOrEqual(seconds(limit));
    expect(world.outcome!.tick).toBeLessThanOrEqual(seconds(limit) + 1);
    expect(world.outcome!.team).toBe(world.players[1]!.team);

    // The score the mode ranked on is the one from the spec: cities, units, land.
    const s = world.stats.players[1]!;
    expect(s.score).toBeCloseTo(
      s.citiesNow * SCORE_PER_CITY + s.armyNow * SCORE_PER_UNIT + s.territory * SCORE_TERRITORY,
      6,
    );
    expect(teamScore(world, 1)).toBeGreaterThan(teamScore(world, 2));
  });

  it('TIMED_SCORE can end in a draw', () => {
    // The default fixture is a mirror image about the vertical centre line, so both
    // players hold one capital, no units, and exactly the same amount of ground.
    const limit = 5;
    const world = makeWorld(emptyMap(), {
      victory: VictoryMode.TimedScore,
      timeLimitSec: limit,
    });
    runTicks(world, seconds(limit) + 5);

    expect(world.stats.players[1]!.territory).toBe(world.stats.players[2]!.territory);
    expect(teamScore(world, 1)).toBe(teamScore(world, 2));
    expect(world.outcome).not.toBeNull();
    expect(world.outcome!.reason).toBe('draw');
    expect(world.outcome!.team).toBe(-1);
    expect(world.outcome!.winners).toEqual([]);
  });

  it('a resignation eliminates the player and hands the match over', () => {
    const world = makeWorld(emptyMap());
    runTicks(world, 2);
    tick(world, [{ t: 'resign', player: 2 }]);

    expect(world.players[2]!.alive).toBe(false);
    expect(world.outcome).not.toBeNull();
    expect(world.outcome!.team).toBe(world.players[1]!.team);
    expect(world.outcome!.reason).toBe('lastStanding');
  });
});
