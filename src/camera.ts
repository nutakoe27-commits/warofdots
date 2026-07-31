/** Camera: world units in, CSS pixels out. `x`/`y` is the point at screen centre. */

export interface Camera {
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  zoom: number;
  vw: number;
  vh: number;
}

export const ZOOM_MIN = 0.18;
export const ZOOM_MAX = 2.2;

export function createCamera(worldW: number, worldH: number, vw: number, vh: number): Camera {
  return { x: worldW / 2, y: worldH / 2, zoom: 0.5, vw, vh };
}

export function sx(c: Camera, wx: number): number {
  return (wx - c.x) * c.zoom + c.vw / 2;
}

export function sy(c: Camera, wy: number): number {
  return (wy - c.y) * c.zoom + c.vh / 2;
}

export function wx(c: Camera, px: number): number {
  return (px - c.vw / 2) / c.zoom + c.x;
}

export function wy(c: Camera, py: number): number {
  return (py - c.vh / 2) / c.zoom + c.y;
}

/** Keeps the map from drifting off screen; centres an axis the viewport overflows. */
export function clamp(c: Camera, worldW: number, worldH: number): void {
  const halfW = c.vw / 2 / c.zoom;
  const halfH = c.vh / 2 / c.zoom;
  c.x = halfW * 2 >= worldW ? worldW / 2 : Math.min(Math.max(c.x, halfW), worldW - halfW);
  c.y = halfH * 2 >= worldH ? worldH / 2 : Math.min(Math.max(c.y, halfH), worldH - halfH);
}

/** Zooms about a screen point, so the world under the cursor stays put. */
export function zoomAt(c: Camera, px: number, py: number, factor: number, worldW: number, worldH: number): void {
  const ax = wx(c, px);
  const ay = wy(c, py);
  const next = Math.min(Math.max(c.zoom * factor, ZOOM_MIN), ZOOM_MAX);
  if (next === c.zoom) return;
  c.zoom = next;
  c.x = ax - (px - c.vw / 2) / c.zoom;
  c.y = ay - (py - c.vh / 2) / c.zoom;
  clamp(c, worldW, worldH);
}

export function pan(c: Camera, dxPixels: number, dyPixels: number, worldW: number, worldH: number): void {
  c.x -= dxPixels / c.zoom;
  c.y -= dyPixels / c.zoom;
  clamp(c, worldW, worldH);
}
