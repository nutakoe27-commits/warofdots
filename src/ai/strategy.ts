/**
 * Layer 1b: deciding what the match is about right now.
 *
 * Six macro modes, scored from the `StrategicView` — one term per row of the table in
 * `docs/SPEC.md` §5.1 — and then chosen with hysteresis. The hysteresis is the part
 * that matters: a bot that re-scores twice a second and always takes the leader
 * twitches between DEFEND and PUSH on noise alone, which reads as a machine. Giving
 * the incumbent mode a standing bonus, and a larger one while the decision is still
 * fresh, makes the bot commit to a plan for a few seconds at a time.
 *
 * `mistakeRate` is spent here rather than on random jitter: a weak bot acts on the
 * *second-best* reading of the board. That is a misjudgement a human would recognise
 * — pushing into a fight that is only nearly won — rather than noise.
 */

import { MACRO_MODES, MacroMode } from './types.ts';
import type { BotProfile, MacroModeId, StrategicView } from './types.ts';
import type { RngState } from '../core/types.ts';
import { TICK_SEC } from '../core/balance.ts';
import { chance } from '../core/rng.ts';
import { clamp } from '../core/geometry.ts';

// ──────────────────────────────────────────────────────────────── weights ──
// Bot coefficients live beside the code that uses them (ADR-011). Each block below
// is one row of the mode table in the spec, quoted above it.

const W = {
  /** «есть нейтральные города, угроз нет» */
  expand: { base: 0.35, neutral: 0.9, room: 0.25, threat: 1.1 },
  /** «враг сильнее на 15%+ или давит на столицу» */
  defend: { base: 0.1, deficit: 2.2, siege: 0.7, capital: 1.6 },
  /** «примерный паритет» */
  pressure: { base: 0.3, parity: 0.7, terrain: 0.3, contact: 0.25 },
  /** «преимущество 20%+ по силе или экономике» */
  push: { base: 0.42, edge: 2.6, front: 0.4 },
  /** «найден разрез, отсекающий врага от его городов» */
  encircle: { base: 0.75, nerve: 0.7, cutCity: 0.35 },
  /** «у врага слабо прикрыт город» */
  snipe: { base: 0.2, weak: 1.2, light: 0.5 },
};

/** An enemy 15% stronger sits at this edge — the spec's DEFEND trigger. */
const DEFEND_EDGE = 0.13;
/** Advantage PUSH demands, from the least to the most aggressive profile. */
const PUSH_EDGE_MAX = 0.34;
const PUSH_EDGE_MIN = 0.1;
/** Advantage at which the board stops reading as parity. */
const PARITY_TOL = 0.22;
/** Share of my army in contact at which PRESSURE counts the front as fully joined. */
const PRESSURE_ENGAGED = 0.4;
/**
 * How loudly a lead in cities counts next to a lead in army. Halved: an economic
 * advantage is real but it is not yet on the board, and cities can be handed back.
 */
const ECO_EDGE_W = 0.5;
/** Enemy strength near a city that already counts as covering it. */
const SNIPE_COVER = 3;
/** City value that counts as a full prize, for normalising the raid opportunity. */
const VALUE_REF = 2;
/** Edges are clamped into this band, so a wiped-out enemy cannot produce Infinity. */
const EDGE_CAP = 2;
const STRENGTH_FLOOR = 1e-3;
/** Slack ENCIRCLE allows: it wants roughly parity before committing to a cut. */
const ENCIRCLE_SLACK = 0.2;
/** Strength floor in threat ratios, so a dead army does not divide by zero. */
const THREAT_FLOOR = 1;

/** Hysteresis: the incumbent carries this bonus, plus more while the choice is fresh. */
const INCUMBENT_BONUS = 0.12;
const FRESH_BONUS = 0.18;
/** How long a decision stays fresh. */
const FRESH_SEC = 2;
const FRESH_TICKS = Math.round(FRESH_SEC / TICK_SEC);

interface CityWeights {
  mine: number;
  neutral: number;
  enemy: number;
  threat: number;
  cut: number;
  weak: number;
}

/** How each mode reads a city. A zero ownership weight drops that class of city. */
const CITY_W: Record<MacroModeId, CityWeights> = {
  [MacroMode.Expand]: { mine: 0.2, neutral: 1.4, enemy: 0.5, threat: -0.6, cut: 0.2, weak: 0.3 },
  [MacroMode.Defend]: { mine: 1.5, neutral: 0.2, enemy: 0, threat: 0.9, cut: 0, weak: 0 },
  [MacroMode.Pressure]: { mine: 0.6, neutral: 1, enemy: 0.9, threat: -0.2, cut: 0.3, weak: 0.4 },
  [MacroMode.Push]: { mine: 0.2, neutral: 0.6, enemy: 1.5, threat: -0.3, cut: 0.3, weak: 0.5 },
  [MacroMode.Encircle]: { mine: 0.2, neutral: 0.8, enemy: 1.2, threat: -0.2, cut: 1.6, weak: 0.3 },
  [MacroMode.Snipe]: { mine: 0, neutral: 0.8, enemy: 1.1, threat: -0.8, cut: 0, weak: 1.6 },
};
/** Enemy cities pull harder for an aggressive profile. */
const AGGRO_FLOOR = 0.6;

// ──────────────────────────────────────────────────────────────── reading ──

export interface StrategyState {
  mode: MacroModeId;
  scores: Partial<Record<MacroModeId, number>>;
  sinceTick: number;
}

export function createStrategy(): StrategyState {
  return { mode: MacroMode.Expand, scores: {}, sinceTick: 0 };
}

/** `mine / theirs - 1`: 0 at parity, positive when ahead. Spec thresholds are ratios. */
function ratioEdge(mine: number, theirs: number): number {
  if (theirs <= STRENGTH_FLOOR) return mine > 0 ? EDGE_CAP : 0;
  return clamp(mine / theirs - 1, -1, EDGE_CAP);
}

interface Reading {
  edge: number;
  ecoEdge: number;
  /** 0..1 how hard the enemy is leaning on my own cities. */
  siege: number;
  /** 0..1 share of the map's cities still unclaimed. */
  neutral: number;
  /** Best front ratio, 0.5 when nothing is in contact. */
  bestFront: number;
  /** 0..1 share of my army already engaged. */
  contact: number;
  /** 0..1 best raiding opportunity among enemy cities. */
  weakCity: number;
  /** 0..1 supply headroom left. */
  room: number;
  /** An enemy city sits on a neck of their own territory. */
  cutCity: boolean;
}

function read(view: StrategicView): Reading {
  const mine = view.myArmy.strength;
  // In a team game each member answers for their share of the enemy coalition. Only
  // my own units are mine to command, so `myArmy` itself stays strictly my own.
  const share = view.enemyArmy.estStrength / (view.allies.length + 1);
  let myCities = 0, enemyCities = 0, neutral = 0;
  let siege = 0, weakCity = 0, cutCity = false;
  for (const c of view.cities) {
    // Perception only ever flags a city I do not hold, and a neutral one on the neck is
    // the cheapest cut of all, so the flag is read before ownership matters.
    if (c.cutsEnemy) cutCity = true;
    if (c.owner === view.me) {
      myCities++;
      siege = Math.max(siege, c.threat / (c.threat + mine + THREAT_FLOOR));
      continue;
    }
    if (c.owner === 0) {
      neutral++;
      continue;
    }
    if (!view.enemies.includes(c.owner)) continue;
    enemyCities++;
    const prize = clamp(c.value / VALUE_REF, 0, 1) / (1 + c.enemyPressure / SNIPE_COVER);
    weakCity = Math.max(weakCity, prize);
  }
  let engaged = 0, bestFront = 0.5;
  for (const f of view.fronts) {
    engaged += f.myStrength;
    bestFront = Math.max(bestFront, f.ratio);
  }
  const cap = view.myArmy.supplyCap;
  return {
    edge: ratioEdge(mine, share),
    // Economy is read off what a human can see: how many cities each side holds.
    ecoEdge: ratioEdge(myCities, enemyCities / Math.max(1, view.enemies.length)),
    siege,
    neutral: neutral / Math.max(1, view.cities.length),
    bestFront,
    contact: mine > 0 ? clamp(engaged / mine, 0, 1) : 0,
    weakCity,
    room: cap > 0 ? clamp(view.myArmy.supplyHeadroom / cap, 0, 1) : 0,
    cutCity,
  };
}

// ──────────────────────────────────────────────────────────────── scoring ──

export function scoreModes(
  view: StrategicView,
  profile: BotProfile,
): Partial<Record<MacroModeId, number>> {
  const r = read(view);
  // Aggression *is* the PUSH threshold: it slides the advantage the bot demands between
  // PUSH_EDGE_MAX and PUSH_EDGE_MIN, so the boldest profile commits on about two thirds
  // of the edge the most timid one waits for.
  const pushNeed = PUSH_EDGE_MAX - (PUSH_EDGE_MAX - PUSH_EDGE_MIN) * clamp(profile.aggression, 0, 1);
  const advantage = Math.max(r.edge, r.ecoEdge * ECO_EDGE_W);
  const deficit = Math.max(0, -r.edge - DEFEND_EDGE);
  const parity =
    (1 - clamp(Math.abs(r.edge) / PARITY_TOL, 0, 1)) *
    clamp(r.contact / PRESSURE_ENGAGED, 0, 1);
  const winning = clamp((r.bestFront - 0.5) * 2, 0, 1);
  const lightShare = view.myArmy.light / Math.max(1, view.myArmy.light + view.myArmy.heavy);
  const rough = profile.usesTerrain ? view.roughShare : 0;
  const alarm = Math.max(r.siege, r.contact, view.capitalThreatened ? 1 : 0);

  return {
    [MacroMode.Expand]:
      W.expand.base +
      W.expand.neutral * r.neutral +
      W.expand.room * r.room -
      W.expand.threat * alarm,
    [MacroMode.Defend]:
      W.defend.base +
      W.defend.deficit * deficit +
      W.defend.siege * r.siege +
      (view.capitalThreatened ? W.defend.capital : 0),
    [MacroMode.Pressure]:
      W.pressure.base +
      W.pressure.parity * parity +
      W.pressure.terrain * rough +
      W.pressure.contact * r.contact,
    // Signed, not floored at zero: below the profile's threshold the edge term drags
    // PUSH down, which is what makes `aggression` a real gate rather than a nudge.
    [MacroMode.Push]:
      W.push.base + W.push.edge * (advantage - pushNeed) + W.push.front * winning,
    // Gated twice over: no cut was found, or this profile does not think in cuts.
    [MacroMode.Encircle]:
      !profile.usesEncirclement || view.cutCell < 0
        ? 0
        : W.encircle.base +
          W.encircle.nerve * clamp(r.edge + ENCIRCLE_SLACK, 0, 1) +
          (r.cutCity ? W.encircle.cutCity : 0),
    [MacroMode.Snipe]: W.snipe.base + (W.snipe.weak + W.snipe.light * lightShare) * r.weakCity,
  };
}

export function chooseMode(
  view: StrategicView,
  profile: BotProfile,
  state: StrategyState,
  rng: RngState,
): MacroModeId {
  const scores = scoreModes(view, profile);
  state.scores = scores;

  const fresh = view.tick - state.sinceTick < FRESH_TICKS;
  const bonus = INCUMBENT_BONUS + (fresh ? FRESH_BONUS : 0);
  const held = (m: MacroModeId): number => (scores[m] ?? 0) + (m === state.mode ? bonus : 0);
  const ranked = MACRO_MODES.slice().sort(
    (a, b) => held(b) - held(a) || MACRO_MODES.indexOf(a) - MACRO_MODES.indexOf(b),
  );

  // The draw happens every time, whether or not it is used, so the stream does not
  // depend on how many modes happened to be in play.
  const misread = chance(rng, profile.mistakeRate);
  const pick = (misread ? ranked[1] ?? ranked[0] : ranked[0]) ?? state.mode;
  if (pick !== state.mode) {
    state.mode = pick;
    state.sinceTick = view.tick;
  }
  return state.mode;
}

/**
 * The cities this mode cares about, best first. Ownership decides which of the mode's
 * weights applies, so DEFEND ranks my own threatened cities highest and drops enemy
 * ones entirely, while SNIPE looks only at what the enemy has left uncovered.
 */
export function rankCityTargets(
  view: StrategicView,
  mode: MacroModeId,
  profile: BotProfile,
): number[] {
  const w = CITY_W[mode];
  const mine = view.myArmy.strength;
  const aggro = AGGRO_FLOOR + clamp(profile.aggression, 0, 1);
  const scored: { index: number; score: number }[] = [];
  for (const c of view.cities) {
    let own = 0;
    if (c.owner === view.me) own = w.mine;
    else if (c.owner === 0) own = w.neutral;
    else if (view.enemies.includes(c.owner)) own = w.enemy * aggro;
    if (own <= 0) continue;

    const threat = c.threat / (c.threat + mine + THREAT_FLOOR);
    const weak = c.owner === view.me ? 0 : 1 / (1 + c.enemyPressure / SNIPE_COVER);
    const cut = c.cutsEnemy && profile.usesEncirclement ? w.cut : 0;
    scored.push({
      index: c.index,
      score: own * c.value + w.threat * threat + cut + w.weak * weak,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.index);
}
