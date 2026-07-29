/**
 * Palette. Two themes ("staff map at night" and "paper"), four player colours, and
 * a colour-blind mode that distinguishes players by capital marker shape rather
 * than hue alone.
 *
 * Terrain fills are deliberately low-contrast against each other but mountains are
 * pushed hard away from everything else, because a wall has to read as a wall at a
 * glance and at any zoom.
 */

import { TERRAIN_COUNT } from '../core/types.ts';

export type ThemeName = 'dark' | 'light';

export interface Theme {
  name: ThemeName;
  background: string;
  /** Fill per terrain id. */
  terrain: string[];
  /** Slightly shifted terrain fills for the checker pattern that gives texture. */
  terrainAlt: string[];
  grid: string;
  /** Front line stroke over the territory fill. */
  frontLine: string;
  cityRing: string;
  cityNeutral: string;
  text: string;
  textDim: string;
  panel: string;
  panelBorder: string;
  selection: string;
  lasso: string;
  orderLine: string;
  minimapFrame: string;
}

const DARK_TERRAIN = [
  '#2c3a2b', // plains
  '#1d3324', // forest
  '#3a3527', // hills
  '#403a29', // sand
  '#3d4550', // snow
  '#2e2820', // mud
  '#13253d', // water
  '#0a0c0f', // mountain
];

const LIGHT_TERRAIN = [
  '#dfe3cf', // plains
  '#b9ccb0', // forest
  '#d9cfb2', // hills
  '#ece0bd', // sand
  '#f4f6f8', // snow
  '#c9bfa6', // mud
  '#b9cfe4', // water
  '#6e6a66', // mountain
];

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 0xff) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export const DARK: Theme = {
  name: 'dark',
  background: '#0e1116',
  terrain: DARK_TERRAIN,
  terrainAlt: DARK_TERRAIN.map((c) => shade(c, 5)),
  grid: 'rgba(255,255,255,0.04)',
  frontLine: 'rgba(255,255,255,0.55)',
  cityRing: 'rgba(255,255,255,0.75)',
  cityNeutral: '#8a8f98',
  text: '#e6e9ee',
  textDim: '#8b93a1',
  panel: 'rgba(14,17,22,0.88)',
  panelBorder: 'rgba(255,255,255,0.12)',
  selection: 'rgba(255,255,255,0.85)',
  lasso: 'rgba(255,255,255,0.7)',
  orderLine: 'rgba(255,255,255,0.4)',
  minimapFrame: 'rgba(255,255,255,0.7)',
};

export const LIGHT: Theme = {
  name: 'light',
  background: '#f2efe9',
  terrain: LIGHT_TERRAIN,
  terrainAlt: LIGHT_TERRAIN.map((c) => shade(c, -6)),
  grid: 'rgba(0,0,0,0.05)',
  frontLine: 'rgba(30,30,30,0.6)',
  cityRing: 'rgba(30,30,30,0.7)',
  cityNeutral: '#6f7278',
  text: '#1d2026',
  textDim: '#5d636e',
  panel: 'rgba(250,248,244,0.92)',
  panelBorder: 'rgba(0,0,0,0.14)',
  selection: 'rgba(30,30,30,0.8)',
  lasso: 'rgba(30,30,30,0.65)',
  orderLine: 'rgba(30,30,30,0.35)',
  minimapFrame: 'rgba(30,30,30,0.7)',
};

if (DARK.terrain.length !== TERRAIN_COUNT || LIGHT.terrain.length !== TERRAIN_COUNT) {
  throw new Error('theme terrain palettes must cover every terrain type');
}

/** Player colours, indexed by `PlayerState.colorIndex`. */
export const PLAYER_COLORS = ['#4a90d9', '#d94a4a', '#5cb85c', '#e0a13a'] as const;
export const PLAYER_COLORS_DIM = ['#2c5b8a', '#8a2f2f', '#3a7440', '#8f6621'] as const;
export const PLAYER_NAMES = ['Синие', 'Красные', 'Зелёные', 'Янтарные'] as const;

/** Capital marker shapes, so players stay distinguishable without colour. */
export const CAPITAL_SHAPES = ['square', 'triangle', 'diamond', 'hexagon'] as const;
export type CapitalShape = (typeof CAPITAL_SHAPES)[number];

export function playerColor(colorIndex: number): string {
  return PLAYER_COLORS[colorIndex % PLAYER_COLORS.length]!;
}

export function playerColorDim(colorIndex: number): string {
  return PLAYER_COLORS_DIM[colorIndex % PLAYER_COLORS_DIM.length]!;
}

export function capitalShape(colorIndex: number): CapitalShape {
  return CAPITAL_SHAPES[colorIndex % CAPITAL_SHAPES.length]!;
}

/** `rgba()` string for a player colour at a given alpha, for territory fills. */
export function playerRgba(colorIndex: number, alpha: number): string {
  const hex = playerColor(colorIndex);
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}

/** Territory fill alpha. Low enough that terrain still reads through the colour. */
export const TERRITORY_ALPHA = 0.25;

export function themeByName(name: ThemeName): Theme {
  return name === 'light' ? LIGHT : DARK;
}
