/**
 * Unit production.
 *
 * Two sliders per player and an on/off switch per city, exactly as in the spec:
 * slider 1 sets how much money a city banks before it spends (max ⇒ spend as soon
 * as the unit is paid for, min ⇒ production off), slider 2 is the probability the
 * next unit comes out heavy.
 */

import { Kind } from './types.ts';
import type { World } from './types.ts';
import {
  CITY_SPAWN_COOLDOWN,
  PRODUCTION_OFF,
  SPAWN_RADIUS_FRAC,
  UNIT_COST,
  productionThreshold,
} from './balance.ts';
import { chance, randInDisc } from './rng.ts';
import { spendFromPocket } from './economy.ts';
import { allocUnit } from './units.ts';

const offset = { x: 0, y: 0 };

export function stepProduction(world: World, dt: number): void {
  for (const city of world.cities) {
    if (city.spawnCooldown > 0) city.spawnCooldown = Math.max(0, city.spawnCooldown - dt);
    if (city.owner === 0 || !city.active || city.pocket < 0) continue;

    const player = world.players[city.owner]!;
    if (player.threshold <= PRODUCTION_OFF) continue;
    if (city.spawnCooldown > 0) continue;

    if (city.queuedKind < 0) {
      city.queuedKind = chance(world.rng, player.heavyShare) ? Kind.Heavy : Kind.Light;
    }
    const kind = city.queuedKind;
    const pocket = world.influence.pockets[city.pocket];
    if (!pocket) continue;
    if (pocket.eco < productionThreshold(kind, player.threshold)) continue;
    if (!spendFromPocket(world, pocket, UNIT_COST[kind]!)) continue;

    randInDisc(world.rng, city.radius * SPAWN_RADIUS_FRAC, offset);
    const slot = allocUnit(
      world.units,
      city.owner,
      kind,
      city.x + offset.x,
      city.y + offset.y,
      world.tick,
    );
    city.queuedKind = -1;
    city.spawnCooldown = CITY_SPAWN_COOLDOWN;
    if (slot < 0) continue;

    world.stats.players[city.owner]!.produced++;
    world.events.push({
      t: 'spawn',
      x: world.units.x[slot]!,
      y: world.units.y[slot]!,
      owner: city.owner,
      kind,
    });
  }
}
