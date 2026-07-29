/**
 * Contact combat.
 *
 * The rule that shapes the whole game: **a unit damages exactly one enemy**, even
 * when three are touching it. Three units on one therefore deal 3× while taking
 * 1× — the "attack surface" that makes local numerical advantage decisive and
 * makes cycling wounded units in and out worth the effort.
 *
 * Damage is resolved simultaneously through an accumulator, so no unit gains an
 * advantage from where it happens to sit in the slot array.
 */

import type { World } from './types.ts';
import { B, CONTACT_R, MOVING_EPS } from './balance.ts';
import { damageMul, terrainAt } from './terrain.ts';
import { makeCellRange, queryInto } from './spatial.ts';
import { effectiveMaxHp, freeUnit } from './units.ts';
import { releasePath } from './paths.ts';
import { MAX_CONTACT_R } from './movement.ts';

const range = makeCellRange();
const neighbours = new Int32Array(1024);

let damageBuf = new Float32Array(0);
let attackedBuf = new Uint8Array(0);

function ensureScratch(n: number): void {
  if (damageBuf.length < n) {
    damageBuf = new Float32Array(n);
    attackedBuf = new Uint8Array(n);
  }
}

export function healthFactor(hp: number): number {
  return Math.pow(Math.max(0, hp), B.HEALTH_EXP);
}

export function moraleFactor(morale: number): number {
  return B.MORALE_FLOOR + (1 - B.MORALE_FLOOR) * Math.max(0, Math.min(1, morale));
}

export function inContact(world: World, a: number, b: number): boolean {
  const u = world.units;
  const reach = CONTACT_R[u.kind[a]!]! + CONTACT_R[u.kind[b]!]!;
  const dx = u.x[a]! - u.x[b]!;
  const dy = u.y[a]! - u.y[b]!;
  return dx * dx + dy * dy <= reach * reach;
}

/** Damage per second unit `slot` currently deals to whatever it is fighting. */
export function damagePerSec(world: World, slot: number): number {
  const u = world.units;
  const kind = u.kind[slot]!;
  const terrain = terrainAt(world.map, u.x[slot]!, u.y[slot]!);
  const moving = Math.hypot(u.vx[slot]!, u.vy[slot]!) > MOVING_EPS;
  return (
    B.BASE_DAMAGE[kind]! *
    healthFactor(u.hp[slot]!) *
    moraleFactor(u.morale[slot]!) *
    damageMul(terrain, kind) *
    (moving ? B.MOVING_PENALTY : 1)
  );
}

/**
 * Keeps the current target while it is alive and still touching, otherwise picks
 * the nearest enemy in contact. Sticky targets model being locked in a melee and
 * stop damage from flickering between neighbours tick to tick.
 */
function pickTarget(world: World, slot: number): number {
  const u = world.units;
  const prev = u.target[slot]!;
  if (prev >= 0 && u.alive[prev] && u.owner[prev] !== u.owner[slot] && inContact(world, slot, prev)) {
    return prev;
  }

  const reach = CONTACT_R[u.kind[slot]!]! + MAX_CONTACT_R;
  const count = queryInto(world.spatial, u.x[slot]!, u.y[slot]!, reach, neighbours, range);
  let best = -1;
  let bestD = Infinity;
  let bestId = 0;
  for (let n = 0; n < count; n++) {
    const j = neighbours[n]!;
    if (j === slot || u.owner[j] === u.owner[slot]) continue;
    const r = CONTACT_R[u.kind[slot]!]! + CONTACT_R[u.kind[j]!]!;
    const dx = u.x[slot]! - u.x[j]!;
    const dy = u.y[slot]! - u.y[j]!;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) continue;
    // Distance first, then lowest id — a tie must not depend on bucket order.
    if (d2 < bestD - 1e-6 || (Math.abs(d2 - bestD) <= 1e-6 && u.id[j]! < bestId)) {
      bestD = d2;
      best = j;
      bestId = u.id[j]!;
    }
  }
  return best;
}

function killUnit(world: World, slot: number): void {
  const u = world.units;
  world.events.push({
    t: 'death',
    x: u.x[slot]!,
    y: u.y[slot]!,
    owner: u.owner[slot]!,
    kind: u.kind[slot]!,
  });
  world.stats.players[u.owner[slot]!]!.lost++;
  releasePath(world.paths, u.pathIdx[slot]!);
  freeUnit(u, slot);
}

export function stepCombat(world: World, dt: number): void {
  const u = world.units;
  const n = u.capacity;
  ensureScratch(n);
  damageBuf.fill(0, 0, n);
  attackedBuf.fill(0, 0, n);

  for (let i = 0; i < n; i++) {
    if (!u.alive[i]) {
      u.target[i] = -1;
      u.inCombat[i] = 0;
      continue;
    }
    const target = pickTarget(world, i);
    u.target[i] = target;
    if (target < 0) continue;
    damageBuf[target]! += damagePerSec(world, i) * dt;
    attackedBuf[target] = 1;
    attackedBuf[i] = 1;
  }

  for (let i = 0; i < n; i++) {
    if (!u.alive[i]) continue;
    const fighting = attackedBuf[i] === 1;
    u.inCombat[i] = fighting ? 1 : 0;
    if (!fighting) continue;
    u.morale[i] = Math.max(0, u.morale[i]! - B.MORALE_DRAIN * dt);
    const dmg = damageBuf[i]!;
    if (dmg > 0) u.hp[i]! -= dmg / effectiveMaxHp(u.kind[i]!);
  }

  for (let i = 0; i < n; i++) {
    if (u.alive[i] && u.hp[i]! <= 0) killUnit(world, i);
  }
}

/** Applies non-combat HP loss and kills the unit if it runs out. Shared by attrition. */
export function applyAttrition(world: World, slot: number, hpLoss: number): void {
  const u = world.units;
  if (hpLoss <= 0 || !u.alive[slot]) return;
  u.hp[slot]! -= hpLoss;
  if (u.hp[slot]! <= 0) killUnit(world, slot);
}
