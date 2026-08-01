/**
 * The front line — the border between the two sides' territory.
 *
 * The important thing, and what the earlier attempt got wrong: this is *captured
 * ground*, not a computed midpoint. A distance-weighted influence field always
 * puts the line halfway between the two armies, so it floats in open country far
 * from anybody. In the original it does the opposite — it clings to whoever is
 * standing there, and a lone unit behind enemy lines gets a tight little loop
 * around it, the same small size however deep it has walked.
 *
 * A fixed size is the giveaway: no falloff curve can do that, because every
 * distance-weighted field is scale-free — its loops grow with the distance to
 * the enemy. So the model here is ownership instead:
 *
 *   - each unit claims the ground within `UNIT_REACH` of it, a few unit radii;
 *   - a cell goes to whichever side claims it more strongly;
 *   - a cell nobody claims **keeps the owner it already had**.
 *
 * That last rule is what makes the line behave. Territory has to be walked over
 * to change hands, so the border advances with the troops, stays where they left
 * it, and never wanders off into ground neither side has touched. Empty country
 * still belongs to somebody, so the line stays continuous from edge to edge.
 */

import type { Unit } from './world.ts';
import { BLUE } from './world.ts';

/** One cell per map tile. Cells must be well under a unit's reach or the loops go blocky. */
const GW = 400;
const GH = 225;
const CELLS = GW * GH;

/**
 * How far a claim carries, in world units. A unit is 9 across, so this is about
 * three radii — measured off the reference, where the loop around a cut-off unit
 * is roughly three times its own size.
 */
const UNIT_REACH = 34;
const HEAVY_REACH = 41;

/** Strongest claim on each cell, 1 at a source and 0 at the edge of its reach. */
const blueCover = new Float32Array(CELLS);
const redCover = new Float32Array(CELLS);
/** 0 blue, 1 red. Persists between rebuilds — that is the whole point. */
const owner = new Uint8Array(CELLS);
/** Ownership as ±1, blurred, so marching squares gives curves and not a staircase. */
const sign = new Float32Array(CELLS);
const tmp = new Float32Array(CELLS);
let seeded = false;

interface Source {
  x: number;
  y: number;
  reach: number;
}

const blue: Source[] = [];
const red: Source[] = [];

/**
 * Troops and only troops. Points hold no ground of their own — a captured point
 * is worth its supply and nothing else — so a city deep behind the line does not
 * bulge the border towards it, and one taken by a raid does not tear a hole in
 * the enemy's territory that the raid itself has not earned.
 */
function collect(units: Unit[]): void {
  blue.length = 0;
  red.length = 0;
  for (const u of units) {
    if (!u.alive) continue;
    (u.side === BLUE ? blue : red).push({ x: u.x, y: u.y, reach: u.heavy ? HEAVY_REACH : UNIT_REACH });
  }
}

/** Claims every cell within reach, keeping the strongest claim rather than summing. */
function stamp(cover: Float32Array, s: Source, cw: number, ch: number): void {
  const x0 = Math.max(0, Math.floor((s.x - s.reach) / cw));
  const x1 = Math.min(GW - 1, Math.ceil((s.x + s.reach) / cw));
  const y0 = Math.max(0, Math.floor((s.y - s.reach) / ch));
  const y1 = Math.min(GH - 1, Math.ceil((s.y + s.reach) / ch));
  const r2 = s.reach * s.reach;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5) * ch - s.y;
    const row = y * GW;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) * cw - s.x;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const v = 1 - Math.sqrt(d2) / s.reach;
      if (v > cover[row + x]!) cover[row + x] = v;
    }
  }
}

/** First call only: every cell goes to the side standing nearest it. */
function seed(cw: number, ch: number): void {
  for (let y = 0; y < GH; y++) {
    const py = (y + 0.5) * ch;
    const row = y * GW;
    for (let x = 0; x < GW; x++) {
      const px = (x + 0.5) * cw;
      let db = Infinity;
      let dr = Infinity;
      for (let i = 0; i < blue.length; i++) {
        const s = blue[i]!;
        const dx = px - s.x;
        const dy = py - s.y;
        const d = dx * dx + dy * dy;
        if (d < db) db = d;
      }
      for (let i = 0; i < red.length; i++) {
        const s = red[i]!;
        const dx = px - s.x;
        const dy = py - s.y;
        const d = dx * dx + dy * dy;
        if (d < dr) dr = d;
      }
      owner[row + x] = db <= dr ? 0 : 1;
    }
  }
}

function capture(cw: number, ch: number): void {
  blueCover.fill(0);
  redCover.fill(0);
  for (const s of blue) stamp(blueCover, s, cw, ch);
  for (const s of red) stamp(redCover, s, cw, ch);
  for (let i = 0; i < CELLS; i++) {
    const b = blueCover[i]!;
    const r = redCover[i]!;
    // Equal claims — which includes the common case of no claim at all — leave the
    // cell alone. Ground changes hands only when somebody actually takes it.
    if (b > r) owner[i] = 0;
    else if (r > b) owner[i] = 1;
  }
}

/** Three [1,2,1] passes: enough to round off the cell staircase, far too little to close a loop. */
function smooth(): void {
  for (let i = 0; i < CELLS; i++) sign[i] = owner[i] === 0 ? 1 : -1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < GH; y++) {
      const row = y * GW;
      // Edges out of the loop — clamping per cell costs more than the blur itself.
      tmp[row] = (3 * sign[row]! + sign[row + 1]!) * 0.25;
      for (let x = 1; x < GW - 1; x++) {
        tmp[row + x] = (sign[row + x - 1]! + 2 * sign[row + x]! + sign[row + x + 1]!) * 0.25;
      }
      tmp[row + GW - 1] = (sign[row + GW - 2]! + 3 * sign[row + GW - 1]!) * 0.25;
    }
    for (let y = 0; y < GH; y++) {
      const row = y * GW;
      const up = (y > 0 ? y - 1 : 0) * GW;
      const dn = (y < GH - 1 ? y + 1 : GH - 1) * GW;
      for (let x = 0; x < GW; x++) {
        sign[row + x] = (tmp[up + x]! + 2 * tmp[row + x]! + tmp[dn + x]!) * 0.25;
      }
    }
  }
}

function cross(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d) < 1e-12 ? 0.5 : a / d;
}

/**
 * Marching-squares cases, as pairs of edges: 0 top, 1 right, 2 bottom, 3 left.
 *
 * Corners are a top-left, b top-right, c bottom-right, d bottom-left, so edge 0 is
 * a–b, 1 is b–c, 2 is d–c and 3 is a–d. Complementary cases must list the same
 * edges — 4 and 11 both cut off corner c, 2 and 13 both cut off corner b. Those two
 * pairs used to disagree, so those cells drew a segment across an edge whose ends
 * have the same sign: a chord through solid territory, and a hole in the border
 * where the real crossing should have been. That was the dashed line.
 */
const EDGES: Record<number, number[]> = {
  1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2], 5: [3, 0, 1, 2], 6: [0, 2], 7: [3, 2],
  8: [2, 3], 9: [0, 2], 10: [0, 1, 2, 3], 11: [1, 2], 12: [1, 3], 13: [0, 1], 14: [3, 0],
};

function contour(cw: number, ch: number): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < GH - 1; y++) {
    for (let x = 0; x < GW - 1; x++) {
      const i = y * GW + x;
      const a = sign[i]!;
      const b = sign[i + 1]!;
      const c = sign[i + GW + 1]!;
      const d = sign[i + GW]!;
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const px = (x + 0.5) * cw;
      const py = (y + 0.5) * ch;
      const at = (e: number): [number, number] => {
        if (e === 0) return [px + cross(a, b) * cw, py];
        if (e === 1) return [px + cw, py + cross(b, c) * ch];
        if (e === 2) return [px + cross(d, c) * cw, py + ch];
        return [px, py + cross(a, d) * ch];
      };
      const segs = EDGES[code]!;
      for (let k = 0; k + 1 < segs.length; k += 2) {
        const p = at(segs[k]!);
        const q = at(segs[k + 1]!);
        out.push([p[0], p[1], q[0], q[1]]);
      }
    }
  }
  return out;
}

export function computeFront(units: Unit[], worldW: number, worldH: number): number[][] {
  collect(units);
  const cw = worldW / GW;
  const ch = worldH / GH;
  if (!seeded) {
    if (blue.length === 0 || red.length === 0) return [];
    seed(cw, ch);
    seeded = true;
  }
  capture(cw, ch);
  smooth();
  return contour(cw, ch);
}
