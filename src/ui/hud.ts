/**
 * The in-match HUD: the top bar plus the production, city and debug panels.
 *
 * Two things worth knowing. First, every number here is tick state, so `update`
 * short-circuits unless the tick actually advanced — at 60 fps against a 20 Hz
 * simulation that is two thirds of the work gone for free. Second, the warning row
 * exists because starvation and encirclement are invisible on the map: units simply
 * lose HP with nothing touching them. The player is told, in words, what is eating
 * their army.
 */

import { TICK_SEC } from '../core/balance.ts';
import { VictoryMode, baseKindOf } from '../core/types.ts';
import type { World } from '../core/types.ts';
import { supplyOf } from '../core/economy.ts';
import type { FrameState } from '../render/frame.ts';
import type { MatchHudOptions, Panel, UiCallbacks } from './types.ts';
import { button, el, fmtClock, fmtInt, fmtRate, setText } from './dom.ts';
import { createProductionPanel } from './production-panel.ts';
import { createCityList } from './city-list.ts';
import { createDebugPanel } from './debug-panel.ts';

export interface Hud extends Panel {
  setPaused(paused: boolean): void;
  setSpeed(speed: number): void;
  /** Toggles the F4 balance/perf panel. */
  setDebugVisible(v: boolean): void;
}

const SPEEDS = [1, 2, 3] as const;

interface StatCell {
  root: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
}

function statCell(label: string): StatCell {
  const root = el('div', 'df-stat');
  const labelNode = el('span', 'df-stat__label', label);
  const value = el('span', 'df-stat__value', '—');
  root.append(labelNode, value);
  return { root, label: labelNode, value };
}

interface Stats {
  eco: StatCell;
  rate: StatCell;
  army: StatCell;
  supply: StatCell;
  territory: StatCell;
  clock: StatCell;
}

function buildStats(bar: HTMLElement): Stats {
  const stats: Stats = {
    eco: statCell('ЭКО'),
    rate: statCell('Доход'),
    army: statCell('Армия'),
    supply: statCell('Снабжение'),
    territory: statCell('Территория'),
    clock: statCell('Время'),
  };
  for (const cell of Object.values(stats)) bar.append(cell.root);
  return stats;
}

interface Controls {
  pause: HTMLButtonElement;
  speeds: HTMLButtonElement[];
}

function buildControls(bar: HTMLElement, cb: UiCallbacks): Controls {
  const pause = button('Пауза', 'df-btn', () => cb.onTogglePause());
  const speeds = SPEEDS.map((s) => button(`${s}×`, 'df-btn', () => cb.onSetSpeed(s)));
  const resign = button('Сдаться', 'df-btn', () => cb.onResign());
  bar.append(pause, ...speeds, resign);
  return { pause, speeds };
}

interface Survey {
  light: number;
  heavy: number;
  encircled: number;
}

/** One pass over the store for everything the bar needs that stats do not carry. */
function survey(world: World, viewer: number): Survey {
  const u = world.units;
  const out: Survey = { light: 0, heavy: 0, encircled: 0 };
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== viewer) continue;
    if (baseKindOf(u.kind[i]!) === 1) out.heavy++;
    else out.light++;
    if (u.encircled[i]) out.encircled++;
  }
  return out;
}

interface Supply {
  cap: number;
  used: number;
}

function paintStats(stats: Stats, world: World, viewer: number, supply: Supply, s: Survey): void {
  const p = world.stats.players[viewer]!;
  setText(stats.eco.value, fmtInt(p.ecoNow));
  setText(stats.rate.value, `${fmtRate(p.ecoRate)}/с`);
  stats.rate.value.classList.toggle('df-warn', p.ecoRate < 0);
  setText(stats.army.value, `${p.armyNow} · ${s.light}л / ${s.heavy}т`);
  setText(stats.supply.value, `${supply.used}/${supply.cap}`);
  stats.supply.value.classList.toggle('df-warn', supply.used > supply.cap);
  setText(stats.territory.value, `${Math.round(p.territory * 100)}%`);

  const timed = world.settings.victory === VictoryMode.TimedScore;
  const elapsed = world.tick * TICK_SEC;
  setText(stats.clock.label, timed ? 'Осталось' : 'Время');
  setText(stats.clock.value, fmtClock(timed ? world.settings.timeLimitSec - elapsed : elapsed));
}

/**
 * The warning row is attached and detached rather than hidden, so it can never
 * occupy space in the layout while it has nothing to say.
 */
function paintWarning(warn: HTMLElement, after: HTMLElement, text: string): void {
  if (text === '') {
    warn.remove();
    return;
  }
  setText(warn, text);
  if (!warn.parentNode) after.after(warn);
}

function warnText(world: World, viewer: number, s: Survey, supply: Supply): string {
  const parts: string[] = [];
  const starving = supply.used - supply.cap;
  if (starving > 0) parts.push(`Нет снабжения: голодают ${starving}`);
  if (s.encircled > 0) parts.push(`В окружении: ${s.encircled}`);
  const p = world.stats.players[viewer]!;
  if (p.ecoRate < 0 && p.ecoNow < 1) parts.push('Казна пуста — содержание не платится');
  return parts.join(' · ');
}

export function createHud(opts: MatchHudOptions): Hud {
  const root = el('div', 'df-hud');
  const bar = el('div', 'df-hud__bar');
  const stats = buildStats(bar);
  const controls = buildControls(bar, opts.callbacks);
  const warn = el('div', 'df-warn');

  const production = createProductionPanel(opts);
  const cities = createCityList(opts);
  const debug = createDebugPanel(opts);
  root.append(bar, production.root, cities.root);

  let lastTick = -1;
  let debugVisible = false;

  function setPaused(paused: boolean): void {
    setText(controls.pause, paused ? 'Продолжить' : 'Пауза');
    controls.pause.classList.toggle('df-btn--active', paused);
  }

  function setSpeed(next: number): void {
    controls.speeds.forEach((b, i) => b.classList.toggle('df-btn--active', i + 1 === next));
  }

  function setDebugVisible(v: boolean): void {
    if (v === debugVisible) return;
    debugVisible = v;
    if (v) root.append(debug.root);
    else debug.root.remove();
  }

  function update(frame: FrameState): void {
    const world = frame.world;
    if (world.tick !== lastTick) {
      lastTick = world.tick;
      const supply = supplyOf(world, opts.viewer);
      const s = survey(world, opts.viewer);
      paintStats(stats, world, opts.viewer, supply, s);
      paintWarning(warn, bar, warnText(world, opts.viewer, s, supply));
    }
    production.update(frame);
    cities.update(frame);
    if (debugVisible) debug.update(frame);
  }

  setPaused(false);
  setSpeed(1);

  return {
    root,
    update,
    setPaused,
    setSpeed,
    setDebugVisible,
    destroy(): void {
      production.destroy();
      cities.destroy();
      debug.destroy();
      root.remove();
    },
  };
}
