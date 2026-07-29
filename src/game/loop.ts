/**
 * Fixed-timestep driver.
 *
 * The simulation only ever advances in whole 50 ms steps. Game speed multiplies how
 * many steps happen per real second rather than changing `dt`, because a variable
 * `dt` would make the same match play out differently at 1× and 3× and destroy
 * determinism (spec §3.2).
 *
 * The accumulator is capped at `MAX_CATCHUP_TICKS`: if a frame takes too long we
 * drop simulated time rather than trying to catch up, which is what stops a slow
 * frame from spiralling into a frozen tab.
 */

import { MAX_CATCHUP_TICKS, TICK_MS } from '../core/balance.ts';
import type { PerfCounters } from '../render/frame.ts';

export interface LoopOptions {
  /** Advance the simulation by exactly one tick. */
  step(): void;
  /** Draw a frame. `alpha` is 0..1 progress through the pending tick. */
  render(alpha: number): void;
  /** Called with the real frame delta in seconds, before stepping. */
  beforeFrame?(dtSec: number): void;
}

export interface Loop {
  readonly perf: PerfCounters;
  paused: boolean;
  /** 1, 2 or 3 — ticks per nominal tick interval. */
  speed: number;
  start(): void;
  stop(): void;
  /** Runs exactly one tick even while paused. */
  stepOnce(): void;
}

const FPS_SMOOTHING = 0.9;

export function createLoop(opts: LoopOptions): Loop {
  const perf: PerfCounters = { fps: 0, simMs: 0, renderMs: 0, ticksThisFrame: 0 };
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  let running = false;

  const loop: Loop = {
    perf,
    paused: false,
    speed: 1,

    start(): void {
      if (running) return;
      running = true;
      last = performance.now();
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },

    stop(): void {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },

    stepOnce(): void {
      const started = performance.now();
      opts.step();
      perf.simMs = performance.now() - started;
      perf.ticksThisFrame = 1;
      opts.render(0);
    },
  };

  function frame(now: number): void {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const dtMs = Math.min(now - last, 250);
    last = now;
    const dtSec = dtMs / 1000;
    perf.fps = perf.fps * FPS_SMOOTHING + (1 / Math.max(dtSec, 1e-4)) * (1 - FPS_SMOOTHING);
    opts.beforeFrame?.(dtSec);

    let ticks = 0;
    if (!loop.paused) {
      accumulator += dtMs * loop.speed;
      const budget = MAX_CATCHUP_TICKS * loop.speed;
      const simStart = performance.now();
      while (accumulator >= TICK_MS && ticks < budget) {
        opts.step();
        accumulator -= TICK_MS;
        ticks++;
      }
      if (accumulator > TICK_MS * budget) accumulator = 0;
      if (ticks > 0) perf.simMs = (performance.now() - simStart) / ticks;
    }
    perf.ticksThisFrame = ticks;

    const renderStart = performance.now();
    opts.render(loop.paused ? 0 : Math.min(1, accumulator / TICK_MS));
    perf.renderMs = performance.now() - renderStart;
  }

  return loop;
}
