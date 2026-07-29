/**
 * Main menu and skirmish setup.
 *
 * The screen is built once and then only ever re-synced: a single `refresh()` walks
 * a list of registered painters, each of which reads the current state and writes
 * through `setText`. That is what makes live re-localisation fall out for free —
 * switching language is the same operation as switching map — and it means no control
 * can drift out of step with the state behind it.
 *
 * Validation is continuous rather than a gate on the Start button: the reason a
 * roster is illegal is on screen the moment it becomes illegal, and Start is disabled
 * only because the reason is already visible next to it.
 */

import { VictoryMode } from '../core/types.ts';
import type { VictoryModeId } from '../core/types.ts';
import { BOT_PROFILES, LIEUTENANT, MARSHAL_HANDICAP } from '../ai/profiles.ts';
import { PLAYER_COLORS } from '../render/theme.ts';
import type { ThemeName } from '../render/theme.ts';
import { el, setText } from './dom.ts';
import { LOCALES, onLocaleChange, setLocale, t } from './i18n.ts';
import type { Locale } from './i18n.ts';
import {
  CAMERA_SPEED_MAX,
  CAMERA_SPEED_MIN,
  CAMERA_SPEED_STEP,
  VOLUME_STEP,
} from './settings.ts';
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

export interface MapChoice {
  id: string;
  name: string;
  players: number;
}

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

interface State {
  mapId: string;
  seed: number;
  victory: VictoryModeId;
  timeLimitMin: number;
  slots: SlotConfig[];
  marshalHandicap: boolean;
}

/** Recomputed before every repaint; the painters read it rather than validating again. */
interface Verdict {
  problem: string;
  note: string;
}

interface Ui {
  /** Registers a sync step and runs it once. */
  add(fn: () => void): void;
  text(node: HTMLElement, key: string, params?: Record<string, string | number>): void;
  run(): void;
}

function createUi(): Ui {
  const steps: (() => void)[] = [];
  const add = (fn: () => void): void => {
    steps.push(fn);
    fn();
  };
  return {
    add,
    text(node, key, params): void {
      add(() => setText(node, t(key, params)));
    },
    run(): void {
      for (const step of steps) step();
    },
  };
}

// ──────────────────────────────────────────────────────────────── controls ──

function titled(ui: Ui, titleKey: string): HTMLElement {
  const root = el('section', 'df-block');
  const title = el('h2', 'df-block__title');
  ui.text(title, titleKey);
  root.append(title);
  return root;
}

function field(ui: Ui, labelKey: string, control: HTMLElement): HTMLElement {
  const root = el('label', 'df-field');
  const label = el('span', 'df-field__label');
  ui.text(label, labelKey);
  root.append(label, control);
  return root;
}

interface Choice {
  value: string;
  key: string;
  params?: Record<string, string | number>;
}

function select(ui: Ui, choices: Choice[], onChange: (v: string) => void): HTMLSelectElement {
  const node = el('select', 'df-select');
  for (const choice of choices) {
    const option = el('option');
    option.value = choice.value;
    ui.text(option, choice.key, choice.params);
    node.append(option);
  }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/** Writes a value in from outside without yanking the control the user is editing. */
function syncValue(node: HTMLSelectElement | HTMLInputElement, value: string): void {
  if (document.activeElement === node) return;
  if (node.value !== value) node.value = value;
}

function numberInput(min: number, max: number, onChange: (v: number) => void): HTMLInputElement {
  const node = el('input', 'df-input');
  node.type = 'number';
  node.min = String(min);
  node.max = String(max);
  node.step = '1';
  node.addEventListener('change', () => {
    const parsed = Number(node.value);
    onChange(Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : min);
  });
  return node;
}

function checkbox(
  ui: Ui,
  labelKey: string,
  read: () => boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const root = el('label', 'df-check');
  const input = el('input');
  input.type = 'checkbox';
  const label = el('span');
  ui.text(label, labelKey);
  ui.add(() => {
    input.checked = read();
  });
  input.addEventListener('change', () => onChange(input.checked));
  root.append(input, label);
  return root;
}

interface RangeSpec {
  labelKey: string;
  min: number;
  max: number;
  step: number;
  read(): number;
  format(v: number): string;
  onInput(v: number): void;
}

function range(ui: Ui, spec: RangeSpec): HTMLElement {
  const root = el('label', 'df-slider');
  const label = el('span', 'df-slider__label');
  const input = el('input', 'df-slider__input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  ui.add(() => {
    const v = spec.read();
    syncValue(input, String(v));
    setText(label, `${t(spec.labelKey)} · ${spec.format(v)}`);
  });
  input.addEventListener('input', () => {
    spec.onInput(Number(input.value));
    setText(label, `${t(spec.labelKey)} · ${spec.format(Number(input.value))}`);
  });
  root.append(label, input);
  return root;
}

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
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
  const slots: SlotConfig[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    slots.push({ kind: 'off', profileId: LIEUTENANT.id, team: i + 1 });
  }
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
  if (active.length > seats) {
    out.problem = t('menu.error.tooMany', {
      map: map?.name ?? state.mapId,
      n: seats,
      have: active.length,
    });
    return;
  }
  if (active.length < 2) {
    out.problem = t('menu.error.tooFew');
    return;
  }
  if (new Set(active.map((s) => s.team)).size < 2) {
    out.problem = t('menu.error.oneTeam');
    return;
  }
  out.problem = '';
  if (active.length < seats) out.note = t('menu.note.padded', { n: seats - active.length });
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

  const mapPick = select(ui, [], (v) => {
    state.mapId = v;
    fitSlots(state, mapOf(maps, v)?.players ?? MAX_SLOTS);
    refresh();
  });
  for (const m of maps) {
    const option = el('option');
    option.value = m.id;
    ui.add(() => setText(option, `${m.name} · ${t('menu.map.players', { n: m.players })}`));
    mapPick.append(option);
  }
  ui.add(() => syncValue(mapPick, state.mapId));

  const victoryPick = select(
    ui,
    Object.values(VictoryMode).map((id) => ({ value: id, key: `victory.${id}` })),
    (v) => {
      state.victory = v as VictoryModeId;
      refresh();
    },
  );
  ui.add(() => syncValue(victoryPick, state.victory));
  const hint = el('p', 'df-hint');
  ui.add(() => setText(hint, t(`victory.hint.${state.victory}`)));

  const seedInput = numberInput(0, SEED_MAX, (v) => {
    state.seed = v;
    refresh();
  });
  ui.add(() => syncValue(seedInput, String(state.seed)));
  const dice = el('button', 'df-btn');
  dice.type = 'button';
  ui.text(dice, 'menu.seed.random');
  // The only randomness in the shell, and deliberately outside the simulation:
  // the seed it produces is what makes the match reproducible afterwards.
  dice.addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * SEED_MAX);
    refresh();
  });
  const seedRow = el('div', 'df-row');
  seedRow.append(seedInput, dice);

  const timeInput = numberInput(TIME_MIN, TIME_MAX, (v) => {
    state.timeLimitMin = v;
    refresh();
  });
  ui.add(() => syncValue(timeInput, String(state.timeLimitMin)));
  const timeUnit = el('span', 'df-unit');
  ui.text(timeUnit, 'menu.minutes');
  const timeRow = el('div', 'df-row');
  timeRow.append(timeInput, timeUnit);
  const timeField = field(ui, 'menu.timeLimit', timeRow);
  ui.add(() => {
    timeField.hidden = state.victory !== VictoryMode.TimedScore;
  });

  root.append(
    field(ui, 'menu.map', mapPick),
    field(ui, 'menu.victory', victoryPick),
    hint,
    field(ui, 'menu.seed', seedRow),
    timeField,
  );
  return root;
}

function slotRow(ui: Ui, state: State, index: number, refresh: () => void): HTMLElement {
  const slot = state.slots[index]!;
  const root = el('div', 'df-slot');
  root.style.setProperty('--df-swatch', PLAYER_COLORS[index]!);

  const name = el('span', 'df-slot__index');
  ui.text(name, 'menu.slot', { n: index + 1 });

  const kind = select(
    ui,
    [
      { value: 'human', key: 'slot.human' },
      { value: 'bot', key: 'slot.bot' },
      { value: 'off', key: 'slot.off' },
    ],
    (v) => {
      slot.kind = v as SlotConfig['kind'];
      refresh();
    },
  );
  const profile = select(
    ui,
    BOT_PROFILES.map((p) => ({ value: p.id, key: `bot.${p.id}` })),
    (v) => {
      slot.profileId = v;
      refresh();
    },
  );
  const team = select(
    ui,
    state.slots.map((_, i) => ({ value: String(i + 1), key: 'menu.team.n', params: { n: i + 1 } })),
    (v) => {
      slot.team = Number(v);
      refresh();
    },
  );

  ui.add(() => {
    syncValue(kind, slot.kind);
    syncValue(profile, slot.profileId);
    syncValue(team, String(slot.team));
    profile.disabled = slot.kind !== 'bot';
    team.disabled = slot.kind === 'off';
    root.classList.toggle('df-slot--off', slot.kind === 'off');
  });

  root.append(name, kind, profile, team);
  return root;
}

function rosterSection(ui: Ui, state: State, refresh: () => void): HTMLElement {
  const root = titled(ui, 'menu.roster');
  for (let i = 0; i < state.slots.length; i++) root.append(slotRow(ui, state, i, refresh));

  root.append(
    checkbox(
      ui,
      'menu.handicap',
      () => state.marshalHandicap,
      (v) => {
        state.marshalHandicap = v;
        refresh();
      },
    ),
  );
  const hint = el('p', 'df-hint');
  ui.text(hint, 'menu.handicap.hint', { pct: Math.round((MARSHAL_HANDICAP - 1) * 100) });
  root.append(hint);
  return root;
}

function settingsSection(ui: Ui, s: Settings, changed: () => void): HTMLElement {
  const root = titled(ui, 'menu.settings');

  const theme = select(
    ui,
    [
      { value: 'dark', key: 'theme.dark' },
      { value: 'light', key: 'theme.light' },
    ],
    (v) => {
      s.theme = v as ThemeName;
      changed();
    },
  );
  ui.add(() => syncValue(theme, s.theme));

  const locale = select(
    ui,
    LOCALES.map((l) => ({ value: l, key: `locale.${l}` })),
    (v) => {
      s.locale = v as Locale;
      // Driven from here rather than waiting for the host to echo it back, because
      // this screen's own labels are what the change is most visible in.
      setLocale(s.locale);
      changed();
    },
  );
  ui.add(() => syncValue(locale, s.locale));

  const colorblindHint = el('p', 'df-hint');
  ui.text(colorblindHint, 'settings.colorblind.hint');

  root.append(
    field(ui, 'settings.theme', theme),
    field(ui, 'settings.locale', locale),
    range(ui, {
      labelKey: 'settings.cameraSpeed',
      min: CAMERA_SPEED_MIN,
      max: CAMERA_SPEED_MAX,
      step: CAMERA_SPEED_STEP,
      read: () => s.cameraSpeed,
      format: (v) => `${v.toFixed(1)}×`,
      onInput: (v) => {
        s.cameraSpeed = v;
        changed();
      },
    }),
    range(ui, {
      labelKey: 'settings.volume',
      min: 0,
      max: 1,
      step: VOLUME_STEP,
      read: () => s.volume,
      format: percent,
      onInput: (v) => {
        s.volume = v;
        changed();
      },
    }),
    checkbox(
      ui,
      'settings.colorblind',
      () => s.colorblind,
      (v) => {
        s.colorblind = v;
        changed();
      },
    ),
    colorblindHint,
    checkbox(
      ui,
      'settings.territory',
      () => s.showTerritory,
      (v) => {
        s.showTerritory = v;
        changed();
      },
    ),
  );
  return root;
}

function helpSection(ui: Ui): HTMLElement {
  const root = titled(ui, 'menu.help');
  const steps = el('ol', 'df-steps');
  for (const key of ['tutorial.step1', 'tutorial.step2', 'tutorial.step3', 'tutorial.step4']) {
    const item = el('li');
    ui.text(item, key);
    steps.append(item);
  }
  const keysTitle = el('h3', 'df-block__subtitle');
  ui.text(keysTitle, 'keys.title');
  const keys = el('ul', 'df-keys');
  for (const key of ['select', 'path', 'orders', 'groups', 'camera', 'debug']) {
    const item = el('li');
    ui.text(item, `keys.row.${key}`);
    keys.append(item);
  }
  root.append(steps, keysTitle, keys);
  return root;
}

function footer(ui: Ui, verdict: Verdict, start: () => void): HTMLElement {
  const root = el('div', 'df-shell__actions');
  const note = el('p', 'df-hint');
  ui.add(() => {
    setText(note, verdict.note);
    note.hidden = verdict.note === '';
  });
  const error = el('p', 'df-error');
  ui.add(() => {
    setText(error, verdict.problem);
    error.hidden = verdict.problem === '';
  });
  const go = el('button', 'df-btn df-btn--primary');
  go.type = 'button';
  ui.text(go, 'menu.start');
  ui.add(() => {
    go.disabled = verdict.problem !== '';
  });
  go.addEventListener('click', start);
  root.append(note, error, go);
  return root;
}

// ─────────────────────────────────────────────────────────────────── shell ──

export function createMenu(opts: MenuOptions): Menu {
  const settings = opts.settings;
  const state = initialState(opts.maps);
  const verdict: Verdict = { problem: '', note: '' };
  const ui = createUi();

  const refresh = (): void => {
    evaluate(state, mapOf(opts.maps, state.mapId), verdict);
    ui.run();
  };

  const root = el('div', 'df-shell');
  const card = el('div', 'df-shell__card');
  const head = el('header', 'df-shell__head');
  const title = el('h1', 'df-shell__title');
  ui.text(title, 'app.title');
  const subtitle = el('p', 'df-shell__subtitle');
  ui.text(subtitle, 'app.subtitle');
  head.append(title, subtitle);

  const columns = el('div', 'df-menu');
  columns.append(
    setupSection(ui, state, opts.maps, refresh),
    rosterSection(ui, state, refresh),
    settingsSection(ui, settings, () => {
      opts.onSettingsChange(settings);
      refresh();
    }),
    helpSection(ui),
  );

  card.append(
    head,
    columns,
    footer(ui, verdict, () => {
      if (verdict.problem === '') opts.onStart(toConfig(state));
    }),
  );
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
