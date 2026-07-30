/**
 * Mouse and keyboard, translated into commands.
 *
 * Two decisions worth knowing about:
 *
 * The right button does double duty. With units selected, a right-drag draws the
 * curve they will walk; with nothing selected it pans the camera. That is how the
 * spec assigns it, and it works because you never want to pan and route at the same
 * moment. Middle-drag always pans, for when you do.
 *
 * Selection is by unit id, so orders survive the slot recycling that happens when
 * units die between the click and the release.
 *
 * Handlers live at module scope over an explicit `Runtime` rather than inside the
 * factory closure: there are a dozen of them, and a 300-line factory is not
 * something anyone should have to read.
 */

import type { Command, World } from '../core/types.ts';
import {
  CLICK_PICK_R,
  DRAG_CLICK_PX,
  EDGE_PAN_BAND,
  PAN_SPEED,
  PATH_SAMPLE_MIN,
} from '../core/balance.ts';
import { decimate, dist2, pointInPolygon, polygonBounds } from '../core/geometry.ts';
import { cityAt } from '../core/terrain.ts';
import type { Camera } from '../render/camera.ts';
import { panBy, screenToWorldX, screenToWorldY, zoomAt } from '../render/camera.ts';
import type { SelectionState } from './selection.ts';
import { assignGroup, recallGroup, selectAll, selectByKind, selectionSlots } from './selection.ts';

const ZOOM_STEP = 1.12;
/** A lasso needs at least this many vertices before it can enclose anything. */
const MIN_LASSO_POINTS = 3;

export interface InputContext {
  world: World;
  camera: Camera;
  selection: SelectionState;
  /** Player the local user controls. 0 while observing. */
  viewer: number;
  cameraSpeed: number;
  /** Suspends all input while a menu or the end screen is up. */
  blocked: boolean;
}

export interface InputHandlers {
  emit(cmd: Command): void;
  togglePause(): void;
  setSpeed(speed: 1 | 2 | 3): void;
  toggleAiDebug(): void;
  toggleDebugPanel(): void;
  toggleTerritory(): void;
  escape(): void;
  focusCity(cityIndex: number): void;
}

export interface Input {
  readonly hoverX: number;
  readonly hoverY: number;
  readonly context: InputContext;
  attach(): void;
  detach(): void;
  /** Applies keyboard and screen-edge panning. Call once per frame. */
  update(dtSec: number): void;
}

type Drag = 'idle' | 'lasso' | 'draw' | 'pan';

interface Runtime {
  canvas: HTMLCanvasElement;
  ctx: InputContext;
  on: InputHandlers;
  keys: Set<string>;
  drag: Drag;
  downX: number;
  downY: number;
  lastX: number;
  lastY: number;
  hoverX: number;
  hoverY: number;
  pointerInside: boolean;
  appendPath: boolean;
  additive: boolean;
}

// ───────────────────────────────────────────────────────────────── helpers ──

function localX(rt: Runtime, e: PointerEvent | WheelEvent): number {
  return e.clientX - rt.canvas.getBoundingClientRect().left;
}

function localY(rt: Runtime, e: PointerEvent | WheelEvent): number {
  return e.clientY - rt.canvas.getBoundingClientRect().top;
}

/** Nearest own living unit to a world point within the pick radius, or -1. */
function pickUnit(rt: Runtime, wx: number, wy: number): number {
  const u = rt.ctx.world.units;
  let best = -1;
  let bestD = CLICK_PICK_R * CLICK_PICK_R;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== rt.ctx.viewer) continue;
    const d = dist2(wx, wy, u.x[i]!, u.y[i]!);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function selectionCentroid(rt: Runtime): { x: number; y: number } | null {
  const slots = selectionSlots(rt.ctx.world, rt.ctx.selection);
  if (slots.length === 0) return null;
  const u = rt.ctx.world.units;
  let x = 0;
  let y = 0;
  for (const slot of slots) {
    x += u.x[slot]!;
    y += u.y[slot]!;
  }
  return { x: x / slots.length, y: y / slots.length };
}

function applyLasso(rt: Runtime, poly: number[], add: boolean): void {
  const sel = rt.ctx.selection;
  if (!add) sel.units.clear();
  if (poly.length < MIN_LASSO_POINTS * 2) return;
  const box = polygonBounds(poly);
  const u = rt.ctx.world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== rt.ctx.viewer) continue;
    const x = u.x[i]!;
    const y = u.y[i]!;
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
    if (pointInPolygon(poly, x, y)) sel.units.add(u.id[i]!);
  }
}

function pushSampled(pts: number[], wx: number, wy: number): void {
  const n = pts.length;
  if (n >= 2 && dist2(wx, wy, pts[n - 2]!, pts[n - 1]!) < PATH_SAMPLE_MIN * PATH_SAMPLE_MIN) return;
  pts.push(wx, wy);
}

// ──────────────────────────────────────────────────────────────── pointer ──

function onPointerDown(rt: Runtime, e: PointerEvent): void {
  if (rt.ctx.blocked) return;
  rt.canvas.setPointerCapture(e.pointerId);
  rt.downX = localX(rt, e);
  rt.downY = localY(rt, e);
  rt.lastX = rt.downX;
  rt.lastY = rt.downY;
  rt.additive = e.shiftKey;
  rt.appendPath = e.shiftKey;
  const wx = screenToWorldX(rt.ctx.camera, rt.downX);
  const wy = screenToWorldY(rt.ctx.camera, rt.downY);

  if (e.button === 1) {
    rt.drag = 'pan';
    return;
  }
  if (e.button === 2) {
    if (rt.ctx.selection.units.size > 0 && rt.ctx.viewer > 0) {
      rt.drag = 'draw';
      const start = selectionCentroid(rt) ?? { x: wx, y: wy };
      rt.ctx.selection.drawing = [start.x, start.y, wx, wy];
    } else {
      rt.drag = 'pan';
    }
    return;
  }
  if (e.button === 0) {
    rt.drag = 'lasso';
    rt.ctx.selection.lasso = [wx, wy];
    rt.ctx.selection.lassoAdditive = rt.additive;
  }
}

function onPointerMove(rt: Runtime, e: PointerEvent): void {
  const sx = localX(rt, e);
  const sy = localY(rt, e);
  rt.hoverX = screenToWorldX(rt.ctx.camera, sx);
  rt.hoverY = screenToWorldY(rt.ctx.camera, sy);
  rt.pointerInside =
    sx >= 0 && sy >= 0 && sx <= rt.canvas.clientWidth && sy <= rt.canvas.clientHeight;
  rt.ctx.selection.hoverCity = cityAt(rt.ctx.world.map, rt.hoverX, rt.hoverY);

  if (!rt.ctx.blocked && rt.drag !== 'idle') {
    if (rt.drag === 'pan') {
      panBy(rt.ctx.camera, sx - rt.lastX, sy - rt.lastY, rt.ctx.world.map);
    } else if (rt.drag === 'lasso' && rt.ctx.selection.lasso) {
      pushSampled(rt.ctx.selection.lasso, rt.hoverX, rt.hoverY);
    } else if (rt.drag === 'draw' && rt.ctx.selection.drawing) {
      pushSampled(rt.ctx.selection.drawing, rt.hoverX, rt.hoverY);
    }
  }
  rt.lastX = sx;
  rt.lastY = sy;
}

function finishLasso(rt: Runtime, moved: number): void {
  const sel = rt.ctx.selection;
  if (moved <= DRAG_CLICK_PX) {
    const slot = pickUnit(rt, rt.hoverX, rt.hoverY);
    if (!rt.additive) sel.units.clear();
    if (slot >= 0) sel.units.add(rt.ctx.world.units.id[slot]!);
    else if (sel.hoverCity >= 0) rt.on.focusCity(sel.hoverCity);
  } else if (sel.lasso) {
    applyLasso(rt, decimate(sel.lasso, PATH_SAMPLE_MIN), rt.additive);
  }
  sel.lasso = null;
}

function finishDraw(rt: Runtime, moved: number): void {
  const sel = rt.ctx.selection;
  if (!sel.drawing) return;
  const start = selectionCentroid(rt);
  const pts =
    moved <= DRAG_CLICK_PX && start
      ? [start.x, start.y, rt.hoverX, rt.hoverY]
      : decimate(sel.drawing, PATH_SAMPLE_MIN);
  sel.drawing = null;
  if (sel.units.size === 0 || pts.length < 4) return;
  rt.on.emit({
    t: 'path',
    player: rt.ctx.viewer,
    units: [...sel.units],
    pts,
    append: rt.appendPath,
  });
}

function onPointerUp(rt: Runtime, e: PointerEvent): void {
  if (rt.canvas.hasPointerCapture(e.pointerId)) rt.canvas.releasePointerCapture(e.pointerId);
  const moved = Math.hypot(localX(rt, e) - rt.downX, localY(rt, e) - rt.downY);
  if (rt.drag === 'lasso') finishLasso(rt, moved);
  else if (rt.drag === 'draw') finishDraw(rt, moved);
  rt.drag = 'idle';
}

function onWheel(rt: Runtime, e: WheelEvent): void {
  if (rt.ctx.blocked) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  zoomAt(rt.ctx.camera, localX(rt, e), localY(rt, e), factor, rt.ctx.world.map);
}

// ─────────────────────────────────────────────────────────────── keyboard ──

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function handleModified(rt: Runtime, e: KeyboardEvent, digit: number): boolean {
  const { world, selection, viewer } = rt.ctx;
  switch (e.key.toLowerCase()) {
    case 'a':
      selectAll(world, selection, viewer);
      return true;
    case 'h':
      selectByKind(world, selection, viewer, true);
      return true;
    case 'l':
      selectByKind(world, selection, viewer, false);
      return true;
    default:
      if (digit === 0) return false;
      assignGroup(selection, digit);
      return true;
  }
}

function handleShortcut(rt: Runtime, e: KeyboardEvent): boolean {
  const sel = rt.ctx.selection;
  const key = e.key.toLowerCase();
  const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;

  if (e.ctrlKey || e.metaKey) return handleModified(rt, e, digit);
  if (digit) {
    recallGroup(sel, digit);
    return true;
  }

  switch (key) {
    case ' ':
      rt.on.togglePause();
      return true;
    case 's':
      if (sel.units.size) rt.on.emit({ t: 'stop', player: rt.ctx.viewer, units: [...sel.units] });
      return true;
    case 'c':
      if (sel.units.size) rt.on.emit({ t: 'clear', player: rt.ctx.viewer, units: [...sel.units] });
      return true;
    case 't':
      rt.on.toggleTerritory();
      return true;
    case '+':
    case '=':
      rt.on.setSpeed(3);
      return true;
    case '-':
      rt.on.setSpeed(1);
      return true;
    default:
      return false;
  }
}

function onKeyDown(rt: Runtime, e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return;
  if (e.key === 'Escape') {
    rt.on.escape();
    return;
  }
  if (e.key === 'F3' || e.key === 'F4') {
    e.preventDefault();
    if (e.key === 'F3') rt.on.toggleAiDebug();
    else rt.on.toggleDebugPanel();
    return;
  }
  if (rt.ctx.blocked) return;
  rt.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (handleShortcut(rt, e)) e.preventDefault();
}

// ──────────────────────────────────────────────────────────────── panning ──

function panFromKeysAndEdges(rt: Runtime, dtSec: number): void {
  if (rt.ctx.blocked) return;
  const step = PAN_SPEED * rt.ctx.cameraSpeed * dtSec * rt.ctx.camera.zoom;
  let dx = 0;
  let dy = 0;
  // The spec gives `S` to both "stop" and WASD panning. Stop wins, because a
  // misfired stop order costs a battle and a missing pan key costs nothing: the
  // arrows, `X`, edge-pan, right-drag and the minimap all still pan down.
  if (rt.keys.has('w') || rt.keys.has('ArrowUp')) dy += step;
  if (rt.keys.has('x') || rt.keys.has('ArrowDown')) dy -= step;
  if (rt.keys.has('a') || rt.keys.has('ArrowLeft')) dx += step;
  if (rt.keys.has('d') || rt.keys.has('ArrowRight')) dx -= step;

  if (rt.pointerInside && rt.drag === 'idle') {
    if (rt.lastX < EDGE_PAN_BAND) dx += step;
    else if (rt.lastX > rt.canvas.clientWidth - EDGE_PAN_BAND) dx -= step;
    if (rt.lastY < EDGE_PAN_BAND) dy += step;
    else if (rt.lastY > rt.canvas.clientHeight - EDGE_PAN_BAND) dy -= step;
  }
  if (dx !== 0 || dy !== 0) panBy(rt.ctx.camera, dx, dy, rt.ctx.world.map);
}

// ─────────────────────────────────────────────────────────────── assembly ──

/** Listeners are bound once so `detach` can actually remove them again. */
function bindListeners(rt: Runtime) {
  return {
    down: (e: PointerEvent) => onPointerDown(rt, e),
    move: (e: PointerEvent) => onPointerMove(rt, e),
    up: (e: PointerEvent) => onPointerUp(rt, e),
    wheel: (e: WheelEvent) => onWheel(rt, e),
    menu: (e: Event) => e.preventDefault(),
    leave: () => {
      rt.pointerInside = false;
    },
    keyDown: (e: KeyboardEvent) => onKeyDown(rt, e),
    keyUp: (e: KeyboardEvent) => {
      rt.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    },
    blur: () => {
      rt.keys.clear();
      rt.pointerInside = false;
      rt.drag = 'idle';
    },
  };
}

export function createInput(
  canvas: HTMLCanvasElement,
  context: InputContext,
  handlers: InputHandlers,
): Input {
  const rt: Runtime = {
    canvas,
    ctx: context,
    on: handlers,
    keys: new Set<string>(),
    drag: 'idle',
    downX: 0,
    downY: 0,
    lastX: 0,
    lastY: 0,
    hoverX: 0,
    hoverY: 0,
    pointerInside: false,
    appendPath: false,
    additive: false,
  };
  const bound = bindListeners(rt);

  return {
    get hoverX() {
      return rt.hoverX;
    },
    get hoverY() {
      return rt.hoverY;
    },
    context,

    attach(): void {
      canvas.addEventListener('pointerdown', bound.down);
      canvas.addEventListener('pointermove', bound.move);
      canvas.addEventListener('pointerup', bound.up);
      canvas.addEventListener('pointercancel', bound.up);
      canvas.addEventListener('pointerleave', bound.leave);
      canvas.addEventListener('wheel', bound.wheel, { passive: false });
      canvas.addEventListener('contextmenu', bound.menu);
      window.addEventListener('keydown', bound.keyDown);
      window.addEventListener('keyup', bound.keyUp);
      window.addEventListener('blur', bound.blur);
    },

    detach(): void {
      canvas.removeEventListener('pointerdown', bound.down);
      canvas.removeEventListener('pointermove', bound.move);
      canvas.removeEventListener('pointerup', bound.up);
      canvas.removeEventListener('pointercancel', bound.up);
      canvas.removeEventListener('pointerleave', bound.leave);
      canvas.removeEventListener('wheel', bound.wheel);
      canvas.removeEventListener('contextmenu', bound.menu);
      window.removeEventListener('keydown', bound.keyDown);
      window.removeEventListener('keyup', bound.keyUp);
      window.removeEventListener('blur', bound.blur);
    },

    update(dtSec: number): void {
      panFromKeysAndEdges(rt, dtSec);
    },
  };
}
