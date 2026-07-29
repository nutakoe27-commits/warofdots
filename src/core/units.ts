/**
 * Structure-of-arrays unit storage with slot recycling.
 *
 * Slots are never spliced out: death pushes the slot onto a freelist and the next
 * spawn reuses it. That keeps the hot loops over `capacity` cache-friendly and
 * means a unit's slot index is stable for exactly one tick — everything that
 * crosses a tick boundary refers to units by `id`.
 */

import { Kind } from './types.ts';
import type { UnitStore, World } from './types.ts';
import { B } from './balance.ts';

export const DEFAULT_UNIT_CAPACITY = 2048;

export function createUnitStore(capacity = DEFAULT_UNIT_CAPACITY): UnitStore {
  const store: UnitStore = {
    count: 0,
    capacity,
    id: new Int32Array(capacity),
    owner: new Uint8Array(capacity),
    kind: new Uint8Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    hp: new Float32Array(capacity),
    morale: new Float32Array(capacity),
    pathIdx: new Int32Array(capacity).fill(-1),
    pathPos: new Float32Array(capacity),
    waterTime: new Float32Array(capacity),
    inCombat: new Uint8Array(capacity),
    alive: new Uint8Array(capacity),
    supplied: new Uint8Array(capacity),
    target: new Int32Array(capacity).fill(-1),
    lateral: new Float32Array(capacity),
    pocket: new Int32Array(capacity).fill(-1),
    encircled: new Uint8Array(capacity),
    bornTick: new Int32Array(capacity),
    freelist: [],
    nextId: 1,
    idToSlot: new Map<number, number>(),
  };
  // Descending so the first allocations come out as slots 0, 1, 2 …
  for (let i = capacity - 1; i >= 0; i--) store.freelist.push(i);
  return store;
}

export function effectiveMaxHp(kind: number): number {
  return B.MAX_HP[kind]!;
}

export function slotOfId(u: UnitStore, id: number): number {
  const slot = u.idToSlot.get(id);
  return slot === undefined ? -1 : slot;
}

/** Allocates a unit. Returns its slot, or -1 when the store is full. */
export function allocUnit(
  u: UnitStore,
  owner: number,
  kind: number,
  x: number,
  y: number,
  tick: number,
): number {
  const slot = u.freelist.pop();
  if (slot === undefined) return -1;

  const id = u.nextId++;
  u.id[slot] = id;
  u.owner[slot] = owner;
  u.kind[slot] = kind;
  u.x[slot] = x;
  u.y[slot] = y;
  u.vx[slot] = 0;
  u.vy[slot] = 0;
  u.hp[slot] = 1;
  u.morale[slot] = 1;
  u.pathIdx[slot] = -1;
  u.pathPos[slot] = 0;
  u.waterTime[slot] = 0;
  u.inCombat[slot] = 0;
  u.alive[slot] = 1;
  u.supplied[slot] = 1;
  u.target[slot] = -1;
  u.lateral[slot] = 0;
  u.pocket[slot] = -1;
  u.encircled[slot] = 0;
  u.bornTick[slot] = tick;
  u.idToSlot.set(id, slot);
  u.count++;
  return slot;
}

/** Releases a slot. The caller is responsible for releasing the unit's path first. */
export function freeUnit(u: UnitStore, slot: number): void {
  if (!u.alive[slot]) return;
  u.alive[slot] = 0;
  u.idToSlot.delete(u.id[slot]!);
  u.id[slot] = 0;
  u.owner[slot] = 0;
  u.kind[slot] = Kind.Light;
  u.hp[slot] = 0;
  u.morale[slot] = 0;
  u.vx[slot] = 0;
  u.vy[slot] = 0;
  u.pathIdx[slot] = -1;
  u.pathPos[slot] = 0;
  u.inCombat[slot] = 0;
  u.target[slot] = -1;
  u.pocket[slot] = -1;
  u.encircled[slot] = 0;
  u.waterTime[slot] = 0;
  u.lateral[slot] = 0;
  u.count--;
  u.freelist.push(slot);
}

export function armySize(w: World, player: number): number {
  const u = w.units;
  let n = 0;
  for (let i = 0; i < u.capacity; i++) if (u.alive[i] && u.owner[i] === player) n++;
  return n;
}

export function countByKind(w: World, player: number): { light: number; heavy: number } {
  const u = w.units;
  let light = 0;
  let heavy = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== player) continue;
    const k = u.kind[i]!;
    if (k === Kind.Heavy || k === Kind.HeavyShip) heavy++;
    else light++;
  }
  return { light, heavy };
}

/** Mean HP and morale of a player's army. Returns zeros for an empty army. */
export function armyCondition(w: World, player: number): { hp: number; morale: number } {
  const u = w.units;
  let hp = 0;
  let morale = 0;
  let n = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== player) continue;
    hp += u.hp[i]!;
    morale += u.morale[i]!;
    n++;
  }
  return n === 0 ? { hp: 0, morale: 0 } : { hp: hp / n, morale: morale / n };
}

/**
 * Combat strength proxy used by bots and the score screen: damage output scaled
 * by how much punishment the unit can still absorb.
 */
export function unitStrength(u: UnitStore, slot: number): number {
  const kind = u.kind[slot]!;
  return B.BASE_DAMAGE[kind]! * Math.sqrt(u.hp[slot]!) * B.MAX_HP[kind]! * u.hp[slot]!;
}

export function armyStrength(w: World, player: number): number {
  const u = w.units;
  let total = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (u.alive[i] && u.owner[i] === player) total += unitStrength(u, i);
  }
  return total;
}
