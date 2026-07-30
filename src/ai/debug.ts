/**
 * The bot's account of itself, as data.
 *
 * `BotDebug` is what the F3 overlay draws and what a headless calibration run can
 * dump straight into a log, which is why there is no drawing code anywhere in this
 * file: `src/ai` is DOM-free by rule, so rendering lives in
 * `src/render/layers/ai-debug.ts` (ADR-012).
 *
 * The only thing here worth explaining is the decision log. It is bounded twice
 * over — by a ten-second window *and* by an entry count — because a bot in a big
 * fight can reach a decision every tick, and an array that only ever grows would
 * quietly leak through a twenty-minute match.
 */

import { TICK_SEC } from '../core/balance.ts';
import { MacroMode } from './types.ts';
import type { Assignment, BotDebug, BotProfile } from './types.ts';

/** Spec §5.4: «лог решений за последние 10 секунд». */
const LOG_WINDOW_SEC = 10;
const LOG_WINDOW_TICKS = Math.round(LOG_WINDOW_SEC / TICK_SEC);
/** Hard ceiling on entries, so a busy second cannot flood the panel. */
const LOG_MAX_ENTRIES = 24;
/** The same message inside this many ticks is the same decision, not a new one. */
const LOG_DEDUPE_TICKS = 20;
/**
 * How far back a repeat is looked for. Comparing against the newest entry alone was
 * enough while the log was mostly mode changes, but the tactical stages interleave:
 * the cycle, the terrain correction and the flank each report in the same tick, so
 * every one of them is somebody else's "previous entry" and none of them dedupes.
 * Three messages taking turns fill a 24-line panel in a little over a second and
 * bury the strategic decisions the overlay exists to show.
 */
const LOG_DEDUPE_SCAN = 6;

export function createBotDebug(player: number, profile: BotProfile): BotDebug {
  return {
    player,
    profile: profile.name,
    mode: MacroMode.Expand,
    modeScores: {},
    fronts: [],
    roles: new Map(),
    targetCities: [],
    encircleCell: -1,
    apmSpent: 0,
    apmBudget: profile.apmBudget,
    reserveTarget: 0,
    log: [],
  };
}

/** Appends a decision, then drops whatever fell out of the window or over the cap. */
export function logDecision(dbg: BotDebug, tick: number, text: string): void {
  const log = dbg.log;
  for (let i = log.length - 1; i >= 0 && i >= log.length - LOG_DEDUPE_SCAN; i--) {
    const seen = log[i]!;
    if (seen.text === text && tick - seen.tick < LOG_DEDUPE_TICKS) return;
  }

  log.push({ tick, text });
  let stale = 0;
  while (stale < log.length && tick - log[stale]!.tick > LOG_WINDOW_TICKS) stale++;
  const over = Math.max(stale, log.length - LOG_MAX_ENTRIES);
  if (over > 0) log.splice(0, over);
}

/** Called once a second by the facade, so the overlay's bar reads per-second APM. */
export function resetApm(dbg: BotDebug, budget: number): void {
  dbg.apmBudget = budget;
  dbg.apmSpent = 0;
}

/**
 * Republishes group membership for the coloured outlines in the overlay. Rebuilt
 * rather than patched: operations already prunes dead units out of its assignment
 * map, so a rebuild cannot leave a stale id behind for the overlay to look up.
 */
export function syncRoles(dbg: BotDebug, assignments: Map<number, Assignment>): void {
  dbg.roles.clear();
  for (const [id, assignment] of assignments) dbg.roles.set(id, assignment.role);
}
