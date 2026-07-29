/**
 * Orders layer: what the player has asked for, plus the cities themselves.
 *
 * Cities live here rather than in the unit layer so that the production network
 * lines are drawn underneath their markers and the markers sit above the dots —
 * a capture arc is a thing you must be able to read through a scrum of units.
 *
 * A path is shared by every unit that was given it, so routes are collapsed to one
 * polyline per pool slot and the split between travelled and remaining is taken
 * from the *least* advanced unit on it: the interesting question when you select a
 * group is how much of the order is still outstanding.
 */

import type { City, World } from '../../core/types.ts';
import { makePathSample, samplePath } from '../../core/paths.ts';
import { slotOfId } from '../../core/units.ts';
import type { ViewBounds } from '../camera.ts';
import { visibleBounds, worldToScreenX, worldToScreenY } from '../camera.ts';
import type { FrameState, Layer } from '../frame.ts';
import type { CapitalShape } from '../theme.ts';
import { capitalShape, playerColor } from '../theme.ts';

const TAU = Math.PI * 2;
const NO_DASH: number[] = [];

const LINK_WIDTH = 1;
const LINK_ALPHA = 0.3;
const LINK_DASH = [3, 5];

const ROUTE_WIDTH = 1.8;
const TRAVELLED_ALPHA = 0.22;
const ROUTE_END_R = 3.5;

const DRAWING_WIDTH = 2;
const LASSO_WIDTH = 1.5;
const LASSO_FILL_ALPHA = 0.08;

const MIN_CITY_R = 5;
const CITY_FILL_ALPHA = 0.3;
const CITY_RING_WIDTH = 2;
const CITY_OFF_DASH = [3, 3];
const CAPTURE_WIDTH = 3;
const CAPTURE_GAP = 3;
const CAPITAL_MARK_R = 4.5;
const CAPITAL_EDGE_WIDTH = 1;
/** Triangle marker: base sits this fraction of the radius below the centre. */
const TRIANGLE_BASE = 0.8;
const CITY_DOT_R = 2.4;
const HOVER_WIDTH = 3;
const HOVER_GAP = 2;

const sample = makePathSample();
const routeBounds: ViewBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
/** Path pool slot → arc length of the least advanced selected unit on it. */
const routes = new Map<number, number>();

// ──────────────────────────────────────────────────────── production links ──

/** Faint mesh between the viewer's active cities (spec 4.8), per supply pocket. */
function drawCityLinks(ctx: CanvasRenderingContext2D, frame: FrameState, world: World): void {
  const cam = frame.camera;
  const cities = world.cities;
  ctx.strokeStyle = frame.theme.orderLine;
  ctx.lineWidth = LINK_WIDTH;
  ctx.globalAlpha = LINK_ALPHA;
  ctx.setLineDash(LINK_DASH);
  ctx.beginPath();
  for (let a = 0; a < cities.length; a++) {
    const ca = cities[a]!;
    if (ca.owner !== frame.viewer || !ca.active) continue;
    for (let b = a + 1; b < cities.length; b++) {
      const cb = cities[b]!;
      if (cb.owner !== frame.viewer || !cb.active || cb.pocket !== ca.pocket) continue;
      ctx.moveTo(worldToScreenX(cam, ca.x), worldToScreenY(cam, ca.y));
      ctx.lineTo(worldToScreenX(cam, cb.x), worldToScreenY(cam, cb.y));
    }
  }
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────────────── routes ──

function collectRoutes(frame: FrameState, world: World): void {
  routes.clear();
  const u = world.units;
  for (const id of frame.selection.units) {
    const slot = slotOfId(u, id);
    if (slot < 0 || !u.alive[slot]) continue;
    const idx = u.pathIdx[slot]!;
    if (idx < 0) continue;
    const pos = u.pathPos[slot]!;
    const prev = routes.get(idx);
    if (prev === undefined || pos < prev) routes.set(idx, pos);
  }
}

/**
 * Strokes either the part already walked or the part still to come. Both halves
 * come from the same vertex list, split at the arc length reached so far.
 */
function strokeRoutes(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  remaining: boolean,
): void {
  const cam = frame.camera;
  const pool = world.paths;
  ctx.beginPath();
  for (const [idx, pos] of routes) {
    const pts = pool.pts[idx];
    const cum = pool.cum[idx];
    if (!pts || !cum) continue;
    const n = cum.length;
    let k = 1;
    while (k < n - 1 && cum[k]! < pos) k++;
    samplePath(pool, idx, pos, sample);

    if (remaining) {
      ctx.moveTo(worldToScreenX(cam, sample.x), worldToScreenY(cam, sample.y));
      for (let v = k; v < n; v++) {
        ctx.lineTo(worldToScreenX(cam, pts[v * 2]!), worldToScreenY(cam, pts[v * 2 + 1]!));
      }
      const ex = worldToScreenX(cam, pts[(n - 1) * 2]!);
      const ey = worldToScreenY(cam, pts[(n - 1) * 2 + 1]!);
      ctx.moveTo(ex + ROUTE_END_R, ey);
      ctx.arc(ex, ey, ROUTE_END_R, 0, TAU);
    } else {
      ctx.moveTo(worldToScreenX(cam, pts[0]!), worldToScreenY(cam, pts[1]!));
      for (let v = 1; v < k; v++) {
        ctx.lineTo(worldToScreenX(cam, pts[v * 2]!), worldToScreenY(cam, pts[v * 2 + 1]!));
      }
      ctx.lineTo(worldToScreenX(cam, sample.x), worldToScreenY(cam, sample.y));
    }
  }
  ctx.stroke();
}

function drawRoutes(ctx: CanvasRenderingContext2D, frame: FrameState, world: World): void {
  collectRoutes(frame, world);
  if (routes.size === 0) return;
  ctx.strokeStyle = frame.theme.orderLine;
  ctx.lineWidth = ROUTE_WIDTH;
  ctx.globalAlpha = TRAVELLED_ALPHA;
  strokeRoutes(ctx, frame, world, false);
  ctx.globalAlpha = 1;
  strokeRoutes(ctx, frame, world, true);
}

// ───────────────────────────────────────────────────────── live mouse shapes ──

function drawFlatPolyline(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  poly: number[],
  close: boolean,
): void {
  const cam = frame.camera;
  ctx.beginPath();
  ctx.moveTo(worldToScreenX(cam, poly[0]!), worldToScreenY(cam, poly[1]!));
  for (let i = 2; i < poly.length; i += 2) {
    ctx.lineTo(worldToScreenX(cam, poly[i]!), worldToScreenY(cam, poly[i + 1]!));
  }
  if (close) ctx.closePath();
}

function drawInput(ctx: CanvasRenderingContext2D, frame: FrameState): void {
  const sel = frame.selection;
  const drawing = sel.drawing;
  if (drawing !== null && drawing.length >= 4) {
    ctx.strokeStyle = frame.theme.selection;
    ctx.lineWidth = DRAWING_WIDTH;
    drawFlatPolyline(ctx, frame, drawing, false);
    ctx.stroke();
  }
  const lasso = sel.lasso;
  if (lasso !== null && lasso.length >= 6) {
    drawFlatPolyline(ctx, frame, lasso, true);
    ctx.fillStyle = frame.theme.lasso;
    ctx.globalAlpha = LASSO_FILL_ALPHA;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = frame.theme.lasso;
    ctx.lineWidth = LASSO_WIDTH;
    ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────── cities ──

/** Capital marker outline. Shape carries the player identity in colour-blind mode. */
function markerPath(
  ctx: CanvasRenderingContext2D,
  shape: CapitalShape,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  switch (shape) {
    case 'square':
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case 'triangle':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r * TRIANGLE_BASE);
      ctx.lineTo(x - r, y + r * TRIANGLE_BASE);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU - Math.PI / 2;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
  }
}

function drawCityCore(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  city: City,
  x: number,
  y: number,
): void {
  const ci = world.players[city.owner]?.colorIndex ?? 0;
  const colour = city.owner === 0 ? frame.theme.cityNeutral : playerColor(ci);
  ctx.fillStyle = colour;
  if (city.capital && frame.colorblind) {
    markerPath(ctx, capitalShape(ci), x, y, CAPITAL_MARK_R);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, city.capital ? CAPITAL_MARK_R : CITY_DOT_R, 0, TAU);
  }
  ctx.fill();
  if (city.capital) {
    ctx.strokeStyle = frame.theme.cityRing;
    ctx.lineWidth = CAPITAL_EDGE_WIDTH;
    ctx.stroke();
  }
}

function drawCity(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  city: City,
): void {
  const cam = frame.camera;
  const x = worldToScreenX(cam, city.x);
  const y = worldToScreenY(cam, city.y);
  const r = Math.max(MIN_CITY_R, city.radius * cam.zoom);
  const ci = world.players[city.owner]?.colorIndex ?? 0;

  ctx.fillStyle = city.owner === 0 ? frame.theme.cityNeutral : playerColor(ci);
  ctx.globalAlpha = CITY_FILL_ALPHA;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  // A switched-off city keeps its income, so it must not read as lost — only as
  // idle. Hence the same ring, dashed and dimmed, rather than another colour.
  ctx.strokeStyle = city.active ? frame.theme.cityRing : frame.theme.textDim;
  ctx.lineWidth = CITY_RING_WIDTH;
  if (!city.active) ctx.setLineDash(CITY_OFF_DASH);
  ctx.stroke();
  ctx.setLineDash(NO_DASH);

  if (city.captureProgress > 0 && city.capturingPlayer > 0) {
    const cci = world.players[city.capturingPlayer]?.colorIndex ?? 0;
    ctx.strokeStyle = playerColor(cci);
    ctx.lineWidth = CAPTURE_WIDTH;
    ctx.beginPath();
    const from = -Math.PI / 2;
    ctx.arc(x, y, r + CAPTURE_GAP, from, from + TAU * Math.min(1, city.captureProgress));
    ctx.stroke();
  }

  if (frame.selection.hoverCity === city.index) {
    ctx.strokeStyle = frame.theme.selection;
    ctx.lineWidth = HOVER_WIDTH;
    ctx.beginPath();
    ctx.arc(x, y, r + HOVER_GAP, 0, TAU);
    ctx.stroke();
  }

  drawCityCore(ctx, frame, world, city, x, y);
}

function drawCities(ctx: CanvasRenderingContext2D, frame: FrameState, world: World): void {
  const b = visibleBounds(frame.camera, 0, routeBounds);
  for (const city of world.cities) {
    const pad = city.radius + CAPTURE_GAP + HOVER_GAP;
    if (city.x + pad < b.x0 || city.x - pad > b.x1) continue;
    if (city.y + pad < b.y0 || city.y - pad > b.y1) continue;
    drawCity(ctx, frame, world, city);
  }
}

export function createOrdersLayer(world: World): Layer {
  return {
    name: 'orders',
    draw(ctx: CanvasRenderingContext2D, frame: FrameState): void {
      drawCityLinks(ctx, frame, world);
      drawRoutes(ctx, frame, world);
      drawInput(ctx, frame);
      drawCities(ctx, frame, world);
    },
  };
}
