/**
 * Replays.
 *
 * A match is fully described by its seed, its setup and the command log, because
 * `tick()` is deterministic. So a replay is a few kilobytes of JSON rather than a
 * recording of state, and "watch the replay" and "verify the simulation is still
 * deterministic" are the same operation.
 *
 * Balance overrides are recorded alongside the seed: a match played with the debug
 * sliders dragged is only reproducible if we know where they were.
 */

import type { Command, MatchSettings, PlayerKind } from '../core/types.ts';
import type { BalanceOverrides } from '../core/balance.ts';
import { B } from '../core/balance.ts';

export const REPLAY_VERSION = 1;

export interface ReplayPlayer {
  kind: PlayerKind;
  team: number;
  name: string;
  colorIndex: number;
  profileId: string | null;
  ecoHandicap: number;
}

export interface ReplayFrame {
  tick: number;
  cmds: Command[];
}

export interface ReplayLog {
  version: number;
  mapId: string;
  settings: MatchSettings;
  players: ReplayPlayer[];
  balance: BalanceOverrides;
  /** Only ticks that carried commands are stored. */
  frames: ReplayFrame[];
  /** Tick the recording ends on, so playback knows when it is finished. */
  lastTick: number;
}

export function createReplay(
  mapId: string,
  settings: MatchSettings,
  players: ReplayPlayer[],
): ReplayLog {
  return {
    version: REPLAY_VERSION,
    mapId,
    settings: { ...settings },
    players: players.map((p) => ({ ...p })),
    balance: JSON.parse(JSON.stringify(B)),
    frames: [],
    lastTick: 0,
  };
}

export function recordCommands(log: ReplayLog, tick: number, cmds: readonly Command[]): void {
  log.lastTick = tick;
  if (cmds.length === 0) return;
  log.frames.push({ tick, cmds: cmds.map((c) => ({ ...c })) as Command[] });
}

/** Index of commands by tick, for playback. Built once when a replay is loaded. */
export function indexReplay(log: ReplayLog): Map<number, Command[]> {
  const byTick = new Map<number, Command[]>();
  for (const frame of log.frames) {
    const existing = byTick.get(frame.tick);
    if (existing) existing.push(...frame.cmds);
    else byTick.set(frame.tick, frame.cmds.slice());
  }
  return byTick;
}

export function serializeReplay(log: ReplayLog): string {
  return JSON.stringify(log);
}

export function parseReplay(json: string): ReplayLog {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('replay is not an object');
  const log = parsed as ReplayLog;
  if (log.version !== REPLAY_VERSION) {
    throw new Error(`replay version ${log.version} is not supported (expected ${REPLAY_VERSION})`);
  }
  for (const field of ['mapId', 'settings', 'players', 'frames'] as const) {
    if (log[field] === undefined) throw new Error(`replay is missing "${field}"`);
  }
  return log;
}

/** Total command count, for the replay UI. */
export function replayCommandCount(log: ReplayLog): number {
  let n = 0;
  for (const frame of log.frames) n += frame.cmds.length;
  return n;
}
