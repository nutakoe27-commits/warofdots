/**
 * Path following, local separation and the land/water form change.
 *
 * Units steer toward a look-ahead point on their shared polyline, offset
 * laterally so a group ordered along one drawn curve marches as a formation
 * rather than in single file. Progress along the path advances by the distance
 * actually covered, projected onto the path tangent, so a unit shoved into a
 * mountain stalls instead of being dragged along an invisible rail.
 */

import { Terrain, isShip, shipFormOf, footFormOf } from './types.ts';
import type { World } from './types.ts';
import {
  ARRIVE_EPS,
  B,
  COMBAT_SPEED_MULT,
  CONTACT_R,
  DRAW_R,
  PATH_LOOKAHEAD,
  PUSH_COMBAT_MULT,
} from './balance.ts';
import { speedMul, terrainAt } from './terrain.ts';
import { makePathSample, releasePath, samplePath, pathLength } from './paths.ts';
import { makeCellRange, queryInto } from './spatial.ts';
import { clamp } from './geometry.ts';

const sample = makePathSample();
const range = makeCellRange();
const neighbours = new Int32Array(512);

/** Desired velocity for a unit, written into `desired`. */
const desired = { x: 0, y: 0, speed: 0 };
/** Fractions of a formation offset to try before giving up and hugging the centreline. */
const LATERAL_FALLBACKS = [1, 0.6, 0.3];

function currentSpeed(world: World, slot: number): number {
  const u = world.units;
  const kind = u.kind[slot]!;
  const terrain = terrainAt(world.map, u.x[slot]!, u.y[slot]!);
  const base = B.UNIT_SPEED * B.KIND_SPEED[kind]! * speedMul(terrain, kind);
  return u.inCombat[slot] ? base * COMBAT_SPEED_MULT : base;
}

/**
 * Shrinks a formation's lateral offset when it would put the unit somewhere it has
 * no business being.
 *
 * A wide line crossing a nine-tile bridge would otherwise walk its flank files
 * straight into the river: the centreline is on the bridge, but ±18 world units of
 * spread is not. Rather than refuse the order, the offset collapses toward the
 * centreline, so the formation narrows to cross and spreads again on the far side.
 */
function usableLateral(world: World, slot: number, lateral: number): number {
  if (lateral === 0) return 0;
  const kind = world.units.kind[slot]!;
  // A ship is already in the water; only foot units need protecting from it.
  const avoidWater = !isShip(kind);
  const nx = -sample.ty;
  const ny = sample.tx;
  for (let i = 0; i < LATERAL_FALLBACKS.length; i++) {
    const scaled = lateral * LATERAL_FALLBACKS[i]!;
    const t = terrainAt(world.map, sample.x + nx * scaled, sample.y + ny * scaled);
    if (t === Terrain.Mountain) continue;
    if (avoidWater && t === Terrain.Water) continue;
    return scaled;
  }
  return 0;
}

function computeDesired(world: World, slot: number): void {
  const u = world.units;
  const pathIdx = u.pathIdx[slot]!;
  desired.x = 0;
  desired.y = 0;
  desired.speed = currentSpeed(world, slot);
  if (pathIdx < 0) return;

  const total = pathLength(world.paths, pathIdx);
  samplePath(world.paths, pathIdx, u.pathPos[slot]! + PATH_LOOKAHEAD, sample);
  const lateral = usableLateral(world, slot, u.lateral[slot]!);
  const tx = sample.x + -sample.ty * lateral;
  const ty = sample.y + sample.tx * lateral;

  const dx = tx - u.x[slot]!;
  const dy = ty - u.y[slot]!;
  const len = Math.hypot(dx, dy);
  if (u.pathPos[slot]! >= total - ARRIVE_EPS && len <= ARRIVE_EPS) {
    releasePath(world.paths, pathIdx);
    u.pathIdx[slot] = -1;
    u.pathPos[slot] = 0;
    u.lateral[slot] = 0;
    return;
  }
  if (len > 1e-4) {
    desired.x = (dx / len) * desired.speed;
    desired.y = (dy / len) * desired.speed;
  }
}

/** Separation impulse, accumulated into `vx`/`vy`. Weakened in combat so fronts hold. */
function applySeparation(world: World, slot: number, dt: number): void {
  const u = world.units;
  const myR = DRAW_R[u.kind[slot]!]!;
  const reach = myR * 2 + 2;
  const count = queryInto(world.spatial, u.x[slot]!, u.y[slot]!, reach, neighbours, range);
  let px = 0;
  let py = 0;
  for (let n = 0; n < count; n++) {
    const j = neighbours[n]!;
    if (j === slot) continue;
    const minD = myR + DRAW_R[u.kind[j]!]!;
    let dx = u.x[slot]! - u.x[j]!;
    let dy = u.y[slot]! - u.y[j]!;
    let d = Math.hypot(dx, dy);
    if (d >= minD) continue;
    if (d < 1e-4) {
      // Perfectly stacked units need a deterministic tie-break, not a random jitter.
      dx = ((slot & 1) === 0 ? 1 : -1) * 0.01;
      dy = ((slot & 2) === 0 ? 1 : -1) * 0.01;
      d = Math.hypot(dx, dy);
    }
    const push = (1 - d / minD) / d;
    px += dx * push;
    py += dy * push;
  }
  if (px === 0 && py === 0) return;
  const strength = B.PUSH_STRENGTH * (u.inCombat[slot] ? PUSH_COMBAT_MULT : 1) * dt;
  u.vx[slot]! += px * strength;
  u.vy[slot]! += py * strength;
}

/** Moves the unit, sliding along impassable tiles rather than stopping dead. */
function integrate(world: World, slot: number, dt: number): void {
  const u = world.units;
  const map = world.map;
  const x = u.x[slot]!;
  const y = u.y[slot]!;
  let nx = x + u.vx[slot]! * dt;
  let ny = y + u.vy[slot]! * dt;
  nx = clamp(nx, 0.5, map.worldW - 0.5);
  ny = clamp(ny, 0.5, map.worldH - 0.5);

  if (terrainAt(map, nx, ny) === Terrain.Mountain) {
    if (terrainAt(map, nx, y) !== Terrain.Mountain) {
      ny = y;
    } else if (terrainAt(map, x, ny) !== Terrain.Mountain) {
      nx = x;
    } else {
      nx = x;
      ny = y;
    }
  }

  const movedX = nx - x;
  const movedY = ny - y;
  u.x[slot] = nx;
  u.y[slot] = ny;

  const pathIdx = u.pathIdx[slot]!;
  if (pathIdx >= 0) {
    const along = movedX * sample.tx + movedY * sample.ty;
    if (along > 0) {
      const total = pathLength(world.paths, pathIdx);
      u.pathPos[slot] = Math.min(total, u.pathPos[slot]! + along);
    }
  }
}

/** Counts time spent in the wrong medium and flips the unit's form at the threshold. */
function updateForm(world: World, slot: number, dt: number): void {
  const u = world.units;
  const kind = u.kind[slot]!;
  const inWater = terrainAt(world.map, u.x[slot]!, u.y[slot]!) === Terrain.Water;
  const ship = isShip(kind);
  const wrongMedium = ship !== inWater;

  if (!wrongMedium) {
    u.waterTime[slot] = Math.max(0, u.waterTime[slot]! - dt);
    return;
  }
  const t = u.waterTime[slot]! + dt;
  if (t < B.SHIP_CONVERT_SEC) {
    u.waterTime[slot] = t;
    return;
  }
  u.waterTime[slot] = 0;
  u.kind[slot] = inWater ? shipFormOf(kind) : footFormOf(kind);
  world.events.push({
    t: 'convert',
    x: u.x[slot]!,
    y: u.y[slot]!,
    owner: u.owner[slot]!,
    toShip: inWater,
  });
}

export function stepMovement(world: World, dt: number): void {
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    computeDesired(world, i);
    const rate = Math.min(1, B.TURN_RATE[u.kind[i]!]! * (dt / 0.05));
    u.vx[i]! += (desired.x - u.vx[i]!) * rate;
    u.vy[i]! += (desired.y - u.vy[i]!) * rate;
    applySeparation(world, i, dt);
    integrate(world, i, dt);
    updateForm(world, i, dt);
  }
}

/** Speed at which a unit currently counts as "moving" for the combat penalty. */
export function isMoving(world: World, slot: number): boolean {
  const u = world.units;
  return Math.hypot(u.vx[slot]!, u.vy[slot]!) > 0;
}

/** Largest contact radius in play. Combat queries use it to size the search disc. */
export const MAX_CONTACT_R = Math.max(...CONTACT_R);
