/**
 * End-of-match screen (spec §4.9): the verdict, the ledger, and two graphs.
 *
 * The graphs are hand-built SVG rather than a chart library, and not only to avoid a
 * dependency: `stats.ecoHistory` is already a sampled series of `[tick, p1, p2, …]`
 * rows, so the whole job is two scales and a polyline per player. The `viewBox`
 * scales uniformly, which keeps the axis text readable at any card width without
 * anyone having to measure a font.
 *
 * Everything is rebuilt on `show()` and on a locale change, because a finished world
 * is frozen — there is no live state to keep in sync, only text to re-render.
 */

import { TICK_SEC } from '../core/balance.ts';
import type { World } from '../core/types.ts';
import { playerColor } from '../render/theme.ts';
import { el, fmtClock, fmtInt } from './dom.ts';
import { onLocaleChange, t } from './i18n.ts';

export interface EndScreenOptions {
  onRestart(): void;
  onExitToMenu(): void;
}

export interface EndScreen {
  readonly root: HTMLElement;
  show(world: World, viewer: number): void;
  hide(): void;
  destroy(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_W = 480;
const CHART_H = 150;
const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 26;
const GRID_LINES = 4;
const X_LABELS = 3;
const LABEL_DY = 4;
const AXIS_GAP = 8;
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

interface Line {
  /** Column in a history row, which is also the player id. */
  column: number;
  color: string;
  name: string;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  return node;
}

/** Rounds an axis maximum up to something a human would have chosen. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of NICE_STEPS) {
    if (value <= magnitude * step) return magnitude * step;
  }
  return magnitude * 10;
}

function linesOf(world: World, viewer: number): Line[] {
  const out: Line[] = [];
  for (let p = 1; p < world.players.length; p++) {
    const player = world.players[p]!;
    const suffix = p === viewer ? ` (${t('end.you')})` : '';
    out.push({ column: p, color: playerColor(player.colorIndex), name: player.name + suffix });
  }
  return out;
}

function maxOf(rows: number[][], lines: Line[]): number {
  let max = 0;
  for (const row of rows) {
    for (const line of lines) {
      const v = row[line.column] ?? 0;
      if (v > max) max = v;
    }
  }
  return max;
}

interface Scale {
  x(tick: number): number;
  y(value: number): number;
  maxTick: number;
  maxValue: number;
}

function scaleFor(rows: number[][], lines: Line[]): Scale {
  const maxTick = Math.max(1, rows[rows.length - 1]?.[0] ?? 1);
  const maxValue = niceMax(maxOf(rows, lines));
  const spanX = CHART_W - PAD_L - PAD_R;
  const spanY = CHART_H - PAD_T - PAD_B;
  return {
    maxTick,
    maxValue,
    x: (tick) => PAD_L + (tick / maxTick) * spanX,
    y: (value) => CHART_H - PAD_B - (value / maxValue) * spanY,
  };
}

function drawGrid(root: SVGSVGElement, scale: Scale): void {
  for (let i = 0; i <= GRID_LINES; i++) {
    const value = (scale.maxValue * i) / GRID_LINES;
    const y = scale.y(value);
    root.append(
      svg('line', { x1: PAD_L, y1: y, x2: CHART_W - PAD_R, y2: y, class: 'df-chart__grid' }),
    );
    const label = svg('text', {
      x: PAD_L - AXIS_GAP,
      y: y + LABEL_DY,
      'text-anchor': 'end',
      class: 'df-chart__label',
    });
    label.textContent = fmtInt(value);
    root.append(label);
  }
}

function drawTimeAxis(root: SVGSVGElement, scale: Scale): void {
  const baseline = CHART_H - PAD_B;
  for (let i = 0; i < X_LABELS; i++) {
    const tick = (scale.maxTick * i) / (X_LABELS - 1);
    const anchor = i === 0 ? 'start' : i === X_LABELS - 1 ? 'end' : 'middle';
    const label = svg('text', {
      x: scale.x(tick),
      y: baseline + AXIS_GAP + LABEL_DY * 2,
      'text-anchor': anchor,
      class: 'df-chart__label',
    });
    label.textContent = fmtClock(tick * TICK_SEC);
    root.append(label);
  }
  const title = svg('text', {
    x: PAD_L + (CHART_W - PAD_L - PAD_R) / 2,
    y: CHART_H - 1,
    'text-anchor': 'middle',
    class: 'df-chart__axis',
  });
  title.textContent = t('end.chart.time');
  root.append(title);
}

function drawSeries(root: SVGSVGElement, rows: number[][], lines: Line[], scale: Scale): void {
  for (const line of lines) {
    const points: string[] = [];
    for (const row of rows) {
      const px = scale.x(row[0] ?? 0).toFixed(1);
      const py = scale.y(row[line.column] ?? 0).toFixed(1);
      points.push(`${px},${py}`);
    }
    root.append(
      svg('polyline', { points: points.join(' '), stroke: line.color, class: 'df-chart__line' }),
    );
  }
}

function buildChart(titleKey: string, rows: number[][], lines: Line[]): HTMLElement {
  const root = el('figure', 'df-chart');
  root.append(el('figcaption', 'df-chart__title', t(titleKey)));
  if (rows.length < 2) {
    root.append(el('p', 'df-hint', t('end.chart.empty')));
    return root;
  }
  const scale = scaleFor(rows, lines);
  const canvas = svg('svg', {
    viewBox: `0 0 ${CHART_W} ${CHART_H}`,
    class: 'df-chart__svg',
    role: 'img',
    'aria-label': t(titleKey),
  });
  drawGrid(canvas, scale);
  drawTimeAxis(canvas, scale);
  drawSeries(canvas, rows, lines, scale);
  root.append(canvas);
  return root;
}

function buildLegend(lines: Line[]): HTMLElement {
  const root = el('div', 'df-legend');
  for (const line of lines) {
    const item = el('span', 'df-legend__item', line.name);
    const swatch = el('span', 'df-legend__swatch');
    swatch.style.setProperty('--df-swatch', line.color);
    item.prepend(swatch);
    root.append(item);
  }
  return root;
}

const COLUMNS = [
  'end.produced',
  'end.lost',
  'end.peakArmy',
  'end.captured',
  'end.cities',
  'end.territory',
  'end.score',
] as const;

function statCells(world: World, player: number): string[] {
  const s = world.stats.players[player]!;
  return [
    fmtInt(s.produced),
    fmtInt(s.lost),
    fmtInt(s.peakArmy),
    fmtInt(s.captured),
    fmtInt(s.citiesNow),
    `${Math.round(s.territory * 100)}%`,
    fmtInt(s.score),
  ];
}

function buildTable(world: World, viewer: number, lines: Line[]): HTMLElement {
  const table = el('table', 'df-table');
  const head = el('tr');
  head.append(el('th', 'df-table__name', t('end.player')));
  for (const key of COLUMNS) head.append(el('th', 'df-table__num', t(key)));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const body = el('tbody');
  for (const line of lines) {
    const row = el('tr', line.column === viewer ? 'df-table__row--you' : undefined);
    const name = el('td', 'df-table__name', line.name);
    name.style.setProperty('--df-swatch', line.color);
    row.append(name);
    for (const cell of statCells(world, line.column)) {
      row.append(el('td', 'df-table__num', cell));
    }
    body.append(row);
  }
  table.append(body);
  return table;
}

/** Win / lose / draw from the viewer's seat, plus the winners by name. */
function verdictOf(world: World, viewer: number, lines: Line[]): { title: string; who: string } {
  const outcome = world.outcome;
  if (!outcome) return { title: t('end.over'), who: '' };
  const names = outcome.winners
    .map((p) => lines.find((l) => l.column === p)?.name ?? String(p))
    .join(', ');
  const who = names === '' ? '' : t('end.winner', { names });
  if (outcome.team < 0) return { title: t('end.draw'), who };
  const seat = world.players[viewer];
  if (!seat) return { title: t('end.over'), who };
  return { title: outcome.team === seat.team ? t('end.win') : t('end.lose'), who };
}

function buildHead(world: World, viewer: number, lines: Line[]): HTMLElement {
  const head = el('header', 'df-shell__head');
  const verdict = verdictOf(world, viewer, lines);
  head.append(el('h1', 'df-shell__title', verdict.title));
  const reason = world.outcome ? t(`end.reason.${world.outcome.reason}`) : '';
  head.append(el('p', 'df-shell__subtitle', [verdict.who, reason].filter(Boolean).join(' · ')));
  const duration = el('p', 'df-hint');
  const ticks = world.outcome?.tick ?? world.tick;
  duration.textContent = `${t('end.duration')}: ${fmtClock(ticks * TICK_SEC)}`;
  head.append(duration);
  return head;
}

export function createEndScreen(opts: EndScreenOptions): EndScreen {
  const root = el('div', 'df-shell');
  const card = el('div', 'df-shell__card');
  const body = el('div', 'df-end');
  const actions = el('div', 'df-shell__actions');
  const restart = el('button', 'df-btn df-btn--primary');
  restart.type = 'button';
  restart.addEventListener('click', () => opts.onRestart());
  const exit = el('button', 'df-btn');
  exit.type = 'button';
  exit.addEventListener('click', () => opts.onExitToMenu());
  actions.append(restart, exit);
  card.append(body, actions);
  root.append(card);
  root.hidden = true;

  let shown: { world: World; viewer: number } | null = null;

  function render(): void {
    restart.textContent = t('end.restart');
    exit.textContent = t('end.exit');
    if (!shown) return;
    const { world, viewer } = shown;
    const lines = linesOf(world, viewer);
    body.replaceChildren(
      buildHead(world, viewer, lines),
      buildTable(world, viewer, lines),
      buildLegend(lines),
      buildChart('end.chart.eco', world.stats.ecoHistory, lines),
      buildChart('end.chart.army', world.stats.armyHistory, lines),
    );
  }

  const stopListening = onLocaleChange(render);
  render();

  return {
    root,
    show(world: World, viewer: number): void {
      shown = { world, viewer };
      render();
      root.hidden = false;
    },
    hide(): void {
      root.hidden = true;
    },
    destroy(): void {
      stopListening();
      root.remove();
    },
  };
}
