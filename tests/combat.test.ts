/**
 * Contact combat: the attack-surface rule, terrain, and the damage formula.
 *
 * Every fixture in here is arranged so that nothing moves. Contact starts at the
 * sum of the contact radii and separation starts at the sum of the draw radii, and
 * the second is smaller than the first, so there is a narrow band of distances at
 * which two units fight without pushing each other. Sitting in that band makes the
 * fights fully analytic: velocities stay zero, so the moving penalty never fires
 * and positions never drift, and an assertion can be written to five decimals.
 */

import { describe, expect, it } from 'vitest';
import { Kind, Terrain } from '../src/core/types.ts';
import {
  BASE_DAMAGE,
  HEALTH_EXP,
  MAX_HP,
  MORALE_DRAIN,
  MORALE_FLOOR,
  MOVING_EPS,
  MOVING_PENALTY,
  TERRAIN_DAMAGE,
  TICK_SEC,
  UNIT_COST,
} from '../src/core/balance.ts';
import { damagePerSec, healthFactor, moraleFactor } from '../src/core/combat.ts';
import { armySize } from '../src/core/units.ts';
import { tick } from '../src/core/sim.ts';
import {
  attritionThisTick,
  emptyMap,
  makeWorld,
  placeHeavy,
  placeLight,
  runTicks,
  seconds,
  slotsOf,
  totalHp,
} from './helpers.ts';

/** Inside player 1's territory but clear of the city radius, on both fixtures. */
const FIELD_X = 100;
const FIELD_Y = 130;

/** Light–light: contact at 6.0, separation at 5.2. Both gaps sit safely between. */
const LIGHT_RANK_GAP = 5.25;
const LIGHT_LINE_GAP = 5;
/** Heavy–light: contact at 6.6, separation at 5.8. */
const HEAVY_REACH = 6.25;
/** Light–light, exactly equal for three attackers so the id tie-break decides. */
const SURROUND_R = 5.5;

const FOREST_RECT = { terrain: 'FOREST' as const, x: 20, y: 24, w: 12, h: 16 };

function fightToTheEnd(world: ReturnType<typeof makeWorld>, cap = seconds(60)): number {
  for (let i = 0; i < cap; i++) {
    tick(world);
    if (armySize(world, 1) === 0 || armySize(world, 2) === 0) return i + 1;
  }
  throw new Error('fight did not resolve');
}

describe('COMBAT', () => {
  it('three lights beat two lights on plains and lose less HP than they destroy', () => {
    const world = makeWorld(emptyMap());
    // Two ranks facing each other. Each of mine touches one or both of theirs; the
    // flanks touch one, so the pair can only ever answer two of the three.
    placeLight(world, 1, FIELD_X, FIELD_Y - LIGHT_RANK_GAP);
    placeLight(world, 1, FIELD_X, FIELD_Y);
    placeLight(world, 1, FIELD_X, FIELD_Y + LIGHT_RANK_GAP);
    placeLight(world, 2, FIELD_X + LIGHT_LINE_GAP, FIELD_Y - LIGHT_RANK_GAP / 2);
    placeLight(world, 2, FIELD_X + LIGHT_LINE_GAP, FIELD_Y + LIGHT_RANK_GAP / 2);

    fightToTheEnd(world);

    expect(armySize(world, 2)).toBe(0);
    expect(armySize(world, 1)).toBe(3);

    // Everything the trio spent, measured in the same units as the pool it emptied.
    const destroyed = 2 * MAX_HP[Kind.Light]!;
    const spent = (3 - totalHp(world, 1)) * MAX_HP[Kind.Light]!;
    expect(spent).toBeGreaterThan(0.3);
    expect(spent).toBeLessThan(destroyed);

    // The one-target rule at work: the third unit in the trio is answered by nobody.
    const untouched = slotsOf(world, 1).filter((s) => world.units.hp[s]! >= 1);
    expect(untouched.length).toBe(1);
    for (const s of slotsOf(world, 1)) expect(world.units.morale[s]!).toBeLessThan(1);
  });

  it('a heavy is worth its cost in lights on plains and worthless in forest', () => {
    const lights = UNIT_COST[Kind.Heavy]! / UNIT_COST[Kind.Light]!;
    expect(lights).toBe(2);

    const onPlains = makeWorld(emptyMap());
    placeHeavy(onPlains, 1, FIELD_X, FIELD_Y);
    placeLight(onPlains, 2, FIELD_X, FIELD_Y - HEAVY_REACH);
    placeLight(onPlains, 2, FIELD_X, FIELD_Y + HEAVY_REACH);
    fightToTheEnd(onPlains);
    expect(armySize(onPlains, 2)).toBe(0);
    expect(armySize(onPlains, 1)).toBe(1);
    const survivor = slotsOf(onPlains, 1)[0]!;
    expect(onPlains.units.hp[survivor]!).toBeGreaterThan(0.05);
    expect(onPlains.units.hp[survivor]!).toBeLessThan(0.6);

    const inForest = makeWorld(emptyMap({ id: 'test-forest', rects: [FOREST_RECT] }));
    expect(inForest.map.terrain[((FIELD_Y / 4) | 0) * inForest.map.w + ((FIELD_X / 4) | 0)]).toBe(
      Terrain.Forest,
    );
    placeHeavy(inForest, 1, FIELD_X, FIELD_Y);
    placeLight(inForest, 2, FIELD_X, FIELD_Y - HEAVY_REACH);
    placeLight(inForest, 2, FIELD_X, FIELD_Y + HEAVY_REACH);
    fightToTheEnd(inForest);
    expect(armySize(inForest, 1)).toBe(0);
    expect(armySize(inForest, 2)).toBe(lights);

    // The mechanism, stated directly: in forest a heavy hits softer than a light.
    const check = makeWorld(emptyMap({ id: 'test-forest-2', rects: [FOREST_RECT] }));
    const heavy = placeHeavy(check, 1, FIELD_X, FIELD_Y);
    const light = placeLight(check, 1, FIELD_X + 20, FIELD_Y);
    expect(damagePerSec(check, heavy)).toBeLessThan(damagePerSec(check, light));
  });

  it('three attackers deal 3× to one defender while the defender answers exactly one', () => {
    const world = makeWorld(emptyMap());
    const defender = placeLight(world, 2, FIELD_X, FIELD_Y);
    const attackers = [
      placeLight(world, 1, FIELD_X + SURROUND_R, FIELD_Y),
      placeLight(world, 1, FIELD_X - SURROUND_R, FIELD_Y),
      placeLight(world, 1, FIELD_X, FIELD_Y + SURROUND_R),
    ];

    const u = world.units;
    const perAttacker = damagePerSec(world, attackers[0]!);
    const incoming = attackers.reduce((sum, s) => sum + damagePerSec(world, s), 0);
    const outgoing = damagePerSec(world, defender);
    expect(perAttacker).toBeCloseTo(BASE_DAMAGE[Kind.Light]!, 10);
    expect(incoming).toBeCloseTo(3 * perAttacker, 10);

    tick(world);

    // The defender absorbs all three; nothing is shared out or averaged away.
    const defenderDrop =
      (incoming * TICK_SEC) / MAX_HP[Kind.Light]! + attritionThisTick(world, defender);
    expect(u.hp[defender]!).toBeCloseTo(1 - defenderDrop, 5);
    expect(u.target[defender]!).toBeGreaterThanOrEqual(0);

    const hurt = attackers.filter((s) => u.hp[s]! < 1);
    expect(hurt.length).toBe(1);
    // Equal distances, so the tie falls to the lowest unit id — the first one placed.
    expect(u.id[hurt[0]!]!).toBe(Math.min(...attackers.map((s) => u.id[s]!)));
    const attackerDrop =
      (outgoing * TICK_SEC) / MAX_HP[Kind.Light]! + attritionThisTick(world, hurt[0]!);
    expect(u.hp[hurt[0]!]!).toBeCloseTo(1 - attackerDrop, 5);
    for (const s of attackers) {
      if (s === hurt[0]) continue;
      expect(u.hp[s]!).toBe(1);
      expect(u.inCombat[s]!).toBe(1);
    }
  });

  it('damagePerSec follows the spec formula for hp, morale, terrain and movement', () => {
    const world = makeWorld(emptyMap({ id: 'test-damage', rects: [FOREST_RECT] }));
    const u = world.units;
    const onPlains = placeLight(world, 1, 60, 60);
    const inForest = placeHeavy(world, 1, FIELD_X, FIELD_Y);

    expect(healthFactor(0.25)).toBeCloseTo(Math.pow(0.25, HEALTH_EXP), 10);
    expect(moraleFactor(0)).toBeCloseTo(MORALE_FLOOR, 10);
    expect(moraleFactor(1)).toBeCloseTo(1, 10);
    expect(moraleFactor(0.5)).toBeCloseTo(MORALE_FLOOR + (1 - MORALE_FLOOR) * 0.5, 10);

    const light = BASE_DAMAGE[Kind.Light]!;
    expect(damagePerSec(world, onPlains)).toBeCloseTo(light, 10);

    u.hp[onPlains] = 0.25;
    expect(damagePerSec(world, onPlains)).toBeCloseTo(light * Math.pow(0.25, HEALTH_EXP), 6);

    u.morale[onPlains] = 0;
    expect(damagePerSec(world, onPlains)).toBeCloseTo(
      light * Math.pow(0.25, HEALTH_EXP) * MORALE_FLOOR,
      6,
    );

    u.hp[onPlains] = 1;
    u.morale[onPlains] = 1;
    u.vx[onPlains] = MOVING_EPS * 0.5;
    expect(damagePerSec(world, onPlains)).toBeCloseTo(light, 6);
    u.vx[onPlains] = MOVING_EPS + 1;
    expect(damagePerSec(world, onPlains)).toBeCloseTo(light * MOVING_PENALTY, 6);

    const heavyInForest = BASE_DAMAGE[Kind.Heavy]! * TERRAIN_DAMAGE[Terrain.Forest]![Kind.Heavy]!;
    expect(damagePerSec(world, inForest)).toBeCloseTo(heavyInForest, 6);
    u.hp[inForest] = 0.64;
    u.morale[inForest] = 0.5;
    expect(damagePerSec(world, inForest)).toBeCloseTo(
      heavyInForest * Math.pow(0.64, HEALTH_EXP) * (MORALE_FLOOR + (1 - MORALE_FLOOR) * 0.5),
      6,
    );
  });

  it('morale drains at MORALE_DRAIN while in contact', () => {
    const world = makeWorld(emptyMap());
    const mine = placeLight(world, 1, FIELD_X, FIELD_Y);
    placeLight(world, 2, FIELD_X + LIGHT_RANK_GAP, FIELD_Y);

    // Short window on purpose: an even light-on-light duel is over inside two
    // seconds, and a dead unit has no morale to measure.
    const ticks = seconds(0.5);
    runTicks(world, ticks);
    expect(world.units.alive[mine]!).toBe(1);
    expect(world.units.inCombat[mine]!).toBe(1);
    expect(world.units.morale[mine]!).toBeCloseTo(1 - MORALE_DRAIN * TICK_SEC * ticks, 4);
  });
});
