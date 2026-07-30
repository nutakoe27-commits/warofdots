/**
 * The bot facade: cadence, reaction delay and the APM budget.
 *
 * The three thinking layers run at different rates — strategy at 2 Hz, operations
 * at 4 Hz, tactics every tick — and none of them may issue more commands than the
 * profile's actions-per-second allows. That budget is the whole difficulty system:
 * a Новобранец is not a bot that plays badly on purpose, it is a bot that gets
 * eight actions a second and therefore cannot micro an army even when it knows
 * exactly what it should do.
 *
 * Reaction delay is modelled honestly: the bot acts on a picture of the world that
 * is `reactionDelayMs` old. Perception queues views as it builds them, and each
 * tick the bot adopts the newest one that has aged past its delay. The stale view
 * is why a bot's unit lists are unit ids rather than slots — by the time the bot
 * acts on a front, some of the units it saw there may be dead, and every consumer
 * has to cope with that (ADR-020).
 *
 * Adoption is checked every tick rather than only when perception runs. That is
 * what keeps the fast end of the dial meaningful: with a 500 ms perception cadence,
 * checking only on perception ticks would collapse 80 ms, 150 ms and 300 ms into
 * the same 500 ms of staleness.
 */

import type { Command, RngState, World } from '../core/types.ts';
import { TICK_MS, TICK_SEC } from '../core/balance.ts';
import { deriveRng } from '../core/rng.ts';
import type { Bot, BotDebug, BotProfile, MacroModeId, StrategicView } from './types.ts';
import { MacroMode } from './types.ts';
import { createPerception, perceive } from './perception.ts';
import type { PerceptionState } from './perception.ts';
import { chooseMode, createStrategy } from './strategy.ts';
import type { StrategyState } from './strategy.ts';
import { createOperations, planOperations } from './operations.ts';
import type { OperationsState } from './operations.ts';
import { createTactics, runTactics } from './tactics.ts';
import type { TacticsState } from './tactics.ts';
import { planEconomy } from './bot-economy.ts';
import { createBotDebug, logDecision, resetApm } from './debug.ts';

/** Ticks between runs of each layer. 20 ticks = 1 second. */
const STRATEGY_INTERVAL = 10;
const OPS_INTERVAL = 5;
const ECO_INTERVAL = 20;
/** Seconds of unspent actions a bot may bank, so a lull does not fund a burst. */
const APM_BANK_SEC = 1.5;
/**
 * Cap on queued views. The slowest profile needs `ceil(900ms / 500ms) + 1 = 3`;
 * the cap only matters if a caller stops calling `think` for a while.
 */
const MAX_QUEUED_VIEWS = 4;

interface QueuedView {
  view: StrategicView;
  tick: number;
}

interface BotRuntime {
  player: number;
  profile: BotProfile;
  rng: RngState;
  perception: PerceptionState;
  strategy: StrategyState;
  ops: OperationsState;
  tactics: TacticsState;
  dbg: BotDebug;
  /** Views waiting out the reaction delay, oldest first. */
  queue: QueuedView[];
  /** View the bot is currently acting on. */
  active: StrategicView | null;
  mode: MacroModeId;
  /** Unspent action budget, in actions. */
  bank: number;
  spentThisSecond: number;
  stratOffset: number;
  opsOffset: number;
  ecoOffset: number;
}

/**
 * Staggers the thinking of different players across ticks so four bots do not all
 * do their strategic pass on the same frame.
 */
function phaseOffset(player: number, interval: number): number {
  return (player * 3) % interval;
}

/**
 * Takes the newest queued view that has aged past the profile's reaction delay, or
 * null when none has. Everything older is discarded with it — a bot that fell
 * behind should skip to the most recent picture it is entitled to, not replay a
 * backlog of stale ones.
 */
function dueView(rt: BotRuntime, w: World): StrategicView | null {
  let take = -1;
  for (let i = 0; i < rt.queue.length; i++) {
    if ((w.tick - rt.queue[i]!.tick) * TICK_MS < rt.profile.reactionDelayMs) break;
    take = i;
  }
  if (take < 0) return null;
  const chosen = rt.queue[take]!.view;
  rt.queue.splice(0, take + 1);
  return chosen;
}

function refreshView(rt: BotRuntime, w: World): void {
  if (w.tick % STRATEGY_INTERVAL === rt.stratOffset) {
    rt.queue.push({ view: perceive(w, rt.player, rt.profile, rt.perception), tick: w.tick });
    if (rt.queue.length > MAX_QUEUED_VIEWS) rt.queue.shift();
  }

  // The opening move is an exception: with nothing to act on yet, waiting out the
  // delay would leave the bot idle rather than merely slow.
  const next = rt.active === null ? (rt.queue.shift()?.view ?? null) : dueView(rt, w);
  if (next === null) return;
  rt.active = next;

  const mode = chooseMode(rt.active, rt.profile, rt.strategy, rt.rng);
  if (mode !== rt.mode) {
    logDecision(rt.dbg, w.tick, `режим: ${rt.mode} → ${mode}`);
    rt.mode = mode;
  }
  rt.dbg.mode = mode;
  rt.dbg.modeScores = rt.strategy.scores;
  rt.dbg.fronts = rt.active.fronts;
}

/** Rolls the per-second APM readout the F3 overlay shows. */
function rollApmWindow(rt: BotRuntime): void {
  const observed = rt.spentThisSecond;
  rt.spentThisSecond = 0;
  resetApm(rt.dbg, rt.profile.apmBudget);
  rt.dbg.apmSpent = observed;
}

function spendTactics(rt: BotRuntime, w: World, view: StrategicView, budget: number, out: Command[]): void {
  if (budget <= 0) return;
  const spent = runTactics({
    world: w,
    view,
    mode: rt.mode,
    profile: rt.profile,
    ops: rt.ops,
    state: rt.tactics,
    rng: rt.rng,
    budget,
    out,
    dbg: rt.dbg,
  });
  rt.bank -= Math.max(0, Math.min(spent, budget));
  rt.spentThisSecond += Math.max(0, spent);
}

function think(rt: BotRuntime, w: World): Command[] {
  const out: Command[] = [];
  if (w.outcome !== null || !w.players[rt.player]!.alive) return out;
  if (w.tick % ECO_INTERVAL === 0) rollApmWindow(rt);

  refreshView(rt, w);
  const view = rt.active;
  if (view === null) return out;

  if (w.tick % OPS_INTERVAL === rt.opsOffset) {
    planOperations(w, view, rt.mode, rt.profile, rt.ops, rt.rng);
    rt.dbg.targetCities = rt.ops.targetCities;
    rt.dbg.encircleCell = rt.ops.encircleCell;
    rt.dbg.reserveTarget = rt.ops.reserveTarget;
  }

  rt.bank = Math.min(
    rt.bank + rt.profile.apmBudget * TICK_SEC,
    rt.profile.apmBudget * APM_BANK_SEC,
  );
  const budget = Math.floor(rt.bank);
  spendTactics(rt, w, view, budget, out);

  if (w.tick % ECO_INTERVAL === rt.ecoOffset && rt.bank >= 1) {
    const before = out.length;
    planEconomy(w, view, rt.profile, rt.rng, out);
    const used = out.length - before;
    rt.bank -= used;
    rt.spentThisSecond += used;
  }

  // The budget is a hard ceiling, not a suggestion: if a layer overran it, the
  // surplus is dropped here rather than reaching the simulation, so the APM figure
  // in the F3 overlay is always the truth.
  if (out.length > budget) out.length = budget;
  return out;
}

export function createBot(world: World, player: number, profile: BotProfile, seed: number): Bot {
  const rt: BotRuntime = {
    player,
    profile,
    rng: deriveRng(seed, player * 0x1f123bb5),
    perception: createPerception(seed, player),
    strategy: createStrategy(),
    ops: createOperations(),
    tactics: createTactics(),
    dbg: createBotDebug(player, profile),
    queue: [],
    active: null,
    mode: MacroMode.Expand,
    bank: 0,
    spentThisSecond: 0,
    stratOffset: phaseOffset(player, STRATEGY_INTERVAL),
    opsOffset: phaseOffset(player, OPS_INTERVAL),
    ecoOffset: phaseOffset(player, ECO_INTERVAL),
  };
  rt.dbg.apmBudget = profile.apmBudget;
  logDecision(rt.dbg, world.tick, `${profile.name} на связи`);

  return {
    player,
    profile,
    think: (w: World) => think(rt, w),
    debug: () => rt.dbg,
  };
}
