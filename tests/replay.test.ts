/**
 * Replay round-trip.
 *
 * A replay is a seed plus a command log, which only works because `tick` is
 * deterministic. So this is the test that closes the loop on the whole design: run
 * a match with live bots, recording as it goes, then rebuild the world from the log
 * alone and check that the two agree bit for bit at every step of the way.
 *
 * Checking intermediate hashes rather than only the final one matters — a replay
 * that diverges at tick 300 and happens to reconverge by tick 3000 is still broken,
 * and would look fine to an end-state comparison.
 */

import { describe, expect, it } from 'vitest';

import { hashHex } from '../src/core/hash.ts';
import { VictoryMode } from '../src/core/types.ts';
import type { MatchSettings } from '../src/core/types.ts';
import { createWorld } from '../src/core/world.ts';
import type { PlayerSetup } from '../src/core/world.ts';
import { getMapRuntime } from '../src/content/registry.ts';
import { loadMapsFromDisk } from '../tools/maps.ts';
import { createSession } from '../src/game/session.ts';
import type { ReplayPlayer } from '../src/game/replay.ts';
import {
  parseReplay,
  replayCommandCount,
  serializeReplay,
  REPLAY_VERSION,
} from '../src/game/replay.ts';
import { COLONEL, LIEUTENANT } from '../src/ai/profiles.ts';

loadMapsFromDisk();

const MAP_ID = 'crossing';
const SEED = 90210;
const TICKS = 900;
/** Ticks at which both runs must already agree, not just at the end. */
const CHECKPOINTS = [1, 5, 60, 200, 450, 700, TICKS];

function settings(): MatchSettings {
  return {
    seed: SEED,
    victory: VictoryMode.CapitalAndMajority,
    timeLimitSec: 3600,
    majorityShare: 0.8,
    starveStrategy: 'healthiestFirst',
  };
}

const PROFILES = [COLONEL, LIEUTENANT];

function playerSetups(): PlayerSetup[] {
  return PROFILES.map((profile, i) => ({
    kind: 'bot' as const,
    team: i + 1,
    name: profile.name,
    colorIndex: i,
    ecoHandicap: 1,
  }));
}

function replayPlayers(): ReplayPlayer[] {
  return PROFILES.map((profile, i) => ({
    kind: 'bot' as const,
    team: i + 1,
    name: profile.name,
    colorIndex: i,
    profileId: profile.id,
    ecoHandicap: 1,
  }));
}

/** Plays a live match with bots, returning the log and a hash at each checkpoint. */
function record(): { json: string; hashes: Map<number, string>; ticks: number } {
  const world = createWorld({
    map: getMapRuntime(MAP_ID),
    players: playerSetups(),
    settings: settings(),
  });
  const session = createSession({
    world,
    mapId: MAP_ID,
    bots: PROFILES.map((profile, i) => ({ player: i + 1, profile })),
    viewer: 0,
    replayPlayers: replayPlayers(),
  });

  const hashes = new Map<number, string>();
  while (world.tick < TICKS && world.outcome === null) {
    session.advance();
    if (CHECKPOINTS.includes(world.tick)) hashes.set(world.tick, hashHex(world));
  }
  return { json: serializeReplay(session.replay), hashes, ticks: world.tick };
}

/** Replays a log with no bots attached, hashing at the same checkpoints. */
function playback(json: string, until: number): Map<number, string> {
  const log = parseReplay(json);
  const world = createWorld({
    map: getMapRuntime(log.mapId),
    players: log.players.map((p, i) => ({
      kind: 'bot' as const,
      team: p.team,
      name: p.name,
      colorIndex: p.colorIndex ?? i,
      ecoHandicap: p.ecoHandicap,
    })),
    settings: log.settings,
  });
  const session = createSession({
    world,
    mapId: log.mapId,
    bots: [],
    viewer: 0,
    replayPlayers: log.players,
    playback: log,
  });

  const hashes = new Map<number, string>();
  while (world.tick < until && world.outcome === null) {
    session.advance();
    if (CHECKPOINTS.includes(world.tick)) hashes.set(world.tick, hashHex(world));
  }
  return hashes;
}

describe('REPLAY', () => {
  const live = record();

  it('records something worth replaying', () => {
    expect(live.ticks).toBe(TICKS);
    // A bot match that issued no orders would make the rest of this vacuous.
    expect(replayCommandCount(parseReplay(live.json))).toBeGreaterThan(20);
    expect(live.hashes.size).toBe(CHECKPOINTS.length);
  });

  it('reproduces the match from the log alone, tick for tick', () => {
    const again = playback(live.json, TICKS);
    for (const tick of CHECKPOINTS) {
      expect(again.get(tick), `tick ${tick}`).toBe(live.hashes.get(tick));
    }
  });

  it('replays identically twice, so playback itself carries no state', () => {
    expect([...playback(live.json, TICKS)]).toEqual([...playback(live.json, TICKS)]);
  });

  it('survives a serialise/parse round trip unchanged', () => {
    const parsed = parseReplay(live.json);
    expect(parsed.version).toBe(REPLAY_VERSION);
    expect(parsed.mapId).toBe(MAP_ID);
    expect(parsed.settings.seed).toBe(SEED);
    // Re-serialising has to be byte-stable, or a saved replay would drift on reload.
    expect(serializeReplay(parsed)).toBe(live.json);
  });

  it('records the balance overrides a match was played under', () => {
    // Without them a replay of a match played with the debug sliders dragged would
    // silently diverge (ADR-017).
    const parsed = parseReplay(live.json);
    expect(parsed.balance.HEALTH_EXP).toBeTypeOf('number');
    expect(parsed.balance.ENCIRCLED_DPS).toBeTypeOf('number');
  });

  it('rejects a log from an incompatible version', () => {
    const bumped = JSON.stringify({ ...parseReplay(live.json), version: REPLAY_VERSION + 1 });
    expect(() => parseReplay(bumped)).toThrow(/version/);
  });
});
