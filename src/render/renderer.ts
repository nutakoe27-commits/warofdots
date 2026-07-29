/**
 * The renderer: canvas ownership, device-pixel handling, and layer composition.
 *
 * Every layer draws in CSS pixels. The device-pixel ratio is applied once, as a
 * transform on the context, so nothing downstream has to know about it and a
 * `lineWidth` of 2 means two visible pixels on every display. The ratio is capped
 * at 2 — beyond that the fill cost grows quadratically for a difference nobody can
 * see on a map of coloured dots.
 *
 * Each layer is wrapped in save/restore so a layer that leaves a dash pattern or a
 * font behind cannot corrupt the next one; six state pairs per frame is nothing
 * against the 8 ms budget.
 */

import type { World } from '../core/types.ts';
import { clamp } from '../core/geometry.ts';
import type { FrameState, Layer } from './frame.ts';
import { createTerrainLayer } from './layers/terrain.ts';
import { createTerritoryLayer } from './layers/territory.ts';
import { createUnitsLayer } from './layers/units.ts';
import { createOrdersLayer } from './layers/orders.ts';
import { createEffectsLayer } from './layers/effects.ts';
import { createAiDebugLayer } from './layers/ai-debug.ts';

const MAX_DPR = 2;

export interface Renderer {
  readonly canvas: HTMLCanvasElement;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  draw(frame: FrameState): void;
  /** Re-bakes the cached terrain bitmap. Call on theme change. */
  invalidateTerrain(): void;
}

export function createRenderer(canvas: HTMLCanvasElement, world: World): Renderer {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('canvas 2d context unavailable');

  const layers: Layer[] = [
    createTerrainLayer(world),
    createTerritoryLayer(world),
    createUnitsLayer(world),
    createOrdersLayer(world),
    createEffectsLayer(world),
    createAiDebugLayer(world),
  ];

  let cssW = 1;
  let cssH = 1;
  let dpr = 1;

  // Only the backing store is touched: the element's CSS size belongs to the page,
  // and pinning it inline here would fight the stylesheet the caller measured.
  const resize = (cssWidth: number, cssHeight: number, ratio: number): void => {
    dpr = clamp(ratio || 1, 1, MAX_DPR);
    cssW = Math.max(1, Math.round(cssWidth));
    cssH = Math.max(1, Math.round(cssHeight));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  };

  const draw = (frame: FrameState): void => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = frame.theme.background;
    ctx.fillRect(0, 0, cssW, cssH);
    for (const layer of layers) {
      ctx.save();
      layer.draw(ctx, frame);
      ctx.restore();
    }
  };

  const invalidateTerrain = (): void => {
    for (const layer of layers) layer.invalidate?.();
  };

  // Start from whatever the element already measures, so a caller that never gets
  // round to `resize` still draws something instead of a 300×150 stub.
  resize(
    canvas.clientWidth || canvas.width,
    canvas.clientHeight || canvas.height,
    window.devicePixelRatio,
  );

  return { canvas, resize, draw, invalidateTerrain };
}
