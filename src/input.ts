/**
 * Mouse and keyboard.
 *
 * Orders run the instant they are given. Select, drag a route, let go, and the
 * troops are already walking it — there is nothing to confirm.
 */

import { clamp, pan, sx, sy, wx, wy, zoomAt } from './camera.ts';
import type { Camera } from './camera.ts';
import { sfxOrder, sfxSelect } from './audio.ts';
import { clearLine, findPath } from './nav.ts';
import { TILE } from './terrain.ts';
import { BLUE, selectedUnits } from './world.ts';
import type { Unit, World } from './world.ts';

const ZOOM_STEP = 1.14;
/** A drag shorter than this counts as a click. */
const CLICK_SLOP = 6;
/** Grab radius for clicking a unit, screen pixels. */
const PICK_PX = 14;
/** Minimum spacing between sampled points of a drawn route, world units. */
const SAMPLE = 22;
/** Spacing between neighbours walking abreast along one route, world units. */
const FILE_SPACING = 20;
/** Wider than this and the line wraps into another rank. */
const MAX_FILES = 14;
/** Screen-edge band that pans the camera, pixels. */
const EDGE = 16;
const PAN_SPEED = 900;

type Drag = 'none' | 'lasso' | 'route' | 'pan';

export interface InputState {
  drag: Drag;
  /** World-space polygon being drawn for selection. */
  lasso: number[];
  /** World-space route being drawn. */
  route: number[];
  formation: boolean;
  hoverX: number;
  hoverY: number;
  mouseX: number;
  mouseY: number;
  inside: boolean;
}

export function createInput(): InputState {
  return {
    drag: 'none',
    lasso: [],
    route: [],
    formation: false,
    hoverX: 0,
    hoverY: 0,
    mouseX: 0,
    mouseY: 0,
    inside: false,
  };
}

function pointInPolygon(poly: number[], px: number, py: number): boolean {
  const n = poly.length >> 1;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!;
    const yi = poly[i * 2 + 1]!;
    const xj = poly[j * 2]!;
    const yj = poly[j * 2 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pickUnit(w: World, cam: Camera, px: number, py: number): Unit | null {
  let best: Unit | null = null;
  let bestD = PICK_PX;
  for (const u of w.units) {
    if (!u.alive || u.side !== BLUE) continue;
    const d = Math.hypot(sx(cam, u.x) - px, sy(cam, u.y) - py);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

/**
 * Searches allowed while handing out a single order.
 *
 * Sending a whole army across broken country wanted sixty-odd routes at once and
 * cost 42ms — a dropped frame the instant you let go of the mouse. The ones that
 * miss out set off straight at the target and ask for a route when they actually
 * meet something, which is the same machinery half a second later and invisible.
 */
const ORDER_SEARCHES = 8;
let searchBudget = 0;

/**
 * The route a unit should actually walk to reach a point: the straight line when
 * nothing is in the way, and a way round when something is.
 */
function routeTo(w: World, u: Unit, x: number, y: number): number[] {
  if (clearLine(w.map, u.x, u.y, x, y) || searchBudget === 0) return [x, y];
  searchBudget--;
  const found = findPath(w.map, u.x, u.y, x, y);
  // findPath starts at the unit itself; that first point is where it already is.
  return found && found.length > 2 ? found.slice(2) : [x, y];
}

function send(u: Unit, path: number[], lateral: number): void {
  // An empty route has to become null, not an empty array: `path !== null` is what
  // marks a unit as advancing, and a stationary one must never read as attacking.
  u.path = path.length >= 2 ? path : null;
  u.leg = 0;
  u.lateral = lateral;
  u.stuck = 0;
}

/** Sends every selected unit along the drawn route, spread across its width. */
function orderAlongRoute(w: World, route: number[]): void {
  const units = selectedUnits(w);
  if (units.length === 0 || route.length < 4) return;
  searchBudget = ORDER_SEARCHES;

  const dirX = route[2]! - route[0]!;
  const dirY = route[3]! - route[1]!;
  const len = Math.hypot(dirX, dirY) || 1;
  const nx = -dirY / len;
  const ny = dirX / len;
  // Keep left-to-right order relative to the heading, so a line stays a line.
  const ordered = units.slice().sort((a, b) => a.x * nx + a.y * ny - (b.x * nx + b.y * ny));

  const files = Math.max(1, Math.min(ordered.length, MAX_FILES));
  const centre = (files - 1) / 2;
  ordered.forEach((u, i) => {
    // Getting to the head of the drawn route is the unit's own problem, and it may
    // have a hill in the way; the drawn part after that is exactly as drawn.
    const lead = routeTo(w, u, route[0]!, route[1]!);
    lead.length -= 2;
    send(u, [...lead, ...route], ((i % files) - centre) * FILE_SPACING);
  });
}

/** Formation move: everyone shifts by the same vector, so the shape is preserved. */
function orderFormation(w: World, fromX: number, fromY: number, toX: number, toY: number): void {
  const units = selectedUnits(w);
  if (units.length === 0) return;
  searchBudget = ORDER_SEARCHES;
  const dx = toX - fromX;
  const dy = toY - fromY;
  for (const u of units) send(u, routeTo(w, u, u.x + dx, u.y + dy), 0);
}

function orderToPoint(w: World, x: number, y: number): void {
  const units = selectedUnits(w);
  if (units.length === 0) return;
  const centreX = units.reduce((s, u) => s + u.x, 0) / units.length;
  const centreY = units.reduce((s, u) => s + u.y, 0) / units.length;
  orderFormation(w, centreX, centreY, x, y);
  void centreX;
  void centreY;
}

/** Cancels the route: the unit keeps walking off its momentum and then holds. */
export function clearOrders(w: World): void {
  for (const u of selectedUnits(w)) send(u, [], 0);
}

/** Same, but plants it where it stands. */
export function stopSelected(w: World): void {
  for (const u of selectedUnits(w)) {
    send(u, [], 0);
    u.vx = 0;
    u.vy = 0;
  }
}

export interface InputDeps {
  world: World;
  camera: Camera;
  input: InputState;
  /** False while a menu is up: the canvas is still there, but it is scenery. */
  enabled: boolean;
}

export function attachInput(canvas: HTMLCanvasElement, deps: InputDeps): void {
  const { input } = deps;
  let downX = 0;
  let downY = 0;
  let startWX = 0;
  let startWY = 0;
  let lastX = 0;
  let lastY = 0;

  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!deps.enabled) return;
    const [px, py] = local(e);
    canvas.setPointerCapture(e.pointerId);
    downX = px;
    downY = py;
    lastX = px;
    lastY = py;
    startWX = wx(deps.camera, px);
    startWY = wy(deps.camera, py);
    input.formation = e.shiftKey;

    if (e.button === 1 || e.button === 2) {
      input.drag = 'pan';
      return;
    }
    if (deps.world.selection.size > 0) {
      input.drag = 'route';
      input.route = [startWX, startWY];
    } else {
      input.drag = 'lasso';
      input.lasso = [startWX, startWY];
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!deps.enabled) return;
    const [px, py] = local(e);
    input.mouseX = px;
    input.mouseY = py;
    input.inside = px >= 0 && py >= 0 && px <= canvas.clientWidth && py <= canvas.clientHeight;
    input.hoverX = wx(deps.camera, px);
    input.hoverY = wy(deps.camera, py);

    if (input.drag === 'pan') {
      pan(deps.camera, px - lastX, py - lastY, deps.world.map.worldW, deps.world.map.worldH);
    } else if (input.drag === 'lasso') {
      pushSample(input.lasso, input.hoverX, input.hoverY);
    } else if (input.drag === 'route' && !input.formation) {
      pushSample(input.route, input.hoverX, input.hoverY);
    }
    lastX = px;
    lastY = py;
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!deps.enabled) return;
    const [px, py] = local(e);
    const moved = Math.hypot(px - downX, py - downY);
    const w = deps.world;

    if (input.drag === 'lasso') {
      if (moved <= CLICK_SLOP) {
        const hit = pickUnit(w, deps.camera, px, py);
        w.selection.clear();
        if (hit) {
          w.selection.add(hit.id);
          sfxSelect();
        }
      } else {
        if (!e.shiftKey) w.selection.clear();
        const before = w.selection.size;
        for (const u of w.units) {
          if (u.alive && u.side === BLUE && pointInPolygon(input.lasso, u.x, u.y)) {
            w.selection.add(u.id);
          }
        }
        if (w.selection.size > before) sfxSelect();
      }
      input.lasso = [];
    } else if (input.drag === 'route') {
      const hit = moved <= CLICK_SLOP ? pickUnit(w, deps.camera, px, py) : null;
      if (hit) {
        if (!e.shiftKey) w.selection.clear();
        w.selection.add(hit.id);
        sfxSelect();
      } else {
        if (moved <= CLICK_SLOP) orderToPoint(w, input.hoverX, input.hoverY);
        else if (input.formation) orderFormation(w, startWX, startWY, input.hoverX, input.hoverY);
        else orderAlongRoute(w, input.route);
        if (w.selection.size > 0) sfxOrder();
      }
      input.route = [];
    }
    input.drag = 'none';
  });

  canvas.addEventListener('wheel', (e) => {
    if (!deps.enabled) return;
    e.preventDefault();
    const [px, py] = local(e);
    const f = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(deps.camera, px, py, f, deps.world.map.worldW, deps.world.map.worldH);
  }, { passive: false });

  canvas.addEventListener('pointerleave', () => {
    input.inside = false;
  });
}

function pushSample(pts: number[], x: number, y: number): void {
  const n = pts.length;
  if (n >= 2 && Math.hypot(x - pts[n - 2]!, y - pts[n - 1]!) < SAMPLE) return;
  pts.push(x, y);
}

/** Keyboard and edge panning, applied once per frame. */
export function updateCamera(deps: InputDeps, keys: Set<string>, dt: number): void {
  const { camera, input, world } = deps;
  if (!deps.enabled) return;
  const step = (PAN_SPEED * dt) / camera.zoom;
  let dx = 0;
  let dy = 0;
  if (keys.has('w') || keys.has('arrowup')) dy -= step;
  if (keys.has('s') || keys.has('arrowdown')) dy += step;
  if (keys.has('a') || keys.has('arrowleft')) dx -= step;
  if (keys.has('d') || keys.has('arrowright')) dx += step;

  if (input.inside && input.drag === 'none') {
    if (input.mouseX < EDGE) dx -= step;
    else if (input.mouseX > camera.vw - EDGE) dx += step;
    if (input.mouseY < EDGE) dy -= step;
    else if (input.mouseY > camera.vh - EDGE) dy += step;
  }
  if (dx !== 0 || dy !== 0) {
    camera.x += dx;
    camera.y += dy;
    clamp(camera, world.map.worldW, world.map.worldH);
  }
}

export { TILE };
