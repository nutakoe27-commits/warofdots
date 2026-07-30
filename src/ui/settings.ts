/**
 * Persisted user settings.
 *
 * Everything in here is presentation, never simulation: nothing a player changes on
 * this screen can alter a tick, so a stored settings blob can never desync a replay.
 *
 * `loadSettings` is field-by-field tolerant rather than all-or-nothing. A blob
 * written by an older build — or hand-edited in the console, or truncated by a
 * browser wiping storage mid-write — should cost the user the one field that is
 * broken, not their whole configuration.
 */

import type { ThemeName } from '../render/theme.ts';
import { el, setText } from './dom.ts';
import type { Locale } from './i18n.ts';
import { isLocale, t } from './i18n.ts';

export interface Settings {
  theme: ThemeName;
  colorblind: boolean;
  /** Multiplier on the keyboard/edge pan speed. */
  cameraSpeed: number;
  /** Master volume for the procedural audio layer, 0..1. */
  volume: number;
  locale: Locale;
  showTerritory: boolean;
}

export const CAMERA_SPEED_MIN = 0.4;
export const CAMERA_SPEED_MAX = 2.5;
export const CAMERA_SPEED_STEP = 0.1;
export const VOLUME_STEP = 0.05;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  colorblind: false,
  cameraSpeed: 1,
  volume: 0.6,
  locale: 'ru',
  showTerritory: true,
};

const STORAGE_KEY = 'dotfront.settings';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function readBool(raw: Record<string, unknown>, key: keyof Settings, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === 'boolean' ? v : fallback;
}

function readNumber(
  raw: Record<string, unknown>,
  key: keyof Settings,
  fallback: number,
  lo: number,
  hi: number,
): number {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

function readTheme(raw: Record<string, unknown>): ThemeName {
  return raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : DEFAULT_SETTINGS.theme;
}

function readLocale(raw: Record<string, unknown>): Locale {
  return isLocale(raw.locale) ? raw.locale : DEFAULT_SETTINGS.locale;
}

/** Parses whatever is in storage into a whole `Settings`, keeping every sane field. */
export function parseSettings(input: unknown): Settings {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_SETTINGS };
  const raw = input as Record<string, unknown>;
  return {
    theme: readTheme(raw),
    colorblind: readBool(raw, 'colorblind', DEFAULT_SETTINGS.colorblind),
    cameraSpeed: readNumber(
      raw,
      'cameraSpeed',
      DEFAULT_SETTINGS.cameraSpeed,
      CAMERA_SPEED_MIN,
      CAMERA_SPEED_MAX,
    ),
    volume: readNumber(raw, 'volume', DEFAULT_SETTINGS.volume, 0, 1),
    locale: readLocale(raw),
    showTerritory: readBool(raw, 'showTerritory', DEFAULT_SETTINGS.showTerritory),
  };
}

export function loadSettings(): Settings {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing modes throw on access rather than returning null.
    return { ...DEFAULT_SETTINGS };
  }
  if (stored === null) return { ...DEFAULT_SETTINGS };
  try {
    return parseSettings(JSON.parse(stored) as unknown);
  } catch {
    console.warn('dotfront: settings in localStorage are not valid JSON, using defaults');
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    console.warn('dotfront: could not persist settings');
  }
}

// ─────────────────────────────────────────────────────────── scrubbed values ──

/**
 * The two settings a player scrubs rather than picks. They live here, next to the
 * model, because a slider is bound to one field of `Settings` and to nothing else —
 * and because the menu has no room for a second widget kit.
 *
 * Each slider syncs itself instead of being driven by the menu's painter list: the
 * menu only has to call `refresh()`, which it already does for every other control.
 */
export interface SettingsSliders {
  readonly root: HTMLElement;
  /** Re-reads the settings object and re-labels for the current locale. */
  refresh(): void;
}

interface SliderSpec {
  field: 'cameraSpeed' | 'volume';
  key: string;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
}

const SLIDERS: SliderSpec[] = [
  {
    field: 'cameraSpeed',
    key: 'settings.cameraSpeed',
    min: CAMERA_SPEED_MIN,
    max: CAMERA_SPEED_MAX,
    step: CAMERA_SPEED_STEP,
    format: (v) => `${v.toFixed(1)}×`,
  },
  {
    field: 'volume',
    key: 'settings.volume',
    min: 0,
    max: 1,
    step: VOLUME_STEP,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

function buildSlider(s: Settings, spec: SliderSpec, changed: () => void): SettingsSliders {
  const root = el('label', 'df-slider');
  const label = el('span', 'df-slider__label');
  const input = el('input', 'df-slider__input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  const paint = (): void => setText(label, `${t(spec.key)} · ${spec.format(s[spec.field])}`);
  input.addEventListener('input', () => {
    s[spec.field] = Number(input.value);
    paint();
    changed();
  });
  root.append(label, input);
  return {
    root,
    refresh(): void {
      const next = String(s[spec.field]);
      // A value written in from the host must never yank a live drag.
      if (document.activeElement !== input && input.value !== next) input.value = next;
      paint();
    },
  };
}

export function createSettingsSliders(s: Settings, changed: () => void): SettingsSliders {
  // `df-group` is `display: contents`, so the sliders lay out as if they were direct
  // children of the settings block.
  const root = el('div', 'df-group');
  const parts = SLIDERS.map((spec) => buildSlider(s, spec, changed));
  for (const part of parts) root.append(part.root);
  return {
    root,
    refresh(): void {
      for (const part of parts) part.refresh();
    },
  };
}
