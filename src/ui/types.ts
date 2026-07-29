/**
 * The seam between the HUD and the game layer.
 *
 * The UI never mutates the world and never builds a `Command`: it reports intent
 * through `UiCallbacks` and reads state back out of the `FrameState` it is handed.
 * That keeps the panels replay-safe — a replay drives them by feeding frames, with
 * nobody listening on the other end of the callbacks.
 */

import type { FrameState } from '../render/frame.ts';

export interface UiCallbacks {
  onProduction(threshold: number, heavyShare: number): void;
  onToggleCity(cityIndex: number, active: boolean): void;
  onFocusCity(cityIndex: number): void;
  onSetSpeed(speed: 1 | 2 | 3): void;
  onTogglePause(): void;
  onResign(): void;
}

export interface MatchHudOptions {
  viewer: number;
  callbacks: UiCallbacks;
}

export interface Panel {
  readonly root: HTMLElement;
  update(frame: FrameState): void;
  destroy(): void;
}
