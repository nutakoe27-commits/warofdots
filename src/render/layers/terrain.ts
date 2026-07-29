/**
 * Terrain layer, plus the small bitmap helper the other cached layers share.
 *
 * The map never changes, so the whole thing is baked once at one bitmap pixel per
 * tile and blitted with a single `drawImage`. A 256×256 map is a 256 KB bitmap;
 * scaling it up with smoothing off keeps tiles crisp at every zoom and costs one
 * blit per frame instead of 65 536 `fillRect` calls.
 *
 * The bake target is a detached `<canvas>` rather than an `OffscreenCanvas`: it is
 * only ever used as a `drawImage` source on the main thread, so the transferable
 * variant buys nothing and the detached element works in every browser.
 */

import type { MapRuntime, World } from '../../core/types.ts';
import { TERRAIN_COUNT, Terrain } from '../../core/types.ts';
import { TILE_SIZE } from '../../core/balance.ts';
import type { ViewBounds } from '../camera.ts';
import { visibleBounds, worldToScreenX, worldToScreenY } from '../camera.ts';
import type { FrameState, Layer } from '../frame.ts';
import type { Theme, ThemeName } from '../theme.ts';

/** Zoom at or above which the reference grid is worth drawing. */
const GRID_MIN_ZOOM = 0.75;
/** Grid spacing, in tiles. */
const GRID_TILES = 8;
const GRID_WIDTH = 1;

export interface Bitmap {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** A detached canvas of exactly `w × h` bitmap pixels, with its 2D context. */
export function createBitmap(w: number, h: number): Bitmap {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for an offscreen bitmap');
  return { canvas, ctx, w: canvas.width, h: canvas.height };
}

/** Terrain fills unpacked to RGB triples, indexed `terrain * 3`. */
export function terrainRgb(theme: Theme, alt: boolean): Uint8Array {
  const src = alt ? theme.terrainAlt : theme.terrain;
  const out = new Uint8Array(TERRAIN_COUNT * 3);
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    const n = parseInt(src[t]!.slice(1), 16);
    out[t * 3] = (n >> 16) & 0xff;
    out[t * 3 + 1] = (n >> 8) & 0xff;
    out[t * 3 + 2] = n & 0xff;
  }
  return out;
}

function bakeTerrain(map: MapRuntime, theme: Theme): Bitmap {
  const bmp = createBitmap(map.w, map.h);
  const img = bmp.ctx.createImageData(map.w, map.h);
  const data = img.data;
  const base = terrainRgb(theme, false);
  const alt = terrainRgb(theme, true);

  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const cell = ty * map.w + tx;
      const t = map.terrain[cell]!;
      // Mountains keep one flat colour — the weave would soften a wall that has
      // to read as impassable at a glance.
      const weave = t !== Terrain.Mountain && ((tx ^ ty) & 1) === 1;
      const pal = weave ? alt : base;
      const o = cell * 4;
      data[o] = pal[t * 3]!;
      data[o + 1] = pal[t * 3 + 1]!;
      data[o + 2] = pal[t * 3 + 2]!;
      data[o + 3] = 255;
    }
  }
  bmp.ctx.putImageData(img, 0, 0);
  return bmp;
}

const gridBounds: ViewBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Faint reference grid, only once a tile is big enough for it to mean anything. */
function drawGrid(ctx: CanvasRenderingContext2D, frame: FrameState, map: MapRuntime): void {
  const cam = frame.camera;
  const b = visibleBounds(cam, 0, gridBounds);
  const step = TILE_SIZE * GRID_TILES;
  const wx0 = Math.max(0, b.x0);
  const wy0 = Math.max(0, b.y0);
  const wx1 = Math.min(map.worldW, b.x1);
  const wy1 = Math.min(map.worldH, b.y1);
  const top = worldToScreenY(cam, wy0);
  const bottom = worldToScreenY(cam, wy1);
  const left = worldToScreenX(cam, wx0);
  const right = worldToScreenX(cam, wx1);

  ctx.strokeStyle = frame.theme.grid;
  ctx.lineWidth = GRID_WIDTH;
  ctx.beginPath();
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
    const sx = worldToScreenX(cam, x);
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
  }
  for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
    const sy = worldToScreenY(cam, y);
    ctx.moveTo(left, sy);
    ctx.lineTo(right, sy);
  }
  ctx.stroke();
}

export function createTerrainLayer(world: World): Layer {
  const map = world.map;
  let bmp: Bitmap | null = null;
  let bakedTheme: ThemeName | null = null;

  return {
    name: 'terrain',
    invalidate(): void {
      bmp = null;
    },
    draw(ctx: CanvasRenderingContext2D, frame: FrameState): void {
      if (bmp === null || bakedTheme !== frame.theme.name) {
        bmp = bakeTerrain(map, frame.theme);
        bakedTheme = frame.theme.name;
      }
      const cam = frame.camera;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        bmp.canvas,
        worldToScreenX(cam, 0),
        worldToScreenY(cam, 0),
        map.worldW * cam.zoom,
        map.worldH * cam.zoom,
      );
      ctx.imageSmoothingEnabled = true;
      if (cam.zoom >= GRID_MIN_ZOOM) drawGrid(ctx, frame, map);
    },
  };
}
