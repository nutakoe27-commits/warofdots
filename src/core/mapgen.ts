/**
 * Deterministic procedural terrain.
 *
 * A map can be authored either as a PNG palette mask or as a recipe of brushes.
 * The recipe path exists because the headless tuner (`npm run sim`) runs in Node
 * with zero runtime dependencies, and pulling in a PNG decoder just to run 100
 * bot-vs-bot matches would be the tail wagging the dog (ADR-003).
 */

import { Terrain } from './types.ts';
import type { MapDef, TerrainFeatureDef } from './types.ts';
import { terrainKeyToId } from './terrain.ts';
import { makeRng, rand, randRange } from './rng.ts';
import type { RngState } from './types.ts';
import { clamp } from './geometry.ts';

interface Grid {
  w: number;
  h: number;
  t: Uint8Array;
}

function stampDisc(g: Grid, cx: number, cy: number, r: number, terrain: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(g.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(g.h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) g.t[y * g.w + x] = terrain;
    }
  }
}

/** A circle whose radius wobbles with three fixed harmonics — cheap organic edges. */
function stampBlob(g: Grid, r: RngState, cx: number, cy: number, radius: number, t: number): void {
  const p1 = rand(r) * Math.PI * 2;
  const p2 = rand(r) * Math.PI * 2;
  const p3 = rand(r) * Math.PI * 2;
  const a1 = randRange(r, 0.1, 0.26);
  const a2 = randRange(r, 0.06, 0.16);
  const a3 = randRange(r, 0.03, 0.1);
  const max = radius * (1 + a1 + a2 + a3);
  const x0 = Math.max(0, Math.floor(cx - max));
  const x1 = Math.min(g.w - 1, Math.ceil(cx + max));
  const y0 = Math.max(0, Math.floor(cy - max));
  const y1 = Math.min(g.h - 1, Math.ceil(cy + max));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > max) continue;
      const ang = Math.atan2(dy, dx);
      const wobble =
        1 + a1 * Math.sin(ang * 2 + p1) + a2 * Math.sin(ang * 3 + p2) + a3 * Math.sin(ang * 5 + p3);
      if (d <= radius * wobble) g.t[y * g.w + x] = t;
    }
  }
}

/** Midpoint-displaced polyline from a to b. Used for rivers, ridges and roads. */
function meanderPath(
  r: RngState,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  jitter: number,
): number[] {
  let pts = [ax, ay, bx, by];
  for (let pass = 0; pass < 5; pass++) {
    const next: number[] = [pts[0]!, pts[1]!];
    const amp = jitter / (pass + 1);
    for (let i = 2; i < pts.length; i += 2) {
      const x0 = pts[i - 2]!;
      const y0 = pts[i - 1]!;
      const x1 = pts[i]!;
      const y1 = pts[i + 1]!;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const off = randRange(r, -amp, amp);
      next.push(mx + (-dy / len) * off, my + (dx / len) * off, x1, y1);
    }
    pts = next;
  }
  return pts;
}

function stampPath(g: Grid, pts: number[], width: number, terrain: number): void {
  for (let i = 0; i < pts.length; i += 2) {
    stampDisc(g, pts[i]!, pts[i + 1]!, width / 2, terrain);
  }
  // Fill the gaps between sample centres so thin brushes stay connected.
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2]!;
    const y0 = pts[i - 1]!;
    const x1 = pts[i]!;
    const y1 = pts[i + 1]!;
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      stampDisc(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, terrain);
    }
  }
}

function applyFeature(g: Grid, f: TerrainFeatureDef, r: RngState): void {
  const t = terrainKeyToId(f.terrain);
  switch (f.type) {
    case 'fill':
      g.t.fill(t);
      return;
    case 'rect': {
      const x = f.x ?? 0;
      const y = f.y ?? 0;
      const w = f.w ?? g.w;
      const h = f.h ?? g.h;
      for (let yy = Math.max(0, y); yy < Math.min(g.h, y + h); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(g.w, x + w); xx++) g.t[yy * g.w + xx] = t;
      }
      return;
    }
    case 'blob': {
      const count = f.count ?? 1;
      const jitter = f.jitter ?? 0;
      for (let i = 0; i < count; i++) {
        const cx = clamp((f.x ?? g.w / 2) + randRange(r, -jitter, jitter), 0, g.w);
        const cy = clamp((f.y ?? g.h / 2) + randRange(r, -jitter, jitter), 0, g.h);
        stampBlob(g, r, cx, cy, (f.radius ?? 8) * randRange(r, 0.7, 1.3), t);
      }
      return;
    }
    case 'river':
    case 'ridge':
    case 'road': {
      const pts = meanderPath(
        r,
        f.x ?? 0,
        f.y ?? 0,
        f.x2 ?? g.w - 1,
        f.y2 ?? g.h - 1,
        f.jitter ?? 18,
      );
      stampPath(g, pts, f.width ?? 6, t);
      return;
    }
  }
}

/** Builds the terrain grid for a map definition that uses `terrainGen`. */
export function generateTerrain(def: MapDef): Uint8Array {
  const gen = def.terrainGen;
  if (!gen) throw new Error(`map ${def.id} has no terrainGen recipe`);
  const g: Grid = {
    w: def.size.w,
    h: def.size.h,
    t: new Uint8Array(def.size.w * def.size.h).fill(Terrain.Plains),
  };
  for (let i = 0; i < gen.features.length; i++) {
    const f = gen.features[i]!;
    // Each brush gets its own stream so editing feature N does not reshuffle N+1.
    applyFeature(g, f, makeRng((gen.seed ^ (f.seed ?? 0)) + i * 0x9e3779b1));
  }
  return g.t;
}
