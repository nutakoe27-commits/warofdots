/**
 * A match in progress: the world, its bots, the pending command queue and the
 * replay log.
 *
 * Player input and bot output are merged into one command list and handed to
 * `tick()` together, so nothing has a privileged path into the simulation. That is
 * also what makes replay playback identical to live play: swap the command source
 * and the same code runs.
 */

import type { Command, World } from '../core/types.ts';
import { tick } from '../core/sim.ts';
import { hashWorld } from '../core/hash.ts';
import type { Bot, BotProfile } from '../ai/types.ts';
import { createBot } from '../ai/bot.ts';
import { createReplay, indexReplay, recordCommands } from './replay.ts';
import type { ReplayLog, ReplayPlayer } from './replay.ts';

export interface BotSlot {
  player: number;
  profile: BotProfile;
}

export interface SessionOptions {
  world: World;
  mapId: string;
  bots: BotSlot[];
  /** Player whose HUD is shown. 0 means observer (bot-vs-bot). */
  viewer: number;
  replayPlayers: ReplayPlayer[];
  /** When set, commands come from this log instead of from bots and input. */
  playback?: ReplayLog;
}

export interface MatchSession {
  readonly world: World;
  readonly viewer: number;
  readonly bots: readonly Bot[];
  readonly replay: ReplayLog;
  readonly isPlayback: boolean;
  /** Simulation cost of the most recent `advance()`, in milliseconds. */
  lastSimMs: number;
  /** Queues a command from the local player for the next tick. */
  queue(cmd: Command): void;
  /** Advances exactly one tick. */
  advance(): void;
  /** True once the world has an outcome, or playback has run out of log. */
  finished(): boolean;
  hash(): number;
}

export function createSession(opts: SessionOptions): MatchSession {
  const world = opts.world;
  const bots: Bot[] = opts.playback
    ? []
    : opts.bots.map((slot) =>
        createBot(world, slot.player, slot.profile, world.settings.seed ^ (slot.player * 2654435761)),
      );

  const pending: Command[] = [];
  const merged: Command[] = [];
  const replay = opts.playback ?? createReplay(opts.mapId, world.settings, opts.replayPlayers);
  const playbackIndex = opts.playback ? indexReplay(opts.playback) : null;

  const session: MatchSession = {
    world,
    viewer: opts.viewer,
    bots,
    replay,
    isPlayback: playbackIndex !== null,
    lastSimMs: 0,

    queue(cmd: Command): void {
      if (playbackIndex) return;
      pending.push(cmd);
    },

    advance(): void {
      const started = performance.now();
      merged.length = 0;

      if (playbackIndex) {
        const cmds = playbackIndex.get(world.tick + 1);
        if (cmds) merged.push(...cmds);
      } else {
        merged.push(...pending);
        pending.length = 0;
        for (const bot of bots) {
          const cmds = bot.think(world);
          for (const cmd of cmds) merged.push(cmd);
        }
        recordCommands(replay, world.tick + 1, merged);
      }

      tick(world, merged);
      session.lastSimMs = performance.now() - started;
    },

    finished(): boolean {
      if (world.outcome !== null) return true;
      return playbackIndex !== null && world.tick >= replay.lastTick;
    },

    hash(): number {
      return hashWorld(world);
    },
  };
  return session;
}
