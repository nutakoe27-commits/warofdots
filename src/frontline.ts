/**
 * The front line: the contour where the two sides' influence is equal.
 *
 * Cities and units both project, per the original — a city holds ground on its own,
 * which is why the line bulges around a garrison and closes into a loop around
 * anyone who has been cut off.
 */

import type { City } from './terrain.ts';
import { TILE } from './terrain.ts';
import type { Unit } from './world.ts';
import { BLUE } from './world.ts';

const GW = 100;
const GH = 56;
const BLUR_PASSES = 3;
/** How far influence carries, in world units. */
const UNIT_REACH = 380;
const CITY_REACH = 900;
const CITY_WEIGHT = 7;
const HEAVY_WEIGHT = 1.7;
/**
 * Empty ground gets no line. Without this the contour wanders across the map,
 * because far from everyone the field sits a hair either side of zero.
 */
const MIN_PRESENCE = 0.01;

const field = new Float32Array(GW * GH);
const presence = new Float32Array(GW * GH);
const scratch = new Float32Array(GW * GH);

function blur(buf: Float32Array): void {
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

function splat(cx: number, cy: number, reach: number, weight: number, sign: number, cw: number, ch: number): void {
  const reach2 = reach * reach;
  const span = reach / Math.min(cw, ch);
  const gx = cx / cw;
  const gy = cy / ch;
  const x0 = Math.max(0, Math.floor(gx - span));
  const x1 = Math.min(GW - 1, Math.ceil(gx + span));
  const y0 = Math.max(0, Math.floor(gy - span));
  const y1 = Math.min(GH - 1, Math.ceil(gy + span));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) * cw - cx;
      const dy = (y + 0.5) * ch - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2) continue;
      const k = 1 - d2 / reach2;
      const v = weight * k * k;
      field[y * GW + x]! += sign * v;
      presence[y * GW + x]! += v;
    }
  }
}

function cross(a: number, b: number): number {
  const d = a - b;
  return Math.abs(d) < 1e-6 ? 0.5 : a / d;
}

const EDGES: Record<number, number[]> = {
  1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2], 5: [3, 0, 1, 2], 6: [0, 2], 7: [3, 2],
  8: [2, 3], 9: [0, 2], 10: [0, 1, 2, 3], 11: [0, 1], 12: [1, 3], 13: [1, 2], 14: [3, 0],
};

function contour(cw: number, ch: number): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < GH - 1; y++) {
    for (let x = 0; x < GW - 1; x++) {
      const i = y * GW + x;
      const a = field[i]!;
      const b = field[i + 1]!;
      const c = field[i + GW + 1]!;
      const d = field[i + GW]!;
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      if (presence[i]! + presence[i + 1]! + presence[i + GW + 1]! + presence[i + GW]! < MIN_PRESENCE * 4) {
        continue;
      }

      const t = [cross(a, b), cross(b, c), cross(d, c), cross(a, d)];
      const px = (x + 0.5) * cw;
      const py = (y + 0.5) * ch;
      const pt = (e: number): [number, number] => {
        const along = t[e]!;
        if (e === 0) return [px + along * cw, py];
        if (e === 1) return [px + cw, py + along * ch];
        if (e === 2) return [px + along * cw, py + ch];
        return [px, py + along * ch];
      };
      const segs = EDGES[code]!;
      for (let k = 0; k + 1 < segs.length; k += 2) {
        const p = pt(segs[k]!);
        const q = pt(segs[k + 1]!);
        out.push([p[0], p[1], q[0], q[1]]);
      }
    }
  }
  return out;
}

export function computeFront(units: Unit[], cities: City[], worldW: number, worldH: number): number[][] {
  field.fill(0);
  presence.fill(0);
  const cw = worldW / GW;
  const ch = worldH / GH;

  for (const u of units) {
    if (!u.alive) continue;
    splat(u.x, u.y, UNIT_REACH, u.heavy ? HEAVY_WEIGHT : 1, u.side === BLUE ? 1 : -1, cw, ch);
  }
  for (const c of cities) {
    if (c.owner < 0) continue;
    splat(c.x * TILE, c.y * TILE, CITY_REACH, CITY_WEIGHT, c.owner === BLUE ? 1 : -1, cw, ch);
  }

  blur(field);
  blur(presence);
  return contour(cw, ch);
}
