/**
 * Difficulty profiles, straight from `docs/SPEC.md` §5.3.
 *
 * The dials that matter are APM and reaction delay: a weak bot is not a bot that
 * plays badly on purpose, it is a bot that cannot physically micro its whole army.
 * `cycleHpThreshold` encodes the classic beginner mistake — holding wounded units
 * in the line far too long — as a number rather than as randomness.
 */

import type { BotProfile } from './types.ts';

export const RECRUIT: BotProfile = {
  id: 'recruit',
  name: 'Новобранец',
  apmBudget: 8,
  reactionDelayMs: 900,
  perceptionNoise: 0.45,
  cycleHpThreshold: 0.3,
  aggression: 0.35,
  planHorizonSec: 20,
  usesEncirclement: false,
  usesTerrain: false,
  ecoEfficiency: 0.45,
  mistakeRate: 0.35,
  ecoHandicap: 1,
};

export const LIEUTENANT: BotProfile = {
  id: 'lieutenant',
  name: 'Лейтенант',
  apmBudget: 20,
  reactionDelayMs: 550,
  perceptionNoise: 0.3,
  cycleHpThreshold: 0.5,
  aggression: 0.45,
  planHorizonSec: 30,
  usesEncirclement: false,
  usesTerrain: true,
  ecoEfficiency: 0.65,
  mistakeRate: 0.2,
  ecoHandicap: 1,
};

export const COLONEL: BotProfile = {
  id: 'colonel',
  name: 'Полковник',
  apmBudget: 45,
  reactionDelayMs: 300,
  perceptionNoise: 0.18,
  cycleHpThreshold: 0.7,
  aggression: 0.55,
  planHorizonSec: 45,
  usesEncirclement: true,
  usesTerrain: true,
  ecoEfficiency: 0.82,
  mistakeRate: 0.1,
  ecoHandicap: 1,
};

export const GENERAL: BotProfile = {
  id: 'general',
  name: 'Генерал',
  apmBudget: 90,
  reactionDelayMs: 150,
  perceptionNoise: 0.08,
  cycleHpThreshold: 0.82,
  aggression: 0.62,
  planHorizonSec: 60,
  usesEncirclement: true,
  usesTerrain: true,
  ecoEfficiency: 0.93,
  mistakeRate: 0.03,
  ecoHandicap: 1,
};

export const MARSHAL: BotProfile = {
  id: 'marshal',
  name: 'Маршал',
  apmBudget: 160,
  reactionDelayMs: 80,
  perceptionNoise: 0.03,
  cycleHpThreshold: 0.85,
  aggression: 0.7,
  planHorizonSec: 90,
  usesEncirclement: true,
  usesTerrain: true,
  ecoEfficiency: 1,
  mistakeRate: 0,
  ecoHandicap: 1,
};

export const BOT_PROFILES: readonly BotProfile[] = [
  RECRUIT,
  LIEUTENANT,
  COLONEL,
  GENERAL,
  MARSHAL,
];

export function profileById(id: string): BotProfile {
  const found = BOT_PROFILES.find((p) => p.id === id);
  if (!found) {
    throw new Error(`unknown bot profile "${id}". Known: ${BOT_PROFILES.map((p) => p.id).join(', ')}`);
  }
  return found;
}

/**
 * The optional Marshal economic handicap. Off by default and never hidden: the
 * caller has to ask for it, and the setup screen labels the match when it is on.
 */
export const MARSHAL_HANDICAP = 1.15;

export function withHandicap(profile: BotProfile, enabled: boolean): BotProfile {
  if (!enabled || profile.id !== MARSHAL.id) return profile;
  return { ...profile, ecoHandicap: MARSHAL_HANDICAP };
}
