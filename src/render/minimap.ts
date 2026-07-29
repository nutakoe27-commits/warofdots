/**
 * Minimap.
 *
 * Both cached bitmaps are built at the influence-grid resolution rather than the
 * tile resolution: 64×64 is already more detail than a 200 px thumbnail can show,
 * the modal terrain per coarse cell is precomputed by the map loader, and it means
 * the territory overlay and the terrain underneath line up cell for cell.
 *
 * Layout is derived from the canvas backing store every frame, so the widget
 * survives being resized or moved to a different-DPR screen without an API for it.
 * `hitTest` takes CSS pixels — what a pointer event reports — and converts.
 */

import type { World } from '../core/types.ts';
import { COARSE_SIZE } from '../core/balance.ts';
import { clamp } from '../core/geometry.ts';
import type { Camera } from './camera.ts';
import type { FrameState } from './frame.ts';
import type { Theme, ThemeName } from './theme.ts';
import { playerColor } from './theme.ts';
import type { Bitmap } from './layers/terrain.ts';
import { createBitmap, terrainRgb } from './layers/terrain.ts';
import { paintOwnerImage } from './layers/territory.ts';

/** Territory reads as the primary signal here, so it is far more opaque than in world view. */
const TERRITORY_ALPHA = 0.72;
const PAD = 4;
const UNIT_PX = 2;
const CITY_PX = 4;
const CAPITAL_PX = 6;
const FRAME_WIDTH = 1.5;
const BORDER_WIDTH = 1;
const MAX_DPR = 2;

export interface Minimap {
  readonly canvas: HTMLCanvasElement;
  draw(frame: FrameState): void;
  /** Canvas-local pixel -> world point, or null when outside the map area. */
  hitTest(px: number, py: number): { x: number; y: number } | null;
}

interface MiniLayout {
  /** Backing-store pixels per world unit. */
  scale: number;
  ox: number;
  oy: number;
  /** Backing-store pixels per CSS pixel, so marker sizes stay constant on screen. */
  px: number;
}

/**
 * Matches the backing store to the CSS box. The widget has no `resize` in its API,
 * so it keeps itself sharp; assigning `width` clears the canvas, hence the guard.
 */
function syncSize(canvas: HTMLCanvasElement): void {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const dpr = clamp(window.devicePixelRatio || 1, 1, MAX_DPR);
  const w = Math.max(1, Math.round(cw * dpr));
  const h = Math.max(1, Math.round(ch * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function layoutOf(canvas: HTMLCanvasElement, world: World): MiniLayout {
  const px = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
  const pad = PAD * px;
  const scale = Math.min(
    (canvas.width - pad * 2) / world.map.worldW,
    (canvas.height - pad * 2) / world.map.worldH,
  );
  return {
    scale,
    ox: (canvas.width - world.map.worldW * scale) / 2,
    oy: (canvas.height - world.map.worldH * scale) / 2,
    px,
  };
}

function bakeTerrainThumb(world: World, theme: Theme): Bitmap {
  const map = world.map;
  const bmp = createBitmap(map.cw, map.ch);
  const img = bmp.ctx.createImageData(map.cw, map.ch);
  const pal = terrainRgb(theme, false);
  for (let cell = 0; cell < map.coarseTerrain.length; cell++) {
    const t = map.coarseTerrain[cell]!;
    const o = cell * 4;
    img.data[o] = pal[t * 3]!;
    img.data[o + 1] = pal[t * 3 + 1]!;
    img.data[o + 2] = pal[t * 3 + 2]!;
    img.data[o + 3] = 255;
  }
  bmp.ctx.putImageData(img, 0, 0);
  return bmp;
}

function blitGrid(ctx: CanvasRenderingContext2D, bmp: Bitmap, world: World, l: MiniLayout): void {
  ctx.drawImage(
    bmp.canvas,
    l.ox,
    l.oy,
    world.influence.cw * COARSE_SIZE * l.scale,
    world.influence.ch * COARSE_SIZE * l.scale,
  );
}

function drawUnits(ctx: CanvasRenderingContext2D, world: World, l: MiniLayout): void {
  const u = world.units;
  const size = UNIT_PX * l.px;
  const half = size / 2;
  for (let p = 1; p < world.players.length; p++) {
    ctx.fillStyle = playerColor(world.players[p]!.colorIndex);
    for (let i = 0; i < u.capacity; i++) {
      if (!u.alive[i] || u.owner[i] !== p) continue;
      ctx.fillRect(l.ox + u.x[i]! * l.scale - half, l.oy + u.y[i]! * l.scale - half, size, size);
    }
  }
}

function drawCities(
  ctx: CanvasRenderingContext2D,
  world: World,
  theme: Theme,
  l: MiniLayout,
): void {
  ctx.lineWidth = BORDER_WIDTH * l.px;
  ctx.strokeStyle = theme.cityRing;
  for (const city of world.cities) {
    const size = (city.capital ? CAPITAL_PX : CITY_PX) * l.px;
    const x = l.ox + city.x * l.scale - size / 2;
    const y = l.oy + city.y * l.scale - size / 2;
    ctx.fillStyle =
      city.owner === 0 ? theme.cityNeutral : playerColor(world.players[city.owner]!.colorIndex);
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x, y, size, size);
  }
}

function drawViewport(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  theme: Theme,
  l: MiniLayout,
): void {
  const w = (cam.vw / cam.zoom) * l.scale;
  const h = (cam.vh / cam.zoom) * l.scale;
  ctx.strokeStyle = theme.minimapFrame;
  ctx.lineWidth = FRAME_WIDTH * l.px;
  ctx.strokeRect(l.ox + cam.x * l.scale - w / 2, l.oy + cam.y * l.scale - h / 2, w, h);
}

export function createMinimap(canvas: HTMLCanvasElement, world: World): Minimap {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context for the minimap');

  let terrain: Bitmap | null = null;
  let terrainTheme: ThemeName | null = null;
  let owners: Bitmap | null = null;
  let ownersImg: ImageData | null = null;
  let ownersTick = -2;

  const draw = (frame: FrameState): void => {
    syncSize(canvas);
    const l = layoutOf(canvas, world);
    if (terrain === null || terrainTheme !== frame.theme.name) {
      terrain = bakeTerrainThumb(world, frame.theme);
      terrainTheme = frame.theme.name;
    }
    if (owners === null || ownersImg === null) {
      owners = createBitmap(world.influence.cw, world.influence.ch);
      ownersImg = owners.ctx.createImageData(world.influence.cw, world.influence.ch);
    }
    if (ownersTick !== world.influence.lastTick) {
      paintOwnerImage(world, ownersImg.data, TERRITORY_ALPHA, true);
      owners.ctx.putImageData(ownersImg, 0, 0);
      ownersTick = world.influence.lastTick;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = frame.theme.panel;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    blitGrid(ctx, terrain, world, l);
    if (frame.showTerritory) blitGrid(ctx, owners, world, l);
    drawUnits(ctx, world, l);
    drawCities(ctx, world, frame.theme, l);
    drawViewport(ctx, frame.camera, frame.theme, l);

    ctx.strokeStyle = frame.theme.panelBorder;
    ctx.lineWidth = BORDER_WIDTH * l.px;
    ctx.strokeRect(l.ox, l.oy, world.map.worldW * l.scale, world.map.worldH * l.scale);
  };

  const hitTest = (px: number, py: number): { x: number; y: number } | null => {
    const l = layoutOf(canvas, world);
    const ky = canvas.clientHeight > 0 ? canvas.height / canvas.clientHeight : l.px;
    const x = (px * l.px - l.ox) / l.scale;
    const y = (py * ky - l.oy) / l.scale;
    if (x < 0 || y < 0 || x > world.map.worldW || y > world.map.worldH) return null;
    return { x, y };
  };

  return { canvas, draw, hitTest };
}
