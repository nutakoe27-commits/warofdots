/**
 * Node-side map loading, used by the tests, the benchmark and the headless tuner.
 * Reads the same JSON files the browser bundles, straight off disk.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerMapDefs, listMapDefs } from '../src/content/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const MAPS_DIR = join(here, '..', 'src', 'content', 'maps');

let loaded = false;

/** Registers every `*.json` map in `src/content/maps`. Idempotent. */
export function loadMapsFromDisk(): void {
  if (loaded) return;
  const files = readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json')).sort();
  registerMapDefs(files.map((f) => JSON.parse(readFileSync(join(MAPS_DIR, f), 'utf8'))));
  loaded = true;
  if (listMapDefs().length === 0) throw new Error(`no maps found in ${MAPS_DIR}`);
}
