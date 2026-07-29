/**
 * Selection and control-group state.
 *
 * Units are held by stable id, never by slot, so a selection survives other units
 * dying and their slots being recycled.
 */

import type { World } from '../core/types.ts';
import { Kind } from '../core/types.ts';
import { slotOfId } from '../core/units.ts';

export interface SelectionState {
  /** Selected unit ids. */
  units: Set<number>;
  /** Control groups 1..9. */
  groups: Map<number, number[]>;
  /** World-space polygon of the lasso currently being drawn, or null. */
  lasso: number[] | null;
  /** World-space path currently being drawn with the right button, or null. */
  drawing: number[] | null;
  /** True while the lasso is adding to the existing selection. */
  lassoAdditive: boolean;
  /** City index under the cursor, or -1. */
  hoverCity: number;
}

export function createSelection(): SelectionState {
  return {
    units: new Set<number>(),
    groups: new Map<number, number[]>(),
    lasso: null,
    drawing: null,
    lassoAdditive: false,
    hoverCity: -1,
  };
}

/** Live slots for the current selection, skipping anything that has died. */
export function selectionSlots(world: World, sel: SelectionState): number[] {
  const out: number[] = [];
  for (const id of sel.units) {
    const slot = slotOfId(world.units, id);
    if (slot >= 0 && world.units.alive[slot]) out.push(slot);
  }
  return out;
}

/** Drops dead or foreign units from the selection and from every control group. */
export function pruneSelection(world: World, sel: SelectionState, player: number): void {
  const u = world.units;
  const stillOurs = (id: number): boolean => {
    const slot = slotOfId(u, id);
    return slot >= 0 && u.alive[slot] === 1 && u.owner[slot] === player;
  };
  for (const id of [...sel.units]) if (!stillOurs(id)) sel.units.delete(id);
  for (const [key, ids] of sel.groups) {
    const kept = ids.filter(stillOurs);
    if (kept.length === 0) sel.groups.delete(key);
    else sel.groups.set(key, kept);
  }
}

export function selectAll(world: World, sel: SelectionState, player: number): void {
  sel.units.clear();
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (u.alive[i] && u.owner[i] === player) sel.units.add(u.id[i]!);
  }
}

/** `Ctrl+H` / `Ctrl+L`: select the whole army of one family. */
export function selectByKind(
  world: World,
  sel: SelectionState,
  player: number,
  heavy: boolean,
): void {
  sel.units.clear();
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== player) continue;
    const isHeavy = u.kind[i] === Kind.Heavy || u.kind[i] === Kind.HeavyShip;
    if (isHeavy === heavy) sel.units.add(u.id[i]!);
  }
}

export function assignGroup(sel: SelectionState, key: number): void {
  if (sel.units.size === 0) sel.groups.delete(key);
  else sel.groups.set(key, [...sel.units]);
}

export function recallGroup(sel: SelectionState, key: number): void {
  const ids = sel.groups.get(key);
  if (!ids) return;
  sel.units.clear();
  for (const id of ids) sel.units.add(id);
}
