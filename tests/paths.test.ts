/**
 * Drawn paths: simplification, lasso hit-testing, following and formations.
 *
 * The formation assertion is the one worth being exact about. A selection ordered
 * along a single curve must fan out across it, and the reason it can be checked to
 * the last decimal is that the lateral offsets are assigned once, at command time,
 * from `FORMATION_SPACING` — so the test can name the five offsets it expects
 * instead of measuring a blob and hoping.
 */

import { describe, expect, it } from 'vitest';
import type { Command } from '../src/core/types.ts';
import {
  ARRIVE_EPS,
  FORMATION_SPACING,
  KIND_SPEED,
  PATH_SIMPLIFY_EPS,
  TICK_SEC,
  UNIT_SPEED,
} from '../src/core/balance.ts';
import { Kind } from '../src/core/types.ts';
import {
  decimate,
  dist,
  pointInPolygon,
  pointSegmentDist,
  polygonBounds,
  polylineLength,
  rdpSimplify,
} from '../src/core/geometry.ts';
import { tick } from '../src/core/sim.ts';
import { emptyMap, makeWorld, placeLight, runTicks, seconds } from './helpers.ts';

const LANE_Y = 130;
const START_X = 60;
const END_X = 150;

/** A deterministic wobbly curve — no randomness anywhere in the suite. */
function sineCurve(points: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    pts.push(START_X + t * 120, LANE_Y + Math.sin(t * Math.PI * 3) * 18);
  }
  return pts;
}

/** Closest approach from a point to a flat polyline. */
function distanceToPolyline(poly: number[], px: number, py: number): number {
  let best = Infinity;
  for (let i = 2; i < poly.length; i += 2) {
    const d = pointSegmentDist(px, py, poly[i - 2]!, poly[i - 1]!, poly[i]!, poly[i + 1]!);
    if (d < best) best = d;
  }
  return best;
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

describe('PATHS', () => {
  it('rdpSimplify keeps both endpoints and every dropped point within tolerance', () => {
    const curve = sineCurve(400);
    const eps = PATH_SIMPLIFY_EPS;
    const simple = rdpSimplify(curve, eps);

    expect(simple.length).toBeGreaterThanOrEqual(4);
    expect(simple.length).toBeLessThan(curve.length);
    expect(simple[0]).toBe(curve[0]);
    expect(simple[1]).toBe(curve[1]);
    expect(simple[simple.length - 2]).toBe(curve[curve.length - 2]);
    expect(simple[simple.length - 1]).toBe(curve[curve.length - 1]);

    for (let i = 0; i < curve.length; i += 2) {
      expect(distanceToPolyline(simple, curve[i]!, curve[i + 1]!)).toBeLessThanOrEqual(eps + 1e-6);
    }
    // Shape survives: the simplified curve is nearly as long as the original.
    const before = polylineLength(curve);
    const after = polylineLength(simple);
    expect(after).toBeLessThanOrEqual(before + 1e-6);
    expect(after).toBeGreaterThan(before * 0.9);

    // A tighter tolerance keeps more vertices; a looser one keeps fewer.
    expect(rdpSimplify(curve, eps / 5).length).toBeGreaterThan(simple.length);
    expect(rdpSimplify(curve, eps * 8).length).toBeLessThan(simple.length);
    // Degenerate inputs come back untouched.
    expect(rdpSimplify([1, 2, 3, 4], eps)).toEqual([1, 2, 3, 4]);
    expect(rdpSimplify([1, 2], eps)).toEqual([1, 2]);
  });

  it('decimate thins a dense drag but keeps the last sample', () => {
    const curve = sineCurve(400);
    const thinned = decimate(curve, 6);
    expect(thinned.length).toBeLessThan(curve.length);
    expect(thinned[0]).toBe(curve[0]);
    expect(thinned[thinned.length - 2]).toBe(curve[curve.length - 2]);
    expect(thinned[thinned.length - 1]).toBe(curve[curve.length - 1]);
    for (let i = 2; i < thinned.length; i += 2) {
      const step = dist(thinned[i]!, thinned[i + 1]!, thinned[i - 2]!, thinned[i - 1]!);
      // The final point is force-kept, so only the interior spacing is guaranteed.
      if (i < thinned.length - 2) expect(step).toBeGreaterThanOrEqual(6 - 1e-6);
    }
  });

  it('pointInPolygon handles a concave lasso', () => {
    // A "U": two arms at x 0..10 and 30..40, joined along the bottom.
    const lasso = [0, 0, 40, 0, 40, 30, 30, 30, 30, 10, 10, 10, 10, 30, 0, 30];
    expect(polygonBounds(lasso)).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 30 });

    expect(pointInPolygon(lasso, 5, 20)).toBe(true); // left arm
    expect(pointInPolygon(lasso, 35, 20)).toBe(true); // right arm
    expect(pointInPolygon(lasso, 20, 5)).toBe(true); // the joining base
    expect(pointInPolygon(lasso, 20, 20)).toBe(false); // the notch between the arms
    expect(pointInPolygon(lasso, -5, 15)).toBe(false);
    expect(pointInPolygon(lasso, 20, 40)).toBe(false);
    // Fewer than three vertices cannot enclose anything.
    expect(pointInPolygon([0, 0, 10, 10], 5, 5)).toBe(false);
  });

  it('a unit follows a drawn path and comes to rest at the end', () => {
    const world = makeWorld(emptyMap());
    const slot = placeLight(world, 1, START_X, LANE_Y);
    const order: Command = {
      t: 'path',
      player: 1,
      units: [world.units.id[slot]!],
      pts: [START_X, LANE_Y, END_X, LANE_Y],
      append: false,
    };

    tick(world, [order]);
    expect(world.units.pathIdx[slot]!).toBeGreaterThanOrEqual(0);

    // Halfway through, progress matches the plains speed for a light to within a
    // few tenths of a second of acceleration.
    const half = seconds(4);
    runTicks(world, half - 1);
    const nominal = UNIT_SPEED * KIND_SPEED[Kind.Light]! * TICK_SEC * half;
    const travelled = world.units.x[slot]! - START_X;
    expect(travelled).toBeGreaterThan(nominal * 0.85);
    expect(travelled).toBeLessThanOrEqual(nominal);

    runTicks(world, seconds(15));
    expect(world.units.pathIdx[slot]!).toBe(-1);
    expect(world.units.pathPos[slot]!).toBe(0);
    expect(dist(world.units.x[slot]!, world.units.y[slot]!, END_X, LANE_Y)).toBeLessThan(
      ARRIVE_EPS + 2,
    );
    expect(Math.hypot(world.units.vx[slot]!, world.units.vy[slot]!)).toBeLessThan(0.05);
  });

  it('several units on one path march abreast instead of queueing', () => {
    const world = makeWorld(emptyMap());
    const count = 5;
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      slots.push(placeLight(world, 1, START_X, LANE_Y + (i - (count - 1) / 2) * 5.5));
    }

    tick(world, [
      {
        t: 'path',
        player: 1,
        units: slots.map((s) => world.units.id[s]!),
        pts: [START_X, LANE_Y, START_X + 140, LANE_Y],
        append: false,
      },
    ]);

    // Files are laid out across the path, centred on it, one spacing apart.
    const centre = (count - 1) / 2;
    for (let i = 0; i < count; i++) {
      expect(world.units.lateral[slots[i]!]!).toBeCloseTo((i - centre) * FORMATION_SPACING, 5);
    }
    expect(new Set(slots.map((s) => world.units.lateral[s]!)).size).toBe(count);

    runTicks(world, seconds(7));

    const across = spread(slots.map((s) => world.units.y[s]!));
    const along = spread(slots.map((s) => world.units.x[s]!));
    expect(across).toBeGreaterThanOrEqual(FORMATION_SPACING * (count - 2));
    expect(across).toBeGreaterThan(along);
    for (const s of slots) {
      expect(world.units.alive[s]!).toBe(1);
      expect(world.units.x[s]!).toBeGreaterThan(START_X + 40);
    }
  });

  it('stop halts a unit and clear only drops its orders', () => {
    const world = makeWorld(emptyMap());
    const a = placeLight(world, 1, START_X, LANE_Y);
    const b = placeLight(world, 1, START_X, LANE_Y + 20);
    const order = (slot: number): Command => ({
      t: 'path',
      player: 1,
      units: [world.units.id[slot]!],
      pts: [world.units.x[slot]!, world.units.y[slot]!, END_X, world.units.y[slot]!],
      append: false,
    });

    tick(world, [order(a), order(b)]);
    runTicks(world, seconds(1));
    expect(Math.hypot(world.units.vx[a]!, world.units.vy[a]!)).toBeGreaterThan(1);

    tick(world, [
      { t: 'stop', player: 1, units: [world.units.id[a]!] },
      { t: 'clear', player: 1, units: [world.units.id[b]!] },
    ]);
    expect(world.units.pathIdx[a]!).toBe(-1);
    expect(world.units.pathIdx[b]!).toBe(-1);
    // `stop` zeroes the velocity outright; `clear` lets the unit coast to a halt.
    expect(Math.hypot(world.units.vx[a]!, world.units.vy[a]!)).toBeLessThan(1);
    expect(Math.hypot(world.units.vx[b]!, world.units.vy[b]!)).toBeGreaterThan(1);
  });

  it('a path command for somebody else’s units is ignored', () => {
    const world = makeWorld(emptyMap());
    const mine = placeLight(world, 1, START_X, LANE_Y);
    tick(world, [
      {
        t: 'path',
        player: 2,
        units: [world.units.id[mine]!],
        pts: [START_X, LANE_Y, END_X, LANE_Y],
        append: false,
      },
    ]);
    expect(world.units.pathIdx[mine]!).toBe(-1);
  });
});
