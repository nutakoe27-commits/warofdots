/**
 * Map registry. Environment-agnostic: whoever has access to the JSON files
 * registers them, and everything downstream asks the registry.
 *
 * The browser fills it through Vite's glob import (`maps.browser.ts`), Node fills
 * it from the filesystem (`tools/maps.ts`). Keeping the registry itself free of
 * either concern is what lets the same map definitions drive the game, the tests
 * and the headless tuner.
 */

import type { MapDef, MapRuntime } from '../core/types.ts';
import { buildMapRuntime, parseMapDef } from '../core/map.ts';

const defs = new Map<string, MapDef>();
const runtimeCache = new Map<string, MapRuntime>();

export function registerMapDef(raw: unknown): MapDef {
  const def = parseMapDef(raw);
  defs.set(def.id, def);
  runtimeCache.delete(def.id);
  return def;
}

export function registerMapDefs(list: readonly unknown[]): void {
  for (const raw of list) registerMapDef(raw);
}

export function listMapDefs(): MapDef[] {
  return [...defs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getMapDef(id: string): MapDef {
  const def = defs.get(id);
  if (!def) {
    throw new Error(`unknown map "${id}". Registered: ${[...defs.keys()].join(', ') || '(none)'}`);
  }
  return def;
}

export function hasMap(id: string): boolean {
  return defs.has(id);
}

/**
 * Builds (and caches) the runtime for a procedurally-generated map.
 * Maps authored as PNG masks must be built by the caller, which supplies the
 * decoded mask — the registry has no way to read images.
 */
export function getMapRuntime(id: string): MapRuntime {
  const cached = runtimeCache.get(id);
  if (cached) return cached;
  const def = getMapDef(id);
  if (def.terrainMask && !def.terrainGen) {
    throw new Error(
      `map "${id}" is authored as a PNG mask; decode it and call buildMapRuntime directly`,
    );
  }
  const runtime = buildMapRuntime(def);
  runtimeCache.set(id, runtime);
  return runtime;
}

export function clearRegistry(): void {
  defs.clear();
  runtimeCache.clear();
}
