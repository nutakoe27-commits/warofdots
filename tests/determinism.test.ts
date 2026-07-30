/**
 * The most important test in the project.
 *
 * Two runs of the same match, same seed, same command log, must agree bit for bit
 * after 5000 ticks. The command log is a pure function of the tick number and
 * addresses units by fixed ids, so it cannot smuggle any state of its own between
 * runs — and it deliberately covers paths, appends, stops, clears, production moves
 * and city toggles, because an idle world exercises almost none of the code that
 * tends to hold a hidden `Math.random()`.
 *
 * The second test steps two worlds alternately. Several core modules keep
 * module-level scratch buffers (the influence heap, the A* grids, the combat damage
 * accumulator) and any of them carrying a value across a world boundary would show
 * up here and nowhere else.
 */

import { describe, expect, it } from 'vitest';
import type { Command, World } from '../src/core/types.ts';
import { hashHex, hashWorld } from '../src/core/hash.ts';
import { tick } from '../src/core/sim.ts';
import { getMapRuntime } from '../src/content/registry.ts';
import { loadMapsFromDisk } from '../tools/maps.ts';
import { makeWorld } from './helpers.ts';

loadMapsFromDisk();

const TICKS = 5000;
const CHECKPOINTS = [500, 1000, 2000, 3000, 4000, TICKS];
const SEED = 0xc0ffee;
const MAP_ID = 'crossing';

/**
 * Unit ids of the starting armies. `crossing` spawns player 1's ten units first, so
 * ids 1..10 are player 1's and 11..20 are player 2's. Naming ids rather than reading
 * them out of a world keeps the log independent of the state it is driving.
 */
const P1_VANGUARD = [1, 2, 3, 4, 5];
const P1_REAR = [6, 7, 8, 9, 10];
const P2_VANGUARD = [11, 12, 13, 14];
const P2_REAR = [15, 16, 17, 18];

/** Curves that cross the river in the middle of the map, so ships happen too. */
const EASTWARD = [186, 490, 300, 500, 420, 512, 520, 514];
const EASTWARD_MORE = [520, 514, 600, 470, 680, 430];
const WESTWARD = [842, 538, 700, 530, 560, 520];
const SOUTHWARD = [842, 538, 800, 640, 700, 760, 640, 824];

function path(player: number, units: number[], pts: number[], append = false): Command {
  return { t: 'path', player, units, pts, append };
}

/** The scripted match. A pure function of the tick number — no closure state. */
function commandsForTick(t: number): Command[] {
  switch (t) {
    case 1:
      return [
        { t: 'production', player: 1, threshold: 1, heavyShare: 0.4 },
        { t: 'production', player: 2, threshold: 0.75, heavyShare: 0.15 },
      ];
    case 40:
      return [path(1, P1_VANGUARD, EASTWARD)];
    case 120:
      return [path(2, P2_VANGUARD, WESTWARD)];
    case 300:
      return [{ t: 'cityActive', player: 1, city: 0, active: false }];
    case 600:
      return [path(1, P1_VANGUARD, EASTWARD_MORE, true)];
    case 900:
      return [{ t: 'stop', player: 1, units: P1_VANGUARD.slice(3) }];
    case 1200:
      return [
        { t: 'cityActive', player: 1, city: 0, active: true },
        { t: 'production', player: 1, threshold: 0.5, heavyShare: 0.8 },
      ];
    case 1800:
      return [path(1, P1_REAR, EASTWARD)];
    case 2000:
      return [{ t: 'clear', player: 2, units: P2_VANGUARD }];
    case 2600:
      return [path(2, P2_REAR, SOUTHWARD)];
    case 3000:
      return [{ t: 'production', player: 2, threshold: 1, heavyShare: 0.5 }];
    case 3600:
      return [{ t: 'cityActive', player: 2, city: 1, active: false }];
    case 4200:
      return [path(1, [...P1_VANGUARD, ...P1_REAR], WESTWARD)];
    case 4800:
      return [{ t: 'cityActive', player: 2, city: 1, active: true }];
    default:
      return [];
  }
}

function newWorld(seed = SEED): World {
  return makeWorld(getMapRuntime(MAP_ID), {
    seed,
    production: true,
    unitCapacity: 512,
  });
}

interface Trace {
  hash: string;
  marks: string[];
  tick: number;
  produced: number;
  lost: number;
}

function trace(world: World): Trace {
  return {
    hash: hashHex(world),
    marks: [],
    tick: world.tick,
    produced: world.stats.players[1]!.produced + world.stats.players[2]!.produced,
    lost: world.stats.players[1]!.lost + world.stats.players[2]!.lost,
  };
}

function runScripted(seed = SEED): Trace {
  const world = newWorld(seed);
  const marks: string[] = [];
  for (let t = 1; t <= TICKS; t++) {
    tick(world, commandsForTick(t));
    if (CHECKPOINTS.includes(t)) marks.push(hashHex(world));
  }
  return { ...trace(world), marks };
}

let reference: Trace | null = null;
function referenceTrace(): Trace {
  if (reference === null) reference = runScripted();
  return reference;
}

describe('DETERMINISM', () => {
  it('two runs of the same scripted match agree bit for bit', () => {
    const first = referenceTrace();
    const second = runScripted();

    expect(second.marks).toEqual(first.marks);
    expect(second.hash).toBe(first.hash);
    expect(second.tick).toBe(TICKS);

    // A match that did nothing would agree trivially, so check it was a real one.
    expect(first.produced).toBeGreaterThan(20);
    expect(first.lost).toBeGreaterThan(0);
    expect(first.marks.length).toBe(CHECKPOINTS.length);
    expect(new Set(first.marks).size).toBe(CHECKPOINTS.length);
  });

  it('stepping two worlds alternately gives the same result as running them apart', () => {
    const a = newWorld();
    const b = newWorld();
    const marks: string[] = [];

    for (let t = 1; t <= TICKS; t++) {
      const commands = commandsForTick(t);
      tick(a, commands);
      tick(b, commands);
      // Divergence is cheapest to diagnose the tick it appears, not 4000 later.
      if (CHECKPOINTS.includes(t)) {
        expect(hashHex(a)).toBe(hashHex(b));
        marks.push(hashHex(a));
      }
    }

    expect(hashHex(a)).toBe(hashHex(b));
    expect(marks).toEqual(referenceTrace().marks);
  });

  it('a different seed gives a different world', () => {
    const short = (seed: number): string => {
      const world = newWorld(seed);
      for (let t = 1; t <= 600; t++) tick(world, commandsForTick(t));
      return hashHex(world);
    };
    expect(short(SEED)).not.toBe(short(SEED + 1));
    // Same seed twice, short run: still identical.
    expect(short(SEED)).toBe(short(SEED));
  });

  it('the hash covers state a bug would move', () => {
    const world = newWorld();
    for (let t = 1; t <= 200; t++) tick(world, commandsForTick(t));
    const before = hashWorld(world);

    const revert = world.units.hp[0]!;
    world.units.hp[0] = revert - 0.5;
    expect(hashWorld(world)).not.toBe(before);
    world.units.hp[0] = revert;
    expect(hashWorld(world)).toBe(before);

    world.cities[0]!.eco += 1;
    expect(hashWorld(world)).not.toBe(before);
    world.cities[0]!.eco -= 1;

    const owner = world.influence.owner[0]!;
    world.influence.owner[0] = owner === 1 ? 2 : 1;
    expect(hashWorld(world)).not.toBe(before);
    world.influence.owner[0] = owner;

    expect(hashHex(world)).toMatch(/^[0-9a-f]{8}$/);
  });
});
