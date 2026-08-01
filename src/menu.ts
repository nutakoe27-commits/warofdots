/**
 * The shell around the match: pick a battlefield, pick an opponent, play, and
 * find out how it went.
 *
 * Plain DOM over the canvas rather than anything drawn in it. The menu is a list
 * of buttons; a list of buttons is what HTML is for, and it comes with focus,
 * keyboard access and text wrapping already working.
 */

import { DIFFICULTIES } from './ai.ts';
import { LEVELS } from './levels.ts';
import type { Level } from './levels.ts';
import { getVolume, initAudio, isMuted, sfxClick, setMuted, setVolume } from './audio.ts';

/**
 * Every button press goes through here.
 *
 * A browser will only create an audio context inside a real gesture, so the first
 * click the user makes has to be the one that builds it — otherwise the menu is
 * silent, the sound toggle appears to do nothing, and the noise only turns up once
 * the battle has already started.
 */
function tap(): void {
  initAudio();
  sfxClick();
}

export interface Choice {
  level: Level;
  difficulty: number;
  perSide: number;
}

const ARMIES = [
  { name: 'Малая', n: 32, blurb: 'Короткий бой, каждый юнит на счету' },
  { name: 'Средняя', n: 64, blurb: 'Полный фронт' },
  { name: 'Большая', n: 96, blurb: 'Длинный бой, глубокая оборона' },
];

const choice: Choice = { level: LEVELS[0]!, difficulty: 1, perSide: 64 };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A row of mutually exclusive buttons. */
function pick<T>(
  host: HTMLElement,
  items: T[],
  selected: (v: T) => boolean,
  label: (v: T) => string,
  sub: (v: T) => string,
  onPick: (v: T) => void,
): void {
  for (const item of items) {
    const b = el('button', selected(item) ? 'opt on' : 'opt');
    b.appendChild(el('b', undefined, label(item)));
    b.appendChild(el('span', undefined, sub(item)));
    b.addEventListener('click', () => {
      tap();
      onPick(item);
    });
    host.appendChild(b);
  }
}

export function renderMenu(root: HTMLElement, onStart: (c: Choice) => void): void {
  root.innerHTML = '';
  root.className = 'screen';

  const card = el('div', 'card');
  const head = el('header');
  head.appendChild(el('h1', undefined, 'War of Dots'));
  head.appendChild(el('p', undefined, 'Десять настоящих полей сражений. Вы — синие.'));
  card.appendChild(head);

  const mk = (title: string, hint: string, cls: string): HTMLElement => {
    const s = el('section');
    const h = el('h2', undefined, title);
    h.appendChild(el('em', undefined, hint));
    s.appendChild(h);
    const g = el('div', cls);
    s.appendChild(g);
    card.appendChild(s);
    return g;
  };

  const levels = mk('Поле боя', 'по мотивам реальных сражений', 'grid levels');
  pick(levels, LEVELS, (l) => l === choice.level, (l) => l.name, (l) => `${l.when} · ${l.blurb}`, (l) => {
    choice.level = l;
    renderMenu(root, onStart);
  });

  const diff = mk('Противник', 'меняется только то, как он думает', 'grid');
  pick(diff, DIFFICULTIES.map((_, i) => i), (i) => i === choice.difficulty,
    (i) => DIFFICULTIES[i]!.name, (i) => DIFFICULTIES[i]!.blurb, (i) => {
      choice.difficulty = i;
      renderMenu(root, onStart);
    });

  const army = mk('Размер армии', 'у обеих сторон поровну', 'grid');
  pick(army, ARMIES, (a) => a.n === choice.perSide, (a) => a.name, (a) => a.blurb, (a) => {
    choice.perSide = a.n;
    renderMenu(root, onStart);
  });

  const snd = mk('Звук', 'всё синтезируется на лету', 'grid sound');
  const toggle = el('button', isMuted() ? 'opt' : 'opt on');
  toggle.appendChild(el('b', undefined, isMuted() ? 'Выключен' : 'Включён'));
  toggle.appendChild(el('span', undefined, 'Гул боя, выстрелы, приказы'));
  toggle.addEventListener('click', () => {
    initAudio();
    setMuted(!isMuted());
    sfxClick();
    renderMenu(root, onStart);
  });
  snd.appendChild(toggle);

  const slider = el('label', 'slider');
  slider.appendChild(el('b', undefined, 'Громкость'));
  const range = el('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.value = String(Math.round(getVolume() * 100));
  range.addEventListener('input', () => {
    initAudio();
    setVolume(Number(range.value) / 100);
  });
  slider.appendChild(range);
  snd.appendChild(slider);

  const go = el('button', 'start', 'В бой');
  go.addEventListener('click', () => {
    tap();
    onStart({ ...choice });
  });
  card.appendChild(go);

  card.appendChild(el('p', 'foot',
    'ЛКМ — выделить · тянуть — лассо · с выделением тянуть — маршрут · Shift+тянуть — строем · ' +
    'C — сброс · S — стоп · колесо — зум · ПКМ/СКМ — сдвинуть · F — туман · Space — пауза · Esc — меню'));

  root.appendChild(card);
  root.hidden = false;
}

export function renderPause(root: HTMLElement, onResume: () => void, onQuit: () => void): void {
  root.innerHTML = '';
  root.className = 'screen thin';
  const card = el('div', 'card');
  card.appendChild(el('h1', undefined, 'Пауза'));
  const a = el('button', 'start', 'Продолжить');
  a.addEventListener('click', () => {
    tap();
    onResume();
  });
  const b = el('button', 'start ghost', 'Выйти в меню');
  b.addEventListener('click', () => {
    tap();
    onQuit();
  });
  card.appendChild(a);
  card.appendChild(b);
  root.appendChild(card);
  root.hidden = false;
}

export interface Outcome {
  won: boolean;
  level: Level;
  difficulty: number;
  time: string;
  lost: number;
  killed: number;
  left: number;
}

export function renderResult(root: HTMLElement, o: Outcome, onAgain: () => void, onQuit: () => void): void {
  root.innerHTML = '';
  root.className = 'screen thin';
  const card = el('div', 'card');
  card.appendChild(el('h1', o.won ? 'won' : 'lost', o.won ? 'Победа' : 'Поражение'));
  card.appendChild(el('p', undefined,
    `${o.level.name}, ${o.level.when} · противник: ${DIFFICULTIES[o.difficulty]!.name}`));

  const stats = el('dl', 'stats');
  for (const [k, v] of [
    ['Время', o.time],
    ['Ваши потери', String(o.lost)],
    ['Потери противника', String(o.killed)],
    ['Осталось войск', String(o.left)],
  ] as const) {
    stats.appendChild(el('dt', undefined, k));
    stats.appendChild(el('dd', undefined, v));
  }
  card.appendChild(stats);

  const a = el('button', 'start', 'Ещё раз');
  a.addEventListener('click', () => {
    tap();
    onAgain();
  });
  const b = el('button', 'start ghost', 'В меню');
  b.addEventListener('click', () => {
    tap();
    onQuit();
  });
  card.appendChild(a);
  card.appendChild(b);
  root.appendChild(card);
  root.hidden = false;
}

export function hideScreen(root: HTMLElement): void {
  root.hidden = true;
  root.innerHTML = '';
}
