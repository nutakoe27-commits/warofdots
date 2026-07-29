/**
 * Camera. `x`/`y` are the world coordinates at the centre of the viewport and
 * `zoom` is screen pixels per world unit, so the transform is the same three
 * multiplications everywhere and nothing has to guess about anchoring.
 */

import type { MapRuntime } from '../core/types.ts';
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from '../core/balance.ts';
import { clamp } from '../core/geometry.ts';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** Viewport size in CSS pixels. */
  vw: number;
  vh: number;
}

export interface ViewBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function createCamera(map: MapRuntime, vw: number, vh: number): Camera {
  const cam: Camera = { x: map.worldW / 2, y: map.worldH / 2, zoom: ZOOM_DEFAULT, vw, vh };
  fitToMap(cam, map);
  return cam;
}

/** Picks the zoom that shows the whole map, then centres on it. */
export function fitToMap(cam: Camera, map: MapRuntime): void {
  const z = Math.min(cam.vw / map.worldW, cam.vh / map.worldH);
  cam.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
  cam.x = map.worldW / 2;
  cam.y = map.worldH / 2;
}

export function worldToScreenX(cam: Camera, wx: number): number {
  return (wx - cam.x) * cam.zoom + cam.vw / 2;
}

export function worldToScreenY(cam: Camera, wy: number): number {
  return (wy - cam.y) * cam.zoom + cam.vh / 2;
}

export function screenToWorldX(cam: Camera, sx: number): number {
  return (sx - cam.vw / 2) / cam.zoom + cam.x;
}

export function screenToWorldY(cam: Camera, sy: number): number {
  return (sy - cam.vh / 2) / cam.zoom + cam.y;
}

/**
 * Keeps the map from sliding away from the viewport. When the map is smaller than
 * the viewport on an axis it is centred on that axis instead of clamped.
 */
export function clampCamera(cam: Camera, map: MapRuntime): void {
  const halfW = cam.vw / 2 / cam.zoom;
  const halfH = cam.vh / 2 / cam.zoom;
  cam.x = halfW * 2 >= map.worldW ? map.worldW / 2 : clamp(cam.x, halfW, map.worldW - halfW);
  cam.y = halfH * 2 >= map.worldH ? map.worldH / 2 : clamp(cam.y, halfH, map.worldH - halfH);
}

export function panBy(cam: Camera, dxScreen: number, dyScreen: number, map: MapRuntime): void {
  cam.x -= dxScreen / cam.zoom;
  cam.y -= dyScreen / cam.zoom;
  clampCamera(cam, map);
}

/** Zooms by `factor` while holding the world point under `(sx, sy)` in place. */
export function zoomAt(
  cam: Camera,
  sx: number,
  sy: number,
  factor: number,
  map: MapRuntime,
): void {
  const wx = screenToWorldX(cam, sx);
  const wy = screenToWorldY(cam, sy);
  const next = clamp(cam.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (next === cam.zoom) return;
  cam.zoom = next;
  cam.x = wx - (sx - cam.vw / 2) / cam.zoom;
  cam.y = wy - (sy - cam.vh / 2) / cam.zoom;
  clampCamera(cam, map);
}

export function centreOn(cam: Camera, wx: number, wy: number, map: MapRuntime): void {
  cam.x = wx;
  cam.y = wy;
  clampCamera(cam, map);
}

export function resize(cam: Camera, vw: number, vh: number, map: MapRuntime): void {
  cam.vw = vw;
  cam.vh = vh;
  clampCamera(cam, map);
}

/** Visible world rectangle, padded so half-offscreen sprites are not culled. */
export function visibleBounds(cam: Camera, pad = 8, out?: ViewBounds): ViewBounds {
  const halfW = cam.vw / 2 / cam.zoom + pad;
  const halfH = cam.vh / 2 / cam.zoom + pad;
  const b = out ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  b.x0 = cam.x - halfW;
  b.y0 = cam.y - halfH;
  b.x1 = cam.x + halfW;
  b.y1 = cam.y + halfH;
  return b;
}
