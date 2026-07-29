/**
 * Every balance number in the game lives in this file. Nothing else in
 * `src/core` or `src/ai` is allowed to contain a numeric literal that a designer
 * might want to change (see `docs/SPEC.md` §0.6).
 *
 * Entries marked 🎚 in the spec are additionally exposed through the debug panel
 * (`F4`) and can be nudged at runtime via `applyBalanceOverrides`.
 */

import { TERRAIN_COUNT, KIND_COUNT } from './types.ts';

// ───────────────────────────────────────────────────────────── time & space ──

/** Simulation step, milliseconds. 20 Hz. */
export const TICK_MS = 50;
export const TICK_SEC = TICK_MS / 1000;
/** World units per tile edge. */
export const TILE_SIZE = 4;
/** Influence grid is this many times coarser than the tile grid. */
export const COARSE = 4;
/** World units per coarse influence cell. */
export const COARSE_SIZE = TILE_SIZE * COARSE;
/** Never run more than this many catch-up ticks in one frame (death-spiral guard). */
export const MAX_CATCHUP_TICKS = 5;
/** Influence, supply and pockets are recomputed every N ticks. */
export const INFLUENCE_INTERVAL = 5;
/** Economy history samples for the end-screen graphs. */
export const STATS_SAMPLE_TICKS = 40;

// ───────────────────────────────────────────────────────────────────── units ──

/** Indexed by KindId: light, heavy, lightShip, heavyShip. */
export const UNIT_COST = [200, 400, 200, 400];
/** 🎚 Damage per second at full HP, full morale, on plains. */
export const BASE_DAMAGE = [1.0, 2.2, 1.0, 2.2];
/** 🎚 Effective HP pool. `hp` is normalised 0..1, so this scales incoming damage. */
export const MAX_HP = [1.0, 1.8, 1.0, 1.8];
/** 🎚 Speed multiplier per kind, on top of `UNIT_SPEED`. */
export const KIND_SPEED = [1.0, 0.65, 1.0, 0.65];
/** World units per second at multiplier 1.0. */
export const UNIT_SPEED = 10;
/** Contact radius, world units. Combat starts when centres are within the sum. */
export const CONTACT_R = [3.0, 3.6, 3.0, 3.6];
/** 🎚 Steering responsiveness per tick. Low = heavy inertia, hard to disengage. */
export const TURN_RATE = [0.36, 0.15, 0.3, 0.13];
/** Render radius, world units. */
export const DRAW_R = [2.6, 3.2, 2.6, 3.2];
/** 🎚 Seconds in water before a unit becomes a ship, and back again on land. */
export const SHIP_CONVERT_SEC = 5;
/** Speed multiplier while locked in combat — units cannot simply walk out. */
export const COMBAT_SPEED_MULT = 0.35;
/** Distance from the final path vertex at which a unit considers itself arrived. */
export const ARRIVE_EPS = 1.2;

// ────────────────────────────────────────────────────────────────── terrain ──

type Table = number[][];

function table(rows: Record<string, [number, number, number, number]>): Table {
  const out: Table = [];
  for (const key of Object.keys(rows)) out.push(rows[key]!.slice());
  if (out.length !== TERRAIN_COUNT) throw new Error('terrain table must have 8 rows');
  for (const row of out) if (row.length !== KIND_COUNT) throw new Error('row must have 4 kinds');
  return out;
}

/**
 * Speed multiplier `[terrain][kind]`. Ship forms move well in water and badly on
 * land, which is what makes a stranded navy a real mistake.
 */
export const TERRAIN_SPEED: Table = table({
  PLAINS: [1.0, 1.0, 0.5, 0.45],
  FOREST: [1.0, 0.55, 0.4, 0.35],
  HILLS: [1.0, 0.6, 0.4, 0.35],
  SAND: [0.7, 1.0, 0.5, 0.45],
  SNOW: [0.85, 0.85, 0.45, 0.4],
  MUD: [0.7, 0.6, 0.4, 0.35],
  WATER: [0.35, 0.3, 0.62, 0.55],
  MOUNTAIN: [0, 0, 0, 0],
});

/**
 * Damage multiplier `[terrain][kind]`. The ×0.5 ship damage penalty from the spec
 * is folded into the ship columns so the combat formula stays a single product.
 */
export const TERRAIN_DAMAGE: Table = table({
  PLAINS: [1.0, 1.0, 0.5, 0.5],
  FOREST: [1.0, 0.35, 0.5, 0.175],
  HILLS: [1.0, 0.4, 0.5, 0.2],
  SAND: [1.0, 1.0, 0.5, 0.5],
  SNOW: [0.75, 0.75, 0.375, 0.375],
  MUD: [0.75, 0.75, 0.375, 0.375],
  WATER: [0.5, 0.5, 0.25, 0.25],
  MOUNTAIN: [0, 0, 0, 0],
});

/** 🎚 HP lost per second while standing in water — ships included. */
export const WATER_DPS = 0.02;

/** Pathfinding step cost per `[terrain][baseKind]` (light, heavy). Infinity blocks. */
export const PATH_COST: number[][] = [
  [1.0, 1.0], // plains
  [1.0, 2.4], // forest
  [1.0, 2.2], // hills
  [1.5, 1.0], // sand
  [1.2, 1.2], // snow
  [1.5, 1.7], // mud
  [8.0, 10.0], // water — legal but strongly discouraged
  [Infinity, Infinity], // mountain
];

export function isPassable(terrain: number): boolean {
  return terrain !== 7;
}

// ──────────────────────────────────────────────────────────────── combat ──

/** 🎚 `healthFactor(hp) = hp ** HEALTH_EXP`. Below 1 makes wounded units precious. */
export const HEALTH_EXP = 0.5;
/** 🎚 Damage floor at zero morale. */
export const MORALE_FLOOR = 0.2;
/** 🎚 Damage multiplier while moving — a small, deliberate defender's advantage. */
export const MOVING_PENALTY = 0.9;
/** A unit counts as "moving" above this speed, world units per second. */
export const MOVING_EPS = 0.6;
/** 🎚 Morale lost per second in combat. */
export const MORALE_DRAIN = 0.06;

// ────────────────────────────────────────────────────────── regeneration ──

/** 🎚 Enemy within this radius (world units) freezes HP regeneration. */
export const PROXIMITY_R = 12;
/** 🎚 HP per second regained out of combat with no enemy nearby. */
export const HP_REGEN = 0.01;
/** 🎚 City multiplier on HP regeneration. */
export const HP_REGEN_CITY_MULT = 2;
/** 🎚 Morale per second regained whenever the unit is not in combat. */
export const MORALE_REGEN = 0.1;

// ─────────────────────────────────────────────────────────────── economy ──

/** 🎚 ECO per second per city. */
export const CITY_INCOME = 12;
/** 🎚 Capital income multiplier. */
export const CAPITAL_INCOME_MULT = 1.5;
/** 🎚 ECO per second per unit outside a city. Units inside a city are free. */
export const UPKEEP = 1.5;
/** 🎚 Units supplied per city in the pocket. */
export const SUPPLY_PER_CITY = 5;
/** 🎚 HP per second lost by unsupplied units over the pocket's supply cap. */
export const STARVE_DPS = 0.03;
/** 🎚 HP per second lost by units cut off from every friendly pocket. */
export const ENCIRCLED_DPS = 0.08;
/** Seconds of uncontested presence needed to flip a city. */
export const CAPTURE_SEC = 4;
/** Capture progress decays this many times faster than it builds when contested. */
export const CAPTURE_DECAY_MULT = 2;

// ──────────────────────────────────────────────────────────── influence ──

/** 🎚 Influence emitted by a city. Falls off by accumulated terrain cost. */
export const CITY_POWER = 100;
/** 🎚 Influence emitted by a unit. */
export const UNIT_POWER = 20;
/** Capital influence multiplier. */
export const CAPITAL_POWER_MULT = 1.3;
/** Cost of stepping between adjacent coarse cells, per terrain. */
export const INFLUENCE_STEP_COST: number[] = [
  8, // plains
  10, // forest
  10, // hills
  9, // sand
  10, // snow
  12, // mud
  26, // water
  Infinity, // mountain
];
/**
 * Extra influence each additional unit in the same coarse cell contributes.
 * Well below 1 so a doomstack cannot out-project a city just by standing still.
 */
export const UNIT_STACK_FALLOFF = 0.35;
/** Diagonal steps cost this much more. */
export const INFLUENCE_DIAG = Math.SQRT2;
/** A cell must reach this influence to be claimed at all. */
export const INFLUENCE_CLAIM_MIN = 1;
/** Relative margin the leader needs over the runner-up, else the cell stays neutral. */
export const INFLUENCE_CONTEST_MARGIN = 0.04;

// ────────────────────────────────────────────────────────── production ──

/** `threshold = cost * (1 + (1 - slider) * PRODUCTION_K)`. Middle slider ⇒ 2× cost. */
export const PRODUCTION_K = 2;
/** Slider values at or below this switch production off entirely. */
export const PRODUCTION_OFF = 0.02;
/** Minimum seconds between two spawns from the same city. */
export const CITY_SPAWN_COOLDOWN = 0.6;
/** Spawn point is drawn inside this fraction of the city radius. */
export const SPAWN_RADIUS_FRAC = 0.8;

// ──────────────────────────────────────────────────────────── movement ──

/** 🎚 Separation force strength between overlapping units. */
export const PUSH_STRENGTH = 26;
/** Separation is scaled by this while in combat, so fronts do not drift apart. */
export const PUSH_COMBAT_MULT = 0.3;
/** Lateral spacing between neighbours in a drawn-path formation, world units. */
export const FORMATION_SPACING = 3.4;
/** Formations wider than this many files wrap into extra ranks. */
export const FORMATION_MAX_FILES = 12;
/** Ranks are this far apart along the path, world units. */
export const FORMATION_RANK_GAP = 4.2;
/** Units steer toward a point this far ahead on the path, world units. */
export const PATH_LOOKAHEAD = 3;
/** Ramer–Douglas–Peucker tolerance for drawn paths, world units. */
export const PATH_SIMPLIFY_EPS = 2.5;
/** Minimum distance between sampled points while drawing a path, world units. */
export const PATH_SAMPLE_MIN = 3;
/** Hard cap on vertices in one path. */
export const PATH_MAX_POINTS = 512;
/** Spatial hash cell edge, world units. Must exceed the largest contact diameter. */
export const HASH_CELL = 8;

// ──────────────────────────────────────────────────────────── match start ──

/** ECO each player starts with, split evenly across their starting cities. */
export const START_ECO = 500;

// ───────────────────────────────────────────────────────────────── input ──

/** Click-select grab radius, world units. */
export const CLICK_PICK_R = 5;
/** A right-drag shorter than this counts as a click (straight line to the point). */
export const DRAG_CLICK_PX = 6;
/** Camera zoom limits, screen pixels per world unit. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 6;
export const ZOOM_DEFAULT = 1;
/** Keyboard pan speed, world units per second at zoom 1. */
export const PAN_SPEED = 700;
/** Screen-edge pan band, pixels. */
export const EDGE_PAN_BAND = 18;

// ───────────────────────────────────────────────────────────────── scoring ──

export const SCORE_PER_CITY = 10;
export const SCORE_PER_UNIT = 1;
export const SCORE_TERRITORY = 100;

// ──────────────────────────────────────────────────────── runtime tuning ──

/**
 * Mutable mirror of the numbers the debug panel can move. The simulation reads
 * these through `B`, never the frozen exports, so a designer can drag a slider
 * mid-match without a reload. Replays record the override set alongside the seed.
 */
export const B = {
  BASE_DAMAGE: BASE_DAMAGE.slice(),
  MAX_HP: MAX_HP.slice(),
  KIND_SPEED: KIND_SPEED.slice(),
  TURN_RATE: TURN_RATE.slice(),
  UNIT_SPEED,
  SHIP_CONVERT_SEC,
  WATER_DPS,
  HEALTH_EXP,
  MORALE_FLOOR,
  MOVING_PENALTY,
  MORALE_DRAIN,
  PROXIMITY_R,
  HP_REGEN,
  HP_REGEN_CITY_MULT,
  MORALE_REGEN,
  CITY_INCOME,
  UPKEEP,
  SUPPLY_PER_CITY,
  STARVE_DPS,
  ENCIRCLED_DPS,
  CITY_POWER,
  UNIT_POWER,
  PUSH_STRENGTH,
};

export type BalanceOverrides = Partial<{ [K in keyof typeof B]: (typeof B)[K] }>;

const DEFAULTS: BalanceOverrides = JSON.parse(JSON.stringify(B));

export function applyBalanceOverrides(over: BalanceOverrides): void {
  for (const key of Object.keys(over) as (keyof typeof B)[]) {
    const value = over[key];
    if (value === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (B as any)[key] = Array.isArray(value) ? value.slice() : value;
  }
}

export function resetBalance(): void {
  applyBalanceOverrides(JSON.parse(JSON.stringify(DEFAULTS)));
}

/** Production threshold in ECO for one unit of `kind` at slider position `slider`. */
export function productionThreshold(kind: number, slider: number): number {
  return UNIT_COST[kind]! * (1 + (1 - slider) * PRODUCTION_K);
}
