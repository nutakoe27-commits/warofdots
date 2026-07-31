/**
 * Drawing.
 *
 * The fog goes down before the front line and the city markers: in the original
 * those stay readable across ground you cannot currently see, and only units are
 * actually hidden. Fog has no memory — anything outside current vision darkens
 * again, so the dark is "not seeing", not "never seen".
 */

import { TERRAIN_COLORS, TILE } from './terrain.ts';
import type { GameMap } from './terrain.ts';
import { sx, sy } from './camera.ts';
import type { Camera } from './camera.ts';
import { BLUE, RED } from './world.ts';
import type { Unit, World } from './world.ts';
import type { InputState } from './input.ts';

const SIDE = ['#2233dd', '#e01a1a'];
const FRONT_WIDTH = 3;

const UNIT_R = [9, 10.5];
const HEAVY_RING = 0.5;
const HEAVY_RING_W = 0.3;
/** Units never draw smaller than this, or a zoomed-out army vanishes. */
const MIN_R = 2.2;

const BAR_W = 26;
const BAR_H = 5;
const BAR_LIFT = 15;
const BAR_BORDER = 2;
const HEALTH = '#22e622';
const MORALE = '#3fe3f0';
const BAR_EMPTY = '#6a6a6a';

const SELECT_RING = '#ffffff';
const PENDING = 'rgba(30,30,30,0.55)';
const ACTIVE_PATH = 'rgba(20,20,20,0.38)';
const LASSO = 'rgba(255,255,255,0.9)';
const ARROW_HEAD = 11;

const VISION_UNIT = 340;
const VISION_CITY = 420;
const FOG = 'rgba(8, 26, 12, 0.72)';

/** Combat shake amplitude in world units. */
const SHAKE = 2.4;

let terrainBmp: HTMLCanvasElement | null = null;
let fogBmp: HTMLCanvasElement | null = null;

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function bakeTerrain(map: GameMap): HTMLCanvasElement {
  const c = canvasOf(map.w, map.h);
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

function drawTerrain(ctx: CanvasRenderingContext2D, map: GameMap, cam: Camera): void {
  if (!terrainBmp) terrainBmp = bakeTerrain(map);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(terrainBmp, sx(cam, 0), sy(cam, 0), map.worldW * cam.zoom, map.worldH * cam.zoom);
  ctx.imageSmoothingEnabled = true;
}

function drawFog(ctx: CanvasRenderingContext2D, w: World, cam: Camera): void {
  if (!fogBmp || fogBmp.width !== Math.ceil(cam.vw) || fogBmp.height !== Math.ceil(cam.vh)) {
    fogBmp = canvasOf(Math.max(1, Math.ceil(cam.vw)), Math.max(1, Math.ceil(cam.vh)));
  }
  const f = fogBmp.getContext('2d')!;
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.clearRect(0, 0, fogBmp.width, fogBmp.height);
  f.fillStyle = FOG;
  f.fillRect(0, 0, fogBmp.width, fogBmp.height);
  f.globalCompositeOperation = 'destination-out';

  const punch = (worldX: number, worldY: number, radius: number): void => {
    const x = sx(cam, worldX);
    const y = sy(cam, worldY);
    const r = radius * cam.zoom;
    if (x + r < 0 || y + r < 0 || x - r > cam.vw || y - r > cam.vh) return;
    const g = f.createRadialGradient(x, y, r * 0.55, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = g;
    f.beginPath();
    f.arc(x, y, r, 0, Math.PI * 2);
    f.fill();
  };

  for (const u of w.units) if (u.alive && u.side === BLUE) punch(u.x, u.y, VISION_UNIT);
  for (const c of w.map.cities) {
    if (c.owner === BLUE) punch(c.x * TILE, c.y * TILE, VISION_CITY);
  }

  f.globalCompositeOperation = 'source-over';
  ctx.drawImage(fogBmp, 0, 0);
}

function visible(w: World, x: number, y: number): boolean {
  for (const u of w.units) {
    if (!u.alive || u.side !== BLUE) continue;
    if (Math.hypot(x - u.x, y - u.y) < VISION_UNIT) return true;
  }
  for (const c of w.map.cities) {
    if (c.owner === BLUE && Math.hypot(x - c.x * TILE, y - c.y * TILE) < VISION_CITY) return true;
  }
  return false;
}

function drawFront(ctx: CanvasRenderingContext2D, w: World, cam: Camera): void {
  if (w.front.length === 0) return;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = FRONT_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const s of w.front) {
    ctx.moveTo(sx(cam, s[0]!), sy(cam, s[1]!));
    ctx.lineTo(sx(cam, s[2]!), sy(cam, s[3]!));
  }
  ctx.stroke();
}

function drawCities(ctx: CanvasRenderingContext2D, w: World, cam: Camera): void {
  for (const c of w.map.cities) {
    const x = sx(cam, c.x * TILE);
    const y = sy(cam, c.y * TILE);
    const r = Math.max(4, 7 * cam.zoom);

    ctx.fillStyle = '#ffe000';
    if (c.capital) {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const rad = i % 2 === 0 ? r * 1.8 : r * 0.8;
        const px = x + Math.cos(a) * rad;
        const py = y + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Owner is shown by a flag on a pole, as in the original.
    if (c.owner >= 0) {
      const poleH = r * 3.4;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, 1.6 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - poleH);
      ctx.stroke();
      ctx.fillStyle = SIDE[c.owner]!;
      ctx.beginPath();
      ctx.moveTo(x, y - poleH);
      ctx.lineTo(x + r * 2.1, y - poleH + r * 0.85);
      ctx.lineTo(x, y - poleH + r * 1.7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * ARROW_HEAD - uy * ARROW_HEAD * 0.55, y1 - uy * ARROW_HEAD + ux * ARROW_HEAD * 0.55);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * ARROW_HEAD + uy * ARROW_HEAD * 0.55, y1 - uy * ARROW_HEAD - ux * ARROW_HEAD * 0.55);
}

/** Where a unit actually ends up: the route's last vertex, plus its own offset. */
function endPoint(path: number[], lateral: number): { x: number; y: number } {
  const n = path.length;
  const x = path[n - 2]!;
  const y = path[n - 1]!;
  if (n < 4 || lateral === 0) return { x, y };
  const dx = x - path[n - 4]!;
  const dy = y - path[n - 3]!;
  const len = Math.hypot(dx, dy) || 1;
  return { x: x + (-dy / len) * lateral, y: y + (dx / len) * lateral };
}

function drawOrders(ctx: CanvasRenderingContext2D, w: World, cam: Camera, input: InputState): void {
  // Confirmed routes, faint.
  ctx.strokeStyle = ACTIVE_PATH;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const u of w.units) {
    if (!u.alive || u.side !== BLUE || !u.path) continue;
    ctx.moveTo(sx(cam, u.x), sy(cam, u.y));
    for (let i = u.leg * 2; i + 1 < u.path.length; i += 2) {
      ctx.lineTo(sx(cam, u.path[i]!), sy(cam, u.path[i + 1]!));
    }
  }
  ctx.stroke();

  // Pending orders waiting on ENTER.
  //
  // Each unit gets one arrow to *its own* end point, and the shared route is drawn
  // once on top. Drawing every unit's full path made twenty lines converge on the
  // spot the drag started, which read as a starburst and told you nothing.
  const orders = [...w.pending.values()];
  if (orders.length > 0) {
    ctx.strokeStyle = PENDING;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const order of orders) {
      const u = w.units.find((x) => x.id === order.unitId && x.alive);
      if (!u) continue;
      const end = endPoint(order.path, order.lateral);
      arrow(ctx, sx(cam, u.x), sy(cam, u.y), sx(cam, end.x), sy(cam, end.y));
    }
    ctx.stroke();

    const route = orders[0]!.path;
    if (route.length >= 4) {
      ctx.strokeStyle = PENDING;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx(cam, route[0]!), sy(cam, route[1]!));
      for (let i = 2; i + 1 < route.length; i += 2) {
        ctx.lineTo(sx(cam, route[i]!), sy(cam, route[i + 1]!));
      }
      ctx.stroke();
    }
  }

  // The route being drawn right now.
  if (input.route.length >= 4) {
    ctx.strokeStyle = PENDING;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx(cam, input.route[0]!), sy(cam, input.route[1]!));
    for (let i = 2; i + 1 < input.route.length; i += 2) {
      ctx.lineTo(sx(cam, input.route[i]!), sy(cam, input.route[i + 1]!));
    }
    ctx.stroke();
  }

  if (input.lasso.length >= 4) {
    ctx.strokeStyle = LASSO;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(sx(cam, input.lasso[0]!), sy(cam, input.lasso[1]!));
    for (let i = 2; i + 1 < input.lasso.length; i += 2) {
      ctx.lineTo(sx(cam, input.lasso[i]!), sy(cam, input.lasso[i + 1]!));
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Deterministic tremble from tick and id, so units in combat visibly shake. */
function shakeOf(u: Unit, tick: number): [number, number] {
  if (!u.inCombat) return [0, 0];
  const h = Math.imul(u.id * 2654435761 + tick, 2246822519) >>> 0;
  return [((h & 0xff) / 255 - 0.5) * SHAKE * 2, (((h >> 8) & 0xff) / 255 - 0.5) * SHAKE * 2];
}

function drawUnits(ctx: CanvasRenderingContext2D, w: World, cam: Camera, shown: Unit[]): void {
  for (const side of [BLUE, RED]) {
    ctx.fillStyle = SIDE[side]!;
    ctx.beginPath();
    for (const u of shown) {
      if (u.side !== side) continue;
      const [jx, jy] = shakeOf(u, w.tick);
      const r = Math.max(MIN_R, UNIT_R[u.heavy ? 1 : 0]! * cam.zoom);
      const x = sx(cam, u.x + jx);
      const y = sy(cam, u.y + jy);
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // Heavy units carry a black oval — that is the whole visual difference.
  ctx.strokeStyle = '#000000';
  ctx.beginPath();
  for (const u of shown) {
    if (!u.heavy) continue;
    const [jx, jy] = shakeOf(u, w.tick);
    const r = Math.max(MIN_R, UNIT_R[1]! * cam.zoom);
    ctx.lineWidth = Math.max(1, r * HEAVY_RING_W);
    ctx.moveTo(sx(cam, u.x + jx) + r * HEAVY_RING, sy(cam, u.y + jy));
    ctx.arc(sx(cam, u.x + jx), sy(cam, u.y + jy), r * HEAVY_RING, 0, Math.PI * 2);
  }
  ctx.stroke();

  ctx.strokeStyle = SELECT_RING;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const u of shown) {
    if (u.side !== BLUE || !w.selection.has(u.id)) continue;
    const r = Math.max(MIN_R, UNIT_R[u.heavy ? 1 : 0]! * cam.zoom) + 3;
    ctx.moveTo(sx(cam, u.x) + r, sy(cam, u.y));
    ctx.arc(sx(cam, u.x), sy(cam, u.y), r, 0, Math.PI * 2);
  }
  ctx.stroke();
}

/** Two stacked bars: green health on top, blue morale below, on a black frame. */
function drawBars(ctx: CanvasRenderingContext2D, cam: Camera, shown: Unit[]): void {
  if (cam.zoom < 0.3) return;
  const bw = BAR_W * Math.min(1, cam.zoom);
  const bh = BAR_H * Math.min(1, cam.zoom);
  for (const u of shown) {
    if (u.hp >= 0.999 && u.morale >= 0.999) continue;
    const x = sx(cam, u.x) - bw / 2;
    const y = sy(cam, u.y) - BAR_LIFT * Math.min(1, cam.zoom) - bh * 2;
    ctx.fillStyle = '#000000';
    ctx.fillRect(x - BAR_BORDER, y - BAR_BORDER, bw + BAR_BORDER * 2, bh * 2 + BAR_BORDER * 2);
    ctx.fillStyle = BAR_EMPTY;
    ctx.fillRect(x, y, bw, bh * 2);
    ctx.fillStyle = HEALTH;
    ctx.fillRect(x, y, bw * Math.max(0, u.hp), bh);
    ctx.fillStyle = MORALE;
    ctx.fillRect(x, y + bh, bw * Math.max(0, u.morale), bh);
  }
}

export function render(ctx: CanvasRenderingContext2D, w: World, cam: Camera, input: InputState, fogOn: boolean): void {
  ctx.fillStyle = '#0b0f0b';
  ctx.fillRect(0, 0, cam.vw, cam.vh);
  drawTerrain(ctx, w.map, cam);
  if (fogOn) drawFog(ctx, w, cam);
  drawFront(ctx, w, cam);
  drawCities(ctx, w, cam);

  const shown = w.units.filter(
    (u) => u.alive && (!fogOn || u.side === BLUE || visible(w, u.x, u.y)),
  );
  drawOrders(ctx, w, cam, input);
  drawUnits(ctx, w, cam, shown);
  drawBars(ctx, cam, shown);
}
