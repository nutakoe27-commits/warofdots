/**
 * `npm run map:png -- [mapId…]`
 *
 * Renders a generated map's terrain grid into a palette PNG next to its JSON, so a
 * designer can open a procedural map in an image editor, hand-tune it, and point the
 * JSON at the result with `"terrainMask": "<id>.png"`.
 *
 * One pixel per tile, colours straight from `TERRAIN_MASK_COLORS` — the same table
 * the mask decoder snaps to, so a round trip through an editor is lossless as long
 * as the editor does not resample.
 *
 * An existing PNG is never silently overwritten. Once a mask has been hand-edited it
 * is source material, and a re-export that clobbers it costs a designer their work;
 * `--force` is the deliberate way to say otherwise.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERRAIN_MASK_COLORS, terrainHistogram } from '../src/core/terrain.ts';
import { TERRAIN_KEYS } from '../src/core/types.ts';
import { getMapDef, getMapRuntime, listMapDefs } from '../src/content/registry.ts';
import { loadMapsFromDisk, MAPS_DIR } from './maps.ts';
import { encodePng } from './png.ts';

const LEGEND_FILE = 'terrain-legend.png';
/** Legend geometry, pixels. */
const SWATCH_W = 96;
const ROW_H = 28;
const DIGIT_SCALE = 4;
const DIGIT_X = 10;
const LEGEND_FALLBACK: [number, number, number] = [14, 17, 22];
/** Rows of a 3×5 bitmap font for digits 0–7. Enough to label eight terrain types. */
const DIGITS: readonly string[][] = [
  ['111', '101', '101', '101', '111'],
  ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'],
  ['111', '001', '010', '010', '010'],
];

function parseArgs(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (k: string, v: string): void => void out.set(k, [...(out.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      push('', a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      push(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) push(a.slice(2), argv[++i]!);
    else push(a.slice(2), '1');
  }
  return out;
}

function hex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function paintTerrain(terrain: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(terrain.length * 4);
  for (let i = 0; i < terrain.length; i++) {
    const c = TERRAIN_MASK_COLORS[terrain[i]!] ?? TERRAIN_MASK_COLORS[0]!;
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** The three most common terrains, as a one-line summary of what was exported. */
function histogramSummary(shares: readonly number[]): string {
  return shares
    .map((share, id) => ({ share, key: TERRAIN_KEYS[id] ?? '?' }))
    .filter((e) => e.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, 3)
    .map((e) => `${e.key.toLowerCase()} ${(e.share * 100).toFixed(0)}%`)
    .join(', ');
}

function writeIfChanged(file: string, png: Buffer, force: boolean): 'wrote' | 'same' | 'kept' {
  if (existsSync(file)) {
    if (readFileSync(file).equals(png)) return 'same';
    if (!force) return 'kept';
  }
  writeFileSync(file, png);
  return 'wrote';
}

function exportMap(id: string, outDir: string, force: boolean): void {
  const def = getMapDef(id);
  if (def.terrainMask && !def.terrainGen) {
    console.warn(`${id}: authored as the mask "${def.terrainMask}" already — nothing to export`);
    return;
  }
  const map = getMapRuntime(id);
  const png = encodePng(map.w, map.h, paintTerrain(map.terrain));
  const file = join(outDir, `${id}.png`);
  const size = `${map.w}×${map.h}`;
  const summary = histogramSummary(terrainHistogram(map));

  switch (writeIfChanged(file, png, force)) {
    case 'wrote':
      console.log(`wrote ${file}  ${size}  ${summary}`);
      break;
    case 'same':
      console.log(`${file} is already up to date  ${size}`);
      break;
    case 'kept':
      console.warn(
        `kept ${file}: it differs from the generated terrain, so it looks hand-edited. ` +
          'Pass --force to overwrite it.',
      );
      break;
  }
}

function ink(rgb: readonly [number, number, number]): number {
  // Perceived luminance, so the digit stays readable on snow and on mountain alike.
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140 ? 0 : 255;
}

function put(rgba: Uint8Array, w: number, x: number, y: number, r: number, g: number, b: number): void {
  const i = (y * w + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = 255;
}

function drawDigit(rgba: Uint8Array, w: number, digit: number, x0: number, y0: number, tone: number): void {
  const glyph = DIGITS[digit];
  if (!glyph) return;
  for (let gy = 0; gy < glyph.length; gy++) {
    const row = glyph[gy]!;
    for (let gx = 0; gx < row.length; gx++) {
      if (row[gx] !== '1') continue;
      for (let sy = 0; sy < DIGIT_SCALE; sy++) {
        for (let sx = 0; sx < DIGIT_SCALE; sx++) {
          put(rgba, w, x0 + gx * DIGIT_SCALE + sx, y0 + gy * DIGIT_SCALE + sy, tone, tone, tone);
        }
      }
    }
  }
}

/**
 * A swatch strip: one row per terrain id, the id drawn into its own colour. Names
 * would need a font, so the mapping from index to name is printed to stdout instead.
 */
function writeLegend(outDir: string, force: boolean): void {
  const count = TERRAIN_MASK_COLORS.length;
  const w = SWATCH_W;
  const h = ROW_H * count;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const c = TERRAIN_MASK_COLORS[(y / ROW_H) | 0] ?? LEGEND_FALLBACK;
    for (let x = 0; x < w; x++) put(rgba, w, x, y, c[0], c[1], c[2]);
  }
  for (let id = 0; id < count; id++) {
    const tone = ink(TERRAIN_MASK_COLORS[id]!);
    drawDigit(rgba, w, id, DIGIT_X, id * ROW_H + (ROW_H - 5 * DIGIT_SCALE) / 2, tone);
  }
  const file = join(outDir, LEGEND_FILE);
  switch (writeIfChanged(file, encodePng(w, h, rgba), force)) {
    case 'wrote':
      console.log(`wrote ${file}  ${w}×${h}  one swatch per terrain id`);
      break;
    case 'same':
      console.log(`${file} is already up to date`);
      break;
    case 'kept':
      console.warn(`kept ${file}: it differs from the generated legend. Pass --force to replace it.`);
      break;
  }
}

function printPalette(): void {
  console.log('\nterrain palette (pixel colour → terrain):');
  TERRAIN_MASK_COLORS.forEach((c, id) => {
    console.log(`  ${id}  ${(TERRAIN_KEYS[id] ?? '?').padEnd(9)} ${hex(c)}  rgb(${c.join(', ')})`);
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log('usage: npm run map:png -- [mapId…] [--out <dir>] [--force]');
    return;
  }
  loadMapsFromDisk();
  const outDir = args.get('out')?.[0] ?? MAPS_DIR;
  const force = args.has('force');
  const ids = args.get('') ?? listMapDefs().map((d) => d.id);

  for (const id of ids) exportMap(id, outDir, force);
  writeLegend(outDir, force);
  printPalette();
  console.log(
    '\nTo play a hand-edited mask, set "terrainMask": "<id>.png" in the map JSON and drop ' +
      'its "terrainGen" block. Editors must not resample: one pixel is one tile.',
  );
}

try {
  main();
} catch (err) {
  // A typo in a map id is a user error, not a crash: one clear line, no stack.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
