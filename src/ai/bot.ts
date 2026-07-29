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
 * Reaction delay is modelled honestly. Perception produces a view, and the bot
 * keeps acting on the *previous* one until the profile's delay has elapsed. The
 * stale view is why a bot's unit lists are unit ids rather than slots: by the time
 * the bot acts on a front, some of the units it saw there may be dead, and every
 * consumer has to cope with that.
 */

import type { Command, World } from '../core/types.ts';
import { TICK_MS, TICK_SEC } from '../core/balance.ts';
import { deriveRng } from '../core/rng.ts';
import type { RngState } from '../core/types.ts';
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

interface BotRuntime {
  rng: RngState;
  perception: PerceptionState;
  strategy: StrategyState;
  ops: OperationsState;
  tactics: TacticsState;
  dbg: BotDebug;
  /** View waiting out the reaction delay. */
  pending: StrategicView | null;
  pendingTick: number;
  /** View the bot is currently acting on. */
  active: StrategicView | null;
  mode: MacroModeId;
  /** Unspent action budget, in actions. */
  bank: number;
  spentThisSecond: number;
}

/**
 * Staggers the thinking of different players across ticks so four bots do not all
 * do their strategic pass on the same frame.
 */
function phaseOffset(player: number, interval: number): number {
  return (player * 3) % interval;
}

export function createBot(world: World, player: number, profile: BotProfile, seed: number): Bot {
  const state: BotRuntime = {
    rng: deriveRng(seed, player * 0x1f123bb5),
    perception: createPerception(seed, player),
    strategy: createStrategy(),
    ops: createOperations(),
    tactics: createTactics(),
    dbg: createBotDebug(player, profile),
    pending: null,
    pendingTick: -1,
    active: null,
    mode: MacroMode.Expand,
    bank: 0,
    spentThisSecond: 0,
  };
  state.dbg.apmBudget = profile.apmBudget;
  logDecision(state.dbg, world.tick, `${profile.name} на связи`);

  const stratOffset = phaseOffset(player, STRATEGY_INTERVAL);
  const opsOffset = phaseOffset(player, OPS_INTERVAL);
  const ecoOffset = phaseOffset(player, ECO_INTERVAL);

  function updateView(w: World): void {
    if (w.tick % STRATEGY_INTERVAL === stratOffset) {
      state.pending = perceive(w, player, profile, state.perception);
      state.pendingTick = w.tick;
    }
    if (state.pending === null) return;
    const waited = (w.tick - state.pendingTick) * TICK_MS;
    if (waited < profile.reactionDelayMs && state.active !== null) return;

    state.active = state.pending;
    state.pending = null;
    const next = chooseMode(state.active, profile, state.strategy, state.rng);
    if (next !== state.mode) {
      logDecision(state.dbg, w.tick, `режим: ${state.mode} → ${next}`);
      state.mode = next;
    }
    state.dbg.mode = next;
    state.dbg.modeScores = state.strategy.scores;
    state.dbg.fronts = state.active.fronts;
  }

  function think(w: World): Command[] {
    const out: Command[] = [];
    if (w.outcome !== null || !w.players[player]!.alive) return out;

    if (w.tick % ECO_INTERVAL === 0) {
      const observed = state.spentThisSecond;
      state.spentThisSecond = 0;
      resetApm(state.dbg, profile.apmBudget);
      state.dbg.apmSpent = observed;
    }

    updateView(w);
    const view = state.active;
    if (view === null) return out;

    if (w.tick % OPS_INTERVAL === opsOffset) {
      planOperations(w, view, state.mode, profile, state.ops, state.rng);
      state.dbg.targetCities = state.ops.targetCities;
      state.dbg.encircleCell = state.ops.encircleCell;
      state.dbg.reserveTarget = state.ops.reserveTarget;
    }

    state.bank = Math.min(
      state.bank + profile.apmBudget * TICK_SEC,
      profile.apmBudget * APM_BANK_SEC,
    );

    const budget = Math.floor(state.bank);
    if (budget > 0) {
      const spent = runTactics({
        world: w,
        view,
        mode: state.mode,
        profile,
        ops: state.ops,
        state: state.tactics,
        rng: state.rng,
        budget,
        out,
        dbg: state.dbg,
      });
      state.bank -= Math.max(0, Math.min(spent, budget));
      state.spentThisSecond += Math.max(0, spent);
    }

    if (w.tick % ECO_INTERVAL === ecoOffset && state.bank >= 1) {
      const before = out.length;
      planEconomy(w, view, profile, state.rng, out);
      const used = out.length - before;
      state.bank -= used;
      state.spentThisSecond += used;
    }

    // The budget is a hard ceiling, not a suggestion: if a layer overran it the
    // surplus is dropped here rather than reaching the simulation, so the APM
    // figure shown in the F3 overlay is always the truth.
    if (out.length > budget && budget >= 0) out.length = budget;
    return out;
  }

  return {
    player,
    profile,
    think,
    debug: () => state.dbg,
  };
}
