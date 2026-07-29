/**
 * `tick` is the only function in the codebase that mutates a `World`.
 *
 * The phase order is fixed and matches `docs/SPEC.md` §3.2. Nothing here reads the
 * clock or the DOM: given the same world, the same command list and the same seed,
 * this produces the same world every time, on any machine.
 */

import type { Command, World } from './types.ts';
import { INFLUENCE_INTERVAL, TICK_SEC } from './balance.ts';
import { rebuildSpatial } from './spatial.ts';
import { applyCommands } from './commands.ts';
import { stepMovement } from './movement.ts';
import { stepCombat } from './combat.ts';
import { stepRegen } from './regen.ts';
import { computeInfluence, resolveInfluenceOwners, spreadPlayerField } from './influence.ts';
import { computePockets, refreshPocketUnits } from './pockets.ts';
import { stepEconomy } from './economy.ts';
import { stepCapture } from './capture.ts';
import { stepProduction } from './production.ts';
import { stepVictory } from './victory.ts';
import { sampleHistory, updateStats } from './stats.ts';

/** Ticks of the cycle spent spreading fields; the last one resolves ownership. */
const SPREAD_TICKS = INFLUENCE_INTERVAL - 1;

/**
 * The influence pass costs roughly a millisecond per player, which is too much to
 * pay in a single tick, so it is spread across the cycle: one player's field per
 * tick, ownership and pockets resolved on the last tick. Pocket *membership* is
 * still refreshed every tick — a recycled unit slot must never inherit the dead
 * unit's pocket (ADR-009).
 *
 * The schedule is fixed, so this costs nothing in determinism.
 */
function influenceSchedule(world: World): void {
  const inf = world.influence;
  if (inf.lastTick < 0) {
    computeInfluence(world);
    computePockets(world);
    return;
  }
  const cycle = world.tick % INFLUENCE_INTERVAL;
  if (cycle === SPREAD_TICKS) {
    resolveInfluenceOwners(world);
    computePockets(world);
    return;
  }
  for (let p = cycle + 1; p <= world.map.playerCount; p += SPREAD_TICKS) {
    spreadPlayerField(world, p);
  }
  refreshPocketUnits(world);
}

export function tick(world: World, commands: readonly Command[] = []): void {
  if (world.outcome) return;
  world.events.length = 0;
  world.tick++;
  const dt = TICK_SEC;

  rebuildSpatial(world.spatial, world.units);
  applyCommands(world, commands);
  stepMovement(world, dt);

  // Combat and regeneration both need contact-accurate buckets, so the hash is
  // rebuilt once movement has settled.
  rebuildSpatial(world.spatial, world.units);
  stepCombat(world, dt);
  stepRegen(world, dt);

  influenceSchedule(world);

  stepEconomy(world, dt);
  stepCapture(world, dt);
  stepProduction(world, dt);

  updateStats(world);
  sampleHistory(world);
  stepVictory(world);
}

/** Runs `n` ticks with no commands. Used by tests, the bench and the headless tuner. */
export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n && !world.outcome; i++) tick(world);
}

export function elapsedSeconds(world: World): number {
  return world.tick * TICK_SEC;
}
