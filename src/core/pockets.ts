/**
 * Supply pockets: connected components of a player's territory.
 *
 * A component holding at least one of its owner's cities is a working pocket with
 * its own treasury and its own supply cap. A component with no city is a bag of
 * units that has been cut off, and it bleeds. Because a pocket is just a component
 * of the influence grid, encirclement falls out of the same pass that draws the
 * map — there is no separate "am I surrounded" test anywhere in the codebase.
 */

import type { Pocket, World } from './types.ts';
import { B } from './balance.ts';
import { cellAt } from './influence.ts';
import { cityAt } from './terrain.ts';

let queue = new Int32Array(1024);

function ensureQueue(n: number): void {
  if (queue.length < n) queue = new Int32Array(n);
}

function newPocket(id: number, player: number): Pocket {
  return {
    id,
    player,
    cities: [],
    units: [],
    cells: 0,
    eco: 0,
    supplyCap: 0,
    supplyUsed: 0,
    ecoRate: 0,
  };
}

/** Labels 4-connected components of same-owner cells. */
function labelComponents(world: World): Pocket[] {
  const inf = world.influence;
  const cells = inf.cw * inf.ch;
  ensureQueue(cells);
  inf.pocketId.fill(-1);
  const pockets: Pocket[] = [];

  for (let seed = 0; seed < cells; seed++) {
    const owner = inf.owner[seed]!;
    if (owner === 0 || inf.pocketId[seed]! >= 0) continue;

    const pocket = newPocket(pockets.length, owner);
    pockets.push(pocket);
    let head = 0;
    let tail = 0;
    inf.pocketId[seed] = pocket.id;
    queue[tail++] = seed;

    while (head < tail) {
      const cell = queue[head++]!;
      pocket.cells++;
      const cx = cell % inf.cw;
      const cy = (cell / inf.cw) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= inf.cw || ny >= inf.ch) continue;
        const ncell = ny * inf.cw + nx;
        if (inf.owner[ncell] !== owner || inf.pocketId[ncell]! >= 0) continue;
        inf.pocketId[ncell] = pocket.id;
        queue[tail++] = ncell;
      }
    }
  }
  return pockets;
}

/**
 * Attaches each city to a pocket. A city whose own cell is contested falls back to
 * an adjacent owned cell, and failing that gets a pocket of its own so its
 * treasury and supply keep working while the front sits on top of it.
 */
function attachCities(world: World, pockets: Pocket[]): void {
  const inf = world.influence;
  for (const city of world.cities) {
    city.pocket = -1;
    if (city.owner === 0) continue;

    const cell = cellAt(world, city.x, city.y);
    let pid = inf.owner[cell] === city.owner ? inf.pocketId[cell]! : -1;
    if (pid < 0) {
      const cx = cell % inf.cw;
      const cy = (cell / inf.cw) | 0;
      for (let dy = -1; dy <= 1 && pid < 0; dy++) {
        for (let dx = -1; dx <= 1 && pid < 0; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= inf.cw || ny >= inf.ch) continue;
          const ncell = ny * inf.cw + nx;
          if (inf.owner[ncell] === city.owner) pid = inf.pocketId[ncell]!;
        }
      }
    }
    if (pid < 0) {
      const pocket = newPocket(pockets.length, city.owner);
      pockets.push(pocket);
      pid = pocket.id;
    }
    pockets[pid]!.cities.push(city.index);
    city.pocket = pid;
  }
}

function markSupplied(world: World, pockets: Pocket[]): void {
  const inf = world.influence;
  for (let cell = 0; cell < inf.supplied.length; cell++) {
    const pid = inf.pocketId[cell]!;
    inf.supplied[cell] = pid >= 0 && pockets[pid]!.cities.length > 0 ? 1 : 0;
  }
}

/**
 * Assigns units to pockets. A unit standing inside one of its own cities is always
 * supplied, whatever the influence grid says — losing the garrison of a city you
 * still hold to a rounding artefact would be indefensible.
 */
function attachUnits(world: World, pockets: Pocket[]): void {
  const inf = world.influence;
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    const owner = u.owner[i]!;
    let pid = -1;

    const cell = cellAt(world, u.x[i]!, u.y[i]!);
    if (inf.owner[cell] === owner) {
      const candidate = inf.pocketId[cell]!;
      if (candidate >= 0 && pockets[candidate]!.cities.length > 0) pid = candidate;
    }
    if (pid < 0) {
      const ci = cityAt(world.map, u.x[i]!, u.y[i]!);
      if (ci >= 0 && world.cities[ci]!.owner === owner) pid = world.cities[ci]!.pocket;
    }

    u.pocket[i] = pid;
    u.supplied[i] = pid >= 0 ? 1 : 0;
    u.encircled[i] = pid >= 0 ? 0 : 1;
    if (pid >= 0) pockets[pid]!.units.push(i);
  }
}

function finalise(world: World, pockets: Pocket[]): void {
  for (const pocket of pockets) {
    let eco = 0;
    for (const ci of pocket.cities) eco += world.cities[ci]!.eco;
    pocket.eco = eco;
    pocket.supplyCap = pocket.cities.length * B.SUPPLY_PER_CITY;
    pocket.supplyUsed = pocket.units.length;
  }
}

/** Rebuilds every pocket, then re-tags cities and units. Call after `computeInfluence`. */
export function computePockets(world: World): void {
  const pockets = labelComponents(world);
  attachCities(world, pockets);
  markSupplied(world, pockets);
  world.influence.pockets = pockets;
  refreshPocketUnits(world);
}

/**
 * Re-assigns units to the existing pockets. Runs every tick, unlike the component
 * labelling: pocket membership is what drives starvation and encirclement damage,
 * and a slot recycled by production must never inherit the dead unit's pocket.
 */
export function refreshPocketUnits(world: World): void {
  const pockets = world.influence.pockets;
  for (const pocket of pockets) pocket.units.length = 0;
  attachUnits(world, pockets);
  finalise(world, pockets);
}

export function pocketsOf(world: World, player: number): Pocket[] {
  return world.influence.pockets.filter((p) => p.player === player);
}

/** The pocket a unit belongs to, or null when it is cut off. */
export function pocketOfUnit(world: World, slot: number): Pocket | null {
  const pid = world.units.pocket[slot]!;
  return pid >= 0 ? world.influence.pockets[pid]! ?? null : null;
}
