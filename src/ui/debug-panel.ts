/**
 * The F4 panel: performance counters and live balance knobs.
 *
 * Every 🎚 number from the spec is wired straight to `applyBalanceOverrides`, so a
 * value can be retuned mid-match without a reload. Each knob spells its key out
 * twice — once as `key`, once inside its own `write` closure — because a computed
 * key cannot be written into `BalanceOverrides` without a cast, and an unchecked
 * write into the simulation's tuning record is a worse trade than one repeated
 * literal. Both spellings are checked against `B`, so a typo is a compile error.
 *
 * The world hash is the expensive item here — it walks the whole unit store — so it
 * is sampled a few times a second rather than every frame.
 */

import { B, applyBalanceOverrides, resetBalance } from '../core/balance.ts';
import { hashHex } from '../core/hash.ts';
import type { FrameState } from '../render/frame.ts';
import type { MatchHudOptions, Panel } from './types.ts';
import { button, el, fmtInt, setText, slider } from './dom.ts';
import type { SliderHandle } from './dom.ts';

/** How often the world hash is recomputed, milliseconds. */
const HASH_INTERVAL_MS = 250;

/** Keys of `B` that hold a single number — the ones a slider can drive. */
type NumericBalanceKey = {
  [K in keyof typeof B]: (typeof B)[K] extends number ? K : never;
}[keyof typeof B];

interface Tunable {
  key: NumericBalanceKey;
  min: number;
  max: number;
  step: number;
  write: (v: number) => void;
}

const over = applyBalanceOverrides;

const TUNABLES: Tunable[] = [
  { key: 'HEALTH_EXP', min: 0, max: 1.5, step: 0.05, write: (v) => over({ HEALTH_EXP: v }) },
  { key: 'MORALE_FLOOR', min: 0, max: 1, step: 0.05, write: (v) => over({ MORALE_FLOOR: v }) },
  {
    key: 'MOVING_PENALTY',
    min: 0.4,
    max: 1,
    step: 0.01,
    write: (v) => over({ MOVING_PENALTY: v }),
  },
  { key: 'MORALE_DRAIN', min: 0, max: 0.3, step: 0.005, write: (v) => over({ MORALE_DRAIN: v }) },
  { key: 'PROXIMITY_R', min: 0, max: 40, step: 1, write: (v) => over({ PROXIMITY_R: v }) },
  { key: 'HP_REGEN', min: 0, max: 0.1, step: 0.001, write: (v) => over({ HP_REGEN: v }) },
  { key: 'MORALE_REGEN', min: 0, max: 0.5, step: 0.005, write: (v) => over({ MORALE_REGEN: v }) },
  { key: 'CITY_INCOME', min: 0, max: 60, step: 0.5, write: (v) => over({ CITY_INCOME: v }) },
  { key: 'UPKEEP', min: 0, max: 10, step: 0.1, write: (v) => over({ UPKEEP: v }) },
  { key: 'SUPPLY_PER_CITY', min: 1, max: 30, step: 1, write: (v) => over({ SUPPLY_PER_CITY: v }) },
  { key: 'STARVE_DPS', min: 0, max: 0.3, step: 0.005, write: (v) => over({ STARVE_DPS: v }) },
  { key: 'ENCIRCLED_DPS', min: 0, max: 0.5, step: 0.005, write: (v) => over({ ENCIRCLED_DPS: v }) },
  { key: 'WATER_DPS', min: 0, max: 0.2, step: 0.002, write: (v) => over({ WATER_DPS: v }) },
  {
    key: 'SHIP_CONVERT_SEC',
    min: 0.5,
    max: 20,
    step: 0.5,
    write: (v) => over({ SHIP_CONVERT_SEC: v }),
  },
  { key: 'CITY_POWER', min: 0, max: 400, step: 5, write: (v) => over({ CITY_POWER: v }) },
  { key: 'UNIT_POWER', min: 0, max: 100, step: 1, write: (v) => over({ UNIT_POWER: v }) },
  { key: 'PUSH_STRENGTH', min: 0, max: 80, step: 1, write: (v) => over({ PUSH_STRENGTH: v }) },
  { key: 'UNIT_SPEED', min: 1, max: 40, step: 0.5, write: (v) => over({ UNIT_SPEED: v }) },
];

/** Reading `B` with a union key is safe; only writing one needs the closures above. */
function readBalance(key: NumericBalanceKey): number {
  return B[key];
}

function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

function debugRow(parent: HTMLElement, label: string): HTMLElement {
  const row = el('div', 'df-debug__row');
  const value = el('span', 'df-stat__value');
  row.append(el('span', 'df-stat__label', label), value);
  parent.append(row);
  return value;
}

interface PerfRows {
  fps: HTMLElement;
  sim: HTMLElement;
  render: HTMLElement;
  ticks: HTMLElement;
  units: HTMLElement;
  pockets: HTMLElement;
  hash: HTMLElement;
}

function buildPerfRows(root: HTMLElement): PerfRows {
  return {
    fps: debugRow(root, 'FPS'),
    sim: debugRow(root, 'мс/тик'),
    render: debugRow(root, 'мс/кадр'),
    ticks: debugRow(root, 'тиков за кадр'),
    units: debugRow(root, 'юнитов'),
    pockets: debugRow(root, 'карманы: мои/все'),
    hash: debugRow(root, 'хеш мира'),
  };
}

function buildTunables(root: HTMLElement): SliderHandle[] {
  return TUNABLES.map((knob) => {
    const decimals = decimalsFor(knob.step);
    const handle = slider({
      label: knob.key,
      min: knob.min,
      max: knob.max,
      step: knob.step,
      value: readBalance(knob.key),
      format: (v) => v.toFixed(decimals),
      onInput: (v) => knob.write(v),
    });
    root.append(handle.root);
    return handle;
  });
}

export function createDebugPanel(opts: MatchHudOptions): Panel {
  const root = el('div', 'df-debug');
  root.append(el('div', 'df-panel__title', 'Отладка · F4'));
  const perf = buildPerfRows(root);

  root.append(el('div', 'df-panel__title', 'Баланс'));
  const handles = buildTunables(root);
  root.append(
    button('Сброс', 'df-btn', () => {
      resetBalance();
      handles.forEach((handle, i) => handle.set(readBalance(TUNABLES[i]!.key)));
    }),
  );

  let lastHash = 0;

  function update(frame: FrameState): void {
    setText(perf.fps, frame.perf.fps.toFixed(0));
    setText(perf.sim, frame.perf.simMs.toFixed(2));
    setText(perf.render, frame.perf.renderMs.toFixed(2));
    setText(perf.ticks, String(frame.perf.ticksThisFrame));

    const world = frame.world;
    setText(perf.units, fmtInt(world.units.count));
    let mine = 0;
    for (const pocket of world.influence.pockets) if (pocket.player === opts.viewer) mine++;
    setText(perf.pockets, `${mine}/${world.influence.pockets.length}`);

    const now = performance.now();
    if (now - lastHash >= HASH_INTERVAL_MS) {
      lastHash = now;
      setText(perf.hash, hashHex(world));
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
