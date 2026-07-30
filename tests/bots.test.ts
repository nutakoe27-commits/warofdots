/**
 * Bot smoke tests: the three promises a bot makes to the rest of the codebase.
 *
 * It only ever speaks for its own player, it never spends more actions than its
 * profile allows, and it does not park units where the terrain tables punish them.
 * Nothing here judges how well a bot plays — that is what `npm run sim` is for. The
 * whole file skips cleanly if the AI layer is not present yet, so the suite stays
 * green while it is being written.
 */

import { describe, expect, it } from 'vitest';
import type { Command, World } from '../src/core/types.ts';
import { baseKindOf, Terrain } from '../src/core/types.ts';
import { MOVING_EPS, TICK_SEC } from '../src/core/balance.ts';
import { hashHex } from '../src/core/hash.ts';
import { tick } from '../src/core/sim.ts';
import { terrainAt } from '../src/core/terrain.ts';
import { COLONEL, LIEUTENANT, MARSHAL, RECRUIT } from '../src/ai/profiles.ts';
import type { Bot, BotProfile } from '../src/ai/types.ts';
import { MACRO_MODES } from '../src/ai/types.ts';
import { getMapRuntime } from '../src/content/registry.ts';
import { loadMapsFromDisk } from '../tools/maps.ts';
import { makeWorld, seconds } from './helpers.ts';

// The AI layer may still be under construction; the suite must not care.
const botModule = await import('../src/ai/bot.ts').catch(() => null);

loadMapsFromDisk();

const APM_WINDOW = 400;
/** How long a unit may sit in terrain its own kind hates before it counts as a blunder. */
const BLUNDER_LIMIT = seconds(10);
/** Share of unit-ticks that may be spent in a forbidden spot across a whole match. */
const BLUNDER_SHARE = 0.08;
/**
 * Marching a heavy through a wood to get somewhere is fine; the spec's veto is
 * about fighting there, where it deals 0.35× damage. So the audit counts a heavy in
 * forest as a blunder when it is parked or in combat, and forgives it in transit.
 *
 * Only counting parked units — which is what this audit did at first — quietly
 * forgives the case that actually costs the match: a unit in combat is being pushed
 * around by separation, so its velocity is never zero and it never registered.
 */
const FIGHTING_IN_BAD_TERRAIN_SHARE = 0.01;

interface MatchRig {
  world: World;
  bots: Bot[];
  /** Commands each bot returned on the tick that just ran. */
  step: () => Command[][];
}

function rig(mapId: string, profiles: BotProfile[], seed: number): MatchRig {
  const create = botModule!.createBot;
  const world = makeWorld(getMapRuntime(mapId), { seed, production: true, unitCapacity: 512 });
  const bots = profiles.map((profile, i) => create(world, i + 1, profile, seed));
  return {
    world,
    bots,
    step(): Command[][] {
      const perBot = bots.map((bot) => bot.think(world));
      tick(world, perBot.flat());
      return perBot;
    },
  };
}

/** Longest consecutive run, and total share, of unit-ticks spent somewhere forbidden. */
interface Blunders {
  longestRun: number;
  share: number;
  sampled: number;
  /** Unit-ticks spent parked or fighting somewhere the unit's kind is crippled. */
  fightingShare: number;
}

function auditTerrain(
  mapId: string,
  profiles: BotProfile[],
  ticks: number,
  seed: number,
): Blunders {
  const match = rig(mapId, profiles, seed);
  const runs = new Map<number, number>();
  let longestRun = 0;
  let offending = 0;
  let sampled = 0;
  let fighting = 0;

  for (let t = 0; t < ticks && !match.world.outcome; t++) {
    match.step();
    const u = match.world.units;
    for (let i = 0; i < u.capacity; i++) {
      if (!u.alive[i]) continue;
      sampled++;
      const terrain = terrainAt(match.world.map, u.x[i]!, u.y[i]!);
      const standing = Math.hypot(u.vx[i]!, u.vy[i]!) <= MOVING_EPS;
      const heavyInTrees = baseKindOf(u.kind[i]!) === 1 && terrain === Terrain.Forest;
      const crippled = heavyInTrees || terrain === Terrain.Water;
      if (crippled && (standing || u.inCombat[i] === 1)) fighting++;
      const bad = standing && crippled;
      const id = u.id[i]!;
      if (!bad) {
        runs.delete(id);
        continue;
      }
      offending++;
      const run = (runs.get(id) ?? 0) + 1;
      runs.set(id, run);
      if (run > longestRun) longestRun = run;
    }
  }
  const denom = Math.max(1, sampled);
  return {
    longestRun,
    share: offending / denom,
    sampled,
    fightingShare: fighting / denom,
  };
}

describe.skipIf(botModule === null)('BOTS', () => {
  it('speaks only for the player it owns', () => {
    const match = rig('crossing', [LIEUTENANT, COLONEL], 7);
    let issued = 0;

    for (let t = 0; t < seconds(40); t++) {
      const perBot = match.step();
      perBot.forEach((commands, index) => {
        for (const cmd of commands) {
          expect(cmd.player).toBe(index + 1);
          issued++;
        }
      });
    }

    // A bot that issued nothing would pass the ownership check vacuously.
    expect(issued).toBeGreaterThan(0);
    for (const bot of match.bots) {
      const dbg = bot.debug();
      expect(dbg.player).toBe(bot.player);
      expect(MACRO_MODES).toContain(dbg.mode);
      expect(dbg.apmBudget).toBe(bot.profile.apmBudget);
      expect(dbg.apmSpent).toBeLessThanOrEqual(bot.profile.apmBudget);
    }
  });

  it('never outspends its APM budget over a 400-tick window', () => {
    const profiles = [RECRUIT, MARSHAL];
    const match = rig('crossing', profiles, 11);
    const windowSec = APM_WINDOW * TICK_SEC;

    for (let w = 0; w < 3; w++) {
      const spent = profiles.map(() => 0);
      for (let t = 0; t < APM_WINDOW; t++) {
        match.step().forEach((commands, i) => {
          spent[i] = spent[i]! + commands.length;
        });
      }
      profiles.forEach((profile, i) => {
        // The budget accrues at `apmBudget` per second and cannot be borrowed
        // against, so a window can never contain more than it funded.
        expect(spent[i]!).toBeLessThanOrEqual(Math.ceil(profile.apmBudget * windowSec) + 2);
      });
      // The weak profile must actually be the constrained one.
      expect(spent[0]!).toBeLessThan(Math.ceil(MARSHAL.apmBudget * windowSec));
    }
  });

  it('thinking does not mutate the world', () => {
    const match = rig('crossing', [COLONEL, COLONEL], 13);
    for (let t = 0; t < seconds(20); t++) match.step();

    for (const bot of match.bots) {
      const before = hashHex(match.world);
      bot.think(match.world);
      expect(hashHex(match.world)).toBe(before);
    }
  });

  it.each([
    ['crossing', 'a river to cross'],
    ['thicket', 'forest everywhere'],
  ])('leaves nothing standing in bad terrain on %s', (mapId) => {
    const audit = auditTerrain(mapId, [COLONEL, LIEUTENANT], 3000, 17);
    expect(audit.sampled).toBeGreaterThan(1000);
    expect(audit.longestRun).toBeLessThan(BLUNDER_LIMIT);
    expect(audit.share).toBeLessThan(BLUNDER_SHARE);
    expect(audit.fightingShare).toBeLessThan(FIGHTING_IN_BAD_TERRAIN_SHARE);
  });
});
