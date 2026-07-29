/**
 * The production panel (spec §4.8): two sliders and the numbers they mean.
 *
 * The sliders are *not* the source of truth — `PlayerState.threshold` and
 * `heavyShare` are, and they only change when a `production` command lands on a
 * tick. So a drag has to survive a round trip: after a local edit the panel goes
 * quiet for a moment and ignores the world's value, which is what stops a drag from
 * stuttering back a tick later. When the window closes the world wins again, so an
 * ally bot or a replay can still move the sliders.
 *
 * The threshold slider is otherwise meaningless to a player ("60% of what?"), so
 * the panel prints the resulting ECO thresholds underneath it.
 */

import { Kind } from '../core/types.ts';
import { PRODUCTION_OFF, productionThreshold } from '../core/balance.ts';
import type { FrameState } from '../render/frame.ts';
import type { MatchHudOptions, Panel } from './types.ts';
import { el, fmtInt, setText, slider } from './dom.ts';

/** How long a local edit suppresses adopting the world's value, milliseconds. */
const ECHO_QUIET_MS = 700;
const SLIDER_STEP = 0.01;
/** Shown for the light/heavy cost rows while production is switched off. */
const OFF_DASH = '—';

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function thresholdLabel(v: number): string {
  return v <= PRODUCTION_OFF ? 'Выкл.' : percent(v);
}

interface CostRow {
  root: HTMLElement;
  value: HTMLElement;
}

function costRow(label: string): CostRow {
  const root = el('div', 'df-stat');
  const value = el('span', 'df-stat__value');
  root.append(el('span', 'df-stat__label', label), value);
  return { root, value };
}

interface CostReadout {
  rows: HTMLElement[];
  /** Prints what the threshold slider costs in ECO for each unit family. */
  paint(threshold: number): void;
}

function costReadout(): CostReadout {
  const light = costRow('Лёгкий');
  const heavy = costRow('Тяжёлый');
  return {
    rows: [light.root, heavy.root],
    paint(threshold: number): void {
      const off = threshold <= PRODUCTION_OFF;
      setText(light.value, off ? OFF_DASH : fmtInt(productionThreshold(Kind.Light, threshold)));
      setText(heavy.value, off ? OFF_DASH : fmtInt(productionThreshold(Kind.Heavy, threshold)));
    },
  };
}

export function createProductionPanel(opts: MatchHudOptions): Panel {
  const root = el('div', 'df-panel');
  root.append(el('div', 'df-panel__title', 'Производство'));

  // Mirrors of the world values; corrected on the first `update`.
  let threshold = 1;
  let heavyShare = 0.3;
  let quietUntil = 0;

  const costs = costReadout();

  const push = (): void => {
    quietUntil = performance.now() + ECHO_QUIET_MS;
    costs.paint(threshold);
    opts.callbacks.onProduction(threshold, heavyShare);
  };

  const thresholdSlider = slider({
    label: 'Порог накопления',
    min: 0,
    max: 1,
    step: SLIDER_STEP,
    value: threshold,
    format: thresholdLabel,
    onInput: (v) => {
      threshold = v;
      push();
    },
  });

  const heavySlider = slider({
    label: 'Доля тяжёлых',
    min: 0,
    max: 1,
    step: SLIDER_STEP,
    value: heavyShare,
    format: percent,
    onInput: (v) => {
      heavyShare = v;
      push();
    },
  });

  root.append(thresholdSlider.root, heavySlider.root, ...costs.rows);
  costs.paint(threshold);

  function update(frame: FrameState): void {
    const player = frame.world.players[opts.viewer];
    if (!player) return;
    if (performance.now() < quietUntil) return;
    if (root.contains(document.activeElement)) return;

    if (player.threshold !== threshold) {
      threshold = player.threshold;
      thresholdSlider.set(threshold);
      costs.paint(threshold);
    }
    if (player.heavyShare !== heavyShare) {
      heavyShare = player.heavyShare;
      heavySlider.set(heavyShare);
    }
  }

  return {
    root,
    update,
    destroy(): void {
      root.remove();
    },
  };
}
