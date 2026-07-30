/**
 * Shared fixtures for the core and AI suites.
 *
 * Everything here is built to keep numeric assertions honest. Generated maps are
 * fine for smoke coverage but useless when a test wants to know the exact HP a
 * unit should have after 40 ticks, so `emptyMap` hand-writes a `MapDef` of pure
 * plains with two mirrored capitals and lets a test paint in exactly the forest or
 * water rectangle it needs. The mirror symmetry is load-bearing: it is what makes
 * a genuine draw reachable in `TIMED_SCORE`, and it keeps the influence field of
 * player 1 the exact reflection of player 2's.
 *
 * Production is off by default. A city that spends its starting treasury on the
 * first tick would perturb every economy and combat figure in the suite, so tests
 * that want spawning have to ask for it.
 */

import { Kind, Terrain, VictoryMode } from '../src/core/types.ts';
import type {
  CityDef,
  Command,
  MapDef,
  MapRuntime,
  MatchSettings,
  StartUnitDef,
  StarveStrategy,
  TerrainFeatureDef,
  TerrainKey,
  VictoryModeId,
  World,
} from '../src/core/types.ts';
import { ENCIRCLED_DPS, TICK_SEC, TILE_SIZE, WATER_DPS } from '../src/core/balance.ts';
import { buildMapRuntime } from '../src/core/map.ts';
import { createWorld } from '../src/core/world.ts';
import type { PlayerSetup } from '../src/core/world.ts';
import { allocUnit } from '../src/core/units.ts';
import { tick } from '../src/core/sim.ts';
import { terrainAt } from '../src/core/terrain.ts';

/** Edge of the default test map, in tiles. 64 tiles ⇒ 256 world units ⇒ 16×16 coarse cells. */
export const TEST_MAP_TILES = 64;
/** How far in from the left/right edge the two capitals sit, in tiles. */
export const CAPITAL_INSET_TILES = 12;
const CAPITAL_RADIUS_TILES = 6;
const TOWN_RADIUS_TILES = 5;

/** A terrain override, in tile coordinates, painted over the plains base. */
export interface TerrainRect {
  terrain: TerrainKey;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EmptyMapOptions {
  id?: string;
  w?: number;
  h?: number;
  players?: number;
  /** Replaces the two default capitals outright. */
  cities?: CityDef[];
  /** Painted in order, after the plains fill. */
  rects?: TerrainRect[];
  startUnits?: StartUnitDef[];
}

/** World-space centre of a tile, on either axis. */
export function tileCentre(t: number): number {
  return (t + 0.5) * TILE_SIZE;
}

/** Two capitals, mirrored about the vertical centre line of the map. */
export function mirroredCapitals(w: number, h: number): CityDef[] {
  const y = h >> 1;
  return [
    {
      id: 'west',
      x: CAPITAL_INSET_TILES,
      y,
      capital: true,
      owner: 1,
      radius: CAPITAL_RADIUS_TILES,
    },
    {
      id: 'east',
      x: w - 1 - CAPITAL_INSET_TILES,
      y,
      capital: true,
      owner: 2,
      radius: CAPITAL_RADIUS_TILES,
    },
  ];
}

export function town(id: string, x: number, y: number, owner: number): CityDef {
  return { id, x, y, owner, radius: TOWN_RADIUS_TILES };
}

export function emptyMapDef(opts: EmptyMapOptions = {}): MapDef {
  const w = opts.w ?? TEST_MAP_TILES;
  const h = opts.h ?? TEST_MAP_TILES;
  const features: TerrainFeatureDef[] = [{ type: 'fill', terrain: 'PLAINS' }];
  for (const r of opts.rects ?? []) {
    features.push({ type: 'rect', terrain: r.terrain, x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return {
    id: opts.id ?? 'test-plains',
    name: 'Test Plains',
    size: { w, h },
    players: opts.players ?? 2,
    terrainGen: { seed: 1, features },
    cities: opts.cities ?? mirroredCapitals(w, h),
    startUnits: opts.startUnits ?? [],
  };
}

/** An all-plains map with two mirrored capitals and no starting units. */
export function emptyMap(opts: EmptyMapOptions = {}): MapRuntime {
  return buildMapRuntime(emptyMapDef(opts));
}

/**
 * Two lobes joined by a one-tile mountain pass.
 *
 * The pass is deliberately narrower than a coarse cell: the influence grid sees a
 * solid mountain wall (modal terrain wins the cell, and mountains cost `Infinity`)
 * while the tile grid — and therefore the map validator and any unit on foot — sees
 * a legal route through. That is what lets a test cut a player's territory in two
 * without also cutting the map in two.
 */
export const SPLIT_WALL_X = 28;
export const SPLIT_WALL_W = 8;

export function splitMap(): MapRuntime {
  const h = TEST_MAP_TILES;
  return buildMapRuntime(
    emptyMapDef({
      id: 'test-split',
      rects: [
        { terrain: 'MOUNTAIN', x: SPLIT_WALL_X, y: 0, w: SPLIT_WALL_W, h },
        { terrain: 'PLAINS', x: SPLIT_WALL_X, y: h >> 1, w: SPLIT_WALL_W, h: 1 },
      ],
      cities: [
        { id: 'west-capital', x: 12, y: 32, capital: true, owner: 1, radius: CAPITAL_RADIUS_TILES },
        town('east-outpost', 48, 32, 1),
        { id: 'east-capital', x: 56, y: 56, capital: true, owner: 2, radius: CAPITAL_RADIUS_TILES },
      ],
    }),
  );
}

export interface MakeWorldOptions {
  seed?: number;
  victory?: VictoryModeId;
  timeLimitSec?: number;
  majorityShare?: number;
  starveStrategy?: StarveStrategy;
  /** Team per player, indexed from 0. Defaults to one team each — everybody hostile. */
  teams?: number[];
  /** Leave the production sliders where `createWorld` put them. Off by default. */
  production?: boolean;
  unitCapacity?: number;
}

/** A match on `map` with every player a bot, each on their own team. */
export function makeWorld(map: MapRuntime, opts: MakeWorldOptions = {}): World {
  const players: PlayerSetup[] = [];
  for (let i = 0; i < map.playerCount; i++) {
    players.push({
      kind: 'bot',
      team: opts.teams?.[i] ?? i + 1,
      name: `P${i + 1}`,
      colorIndex: i,
    });
  }
  const settings: MatchSettings = {
    seed: opts.seed ?? 0x5eed,
    victory: opts.victory ?? VictoryMode.CapitalAndMajority,
    timeLimitSec: opts.timeLimitSec ?? 900,
    majorityShare: opts.majorityShare ?? 0.8,
    starveStrategy: opts.starveStrategy ?? 'healthiestFirst',
  };
  const world = createWorld({
    map,
    players,
    settings,
    unitCapacity: opts.unitCapacity ?? 256,
  });
  if (opts.production !== true) {
    for (const p of world.players) p.threshold = 0;
  }
  return world;
}

/** Spawns one unit at exact world coordinates and returns its slot. */
export function place(world: World, owner: number, kind: number, x: number, y: number): number {
  const slot = allocUnit(world.units, owner, kind, x, y, world.tick);
  if (slot < 0) throw new Error('unit store is full');
  return slot;
}

export function placeLight(world: World, owner: number, x: number, y: number): number {
  return place(world, owner, Kind.Light, x, y);
}

export function placeHeavy(world: World, owner: number, x: number, y: number): number {
  return place(world, owner, Kind.Heavy, x, y);
}

/** Ticks `n` times, optionally feeding the commands scheduled for each tick number. */
export function runTicks(
  world: World,
  n: number,
  commandsAt?: (tick: number) => readonly Command[],
): void {
  for (let i = 0; i < n && !world.outcome; i++) {
    tick(world, commandsAt ? commandsAt(world.tick + 1) : []);
  }
}

/** Ticks in seconds. */
export function seconds(n: number): number {
  return Math.round(n / TICK_SEC);
}

/** Live slots owned by `player`, in slot order. */
export function slotsOf(world: World, player: number): number[] {
  const u = world.units;
  const out: number[] = [];
  for (let i = 0; i < u.capacity; i++) {
    if (u.alive[i] && u.owner[i] === player) out.push(i);
  }
  return out;
}

export function idsOf(world: World, player: number): number[] {
  return slotsOf(world, player).map((s) => world.units.id[s]!);
}

/** Summed normalised HP of a player's living units. */
export function totalHp(world: World, player: number): number {
  return slotsOf(world, player).reduce((sum, s) => sum + world.units.hp[s]!, 0);
}

/**
 * HP a unit lost on the tick that just ran to everything except contact combat.
 *
 * Combat tests that assert to five decimal places need this: a unit standing on
 * foreign ground bleeds `ENCIRCLED_DPS` in the same tick it fights, and water
 * bleeds on top of that. Read it *after* the tick — `encircled` is written during
 * the pocket pass that the same tick's economy step then acts on.
 */
export function attritionThisTick(world: World, slot: number): number {
  const u = world.units;
  let loss = 0;
  if (terrainAt(world.map, u.x[slot]!, u.y[slot]!) === Terrain.Water) loss += WATER_DPS * TICK_SEC;
  if (u.encircled[slot]) loss += ENCIRCLED_DPS * TICK_SEC;
  return loss;
}

/** Coarse cells owned by `player`. */
export function ownedCells(world: World, player: number): number {
  const owner = world.influence.owner;
  let n = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === player) n++;
  return n;
}
