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
/** Lasso needs at least this many vertices before it can enclose anything. */
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

export function createInput(
  canvas: HTMLCanvasElement,
  context: InputContext,
  handlers: InputHandlers,
): Input {
  const keys = new Set<string>();
  let drag: Drag = 'idle';
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let hoverX = 0;
  let hoverY = 0;
  let pointerInside = false;
  let appendPath = false;
  let additive = false;

  const localX = (e: PointerEvent | WheelEvent): number =>
    e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e: PointerEvent | WheelEvent): number =>
    e.clientY - canvas.getBoundingClientRect().top;

  /** Nearest own living unit to a world point within the pick radius, or -1. */
  function pickUnit(wx: number, wy: number): number {
    const u = context.world.units;
    let best = -1;
    let bestD = CLICK_PICK_R * CLICK_PICK_R;
    for (let i = 0; i < u.capacity; i++) {
      if (!u.alive[i] || u.owner[i] !== context.viewer) continue;
      const d = dist2(wx, wy, u.x[i]!, u.y[i]!);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function selectionCentroid(): { x: number; y: number } | null {
    const slots = selectionSlots(context.world, context.selection);
    if (slots.length === 0) return null;
    const u = context.world.units;
    let x = 0;
    let y = 0;
    for (const slot of slots) {
      x += u.x[slot]!;
      y += u.y[slot]!;
    }
    return { x: x / slots.length, y: y / slots.length };
  }

  function applyLasso(poly: number[], add: boolean): void {
    const sel = context.selection;
    if (!add) sel.units.clear();
    if (poly.length < MIN_LASSO_POINTS * 2) return;
    const box = polygonBounds(poly);
    const u = context.world.units;
    for (let i = 0; i < u.capacity; i++) {
      if (!u.alive[i] || u.owner[i] !== context.viewer) continue;
      const x = u.x[i]!;
      const y = u.y[i]!;
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
      if (pointInPolygon(poly, x, y)) sel.units.add(u.id[i]!);
    }
  }

  function issuePath(pts: number[]): void {
    const sel = context.selection;
    if (sel.units.size === 0 || pts.length < 4) return;
    handlers.emit({
      t: 'path',
      player: context.viewer,
      units: [...sel.units],
      pts,
      append: appendPath,
    });
  }

  function onPointerDown(e: PointerEvent): void {
    if (context.blocked) return;
    canvas.setPointerCapture(e.pointerId);
    downX = localX(e);
    downY = localY(e);
    lastX = downX;
    lastY = downY;
    additive = e.shiftKey;
    appendPath = e.shiftKey;
    const wx = screenToWorldX(context.camera, downX);
    const wy = screenToWorldY(context.camera, downY);

    if (e.button === 1) {
      drag = 'pan';
      return;
    }
    if (e.button === 2) {
      if (context.selection.units.size > 0 && context.viewer > 0) {
        drag = 'draw';
        const start = selectionCentroid() ?? { x: wx, y: wy };
        context.selection.drawing = [start.x, start.y, wx, wy];
      } else {
        drag = 'pan';
      }
      return;
    }
    if (e.button === 0) {
      drag = 'lasso';
      context.selection.lasso = [wx, wy];
      context.selection.lassoAdditive = additive;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const sx = localX(e);
    const sy = localY(e);
    hoverX = screenToWorldX(context.camera, sx);
    hoverY = screenToWorldY(context.camera, sy);
    pointerInside = sx >= 0 && sy >= 0 && sx <= canvas.clientWidth && sy <= canvas.clientHeight;
    context.selection.hoverCity = cityAt(context.world.map, hoverX, hoverY);

    if (context.blocked || drag === 'idle') {
      lastX = sx;
      lastY = sy;
      return;
    }
    if (drag === 'pan') {
      panBy(context.camera, sx - lastX, sy - lastY, context.world.map);
    } else if (drag === 'lasso' && context.selection.lasso) {
      pushSampled(context.selection.lasso, hoverX, hoverY);
    } else if (drag === 'draw' && context.selection.drawing) {
      pushSampled(context.selection.drawing, hoverX, hoverY);
    }
    lastX = sx;
    lastY = sy;
  }

  function pushSampled(pts: number[], wx: number, wy: number): void {
    const n = pts.length;
    if (n >= 2 && dist2(wx, wy, pts[n - 2]!, pts[n - 1]!) < PATH_SAMPLE_MIN * PATH_SAMPLE_MIN) {
      return;
    }
    pts.push(wx, wy);
  }

  function onPointerUp(e: PointerEvent): void {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const sx = localX(e);
    const sy = localY(e);
    const moved = Math.hypot(sx - downX, sy - downY);
    const sel = context.selection;

    if (drag === 'lasso') {
      if (moved <= DRAG_CLICK_PX) {
        const slot = pickUnit(hoverX, hoverY);
        if (!additive) sel.units.clear();
        if (slot >= 0) sel.units.add(context.world.units.id[slot]!);
        else if (sel.hoverCity >= 0) handlers.focusCity(sel.hoverCity);
      } else if (sel.lasso) {
        applyLasso(decimate(sel.lasso, PATH_SAMPLE_MIN), additive);
      }
      sel.lasso = null;
    } else if (drag === 'draw' && sel.drawing) {
      const start = selectionCentroid();
      const pts =
        moved <= DRAG_CLICK_PX && start
          ? [start.x, start.y, hoverX, hoverY]
          : decimate(sel.drawing, PATH_SAMPLE_MIN);
      issuePath(pts);
      sel.drawing = null;
    }
    drag = 'idle';
  }

  function onWheel(e: WheelEvent): void {
    if (context.blocked) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoomAt(context.camera, localX(e), localY(e), factor, context.world.map);
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Escape') {
      handlers.escape();
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      handlers.toggleAiDebug();
      return;
    }
    if (e.key === 'F4') {
      e.preventDefault();
      handlers.toggleDebugPanel();
      return;
    }
    if (context.blocked) return;
    keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    if (handleShortcut(e)) e.preventDefault();
  }

  function handleModified(e: KeyboardEvent, digit: number): boolean {
    const sel = context.selection;
    switch (e.key.toLowerCase()) {
      case 'a':
        selectAll(context.world, sel, context.viewer);
        return true;
      case 'h':
        selectByKind(context.world, sel, context.viewer, true);
        return true;
      case 'l':
        selectByKind(context.world, sel, context.viewer, false);
        return true;
      default:
        if (digit === 0) return false;
        assignGroup(sel, digit);
        return true;
    }
  }

  function handleShortcut(e: KeyboardEvent): boolean {
    const sel = context.selection;
    const key = e.key.toLowerCase();
    const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;

    if (e.ctrlKey || e.metaKey) return handleModified(e, digit);
    if (digit) {
      recallGroup(sel, digit);
      return true;
    }

    switch (key) {
      case ' ':
        handlers.togglePause();
        return true;
      case 's':
        if (sel.units.size) handlers.emit({ t: 'stop', player: context.viewer, units: [...sel.units] });
        return true;
      case 'c':
        if (sel.units.size) handlers.emit({ t: 'clear', player: context.viewer, units: [...sel.units] });
        return true;
      case 't':
        handlers.toggleTerritory();
        return true;
      case '+':
      case '=':
        handlers.setSpeed(3);
        return true;
      case '-':
        handlers.setSpeed(1);
        return true;
      default:
        return false;
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  }

  function onBlur(): void {
    keys.clear();
    pointerInside = false;
  }

  const preventMenu = (e: Event): void => e.preventDefault();

  return {
    get hoverX() {
      return hoverX;
    },
    get hoverY() {
      return hoverY;
    },
    context,

    attach(): void {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', preventMenu);
      canvas.addEventListener('pointerleave', () => {
        pointerInside = false;
      });
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    },

    detach(): void {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', preventMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },

    update(dtSec: number): void {
      if (context.blocked) return;
      const step = PAN_SPEED * context.cameraSpeed * dtSec * context.camera.zoom;
      let dx = 0;
      let dy = 0;
      // The spec gives `S` to both "stop" and WASD panning. Stop wins, because a
      // misfired stop order costs a battle and a missing pan key costs nothing:
      // the arrows, `X`, edge-pan, right-drag and the minimap all still pan down.
      if (keys.has('w') || keys.has('ArrowUp')) dy += step;
      if (keys.has('x') || keys.has('ArrowDown')) dy -= step;
      if (keys.has('a') || keys.has('ArrowLeft')) dx += step;
      if (keys.has('d') || keys.has('ArrowRight')) dx -= step;

      if (pointerInside && drag === 'idle') {
        if (lastX < EDGE_PAN_BAND) dx += step;
        else if (lastX > canvas.clientWidth - EDGE_PAN_BAND) dx -= step;
        if (lastY < EDGE_PAN_BAND) dy += step;
        else if (lastY > canvas.clientHeight - EDGE_PAN_BAND) dy -= step;
      }
      if (dx !== 0 || dy !== 0) panBy(context.camera, dx, dy, context.world.map);
    },
  };
}
