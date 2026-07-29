/**
 * Browser-side map loading.
 *
 * `import.meta.glob` bakes every map JSON into the bundle at build time, so adding
 * a map is a matter of dropping a file into `src/content/maps/` — no registration
 * list to keep in sync.
 */

import { registerMapDefs } from './registry.ts';
import { decodeTerrainMask } from '../core/terrain.ts';
import { buildMapRuntime } from '../core/map.ts';
import type { MapDef, MapRuntime } from '../core/types.ts';

const modules = import.meta.glob<unknown>('./maps/*.json', { eager: true, import: 'default' });
const maskUrls = import.meta.glob<string>('./maps/*.png', { eager: true, query: '?url', import: 'default' });

let loaded = false;

export function loadBundledMaps(): void {
  if (loaded) return;
  registerMapDefs(Object.values(modules));
  loaded = true;
}

/** Decodes a PNG palette mask through the browser's own image pipeline. */
async function decodeMask(url: string, w: number, h: number): Promise<Uint8Array> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('could not create a 2D context to decode the terrain mask');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, w, h);
  return decodeTerrainMask(ctx.getImageData(0, 0, w, h).data, w * h);
}

/**
 * Builds a map runtime, decoding its PNG mask first when it has one.
 * Async because image decoding is; generated maps resolve immediately.
 */
export async function buildMapForBrowser(def: MapDef): Promise<MapRuntime> {
  if (!def.terrainMask) return buildMapRuntime(def);
  const url = maskUrls[`./maps/${def.terrainMask}`];
  if (!url) throw new Error(`map "${def.id}" references missing mask "${def.terrainMask}"`);
  const terrain = await decodeMask(url, def.size.w, def.size.h);
  return buildMapRuntime(def, terrain);
}
