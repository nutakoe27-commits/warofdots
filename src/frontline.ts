/**
 * The front line.
 *
 * Both armies drop influence onto a coarse grid; the front is the contour where the
 * two are equal. The field is blurred before contouring, which is what turns a
 * staircase of grid cells into the smooth sweeping curve the reference shots have.
 */

import type { Unit } from './world.ts';
import { BLUE } from './world.ts';

/** Grid resolution for the influence field. Coarse on purpose — this is a mood line. */
const GW = 80;
const GH = 45;
const BLUR_PASSES = 3;
/** How far one unit's influence carries, in world units. */
const REACH = 190;

const field = new Float32Array(GW * GH);
/** Total influence regardless of side. Empty ground has none, and gets no line. */
const presence = new Float32Array(GW * GH);
const scratch = new Float32Array(GW * GH);

/**
 * Below this there is nobody near enough for a front to mean anything. Without it
 * the contour wanders off across empty map, because far from every unit the field
 * is a hair either side of zero and marching squares happily traces the noise.
 */
const MIN_PRESENCE = 0.012;

function blurBuffer(buf: Float32Array): void {
  for (let pass = 0; pass < BLUR_PASSES; pass++) {
    scratch.set(buf);
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
            sum += scratch[ny * GW + nx]!;
            n++;
          }
        }
        buf[y * GW + x] = sum / n;
      }
    }
  }
}

/** Linear crossing point between two samples of opposite sign. */
function lerp(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d) < 1e-6 ? 0.5 : a / d;
}

/**
 * Marching squares over the sign of the field. Segments are emitted as separate
 * two-point polylines; drawing them with round joins is enough at this thickness.
 */
function contour(cellW: number, cellH: number): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < GH - 1; y++) {
    for (let x = 0; x < GW - 1; x++) {
      const a = field[y * GW + x]!;
      const b = field[y * GW + x + 1]!;
      const c = field[(y + 1) * GW + x + 1]!;
      const d = field[(y + 1) * GW + x]!;
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const near =
        presence[y * GW + x]! +
        presence[y * GW + x + 1]! +
        presence[(y + 1) * GW + x + 1]! +
        presence[(y + 1) * GW + x]!;
      if (near < MIN_PRESENCE * 4) continue;

      const px = (x + 0.5) * cellW;
      const py = (y + 0.5) * cellH;
      const top: [number, number] = [px + lerp(a, b) * cellW, py];
      const right: [number, number] = [px + cellW, py + lerp(b, c) * cellH];
      const bottom: [number, number] = [px + lerp(d, c) * cellW, py + cellH];
      const left: [number, number] = [px, py + lerp(a, d) * cellH];

      const edges: Record<number, [number, number][]> = {
        1: [left, top],
        2: [top, right],
        3: [left, right],
        4: [right, bottom],
        5: [left, top, right, bottom],
        6: [top, bottom],
        7: [left, bottom],
        8: [bottom, left],
        9: [top, bottom],
        10: [top, right, bottom, left],
        11: [top, right],
        12: [right, left],
        13: [right, bottom],
        14: [left, top],
      };
      const segs = edges[code];
      if (!segs) continue;
      for (let i = 0; i + 1 < segs.length; i += 2) {
        const p = segs[i]!;
        const q = segs[i + 1]!;
        out.push([p[0], p[1], q[0], q[1]]);
      }
    }
  }
  return out;
}

export function computeFront(units: Unit[], worldW: number, worldH: number): number[][] {
  field.fill(0);
  presence.fill(0);
  const cellW = worldW / GW;
  const cellH = worldH / GH;
  const reach2 = REACH * REACH;

  for (const u of units) {
    if (!u.alive) continue;
    const sign = u.side === BLUE ? 1 : -1;
    const weight = u.heavy ? 1.7 : 1;
    const gx = u.x / cellW;
    const gy = u.y / cellH;
    const span = REACH / Math.min(cellW, cellH);
    const x0 = Math.max(0, Math.floor(gx - span));
    const x1 = Math.min(GW - 1, Math.ceil(gx + span));
    const y0 = Math.max(0, Math.floor(gy - span));
    const y1 = Math.min(GH - 1, Math.ceil(gy + span));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5) * cellW - u.x;
        const dy = (y + 0.5) * cellH - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach2) continue;
        // Falls off smoothly to zero at REACH so distant units cannot drag the
        // contour across the whole map.
        const k = 1 - d2 / reach2;
        field[y * GW + x]! += sign * weight * k * k;
        presence[y * GW + x]! += weight * k * k;
      }
    }
  }

  blurBuffer(field);
  blurBuffer(presence);
  return contour(cellW, cellH);
}
