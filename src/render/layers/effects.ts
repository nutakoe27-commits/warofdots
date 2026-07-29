/**
 * Cosmetic one-shot effects: spawn pips, death fades, capture pulses, ship ripples.
 *
 * The layer owns a fixed-size particle pool and reads `world.events` exactly once
 * per simulation tick — the renderer can run several frames per tick, and events
 * are cleared by the next tick, so a "have I already seen this tick" guard is the
 * whole of the bookkeeping. Ageing is wall-clock, not tick-based, so effects keep
 * the same real duration at 1×, 2× and 3× speed.
 *
 * Nothing here is read back by the simulation, and nothing here writes to it.
 */

import type { World } from '../../core/types.ts';
import { DRAW_R } from '../../core/balance.ts';
import type { ViewBounds } from '../camera.ts';
import { visibleBounds, worldToScreenX, worldToScreenY } from '../camera.ts';
import type { FrameState, Layer } from '../frame.ts';
import { playerColor } from '../theme.ts';

const TAU = Math.PI * 2;
const CAP = 192;

const Fx = { Spawn: 0, Death: 1, Capture: 2, Convert: 3 } as const;

/** Lifetime per effect kind, milliseconds. */
const LIFE_MS = [420, 520, 900, 700];
/** Radius multiplier at birth and at death, per effect kind. */
const GROW_FROM = [0.5, 1.0, 0.45, 0.35];
const GROW_TO = [2.2, 0.15, 1.35, 2.6];
const PEAK_ALPHA = [0.9, 0.8, 0.95, 0.7];
const STROKE_WIDTH = [1.4, 1, 2.4, 1.2];
const MIN_R = 1.5;
/** Base radius for effects that are not tied to a city footprint, world units. */
const UNIT_FX_R = DRAW_R[0]!;

interface Particles {
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  born: Float64Array;
  colorIndex: Uint8Array;
  active: Uint8Array;
  cursor: number;
}

function makeParticles(): Particles {
  return {
    kind: new Uint8Array(CAP),
    x: new Float32Array(CAP),
    y: new Float32Array(CAP),
    r: new Float32Array(CAP),
    born: new Float64Array(CAP),
    colorIndex: new Uint8Array(CAP),
    active: new Uint8Array(CAP),
    cursor: 0,
  };
}

/** Takes a free slot, or the oldest live one once the pool is full. */
function takeSlot(p: Particles, now: number): number {
  for (let n = 0; n < CAP; n++) {
    const i = (p.cursor + n) % CAP;
    if (!p.active[i]) {
      p.cursor = (i + 1) % CAP;
      return i;
    }
  }
  let oldest = 0;
  let bornAt = now;
  for (let i = 0; i < CAP; i++) {
    if (p.born[i]! < bornAt) {
      bornAt = p.born[i]!;
      oldest = i;
    }
  }
  return oldest;
}

function emit(
  p: Particles,
  kind: number,
  x: number,
  y: number,
  r: number,
  colorIndex: number,
  now: number,
): void {
  const i = takeSlot(p, now);
  p.kind[i] = kind;
  p.x[i] = x;
  p.y[i] = y;
  p.r[i] = r;
  p.born[i] = now;
  p.colorIndex[i] = colorIndex;
  p.active[i] = 1;
}

function colorIndexOf(world: World, player: number): number {
  return world.players[player]?.colorIndex ?? 0;
}

function ingest(world: World, p: Particles, now: number): void {
  for (const e of world.events) {
    if (e.t === 'spawn') {
      emit(p, Fx.Spawn, e.x, e.y, UNIT_FX_R, colorIndexOf(world, e.owner), now);
    } else if (e.t === 'death') {
      emit(p, Fx.Death, e.x, e.y, DRAW_R[e.kind] ?? UNIT_FX_R, colorIndexOf(world, e.owner), now);
    } else if (e.t === 'convert') {
      emit(p, Fx.Convert, e.x, e.y, UNIT_FX_R, colorIndexOf(world, e.owner), now);
    } else if (e.t === 'capture') {
      const city = world.cities[e.city];
      if (city) emit(p, Fx.Capture, city.x, city.y, city.radius, colorIndexOf(world, e.to), now);
    }
  }
}

const fxBounds: ViewBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

function drawParticles(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  p: Particles,
  now: number,
): void {
  const cam = frame.camera;
  const b = visibleBounds(cam, 0, fxBounds);
  for (let i = 0; i < CAP; i++) {
    if (!p.active[i]) continue;
    const kind = p.kind[i]!;
    const t = (now - p.born[i]!) / LIFE_MS[kind]!;
    if (t >= 1 || t < 0) {
      p.active[i] = 0;
      continue;
    }
    const wx = p.x[i]!;
    const wy = p.y[i]!;
    if (wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1) continue;

    const grow = GROW_FROM[kind]! + (GROW_TO[kind]! - GROW_FROM[kind]!) * t;
    const r = Math.max(MIN_R, p.r[i]! * grow * cam.zoom);
    const colour = playerColor(p.colorIndex[i]!);
    ctx.globalAlpha = PEAK_ALPHA[kind]! * (1 - t);
    ctx.beginPath();
    ctx.arc(worldToScreenX(cam, wx), worldToScreenY(cam, wy), r, 0, TAU);
    if (kind === Fx.Death) {
      ctx.fillStyle = colour;
      ctx.fill();
    } else {
      ctx.strokeStyle = colour;
      ctx.lineWidth = STROKE_WIDTH[kind]!;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

export function createEffectsLayer(world: World): Layer {
  const p = makeParticles();
  let seenTick = -1;

  return {
    name: 'effects',
    invalidate(): void {
      p.active.fill(0);
    },
    draw(ctx: CanvasRenderingContext2D, frame: FrameState): void {
      const now = performance.now();
      if (world.tick !== seenTick) {
        ingest(world, p, now);
        seenTick = world.tick;
      }
      drawParticles(ctx, frame, p, now);
    },
  };
}
