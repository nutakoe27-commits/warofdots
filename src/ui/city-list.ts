/**
 * The city list: one row per city the viewer holds.
 *
 * Rows are rebuilt only when the *set* of owned city indices changes — a capture is
 * a rare event, while treasury, garrison and capture progress change every tick, so
 * everything else is written in place. That is also why the rows key off the city
 * index rather than the `City` object: the world can be swapped out from under the
 * panel and a stale object reference would keep a dead city alive on screen.
 */

import { CAPTURE_SEC } from '../core/balance.ts';
import type { City, World } from '../core/types.ts';
import { cityAt } from '../core/terrain.ts';
import type { FrameState } from '../render/frame.ts';
import type { MatchHudOptions, Panel } from './types.ts';
import { clear, el, setText } from './dom.ts';

/** Prefix marking a capital, so the list still reads without the stylesheet. */
const CAPITAL_MARK = '◆ ';

interface CityRow {
  root: HTMLElement;
  name: HTMLElement;
  eco: HTMLElement;
  garrison: HTMLElement;
  note: HTMLElement;
  toggle: HTMLButtonElement;
  bar: HTMLElement;
  fill: HTMLElement;
  active: boolean;
  pct: number;
}

/** `west-capital` → `West capital`. Map ids are slugs; nobody wants to read a slug. */
function cityLabel(city: City): string {
  const words = city.id.replace(/[-_]/g, ' ');
  return (city.capital ? CAPITAL_MARK : '') + words.charAt(0).toUpperCase() + words.slice(1);
}

function buildRow(index: number, opts: MatchHudOptions): CityRow {
  const root = el('div', 'df-city');
  const name = el('span', 'df-stat__label');
  const eco = el('span', 'df-stat__value');
  const garrison = el('span', 'df-stat__value');
  const note = el('span', 'df-warn');
  const toggle = el('button', 'df-btn');
  toggle.type = 'button';
  const bar = el('div', 'df-city__capture');
  const fill = el('div', 'df-city__capture-fill');
  bar.append(fill);
  // `note` and `bar` are attached only while a capture is running, so a quiet row
  // has nothing in it for the stylesheet to have to hide.
  root.append(name, eco, garrison, toggle);

  const row: CityRow = {
    root,
    name,
    eco,
    garrison,
    note,
    toggle,
    bar,
    fill,
    active: true,
    pct: -1,
  };
  root.addEventListener('click', () => opts.callbacks.onFocusCity(index));
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    opts.callbacks.onToggleCity(index, !row.active);
  });
  return row;
}

/** Friendly units standing inside each city, by city index. */
function countGarrisons(world: World, viewer: number, out: number[]): void {
  out.length = world.cities.length;
  out.fill(0);
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== viewer) continue;
    const ci = cityAt(world.map, u.x[i]!, u.y[i]!);
    if (ci >= 0) out[ci]!++;
  }
}

function paintCapture(row: CityRow, city: City, viewer: number): void {
  const hostile = city.capturingPlayer > 0 && city.capturingPlayer !== viewer;
  const progress = hostile ? Math.max(0, Math.min(1, city.captureProgress)) : 0;
  row.root.classList.toggle('df-city--lost', progress > 0);
  if (progress <= 0) {
    row.note.remove();
    row.bar.remove();
    row.pct = -1;
    return;
  }
  const pct = Math.round(progress * 100);
  if (pct !== row.pct) {
    row.pct = pct;
    row.fill.style.width = `${pct}%`;
  }
  setText(row.note, `Захват ${pct}% · ${Math.ceil((1 - progress) * CAPTURE_SEC)} с`);
  if (!row.note.parentNode) row.garrison.after(row.note);
  if (!row.bar.parentNode) row.root.append(row.bar);
}

function paintRow(row: CityRow, city: City, garrison: number, viewer: number): void {
  setText(row.name, cityLabel(city));
  setText(row.eco, `${Math.round(city.eco)} ЭКО`);
  setText(row.garrison, `${garrison} юн.`);
  row.active = city.active;
  setText(row.toggle, city.active ? 'Вкл' : 'Выкл');
  row.toggle.classList.toggle('df-btn--active', city.active);
  row.root.classList.toggle('df-city--active', city.active);
  row.root.classList.toggle('df-city--capital', city.capital);
  paintCapture(row, city, viewer);
}

export function createCityList(opts: MatchHudOptions): Panel {
  const root = el('div', 'df-panel');
  root.append(el('div', 'df-panel__title', 'Города'));
  const list = el('div', 'df-city-list');
  root.append(list);

  const rows = new Map<number, CityRow>();
  const garrisons: number[] = [];
  let owned: number[] = [];
  let key = '';
  let lastTick = -1;

  function rebuild(next: number[]): void {
    clear(list);
    rows.clear();
    for (const index of next) {
      const row = buildRow(index, opts);
      rows.set(index, row);
      list.append(row.root);
    }
    owned = next;
  }

  function update(frame: FrameState): void {
    const world = frame.world;
    // Everything in this panel is tick state; frames in between show the same thing.
    if (world.tick === lastTick) return;
    lastTick = world.tick;

    const next: number[] = [];
    for (const city of world.cities) if (city.owner === opts.viewer) next.push(city.index);
    const nextKey = next.join(',');
    if (nextKey !== key) {
      key = nextKey;
      rebuild(next);
    }

    countGarrisons(world, opts.viewer, garrisons);
    for (const index of owned) {
      const row = rows.get(index);
      const city = world.cities[index];
      if (row && city) paintRow(row, city, garrisons[index] ?? 0, opts.viewer);
    }
  }

  return {
    root,
    update,
    destroy(): void {
      rows.clear();
      root.remove();
    },
  };
}
