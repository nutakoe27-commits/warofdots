/**
 * Main menu and skirmish setup.
 *
 * The screen is built once and then only ever re-synced: a single `refresh()` walks a
 * list of registered painters, each of which reads the current state and writes through
 * `setText`. That is what makes live re-localisation fall out for free — switching
 * language is the same operation as switching map — and it means no control can drift
 * out of step with the state behind it.
 *
 * Every control is bound to a `Cell`: one getter, one setter, no widget owning state of
 * its own. Validation is continuous rather than a gate on the Start button, so the
 * reason a roster is illegal is on screen the moment it becomes illegal and Start is
 * disabled only because that reason is already sitting next to it.
 *
 * The `Settings` object is mutated in place rather than copied, because the host holds
 * the same reference and changes it too (the territory toggle is a hotkey during a
 * match). Re-syncing on `show()` is what keeps this screen honest about that.
 */

import { VictoryMode } from '../core/types.ts';
import type { VictoryModeId } from '../core/types.ts';
import { BOT_PROFILES, LIEUTENANT, MARSHAL_HANDICAP } from '../ai/profiles.ts';
import { PLAYER_COLORS } from '../render/theme.ts';
import type { ThemeName } from '../render/theme.ts';
import { el, setText } from './dom.ts';
import { LOCALES, onLocaleChange, setLocale, t } from './i18n.ts';
import type { Locale } from './i18n.ts';
import { createSettingsSliders } from './settings.ts';
import type { Settings } from './settings.ts';

export interface SlotConfig {
  kind: 'human' | 'bot' | 'off';
  profileId: string;
  team: number;
}

export interface MatchConfig {
  mapId: string;
  seed: number;
  victory: VictoryModeId;
  timeLimitSec: number;
  /** Active slots only; index 0 is player 1. */
  slots: SlotConfig[];
  marshalHandicap: boolean;
}

export type MapChoice = { id: string; name: string; players: number };

export interface MenuOptions {
  maps: MapChoice[];
  settings: Settings;
  onStart(cfg: MatchConfig): void;
  onSettingsChange(s: Settings): void;
}

export interface Menu {
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
  destroy(): void;
}

/** One slot per player colour — the renderer cannot tell a fifth player apart. */
const MAX_SLOTS = PLAYER_COLORS.length;
const SEED_MAX = 0x7fffffff;
const SEC_PER_MIN = 60;
const TIME_MIN = 1;
const TIME_MAX = 90;
const DEFAULT_TIME_MIN = 15;

const KINDS = ['human', 'bot', 'off'];
const THEMES = ['dark', 'light'];
const PROFILES = BOT_PROFILES.map((p) => p.id);
const VICTORIES: string[] = Object.values(VictoryMode);
const TEAMS = Array.from({ length: MAX_SLOTS }, (_, i) => String(i + 1));
const STEPS = ['tutorial.step1', 'tutorial.step2', 'tutorial.step3', 'tutorial.step4'];
const KEYS = ['select', 'path', 'orders', 'groups', 'camera', 'debug'].map((k) => `keys.row.${k}`);

const kindLabel = (v: string): string => t(`slot.${v}`);
const botLabel = (v: string): string => t(`bot.${v}`);
const teamLabel = (v: string): string => t('menu.team.n', { n: v });
const victoryLabel = (v: string): string => t(`victory.${v}`);
const themeLabel = (v: string): string => t(`theme.${v}`);
const localeLabel = (v: string): string => t(`locale.${v}`);

interface State {
  mapId: string;
  seed: number;
  victory: VictoryModeId;
  timeLimitMin: number;
  slots: SlotConfig[];
  marshalHandicap: boolean;
}

/** Recomputed before every repaint; the painters read it rather than validating again. */
type Verdict = { problem: string; note: string };
type Params = Record<string, string | number>;
type Label = (v: string) => string;
/** A control's binding to one piece of state, and its only connection to the world. */
type Cell<R, W = R> = { get(): R; set(v: W): void };
type PickCell = Cell<string | number, string>;
/** Registers a sync step and runs it once. */
type Ui = (paint: () => void) => void;

function createUi(): [Ui, () => void] {
  const steps: (() => void)[] = [];
  const add: Ui = (paint) => {
    steps.push(paint);
    paint();
  };
  const run = (): void => {
    for (const step of steps) step();
  };
  return [add, run];
}

// ──────────────────────────────────────────────────────────────── controls ──

function text(ui: Ui, node: HTMLElement, key: string, params?: Params): void {
  ui(() => setText(node, t(key, params)));
}

function titled(ui: Ui, titleKey: string): HTMLElement {
  const root = el('section', 'df-block');
  const title = el('h2', 'df-block__title');
  text(ui, title, titleKey);
  root.append(title);
  return root;
}

function field(ui: Ui, labelKey: string, control: HTMLElement): HTMLElement {
  const root = el('label', 'df-field');
  const label = el('span', 'df-field__label');
  text(ui, label, labelKey);
  root.append(label, control);
  return root;
}

function row(...kids: HTMLElement[]): HTMLElement {
  const root = el('div', 'df-row');
  root.append(...kids);
  return root;
}

function list(ui: Ui, tag: 'ol' | 'ul', className: string, keys: string[]): HTMLElement {
  const root = el(tag, className);
  for (const key of keys) {
    const item = el('li');
    text(ui, item, key);
    root.append(item);
  }
  return root;
}

/** Writes a value in from outside without yanking the control the user is editing. */
function syncValue(node: HTMLSelectElement | HTMLInputElement, value: string): void {
  if (document.activeElement === node) return;
  if (node.value !== value) node.value = value;
}

function pick(ui: Ui, vals: readonly string[], label: Label, cell: PickCell): HTMLSelectElement {
  const node = el('select', 'df-select');
  for (const value of vals) {
    const option = el('option');
    option.value = value;
    ui(() => setText(option, label(value)));
    node.append(option);
  }
  ui(() => syncValue(node, String(cell.get())));
  node.addEventListener('change', () => cell.set(node.value));
  return node;
}

function number(ui: Ui, lo: number, hi: number, cell: Cell<number>): HTMLInputElement {
  const node = el('input', 'df-input');
  node.type = 'number';
  node.min = String(lo);
  node.max = String(hi);
  node.step = '1';
  ui(() => syncValue(node, String(cell.get())));
  node.addEventListener('change', () => {
    const parsed = Number(node.value);
    cell.set(Number.isFinite(parsed) ? Math.min(hi, Math.max(lo, Math.round(parsed))) : lo);
  });
  return node;
}

function check(ui: Ui, key: string, cell: Cell<boolean>): HTMLElement {
  const root = el('label', 'df-check');
  const input = el('input');
  input.type = 'checkbox';
  const label = el('span');
  text(ui, label, key);
  ui(() => {
    input.checked = cell.get();
  });
  input.addEventListener('change', () => cell.set(input.checked));
  root.append(input, label);
  return root;
}

// ─────────────────────────────────────────────────────────────────── state ──

function fitSlots(state: State, players: number): void {
  state.slots.forEach((slot, i) => {
    if (i >= players) slot.kind = 'off';
    else if (slot.kind === 'off') slot.kind = i === 0 ? 'human' : 'bot';
  });
}

function initialState(maps: MapChoice[]): State {
  const first = maps[0];
  const slots: SlotConfig[] = TEAMS.map((_, i) => ({
    kind: 'off',
    profileId: LIEUTENANT.id,
    team: i + 1,
  }));
  const state: State = {
    mapId: first?.id ?? '',
    seed: 1,
    victory: VictoryMode.CapitalAndMajority,
    timeLimitMin: DEFAULT_TIME_MIN,
    slots,
    marshalHandicap: false,
  };
  fitSlots(state, first?.players ?? 2);
  return state;
}

function mapOf(maps: MapChoice[], id: string): MapChoice | undefined {
  return maps.find((m) => m.id === id);
}

/**
 * The three rules from the spec, in the order a player is most likely to hit them.
 * A roster *smaller* than the map is legal — the match layer seats bots in the empty
 * capitals — so that case is a note rather than an error.
 */
function evaluate(state: State, map: MapChoice | undefined, out: Verdict): void {
  const active = state.slots.filter((s) => s.kind !== 'off');
  const seats = map?.players ?? 0;
  out.note = '';
  out.problem = '';
  if (active.length > seats) {
    const name = map?.name ?? state.mapId;
    out.problem = t('menu.error.tooMany', { map: name, n: seats, have: active.length });
  } else if (active.length < 2) {
    out.problem = t('menu.error.tooFew');
  } else if (new Set(active.map((s) => s.team)).size < 2) {
    out.problem = t('menu.error.oneTeam');
  } else if (active.length < seats) {
    out.note = t('menu.note.padded', { n: seats - active.length });
  }
}

function toConfig(state: State): MatchConfig {
  return {
    mapId: state.mapId,
    seed: state.seed >>> 0,
    victory: state.victory,
    timeLimitSec: state.timeLimitMin * SEC_PER_MIN,
    slots: state.slots.filter((s) => s.kind !== 'off').map((s) => ({ ...s })),
    marshalHandicap: state.marshalHandicap,
  };
}

// ──────────────────────────────────────────────────────────────── sections ──

function setupSection(ui: Ui, state: State, maps: MapChoice[], refresh: () => void): HTMLElement {
  const root = titled(ui, 'menu.setup');
  const set = (patch: Partial<State>): void => {
    Object.assign(state, patch);
    refresh();
  };
  const mapLabel = (id: string): string => {
    const m = mapOf(maps, id);
    return m ? `${m.name} · ${t('menu.map.players', { n: m.players })}` : id;
  };
  const chooseMap = (id: string): void => {
    state.mapId = id;
    fitSlots(state, mapOf(maps, id)?.players ?? MAX_SLOTS);
    refresh();
  };
  const setVictory = (v: string): void => set({ victory: v as VictoryModeId });
  const setMins = (v: number): void => set({ timeLimitMin: v });

  const ids = maps.map((m) => m.id);
  const mapPick = pick(ui, ids, mapLabel, { get: () => state.mapId, set: chooseMap });
  const vic = pick(ui, VICTORIES, victoryLabel, { get: () => state.victory, set: setVictory });
  const hint = el('p', 'df-hint');
  ui(() => setText(hint, t(`victory.hint.${state.victory}`)));

  const seed = number(ui, 0, SEED_MAX, { get: () => state.seed, set: (v) => set({ seed: v }) });
  const dice = el('button', 'df-btn');
  dice.type = 'button';
  text(ui, dice, 'menu.seed.random');
  // The only randomness in the shell, and deliberately outside the simulation: the seed
  // it produces is exactly what makes the match reproducible afterwards.
  dice.addEventListener('click', () => set({ seed: Math.floor(Math.random() * SEED_MAX) }));

  const mins = number(ui, TIME_MIN, TIME_MAX, { get: () => state.timeLimitMin, set: setMins });
  const unit = el('span', 'df-unit');
  text(ui, unit, 'menu.minutes');
  const timeField = field(ui, 'menu.timeLimit', row(mins, unit));
  ui(() => {
    timeField.hidden = state.victory !== VictoryMode.TimedScore;
  });

  root.append(
    field(ui, 'menu.map', mapPick),
    field(ui, 'menu.victory', vic),
    hint,
    field(ui, 'menu.seed', row(seed, dice)),
    timeField,
  );
  return root;
}

function slotRow(ui: Ui, state: State, index: number, refresh: () => void): HTMLElement {
  const slot = state.slots[index]!;
  const set = (patch: Partial<SlotConfig>): void => {
    Object.assign(slot, patch);
    refresh();
  };
  const setKind = (v: string): void => set({ kind: v as SlotConfig['kind'] });
  const setProfile = (v: string): void => set({ profileId: v });
  const setTeam = (v: string): void => set({ team: Number(v) });

  const root = el('div', 'df-slot');
  root.style.setProperty('--df-swatch', PLAYER_COLORS[index]!);
  const name = el('span', 'df-slot__index');
  text(ui, name, 'menu.slot', { n: index + 1 });
  const kind = pick(ui, KINDS, kindLabel, { get: () => slot.kind, set: setKind });
  const bot = pick(ui, PROFILES, botLabel, { get: () => slot.profileId, set: setProfile });
  const team = pick(ui, TEAMS, teamLabel, { get: () => slot.team, set: setTeam });
  ui(() => {
    bot.disabled = slot.kind !== 'bot';
    team.disabled = slot.kind === 'off';
    root.classList.toggle('df-slot--off', slot.kind === 'off');
  });

  root.append(name, kind, bot, team);
  return root;
}

function rosterSection(ui: Ui, state: State, refresh: () => void): HTMLElement {
  const root = titled(ui, 'menu.roster');
  for (let i = 0; i < state.slots.length; i++) root.append(slotRow(ui, state, i, refresh));
  const set = (v: boolean): void => {
    state.marshalHandicap = v;
    refresh();
  };
  root.append(check(ui, 'menu.handicap', { get: () => state.marshalHandicap, set }));
  const hint = el('p', 'df-hint');
  text(ui, hint, 'menu.handicap.hint', { pct: Math.round((MARSHAL_HANDICAP - 1) * 100) });
  root.append(hint);
  return root;
}

function settingsSection(ui: Ui, s: Settings, changed: () => void): HTMLElement {
  const root = titled(ui, 'menu.settings');
  const set = (patch: Partial<Settings>): void => {
    Object.assign(s, patch);
    // Driven from here rather than waiting for the host to echo it back, because this
    // screen's own labels are where a language change is most visible.
    if (patch.locale !== undefined) setLocale(patch.locale);
    changed();
  };
  const setTheme = (v: string): void => set({ theme: v as ThemeName });
  const setLang = (v: string): void => set({ locale: v as Locale });
  const setBlind = (v: boolean): void => set({ colorblind: v });
  const setTerritory = (v: boolean): void => set({ showTerritory: v });

  const theme = pick(ui, THEMES, themeLabel, { get: () => s.theme, set: setTheme });
  const lang = pick(ui, LOCALES, localeLabel, { get: () => s.locale, set: setLang });
  const blindHint = el('p', 'df-hint');
  text(ui, blindHint, 'settings.colorblind.hint');
  const sliders = createSettingsSliders(s, changed);
  ui(sliders.refresh);

  root.append(
    field(ui, 'settings.theme', theme),
    field(ui, 'settings.locale', lang),
    sliders.root,
    check(ui, 'settings.colorblind', { get: () => s.colorblind, set: setBlind }),
    blindHint,
    check(ui, 'settings.territory', { get: () => s.showTerritory, set: setTerritory }),
  );
  return root;
}

function helpSection(ui: Ui): HTMLElement {
  const root = titled(ui, 'menu.help');
  const keysTitle = el('h3', 'df-block__subtitle');
  text(ui, keysTitle, 'keys.title');
  root.append(list(ui, 'ol', 'df-steps', STEPS), keysTitle, list(ui, 'ul', 'df-keys', KEYS));
  return root;
}

function footer(ui: Ui, verdict: Verdict, start: () => void): HTMLElement {
  const root = el('div', 'df-shell__actions');
  // Problem and note are mutually exclusive by construction, so one line serves both.
  const message = el('p');
  const go = el('button', 'df-btn df-btn--primary');
  go.type = 'button';
  text(ui, go, 'menu.start');
  ui(() => {
    const bad = verdict.problem !== '';
    setText(message, bad ? verdict.problem : verdict.note);
    message.className = bad ? 'df-error' : 'df-hint';
    message.hidden = message.textContent === '';
    go.disabled = bad;
  });
  go.addEventListener('click', start);
  root.append(message, go);
  return root;
}

// ─────────────────────────────────────────────────────────────────── shell ──

export function createMenu(opts: MenuOptions): Menu {
  const settings = opts.settings;
  const state = initialState(opts.maps);
  const verdict: Verdict = { problem: '', note: '' };
  const [ui, run] = createUi();
  const refresh = (): void => {
    evaluate(state, mapOf(opts.maps, state.mapId), verdict);
    run();
  };
  const changed = (): void => {
    opts.onSettingsChange(settings);
    refresh();
  };
  const begin = (): void => opts.onStart(toConfig(state));

  const root = el('div', 'df-shell');
  const card = el('div', 'df-shell__card');
  const head = el('header', 'df-shell__head');
  const title = el('h1', 'df-shell__title');
  const subtitle = el('p', 'df-shell__subtitle');
  text(ui, title, 'app.title');
  text(ui, subtitle, 'app.subtitle');
  head.append(title, subtitle);

  const columns = el('div', 'df-menu');
  columns.append(
    setupSection(ui, state, opts.maps, refresh),
    rosterSection(ui, state, refresh),
    settingsSection(ui, settings, changed),
    helpSection(ui),
  );
  card.append(head, columns, footer(ui, verdict, begin));
  root.append(card);
  root.hidden = true;

  const stopListening = onLocaleChange(refresh);
  refresh();

  return {
    root,
    show(): void {
      root.hidden = false;
      refresh();
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
