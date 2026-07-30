/**
 * World construction. Everything a match needs, assembled from a map runtime and
 * a player roster — no I/O, no globals, so a test or the headless tuner can spin
 * up a match in a single call.
 */

import { Kind, VictoryMode } from './types.ts';
import type {
  City,
  InfluenceState,
  MapRuntime,
  MatchSettings,
  MatchStats,
  PlayerKind,
  PlayerState,
  World,
} from './types.ts';
import { COARSE_SIZE, START_ECO, TILE_SIZE } from './balance.ts';
import { DEFAULT_CITY_RADIUS } from './map.ts';
import { createUnitStore, DEFAULT_UNIT_CAPACITY, allocUnit } from './units.ts';
import { createPathPool } from './paths.ts';
import { createSpatialHash } from './spatial.ts';
import { makeRng, randInDisc } from './rng.ts';
import { terrainAt } from './terrain.ts';
import { Terrain } from './types.ts';
import { clamp } from './geometry.ts';

export interface PlayerSetup {
  kind: PlayerKind;
  team: number;
  name: string;
  colorIndex: number;
  ecoHandicap?: number;
}

export interface WorldOptions {
  map: MapRuntime;
  players: PlayerSetup[];
  settings: MatchSettings;
  unitCapacity?: number;
}

export function defaultSettings(seed = 1): MatchSettings {
  return {
    seed,
    victory: VictoryMode.CapitalAndMajority,
    timeLimitSec: 900,
    majorityShare: 0.8,
    starveStrategy: 'healthiestFirst',
  };
}

function createCities(map: MapRuntime): City[] {
  return map.def.cities.map((def, index) => {
    const radiusTiles = def.radius ?? DEFAULT_CITY_RADIUS;
    const owner = def.owner ?? 0;
    return {
      id: def.id,
      index,
      tx: def.x,
      ty: def.y,
      x: (def.x + 0.5) * TILE_SIZE,
      y: (def.y + 0.5) * TILE_SIZE,
      radiusTiles,
      radius: radiusTiles * TILE_SIZE,
      capital: def.capital === true,
      owner,
      originalOwner: owner,
      active: true,
      eco: 0,
      captureProgress: 0,
      capturingPlayer: -1,
      spawnCooldown: 0,
      queuedKind: -1,
      pocket: -1,
    };
  });
}

function createInfluence(map: MapRuntime, playerCount: number): InfluenceState {
  const cells = map.cw * map.ch;
  return {
    cw: map.cw,
    ch: map.ch,
    owner: new Uint8Array(cells),
    strength: new Float32Array(cells),
    pocketId: new Int32Array(cells).fill(-1),
    supplied: new Uint8Array(cells),
    pockets: [],
    lastTick: -1,
    field: new Float32Array(cells * (playerCount + 1)),
    reach: new Int32Array(cells * (playerCount + 1)),
  };
}

function createStats(playerCount: number): MatchStats {
  const players = [];
  for (let i = 0; i <= playerCount; i++) {
    players.push({
      produced: 0,
      lost: 0,
      peakArmy: 0,
      captured: 0,
      citiesNow: 0,
      armyNow: 0,
      ecoNow: 0,
      ecoRate: 0,
      supplyCap: 0,
      territory: 0,
      score: 0,
    });
  }
  return { players, ecoHistory: [], armyHistory: [] };
}

/** Nudges a spawn point off water and out of mountains, searching outward. */
function placeOnLand(world: World, x: number, y: number): { x: number; y: number } {
  const map = world.map;
  let bx = clamp(x, 1, map.worldW - 1);
  let by = clamp(y, 1, map.worldH - 1);
  const t = terrainAt(map, bx, by);
  if (t !== Terrain.Mountain && t !== Terrain.Water) return { x: bx, y: by };

  for (let ring = 1; ring < 40; ring++) {
    const step = ring * TILE_SIZE;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const cx = clamp(x + Math.cos(ang) * step, 1, map.worldW - 1);
      const cy = clamp(y + Math.sin(ang) * step, 1, map.worldH - 1);
      const ct = terrainAt(map, cx, cy);
      if (ct !== Terrain.Mountain && ct !== Terrain.Water) {
        bx = cx;
        by = cy;
        return { x: bx, y: by };
      }
    }
  }
  return { x: bx, y: by };
}

function spawnStartUnits(world: World): void {
  const offset = { x: 0, y: 0 };
  for (const def of world.map.def.startUnits ?? []) {
    const kind = def.kind === 'heavy' ? Kind.Heavy : Kind.Light;
    const spread = (def.spread ?? 4) * TILE_SIZE;
    for (let i = 0; i < def.count; i++) {
      randInDisc(world.rng, spread, offset);
      const spot = placeOnLand(
        world,
        (def.x + 0.5) * TILE_SIZE + offset.x,
        (def.y + 0.5) * TILE_SIZE + offset.y,
      );
      const slot = allocUnit(world.units, def.owner, kind, spot.x, spot.y, 0);
      if (slot >= 0) world.stats.players[def.owner]!.produced++;
    }
  }
}

function seedTreasuries(world: World): void {
  for (let p = 1; p <= world.map.playerCount; p++) {
    const owned = world.cities.filter((c) => c.owner === p);
    if (owned.length === 0) continue;
    const share = START_ECO / owned.length;
    for (const c of owned) c.eco = share;
  }
}

export function createWorld(opts: WorldOptions): World {
  const map = opts.map;
  const playerCount = map.playerCount;
  if (opts.players.length !== playerCount) {
    throw new Error(`map ${map.id} wants ${playerCount} players, got ${opts.players.length}`);
  }

  const players: PlayerState[] = [
    {
      id: 0,
      team: 0,
      kind: 'neutral',
      name: 'Neutral',
      colorIndex: 0,
      alive: true,
      threshold: 0,
      heavyShare: 0,
      ecoHandicap: 1,
    },
  ];
  opts.players.forEach((setup, i) => {
    players.push({
      id: i + 1,
      team: setup.team,
      kind: setup.kind,
      name: setup.name,
      colorIndex: setup.colorIndex,
      alive: true,
      threshold: 1,
      heavyShare: 0.3,
      ecoHandicap: setup.ecoHandicap ?? 1,
    });
  });

  const capacity = opts.unitCapacity ?? DEFAULT_UNIT_CAPACITY;
  const world: World = {
    tick: 0,
    rng: makeRng(opts.settings.seed),
    map,
    units: createUnitStore(capacity),
    paths: createPathPool(),
    cities: createCities(map),
    players,
    influence: createInfluence(map, playerCount),
    spatial: createSpatialHash(map.worldW, map.worldH, capacity),
    settings: opts.settings,
    stats: createStats(playerCount),
    outcome: null,
    events: [],
  };

  seedTreasuries(world);
  spawnStartUnits(world);
  return world;
}

/** Coarse influence cell index for a world point. */
export function coarseIndex(world: World, x: number, y: number): number {
  const cx = clamp((x / COARSE_SIZE) | 0, 0, world.influence.cw - 1);
  const cy = clamp((y / COARSE_SIZE) | 0, 0, world.influence.ch - 1);
  return cy * world.influence.cw + cx;
}

export function citiesOf(world: World, player: number): City[] {
  return world.cities.filter((c) => c.owner === player);
}

/** Total treasury of a player, summed across every pocket they hold. */
export function playerEco(world: World, player: number): number {
  let total = 0;
  for (const c of world.cities) if (c.owner === player) total += c.eco;
  return total;
}
