/**
 * What a render layer is handed each frame.
 *
 * The simulation runs at a fixed 20 Hz while the screen refreshes at whatever the
 * monitor does, so unit positions are interpolated between the last two ticks.
 * `interp` holds the positions from the previous tick and `alpha` says how far
 * through the current one we are.
 */

import type { World } from '../core/types.ts';
import type { BotDebug } from '../ai/types.ts';
import type { SelectionState } from '../game/selection.ts';
import type { Camera } from './camera.ts';
import type { Theme } from './theme.ts';

/** Positions captured just before the most recent tick, indexed by unit slot. */
export interface InterpBuffer {
  x: Float32Array;
  y: Float32Array;
  /** 1 when the slot held the same unit id last tick, so lerping is meaningful. */
  valid: Uint8Array;
  id: Int32Array;
}

export function createInterpBuffer(capacity: number): InterpBuffer {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    valid: new Uint8Array(capacity),
    id: new Int32Array(capacity),
  };
}

/** Copies current positions into `buf`, to be interpolated from next frame. */
export function captureInterp(world: World, buf: InterpBuffer): void {
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    buf.valid[i] = u.alive[i]! && buf.id[i] === u.id[i]! ? 1 : 0;
    buf.x[i] = u.x[i]!;
    buf.y[i] = u.y[i]!;
    buf.id[i] = u.id[i]!;
  }
}

export interface PerfCounters {
  fps: number;
  simMs: number;
  renderMs: number;
  ticksThisFrame: number;
}

export interface FrameState {
  world: World;
  camera: Camera;
  theme: Theme;
  selection: SelectionState;
  interp: InterpBuffer;
  /** 0..1 through the current tick. */
  alpha: number;
  /** Player whose point of view is drawn. */
  viewer: number;
  colorblind: boolean;
  showTerritory: boolean;
  /** Bot overlays to draw, empty when F3 is off. */
  aiDebug: BotDebug[];
  hoverX: number;
  hoverY: number;
  perf: PerfCounters;
}

/** Interpolated x for a unit slot. */
export function lerpX(frame: FrameState, slot: number): number {
  const u = frame.world.units;
  if (!frame.interp.valid[slot]) return u.x[slot]!;
  return frame.interp.x[slot]! + (u.x[slot]! - frame.interp.x[slot]!) * frame.alpha;
}

export function lerpY(frame: FrameState, slot: number): number {
  const u = frame.world.units;
  if (!frame.interp.valid[slot]) return u.y[slot]!;
  return frame.interp.y[slot]! + (u.y[slot]! - frame.interp.y[slot]!) * frame.alpha;
}

/** A drawing layer. `invalidate` is called when cached bitmaps must be rebuilt. */
export interface Layer {
  readonly name: string;
  draw(ctx: CanvasRenderingContext2D, frame: FrameState): void;
  invalidate?(): void;
}
