/**
 * Match setup: from a configuration the menu produced to a running `MatchSession`.
 *
 * This is the one place that knows how a roster maps onto a map. It is deliberately
 * forgiving — a map wants exactly as many players as it has capitals, so a roster
 * that is short is padded and one that is long is truncated rather than throwing a
 * validation error at the user after they pressed Start.
 */

import type { MatchSettings, PlayerKind, VictoryModeId } from '../core/types.ts';
import { VictoryMode } from '../core/types.ts';
import { createWorld } from '../core/world.ts';
import type { PlayerSetup } from '../core/world.ts';
import { getMapDef } from '../content/registry.ts';
import { buildMapForBrowser } from '../content/maps.browser.ts';
import { BOT_PROFILES, LIEUTENANT, profileById, withHandicap } from '../ai/profiles.ts';
import type { BotProfile } from '../ai/types.ts';
import { PLAYER_NAMES } from '../render/theme.ts';
import { createSession } from './session.ts';
import type { BotSlot, MatchSession } from './session.ts';
import type { ReplayLog, ReplayPlayer } from './replay.ts';

export interface MatchSlot {
  kind: 'human' | 'bot' | 'off';
  profileId: string;
  team: number;
}

export interface MatchSetup {
  mapId: string;
  seed: number;
  victory: VictoryModeId;
  timeLimitSec: number;
  slots: MatchSlot[];
  marshalHandicap: boolean;
}

export function defaultSetup(mapId: string): MatchSetup {
  return {
    mapId,
    seed: 1,
    victory: VictoryMode.CapitalAndMajority,
    timeLimitSec: 900,
    slots: [
      { kind: 'human', profileId: LIEUTENANT.id, team: 1 },
      { kind: 'bot', profileId: LIEUTENANT.id, team: 2 },
    ],
    marshalHandicap: false,
  };
}

/** Trims or pads the roster to exactly the number of players the map expects. */
function normaliseSlots(slots: MatchSlot[], playerCount: number): MatchSlot[] {
  const active = slots.filter((s) => s.kind !== 'off').slice(0, playerCount);
  let nextTeam = active.reduce((max, s) => Math.max(max, s.team), 0) + 1;
  while (active.length < playerCount) {
    active.push({ kind: 'bot', profileId: LIEUTENANT.id, team: nextTeam++ });
  }
  return active;
}

function resolveProfile(slot: MatchSlot, handicap: boolean): BotProfile {
  const base = BOT_PROFILES.some((p) => p.id === slot.profileId)
    ? profileById(slot.profileId)
    : LIEUTENANT;
  return withHandicap(base, handicap);
}

export async function createMatch(setup: MatchSetup): Promise<MatchSession> {
  const def = getMapDef(setup.mapId);
  const map = await buildMapForBrowser(def);
  const slots = normaliseSlots(setup.slots, def.players);

  const settings: MatchSettings = {
    seed: setup.seed >>> 0,
    victory: setup.victory,
    timeLimitSec: setup.timeLimitSec,
    majorityShare: 0.8,
    starveStrategy: 'healthiestFirst',
  };

  const players: PlayerSetup[] = [];
  const bots: BotSlot[] = [];
  const replayPlayers: ReplayPlayer[] = [];
  let viewer = 0;

  slots.forEach((slot, i) => {
    const player = i + 1;
    const kind: PlayerKind = slot.kind === 'human' ? 'human' : 'bot';
    const profile = resolveProfile(slot, setup.marshalHandicap);
    const name = kind === 'human' ? 'Вы' : `${profile.name} (${PLAYER_NAMES[i] ?? player})`;

    players.push({
      kind,
      team: slot.team,
      name,
      colorIndex: i,
      ecoHandicap: kind === 'bot' ? profile.ecoHandicap : 1,
    });
    if (kind === 'bot') bots.push({ player, profile });
    else if (viewer === 0) viewer = player;
    replayPlayers.push({
      kind,
      team: slot.team,
      name,
      colorIndex: i,
      profileId: kind === 'bot' ? profile.id : null,
      ecoHandicap: kind === 'bot' ? profile.ecoHandicap : 1,
    });
  });

  const world = createWorld({ map, players, settings });
  return createSession({ world, mapId: setup.mapId, bots, viewer, replayPlayers });
}

/** Rebuilds a match from a replay log and drives it from the recorded commands. */
export async function openReplay(log: ReplayLog): Promise<MatchSession> {
  const def = getMapDef(log.mapId);
  const map = await buildMapForBrowser(def);
  const players: PlayerSetup[] = log.players.map((p, i) => ({
    kind: p.kind === 'neutral' ? 'bot' : p.kind,
    team: p.team,
    name: p.name,
    colorIndex: p.colorIndex ?? i,
    ecoHandicap: p.ecoHandicap,
  }));
  const world = createWorld({ map, players, settings: log.settings });
  const viewer = log.players.findIndex((p) => p.kind === 'human') + 1;
  return createSession({
    world,
    mapId: log.mapId,
    bots: [],
    viewer,
    replayPlayers: log.players,
    playback: log,
  });
}

/** The roster the setup screen offers for a given map. */
export function slotsForMap(mapId: string): MatchSlot[] {
  const def = getMapDef(mapId);
  const slots: MatchSlot[] = [{ kind: 'human', profileId: LIEUTENANT.id, team: 1 }];
  for (let i = 1; i < def.players; i++) {
    slots.push({ kind: 'bot', profileId: LIEUTENANT.id, team: i + 1 });
  }
  return slots;
}
