/**
 * Drawing.
 *
 * Layer order matters and is not the obvious one: the fog goes down before the
 * front line and the city markers, because in the reference shot the black front
 * line and the yellow markers stay readable across ground the player cannot
 * currently see. Only units and their arrows are actually hidden by fog.
 */

import { TERRAIN_COLORS, TILE } from './terrain.ts';
import type { GameMap } from './terrain.ts';
import { BLUE } from './world.ts';
import type { Unit, World } from './world.ts';

const SIDE_FILL = ['#2222dd', '#ee2020'];
const FRONT_COLOR = '#000000';
const FRONT_WIDTH = 9;

const CITY_COLOR = '#ffd400';
const CITY_R = 5.5;
const CAPITAL_R = 12;

const UNIT_R = 11;
const HEAVY_RING_R = 0.52;
const HEAVY_RING_W = 0.34;

const HP_W = 26;
const HP_H = 7;
const HP_LIFT = 20;
const HP_BG = '#20242a';
const HP_FILL = '#3fe3f0';

const ARROW_COLOR = 'rgba(15, 20, 15, 0.62)';
const ARROW_W = 2;
const ARROW_HEAD = 9;
/**
 * Arrows show heading, not the destination.
 *
 * Drawing a line all the way to the target looked precise and read as nonsense: a
 * hundred units aiming at the same enemy produced a starburst that said nothing
 * about where anyone was going. A short arrow along the direction of travel is what
 * the reference actually shows.
 */
const ARROW_LEN = 52;
/** A unit slower than this is holding position and gets no arrow. */
const ARROW_MIN_SPEED = 4;

/** Vision radius in world units. */
const VISION_UNIT = 132;
const VISION_CITY = 168;
const FOG_COLOR = 'rgba(6, 28, 14, 0.82)';

export interface View {
  /** World units to CSS pixels. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

let terrainBmp: HTMLCanvasElement | null = null;
let fogBmp: HTMLCanvasElement | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Bakes the tile grid once at one pixel per tile. */
function bakeTerrain(map: GameMap): HTMLCanvasElement {
  const c = makeCanvas(map.w, map.h);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(map.w, map.h);
  const rgb = TERRAIN_COLORS.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] as const;
  });
  for (let i = 0; i < map.tiles.length; i++) {
    const [r, g, b] = rgb[map.tiles[i]!] ?? rgb[0]!;
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Fits the whole map inside the viewport. */
export function computeView(map: GameMap, cssW: number, cssH: number): View {
  const scale = Math.min(cssW / map.worldW, cssH / map.worldH);
  return {
    scale,
    offsetX: (cssW - map.worldW * scale) / 2,
    offsetY: (cssH - map.worldH * scale) / 2,
  };
}

function drawTerrain(ctx: CanvasRenderingContext2D, map: GameMap, view: View): void {
  if (!terrainBmp) terrainBmp = bakeTerrain(map);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    terrainBmp,
    view.offsetX,
    view.offsetY,
    map.worldW * view.scale,
    map.worldH * view.scale,
  );
  ctx.imageSmoothingEnabled = true;
}

/**
 * Fog: a full sheet punched through with soft radial holes at everything the
 * player can see. Cheaper and softer-edged than masking a grid.
 */
function drawFog(ctx: CanvasRenderingContext2D, w: World, view: View, cssW: number, cssH: number): void {
  if (!fogBmp || fogBmp.width !== Math.ceil(cssW) || fogBmp.height !== Math.ceil(cssH)) {
    fogBmp = makeCanvas(Math.max(1, Math.ceil(cssW)), Math.max(1, Math.ceil(cssH)));
  }
  const f = fogBmp.getContext('2d')!;
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.clearRect(0, 0, fogBmp.width, fogBmp.height);
  f.fillStyle = FOG_COLOR;
  f.fillRect(0, 0, fogBmp.width, fogBmp.height);

  f.globalCompositeOperation = 'destination-out';
  const punch = (wx: number, wy: number, radius: number): void => {
    const x = view.offsetX + wx * view.scale;
    const y = view.offsetY + wy * view.scale;
    const r = radius * view.scale;
    const g = f.createRadialGradient(x, y, r * 0.45, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = g;
    f.beginPath();
    f.arc(x, y, r, 0, Math.PI * 2);
    f.fill();
  };

  for (const u of w.units) {
    if (u.alive && u.side === BLUE) punch(u.x, u.y, VISION_UNIT);
  }
  // Own capital keeps its surroundings lit even with no troops nearby.
  const home = w.map.cities[0]!;
  punch(home.x * TILE, home.y * TILE, VISION_CITY);

  f.globalCompositeOperation = 'source-over';
  ctx.drawImage(fogBmp, 0, 0);
}

/** True when the point is inside the player's vision. */
function isVisible(w: World, x: number, y: number): boolean {
  const home = w.map.cities[0]!;
  if (Math.hypot(x - home.x * TILE, y - home.y * TILE) < VISION_CITY) return true;
  for (const u of w.units) {
    if (!u.alive || u.side !== BLUE) continue;
    if (Math.hypot(x - u.x, y - u.y) < VISION_UNIT) return true;
  }
  return false;
}

function drawFront(ctx: CanvasRenderingContext2D, w: World, view: View): void {
  if (w.front.length === 0) return;
  ctx.strokeStyle = FRONT_COLOR;
  ctx.lineWidth = FRONT_WIDTH * view.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const seg of w.front) {
    ctx.moveTo(view.offsetX + seg[0]! * view.scale, view.offsetY + seg[1]! * view.scale);
    ctx.lineTo(view.offsetX + seg[2]! * view.scale, view.offsetY + seg[3]! * view.scale);
  }
  ctx.stroke();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.44;
    const px = x + Math.cos(ang) * rad;
    const py = y + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function drawCities(ctx: CanvasRenderingContext2D, w: World, view: View): void {
  ctx.fillStyle = CITY_COLOR;
  for (const c of w.map.cities) {
    const x = view.offsetX + c.x * TILE * view.scale;
    const y = view.offsetY + c.y * TILE * view.scale;
    if (c.capital) {
      star(ctx, x, y, CAPITAL_R * view.scale);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, CITY_R * view.scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, s: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  const ux = dx / len;
  const uy = dy / len;
  const head = ARROW_HEAD * s;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
  ctx.stroke();
}

function drawArrows(ctx: CanvasRenderingContext2D, shown: Unit[], view: View): void {
  ctx.strokeStyle = ARROW_COLOR;
  ctx.lineWidth = ARROW_W * view.scale;
  ctx.lineCap = 'butt';
  for (const u of shown) {
    const speed = Math.hypot(u.vx, u.vy);
    if (speed < ARROW_MIN_SPEED) continue;
    const ux = u.vx / speed;
    const uy = u.vy / speed;
    drawArrow(
      ctx,
      view.offsetX + u.x * view.scale,
      view.offsetY + u.y * view.scale,
      view.offsetX + (u.x + ux * ARROW_LEN) * view.scale,
      view.offsetY + (u.y + uy * ARROW_LEN) * view.scale,
      view.scale,
    );
  }
}

function drawUnits(ctx: CanvasRenderingContext2D, shown: Unit[], view: View): void {
  const r = UNIT_R * view.scale;
  for (const side of [0, 1]) {
    ctx.fillStyle = SIDE_FILL[side]!;
    ctx.beginPath();
    for (const u of shown) {
      if (u.side !== side) continue;
      const x = view.offsetX + u.x * view.scale;
      const y = view.offsetY + u.y * view.scale;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // The black ring is what tells a heavy from a light at a glance.
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = r * HEAVY_RING_W;
  ctx.beginPath();
  for (const u of shown) {
    if (!u.heavy) continue;
    const x = view.offsetX + u.x * view.scale;
    const y = view.offsetY + u.y * view.scale;
    ctx.moveTo(x + r * HEAVY_RING_R, y);
    ctx.arc(x, y, r * HEAVY_RING_R, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function drawHealthBars(ctx: CanvasRenderingContext2D, shown: Unit[], view: View): void {
  const w = HP_W * view.scale;
  const h = HP_H * view.scale;
  for (const u of shown) {
    if (u.hp >= 0.999 && !u.inCombat) continue;
    const x = view.offsetX + u.x * view.scale - w / 2;
    const y = view.offsetY + u.y * view.scale - HP_LIFT * view.scale;
    ctx.fillStyle = HP_BG;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = HP_FILL;
    ctx.fillRect(x + 1, y + 1, Math.max(0, (w - 2) * u.hp), h - 2);
  }
}

export function render(
  ctx: CanvasRenderingContext2D,
  w: World,
  view: View,
  cssW: number,
  cssH: number,
  fogOn: boolean,
): void {
  ctx.fillStyle = '#0b0f0b';
  ctx.fillRect(0, 0, cssW, cssH);
  drawTerrain(ctx, w.map, view);

  if (fogOn) drawFog(ctx, w, view, cssW, cssH);
  drawFront(ctx, w, view);
  drawCities(ctx, w, view);

  const shown = w.units.filter(
    (u) => u.alive && (!fogOn || u.side === BLUE || isVisible(w, u.x, u.y)),
  );
  drawArrows(ctx, shown, view);
  drawUnits(ctx, shown, view);
  drawHealthBars(ctx, shown, view);
}
