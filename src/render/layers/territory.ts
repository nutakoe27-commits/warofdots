/**
 * Territory layer: the coloured map and the front line.
 *
 * The ownership grid is 4× coarser than tiles, which is exactly what we want to
 * draw: a 64×64 `ImageData` blown up with smoothing ON gives the soft, bled edge
 * of a staff map for the price of one bilinear blit. Re-baked only when
 * `influence.lastTick` moves, i.e. four times a second at most.
 *
 * The front line on top is marching squares run once per player over the owner
 * grid, with the lattice sitting on cell centres. Every segment goes into a single
 * path and is stroked once, so a border shared by two players — emitted twice, once
 * from each side — does not composite to a darker line than a border with neutral
 * ground.
 */

import type { World } from '../../core/types.ts';
import { COARSE_SIZE } from '../../core/balance.ts';
import { clamp } from '../../core/geometry.ts';
import type { ViewBounds } from '../camera.ts';
import { visibleBounds, worldToScreenX, worldToScreenY } from '../camera.ts';
import type { FrameState, Layer } from '../frame.ts';
import { TERRITORY_ALPHA, playerColor } from '../theme.ts';
import type { Bitmap } from './terrain.ts';
import { createBitmap } from './terrain.ts';

const FRONT_WIDTH = 2;
/** Unsupplied cells keep their colour but lose most of its life. */
const DIM_RGB_MUL = 0.45;
const DIM_ALPHA_MUL = 0.7;

/** Player colours as RGB triples indexed `player * 3`. */
function playerBytes(world: World): Uint8Array {
  const out = new Uint8Array(world.players.length * 3);
  for (let p = 0; p < world.players.length; p++) {
    const hex = playerColor(world.players[p]?.colorIndex ?? 0);
    const n = parseInt(hex.slice(1), 16);
    out[p * 3] = (n >> 16) & 0xff;
    out[p * 3 + 1] = (n >> 8) & 0xff;
    out[p * 3 + 2] = n & 0xff;
  }
  return out;
}

/**
 * Writes the ownership grid into an RGBA buffer of `cw × ch` pixels. Shared with
 * the minimap, which wants the same picture at a different scale and alpha.
 */
export function paintOwnerImage(
  world: World,
  data: Uint8ClampedArray,
  alpha: number,
  dimUnsupplied: boolean,
): void {
  const inf = world.influence;
  const pal = playerBytes(world);
  const solid = Math.round(alpha * 255);
  const faded = Math.round(alpha * DIM_ALPHA_MUL * 255);

  for (let cell = 0; cell < inf.owner.length; cell++) {
    const p = inf.owner[cell]!;
    const o = cell * 4;
    if (p === 0) {
      data[o + 3] = 0;
      continue;
    }
    const dim = dimUnsupplied && inf.supplied[cell] === 0;
    const mul = dim ? DIM_RGB_MUL : 1;
    data[o] = pal[p * 3]! * mul;
    data[o + 1] = pal[p * 3 + 1]! * mul;
    data[o + 2] = pal[p * 3 + 2]! * mul;
    data[o + 3] = dim ? faded : solid;
  }
}

// ────────────────────────────────────────────────────── marching squares ──

/**
 * Contour cases for corners A (top-left), B, C, D (bottom-left) as bits 0..3.
 * Each entry is a flat list of edge-midpoint pairs; edges are T, R, B, L = 0..3.
 */
const MS_SEGS: readonly number[][] = [
  [],
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  [3, 0, 1, 2],
  [0, 2],
  [3, 2],
  [2, 3],
  [0, 2],
  [0, 1, 2, 3],
  [1, 2],
  [3, 1],
  [0, 1],
  [3, 0],
  [],
];

/** Edge midpoints in cell units, relative to the square's top-left cell. */
const EDGE_DX = [1.0, 1.5, 1.0, 0.5];
const EDGE_DY = [0.5, 1.0, 1.5, 1.0];

const frontBounds: ViewBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

function emitSquare(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  i: number,
  j: number,
  code: number,
): void {
  const cam = frame.camera;
  const segs = MS_SEGS[code]!;
  for (let k = 0; k < segs.length; k += 2) {
    const a = segs[k]!;
    const b = segs[k + 1]!;
    ctx.moveTo(
      worldToScreenX(cam, (i + EDGE_DX[a]!) * COARSE_SIZE),
      worldToScreenY(cam, (j + EDGE_DY[a]!) * COARSE_SIZE),
    );
    ctx.lineTo(
      worldToScreenX(cam, (i + EDGE_DX[b]!) * COARSE_SIZE),
      worldToScreenY(cam, (j + EDGE_DY[b]!) * COARSE_SIZE),
    );
  }
}

function strokeFront(ctx: CanvasRenderingContext2D, frame: FrameState, world: World): void {
  const inf = world.influence;
  const b = visibleBounds(frame.camera, COARSE_SIZE, frontBounds);
  const i0 = clamp(Math.floor(b.x0 / COARSE_SIZE) - 1, 0, inf.cw - 2);
  const i1 = clamp(Math.ceil(b.x1 / COARSE_SIZE), 0, inf.cw - 2);
  const j0 = clamp(Math.floor(b.y0 / COARSE_SIZE) - 1, 0, inf.ch - 2);
  const j1 = clamp(Math.ceil(b.y1 / COARSE_SIZE), 0, inf.ch - 2);

  ctx.strokeStyle = frame.theme.frontLine;
  ctx.lineWidth = FRONT_WIDTH;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let p = 1; p <= world.map.playerCount; p++) {
    for (let j = j0; j <= j1; j++) {
      const row = j * inf.cw;
      const next = row + inf.cw;
      for (let i = i0; i <= i1; i++) {
        const code =
          (inf.owner[row + i] === p ? 1 : 0) |
          (inf.owner[row + i + 1] === p ? 2 : 0) |
          (inf.owner[next + i + 1] === p ? 4 : 0) |
          (inf.owner[next + i] === p ? 8 : 0);
        if (code === 0 || code === 15) continue;
        emitSquare(ctx, frame, i, j, code);
      }
    }
  }
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────────── the layer ──

export function createTerritoryLayer(world: World): Layer {
  const inf = world.influence;
  let bmp: Bitmap | null = null;
  let img: ImageData | null = null;
  let bakedTick = -2;

  return {
    name: 'territory',
    invalidate(): void {
      bakedTick = -2;
    },
    draw(ctx: CanvasRenderingContext2D, frame: FrameState): void {
      if (!frame.showTerritory) return;
      if (bmp === null || img === null) {
        bmp = createBitmap(inf.cw, inf.ch);
        img = bmp.ctx.createImageData(inf.cw, inf.ch);
      }
      if (bakedTick !== inf.lastTick) {
        paintOwnerImage(world, img.data, TERRITORY_ALPHA, true);
        bmp.ctx.putImageData(img, 0, 0);
        bakedTick = inf.lastTick;
      }

      const cam = frame.camera;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        bmp.canvas,
        worldToScreenX(cam, 0),
        worldToScreenY(cam, 0),
        inf.cw * COARSE_SIZE * cam.zoom,
        inf.ch * COARSE_SIZE * cam.zoom,
      );
      strokeFront(ctx, frame, world);
    },
  };
}
