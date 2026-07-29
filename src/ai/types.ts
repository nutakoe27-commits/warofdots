/**
 * The bot's vocabulary.
 *
 * `StrategicView` is the seam of the whole AI: perception folds the world into it,
 * strategy picks a macro mode from it, and operations plans against it. Nothing
 * below the perception layer is allowed to read the `World` directly for anything
 * it could have got from the view — that is what keeps the bot honest, because the
 * view is built with the profile's perception noise already baked in.
 */

import type { Command, World } from '../core/types.ts';

// ────────────────────────────────────────────────────────────── macro modes ──

export const MacroMode = {
  Expand: 'EXPAND',
  Defend: 'DEFEND',
  Pressure: 'PRESSURE',
  Push: 'PUSH',
  Encircle: 'ENCIRCLE',
  Snipe: 'SNIPE',
} as const;
export type MacroModeId = (typeof MacroMode)[keyof typeof MacroMode];
export const MACRO_MODES: MacroModeId[] = Object.values(MacroMode);

// ─────────────────────────────────────────────────────────── strategic view ──

export interface CityView {
  index: number;
  id: string;
  owner: number;
  x: number;
  y: number;
  capital: boolean;
  /** How much this city is worth taking or holding right now. */
  value: number;
  /** Estimated enemy strength that can reach it. */
  threat: number;
  myPressure: number;
  enemyPressure: number;
  /** Friendly units currently standing inside it. */
  garrison: number;
  /** True when taking this city would cut the enemy's territory in two. */
  cutsEnemy: boolean;
}

/** A cluster of contact between this bot and an enemy. */
export interface Front {
  id: number;
  x: number;
  y: number;
  /** Unit ids, not slots — a front outlives the tick it was found on. */
  myUnits: number[];
  enemyUnits: number[];
  myStrength: number;
  enemyStrength: number;
  /** `myStrength / (myStrength + enemyStrength)`, 0..1. */
  ratio: number;
  /** Terrain that dominates the front, as a terrain id. */
  terrain: number;
  /** True when heavies can fight here at full effect (plains/sand). */
  heavyFriendly: boolean;
  /** Nearest own city index, or -1. */
  nearestCity: number;
  priority: number;
}

export interface ArmyView {
  light: number;
  heavy: number;
  avgHp: number;
  avgMorale: number;
  strength: number;
  supplyCap: number;
  supplyUsed: number;
  supplyHeadroom: number;
}

export interface EnemyArmyView {
  estLight: number;
  estHeavy: number;
  estStrength: number;
}

export interface StrategicView {
  tick: number;
  me: number;
  team: number;
  allies: number[];
  enemies: number[];
  cities: CityView[];
  fronts: Front[];
  myArmy: ArmyView;
  enemyArmy: EnemyArmyView;
  ecoRate: number;
  eco: number;
  territoryShare: number;
  /** Fraction of the map that is forest or hills. Drives the heavy/light mix. */
  roughShare: number;
  /** Coarse cell whose loss would cut the enemy off from their cities, or -1. */
  cutCell: number;
  /** True when one of my capitals is under direct threat. */
  capitalThreatened: boolean;
}

// ────────────────────────────────────────────────────────────────── groups ──

export const GroupRole = {
  Frontline: 'frontline',
  Reserve: 'reserve',
  Garrison: 'garrison',
  Raid: 'raid',
  Escort: 'escort',
} as const;
export type GroupRoleId = (typeof GroupRole)[keyof typeof GroupRole];

export interface Assignment {
  unitId: number;
  role: GroupRoleId;
  /** Front this unit belongs to, or -1. */
  front: number;
  /** City this unit is garrisoning or raiding, or -1. */
  city: number;
  /** Where operations wants the unit. Tactics may override within its budget. */
  targetX: number;
  targetY: number;
  /** Tick the assignment was made, so tactics can avoid re-ordering constantly. */
  since: number;
}

// ───────────────────────────────────────────────────────────────── profiles ──

export interface BotProfile {
  id: string;
  name: string;
  /** Actions per second the bot may issue. The main difficulty dial. */
  apmBudget: number;
  reactionDelayMs: number;
  /** 0..1 noise applied to estimates of enemy strength. */
  perceptionNoise: number;
  /** HP below which a unit is pulled out of the line. */
  cycleHpThreshold: number;
  /** 0..1; higher switches to PUSH on a thinner advantage. */
  aggression: number;
  planHorizonSec: number;
  usesEncirclement: boolean;
  usesTerrain: boolean;
  /** 0..1; how close to optimal the production sliders are kept. */
  ecoEfficiency: number;
  /** 0..1 chance of deliberately taking a plausible-but-wrong decision. */
  mistakeRate: number;
  /** Income multiplier. Only the top profile may set this, and the UI says so. */
  ecoHandicap: number;
}

// ──────────────────────────────────────────────────────────────── debugging ──

export interface DecisionLogEntry {
  tick: number;
  text: string;
}

export interface BotDebug {
  player: number;
  profile: string;
  mode: MacroModeId;
  modeScores: Partial<Record<MacroModeId, number>>;
  fronts: Front[];
  /** unit id → role, for the coloured outlines in the F3 overlay. */
  roles: Map<number, GroupRoleId>;
  targetCities: number[];
  encircleCell: number;
  apmSpent: number;
  apmBudget: number;
  reserveTarget: number;
  log: DecisionLogEntry[];
}

// ───────────────────────────────────────────────────────────────── the bot ──

export interface Bot {
  readonly player: number;
  readonly profile: BotProfile;
  /**
   * Called once per tick. Returns the commands the bot wants applied on this tick.
   * Must not mutate `world`.
   */
  think(world: World): Command[];
  /** Current internal state for the F3 overlay. Cheap; may return a live object. */
  debug(): BotDebug;
}
