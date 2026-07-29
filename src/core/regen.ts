/**
 * Out-of-combat recovery, and the terrain attrition that goes with it.
 *
 * The load-bearing rule here is that a nearby enemy freezes HP regeneration even
 * without contact. That is what gives cycling a real cost: pulling a wounded unit
 * one step out of the melee is not enough, it has to leave the neighbourhood, and
 * while it walks it is not fighting.
 */

import { Terrain } from './types.ts';
import type { World } from './types.ts';
import { B } from './balance.ts';
import { isInsideCity, terrainAt } from './terrain.ts';
import { anyEnemyWithin, makeCellRange } from './spatial.ts';
import { applyAttrition } from './combat.ts';

const range = makeCellRange();

export function stepRegen(world: World, dt: number): void {
  const u = world.units;
  const map = world.map;

  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;

    if (terrainAt(map, u.x[i]!, u.y[i]!) === Terrain.Water) {
      applyAttrition(world, i, B.WATER_DPS * dt);
      if (!u.alive[i]) continue;
    }

    // Morale drain in combat is applied by the combat step, so anything still
    // alive and out of combat recovers morale unconditionally.
    if (u.inCombat[i]) continue;
    u.morale[i] = Math.min(1, u.morale[i]! + B.MORALE_REGEN * dt);

    if (u.hp[i]! >= 1) continue;
    const blocked = anyEnemyWithin(
      world.spatial,
      u,
      u.owner[i]!,
      u.x[i]!,
      u.y[i]!,
      B.PROXIMITY_R,
      range,
    );
    if (blocked) continue;

    const mult = isInsideCity(map, u.x[i]!, u.y[i]!) ? B.HP_REGEN_CITY_MULT : 1;
    u.hp[i] = Math.min(1, u.hp[i]! + B.HP_REGEN * dt * mult);
  }
}
