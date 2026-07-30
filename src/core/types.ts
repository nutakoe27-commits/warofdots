/**
 * Every serialisable shape of the simulation lives here.
 *
 * Nothing in this file imports from outside `src/core`, and nothing in it touches
 * the DOM: a `World` is a plain data structure that can be hashed, diffed and
 * replayed. See `docs/DECISIONS.md` (ADR-001) for why the core is kept pure.
 */

// ─────────────────────────────────────────────────────────────── terrain ──

export const Terrain = {
  Plains: 0,
  Forest: 1,
  Hills: 2,
  Sand: 3,
  Snow: 4,
  Mud: 5,
  Water: 6,
  Mountain: 7,
} as const;

export type TerrainId = (typeof Terrain)[keyof typeof Terrain];
export const TERRAIN_COUNT = 8;

export const TERRAIN_KEYS = [
  'PLAINS',
  'FOREST',
  'HILLS',
  'SAND',
  'SNOW',
  'MUD',
  'WATER',
  'MOUNTAIN',
] as const;

export type TerrainKey = (typeof TERRAIN_KEYS)[number];

// ───────────────────────────────────────────────────────────────── units ──

export const Kind = { Light: 0, Heavy: 1, LightShip: 2, HeavyShip: 3 } as const;
export type KindId = (typeof Kind)[keyof typeof Kind];
export const KIND_COUNT = 4;
export const KIND_KEYS = ['light', 'heavy', 'lightShip', 'heavyShip'] as const;
export type KindKey = (typeof KIND_KEYS)[number];

/** 0 for light-family units, 1 for heavy-family units. Indexes the terrain tables. */
export function baseKindOf(kind: number): 0 | 1 {
  return kind === Kind.Heavy || kind === Kind.HeavyShip ? 1 : 0;
}

export function isShip(kind: number): boolean {
  return kind === Kind.LightShip || kind === Kind.HeavyShip;
}

/** The water form of a unit kind. Idempotent for kinds that are already ships. */
export function shipFormOf(kind: number): KindId {
  return baseKindOf(kind) === 1 ? Kind.HeavyShip : Kind.LightShip;
}

/** The land form of a unit kind. Idempotent for kinds that are already on foot. */
export function footFormOf(kind: number): KindId {
  return baseKindOf(kind) === 1 ? Kind.Heavy : Kind.Light;
}

/**
 * Structure-of-arrays unit storage. Slots are recycled through a freelist, so a
 * slot index is only meaningful for the current tick — use `id` for anything that
 * has to survive a tick boundary (commands, replays, bot bookkeeping).
 */
export interface UnitStore {
  count: number;
  capacity: number;
  id: Int32Array;
  owner: Uint8Array;
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  hp: Float32Array;
  morale: Float32Array;
  pathIdx: Int32Array;
  pathPos: Float32Array;
  waterTime: Float32Array;
  inCombat: Uint8Array;
  alive: Uint8Array;
  supplied: Uint8Array;

  // Additions beyond the spec sketch (ADR-006).
  /** Slot of the single unit this one is damaging, or -1. Enforces the one-target rule. */
  target: Int32Array;
  /** Signed lateral offset from the path centreline, in world units. Gives formations. */
  lateral: Float32Array;
  /** Coarse-grid pocket this unit stands in, or -1 when it stands on foreign ground. */
  pocket: Int32Array;
  /** 1 when the unit is outside every supply pocket of its owner. */
  encircled: Uint8Array;
  /** Tick the unit was spawned on. Drives deterministic combat jitter in the renderer. */
  bornTick: Int32Array;

  freelist: number[];
  nextId: number;
  /** Stable id → current slot. Rebuilt as slots are allocated and released. */
  idToSlot: Map<number, number>;
}

// ───────────────────────────────────────────────────────────────── paths ──

/**
 * Pooled polylines. A path is shared by every unit that was given it, so a
 * 200-unit move order allocates one polyline rather than 200.
 */
export interface PathPool {
  /** Flat `[x0, y0, x1, y1, ...]` vertex list per slot. */
  pts: (Float32Array | null)[];
  /** Cumulative arc length per vertex; `cum[i][k]` is the distance to vertex `k`. */
  cum: (Float32Array | null)[];
  refs: Int32Array;
  free: number[];
  capacity: number;
}

// ──────────────────────────────────────────────────────────────── cities ──

export interface City {
  id: string;
  index: number;
  /** Tile coordinates. */
  tx: number;
  ty: number;
  /** World coordinates (tile × TILE_SIZE, tile centre). */
  x: number;
  y: number;
  radiusTiles: number;
  radius: number;
  capital: boolean;
  owner: number;
  originalOwner: number;
  /** A disabled city still earns and still supplies, but produces nothing. */
  active: boolean;
  /** This city's share of its pocket's treasury (ADR-004). */
  eco: number;
  /** 0..1 progress of the currently contesting player, if any. */
  captureProgress: number;
  capturingPlayer: number;
  spawnCooldown: number;
  /**
   * Kind the city is currently saving up for, or -1 when nothing is queued.
   * Rolling the light/heavy die once and then accumulating toward it keeps the
   * heavy-share slider an honest probability even while money is tight.
   */
  queuedKind: number;
  /** Coarse-grid pocket this city belongs to, or -1. */
  pocket: number;
}

// ─────────────────────────────────────────────────────────────── players ──

export type PlayerKind = 'neutral' | 'human' | 'bot';

export interface PlayerState {
  id: number;
  team: number;
  kind: PlayerKind;
  name: string;
  colorIndex: number;
  alive: boolean;
  /** Production slider 1: 0 = production off, 1 = spawn as soon as the unit is paid for. */
  threshold: number;
  /** Production slider 2: probability the next unit is heavy. */
  heavyShare: number;
  /** Income multiplier. Only ever ≠ 1 for the explicitly-labelled top-difficulty handicap. */
  ecoHandicap: number;
}

// ───────────────────────────────────────────────────────── influence map ──

export interface Pocket {
  id: number;
  player: number;
  cities: number[];
  /** Unit slots inside the pocket, refreshed on every influence pass. */
  units: number[];
  cells: number;
  eco: number;
  supplyCap: number;
  supplyUsed: number;
  /** Income minus upkeep for this pocket, ECO/sec. Reported to the HUD and to bots. */
  ecoRate: number;
}

export interface InfluenceState {
  cw: number;
  ch: number;
  /** Winning player per coarse cell, 0 = nobody. */
  owner: Uint8Array;
  /** Winning influence value per coarse cell. */
  strength: Float32Array;
  /** Pocket id per coarse cell, -1 for neutral cells. */
  pocketId: Int32Array;
  /** 1 when the cell is connected to one of its owner's cities. */
  supplied: Uint8Array;
  pockets: Pocket[];
  lastTick: number;
  /** Per-player influence field, `playerCount + 1` planes of `cw × ch`. */
  field: Float32Array;
  /**
   * Supply reach: `playerCount + 1` planes of `cw × ch` holding `pocketId + 1`,
   * or 0. A pocket reaches its own cells plus a band of `SUPPLY_REACH_CELLS`
   * around them, which is what lets an army fight on ground it does not own
   * without being treated as cut off (ADR-024).
   */
  reach: Int32Array;
}

// ────────────────────────────────────────────────────────── spatial hash ──

export interface SpatialHash {
  cellSize: number;
  gw: number;
  gh: number;
  /** Prefix-sum offsets, length `gw * gh + 1`. */
  start: Int32Array;
  /** Unit slots bucketed by cell, length `capacity`. */
  items: Int32Array;
  counts: Int32Array;
  capacity: number;
}

// ─────────────────────────────────────────────────────────────────── map ──

export interface CityDef {
  id: string;
  x: number;
  y: number;
  capital?: boolean;
  owner?: number;
  radius?: number;
}

export interface StartUnitDef {
  owner: number;
  kind: KindKey;
  count: number;
  x: number;
  y: number;
  spread?: number;
}

/** A procedural terrain brush. Deterministic, so headless runs need no image decoder. */
export interface TerrainFeatureDef {
  type: 'fill' | 'blob' | 'river' | 'ridge' | 'road' | 'rect';
  terrain: TerrainKey;
  /** Tile coordinates; meaning depends on `type`. */
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  radius?: number;
  width?: number;
  count?: number;
  jitter?: number;
  seed?: number;
}

export interface MapDef {
  id: string;
  name: string;
  size: { w: number; h: number };
  players: number;
  /** PNG palette mask, browser only. Mutually exclusive with `terrainGen`. */
  terrainMask?: string;
  /** Deterministic terrain recipe. Works in the browser and in Node. */
  terrainGen?: { seed: number; features: TerrainFeatureDef[] };
  cities: CityDef[];
  startUnits?: StartUnitDef[];
  /** Suggested heavy-unit share for bots, 0..1. Forest-heavy maps want fewer heavies. */
  heavyHint?: number;
}

export interface MapRuntime {
  id: string;
  name: string;
  w: number;
  h: number;
  terrain: Uint8Array;
  worldW: number;
  worldH: number;
  cw: number;
  ch: number;
  /** Modal terrain per coarse influence cell. Drives influence spread cost. */
  coarseTerrain: Uint8Array;
  /**
   * Influence step cost per coarse cell, `Infinity` for impassable ones.
   * Precomputed because the influence pass reads it about a quarter of a million
   * times per recomputation, and `Infinity` makes the blocked case fall out of the
   * arithmetic instead of needing a branch.
   */
  coarseCost: Float64Array;
  /** Number of coarse cells anyone can ever own. Denominator for territory share. */
  coarseClaimable: number;
  /** Tile → `cityIndex + 1`, 0 when the tile is not inside any city. */
  cityAt: Int32Array;
  playerCount: number;
  def: MapDef;
}

// ────────────────────────────────────────────────────────────── commands ──

export type Command =
  | { t: 'path'; player: number; units: number[]; pts: number[]; append: boolean }
  | { t: 'stop'; player: number; units: number[] }
  | { t: 'clear'; player: number; units: number[] }
  | { t: 'production'; player: number; threshold: number; heavyShare: number }
  | { t: 'cityActive'; player: number; city: number; active: boolean }
  | { t: 'resign'; player: number };

// ──────────────────────────────────────────────────────────────── events ──

export type SimEvent =
  | { t: 'spawn'; x: number; y: number; owner: number; kind: number }
  | { t: 'death'; x: number; y: number; owner: number; kind: number }
  | { t: 'capture'; city: number; from: number; to: number }
  | { t: 'convert'; x: number; y: number; owner: number; toShip: boolean }
  | { t: 'eliminated'; player: number };

// ───────────────────────────────────────────────────────── match & world ──

export const VictoryMode = {
  CapitalAndMajority: 'CAPITAL_AND_MAJORITY',
  Annihilation: 'ANNIHILATION',
  TimedScore: 'TIMED_SCORE',
} as const;
export type VictoryModeId = (typeof VictoryMode)[keyof typeof VictoryMode];

export type StarveStrategy = 'healthiestFirst' | 'weakestFirst' | 'newestFirst';

export interface MatchSettings {
  seed: number;
  victory: VictoryModeId;
  timeLimitSec: number;
  majorityShare: number;
  starveStrategy: StarveStrategy;
}

export interface PlayerStats {
  produced: number;
  lost: number;
  peakArmy: number;
  captured: number;
  citiesNow: number;
  armyNow: number;
  ecoNow: number;
  ecoRate: number;
  supplyCap: number;
  territory: number;
  score: number;
}

export interface MatchStats {
  players: PlayerStats[];
  /** Sparse economy samples for the end screen graph: `[tick, p1, p2, ...]` rows. */
  ecoHistory: number[][];
  /** Army-size samples, same row layout as `ecoHistory`. */
  armyHistory: number[][];
}

export interface Outcome {
  /** Winning team, or -1 for a draw. */
  team: number;
  winners: number[];
  reason: 'capital' | 'annihilation' | 'timeout' | 'lastStanding' | 'draw';
  tick: number;
}

export interface RngState {
  s: number;
}

export interface World {
  tick: number;
  rng: RngState;
  map: MapRuntime;
  units: UnitStore;
  paths: PathPool;
  cities: City[];
  players: PlayerState[];
  influence: InfluenceState;
  spatial: SpatialHash;
  settings: MatchSettings;
  stats: MatchStats;
  outcome: Outcome | null;
  /** Cleared at the top of every tick; consumed by the renderer and the audio layer. */
  events: SimEvent[];
}
