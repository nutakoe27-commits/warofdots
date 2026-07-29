/**
 * Turning a `MapDef` into a `MapRuntime`, plus the validator.
 *
 * The validator is deliberately loud: a map that is subtly broken (a city walled
 * in by mountains, a player with no capital) produces matches that look fine for
 * a minute and then deadlock, which is far more expensive to debug than a throw
 * at load time.
 */

import { Terrain, TERRAIN_COUNT } from './types.ts';
import type { MapDef, MapRuntime } from './types.ts';
import { COARSE, TILE_SIZE } from './balance.ts';
import { generateTerrain } from './mapgen.ts';
import { terrainKeyToId } from './terrain.ts';

export const DEFAULT_CITY_RADIUS = 6;

function paintCities(def: MapDef, terrain: Uint8Array, w: number, h: number): Int32Array {
  const cityAt = new Int32Array(w * h);
  for (let ci = 0; ci < def.cities.length; ci++) {
    const c = def.cities[ci]!;
    const r = c.radius ?? DEFAULT_CITY_RADIUS;
    const r2 = r * r;
    for (let y = Math.max(0, c.y - r); y <= Math.min(h - 1, c.y + r); y++) {
      for (let x = Math.max(0, c.x - r); x <= Math.min(w - 1, c.x + r); x++) {
        const dx = x - c.x;
        const dy = y - c.y;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * w + x;
        cityAt[i] = ci + 1;
        // City ground behaves as plains and is always safe (spec §4.1).
        const t = terrain[i]!;
        if (t === Terrain.Water || t === Terrain.Mountain) terrain[i] = Terrain.Plains;
      }
    }
  }
  return cityAt;
}

/**
 * Modal terrain per coarse influence cell. Mountains only win a cell when they
 * are the plurality, so a narrow pass through a range stays traversable by
 * influence instead of being sealed by rounding.
 */
function coarsenTerrain(terrain: Uint8Array, w: number, h: number, cw: number, ch: number): Uint8Array {
  const out = new Uint8Array(cw * ch);
  const tally = new Int32Array(TERRAIN_COUNT);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      tally.fill(0);
      const x1 = Math.min(w, (cx + 1) * COARSE);
      const y1 = Math.min(h, (cy + 1) * COARSE);
      for (let y = cy * COARSE; y < y1; y++) {
        for (let x = cx * COARSE; x < x1; x++) tally[terrain[y * w + x]!]!++;
      }
      let best = 0;
      for (let t = 1; t < TERRAIN_COUNT; t++) if (tally[t]! > tally[best]!) best = t;
      out[cy * cw + cx] = best;
    }
  }
  return out;
}

export function buildMapRuntime(def: MapDef, maskTerrain?: Uint8Array): MapRuntime {
  const w = def.size.w;
  const h = def.size.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16) {
    throw new Error(`map ${def.id}: size must be integers ≥ 16, got ${w}×${h}`);
  }

  let terrain: Uint8Array;
  if (maskTerrain) {
    if (maskTerrain.length !== w * h) {
      throw new Error(
        `map ${def.id}: mask has ${maskTerrain.length} tiles, expected ${w * h} (${w}×${h})`,
      );
    }
    terrain = Uint8Array.from(maskTerrain);
  } else if (def.terrainGen) {
    terrain = generateTerrain(def);
  } else {
    throw new Error(`map ${def.id}: needs either a decoded terrainMask or a terrainGen recipe`);
  }

  const cityAt = paintCities(def, terrain, w, h);
  const cw = Math.ceil(w / COARSE);
  const ch = Math.ceil(h / COARSE);

  const runtime: MapRuntime = {
    id: def.id,
    name: def.name,
    w,
    h,
    terrain,
    worldW: w * TILE_SIZE,
    worldH: h * TILE_SIZE,
    cw,
    ch,
    coarseTerrain: coarsenTerrain(terrain, w, h, cw, ch),
    cityAt,
    playerCount: def.players,
    def,
  };
  validateMap(runtime);
  return runtime;
}

/** Non-mountain flood fill from `startTile`, returning the reached mask. */
function reachable(map: MapRuntime, startTile: number): Uint8Array {
  const seen = new Uint8Array(map.w * map.h);
  const queue = new Int32Array(map.w * map.h);
  let head = 0;
  let tail = 0;
  seen[startTile] = 1;
  queue[tail++] = startTile;
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % map.w;
    const y = (i / map.w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni] || map.terrain[ni] === Terrain.Mountain) continue;
      seen[ni] = 1;
      queue[tail++] = ni;
    }
  }
  return seen;
}

function validateCities(map: MapRuntime, def: MapDef): void {
  const ids = new Set<string>();
  const capitals = new Map<number, number>();
  for (const c of def.cities) {
    if (ids.has(c.id)) throw new Error(`map ${def.id}: duplicate city id "${c.id}"`);
    ids.add(c.id);
    if (c.x < 0 || c.y < 0 || c.x >= map.w || c.y >= map.h) {
      throw new Error(`map ${def.id}: city "${c.id}" at ${c.x},${c.y} is outside the map`);
    }
    const owner = c.owner ?? 0;
    if (owner < 0 || owner > def.players) {
      throw new Error(`map ${def.id}: city "${c.id}" has owner ${owner}, players=${def.players}`);
    }
    if (c.capital) {
      if (owner === 0) throw new Error(`map ${def.id}: capital "${c.id}" has no owner`);
      capitals.set(owner, (capitals.get(owner) ?? 0) + 1);
    }
  }
  for (let p = 1; p <= def.players; p++) {
    if (!capitals.get(p)) throw new Error(`map ${def.id}: player ${p} has no capital`);
  }
}

export function validateMap(map: MapRuntime): void {
  const def = map.def;
  if (def.players < 2 || def.players > 4) {
    throw new Error(`map ${def.id}: players must be 2..4, got ${def.players}`);
  }
  if (def.cities.length < def.players) {
    throw new Error(`map ${def.id}: needs at least one city per player`);
  }
  validateCities(map, def);

  const firstCapital = def.cities.find((c) => c.capital)!;
  const seen = reachable(map, firstCapital.y * map.w + firstCapital.x);
  for (const c of def.cities) {
    if (!seen[c.y * map.w + c.x]) {
      throw new Error(`map ${def.id}: city "${c.id}" is unreachable from capital "${firstCapital.id}"`);
    }
  }

  for (const s of def.startUnits ?? []) {
    if (s.owner < 1 || s.owner > def.players) {
      throw new Error(`map ${def.id}: startUnits owner ${s.owner} out of range`);
    }
    const tx = Math.round(s.x);
    const ty = Math.round(s.y);
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) {
      throw new Error(`map ${def.id}: startUnits at ${s.x},${s.y} is outside the map`);
    }
    if (map.terrain[ty * map.w + tx] === Terrain.Mountain) {
      throw new Error(`map ${def.id}: startUnits at ${s.x},${s.y} spawns inside a mountain`);
    }
  }
}

/** Parses and normalises a raw JSON map definition. */
export function parseMapDef(raw: unknown): MapDef {
  if (typeof raw !== 'object' || raw === null) throw new Error('map definition must be an object');
  const def = raw as MapDef;
  for (const field of ['id', 'name', 'size', 'cities'] as const) {
    if (def[field] === undefined) throw new Error(`map definition is missing "${field}"`);
  }
  if (!Array.isArray(def.cities)) throw new Error(`map ${def.id}: "cities" must be an array`);
  if (def.terrainGen) {
    for (const f of def.terrainGen.features) terrainKeyToId(f.terrain);
  }
  return def;
}
