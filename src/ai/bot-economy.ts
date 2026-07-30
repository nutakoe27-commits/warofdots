/**
 * Layer 4: the bot's economic policy — two sliders and a switch per city.
 *
 * The sliders are cheap to think about and expensive to touch: every command costs
 * an action out of the same APM budget the micro is fighting over, so this layer
 * emits at most one `production` command per call and only when the value it wants
 * has actually moved. `ecoEfficiency` is spent on *how far* the sliders land from
 * the ideal and on how often the bot bothers to look at them at all, which is the
 * honest version of a weak economy: a Новобранец is not handed a worse income, he
 * simply leaves the accumulation slider where it was for a few seconds too long.
 *
 * The one thing this layer refuses to do is bank money. The supply cap is a price, not a
 * wall (see `targetArmy`): the accumulation slider stays at the top until the army reaches
 * a deliberate overshoot of the cap, and comes down only on the signals that say the
 * overshoot has stopped paying — starvation outrunning production, or a pocket whose income
 * no longer covers its upkeep. Bot-vs-bot runs are unambiguous about this: the side that
 * read the cap as a ceiling fielded a *smaller* army than the side that ignored it, with
 * twice the cities and twice the income, and could not break through.
 *
 * The city switch exists for one reason. Money is pooled per pocket (ADR-004), so a
 * city that is about to fall keeps spending its pocket's treasury on units that spawn
 * one at a time into a fight that is already lost. Switching it off moves that money
 * to the cities behind the line, and the city keeps earning and supplying either way.
 */

import type { Command, Pocket, RngState, World } from '../core/types.ts';
import { Kind } from '../core/types.ts';
import { B, UNIT_COST, productionThreshold } from '../core/balance.ts';
import { chance } from '../core/rng.ts';
import { clamp, lerp } from '../core/geometry.ts';
import type { BotProfile, CityView, StrategicView } from './types.ts';

// ──────────────────────────────────────────────────────────────── weights ──
// Bot coefficients live beside the code that uses them (ADR-011).

/** The two ends of the accumulation slider: spend as soon as paid for, and hold. */
const SLIDER_WIDE = 1;
const SLIDER_HOLD = 0;
/** Hard ceiling on army size over supply cap, whatever the balance dials work out to. */
const OVERSHOOT_HARD = 2.2;
/**
 * Share of surplus income the bot will commit to feeding bodies it is over cap with.
 *
 * The rest has to keep buying them: a target that spends the whole surplus on upkeep
 * leaves the pocket at an `ecoRate` of zero with nothing to replace losses from.
 */
const UPKEEP_SHARE = 0.6;
/** Enemy share of total strength at which the bot wants every body it can feed. */
const PARITY_SHARE = 0.45;
/** Demand floor: even a bot that is winning keeps a cushion of bodies over the cap. */
const DEMAND_MIN = 0.5;
/** Guard so two armies of zero strength do not divide by zero. */
const STRENGTH_EPS = 1e-3;
/** How far past the target the army goes before the slider is all the way down. */
const OVER_BAND = 0.2;
/** Slider margin so a brake lands below the spawn gate instead of exactly on it. */
const BRAKE_MARGIN = 0.03;
/**
 * Average HP at which an over-cap army has no HP left to trade for numbers.
 *
 * The overshoot is paid for out of the army's HP pool (see `targetArmy`), and an army
 * already this thin is paying out of an empty one — bot-vs-bot runs found it worth naming
 * separately from the flow test in `overshootHurts`, which only sees rates.
 */
const STARVED_HP = 0.55;
/**
 * Floor the accumulation slider is throttled down to, and where an inattentive bot leaves
 * it. The floor sits *above* the sloppy value on purpose, and this is the invariant to keep
 * when tuning: `ecoEfficiency` blends from sloppy toward ideal, so an "ideal" that is ever
 * worse than sloppy would make the better profile build the smaller army and quietly invert
 * the whole difficulty ladder. Bot-vs-bot runs found exactly that.
 */
const THRESHOLD_MIN = 0.6;
const SLOPPY_THRESHOLD = 0.5;
const SLOPPY_HEAVY = 0.4;
/** Chance an inattentive bot skips the slider pass entirely, at zero efficiency. */
const LAZY_CHANCE = 0.5;
/** Slider move too small to be worth an action. */
const EMIT_EPS = 0.04;

/** Heavy share on completely open ground. Rough ground scales it down from here. */
const HEAVY_OPEN_MAX = 0.55;
/** Never build an all-heavy army: rough ground and raids both want legs. */
const HEAVY_HARD_CAP = 0.85;
/** Countering the enemy mix: how far from a 50/50 read the answer swings. */
const COUNTER_MID = 0.5;
const COUNTER_W = 0.3;
/** Last stretch toward the target army, as a share of it, that counts as "no room left". */
const TIGHT_BAND = 0.25;
/**
 * A heavy and a light each eat one supply slot but the heavy carries far more of the
 * fight, so an army that has run out of room for bodies should buy better ones instead.
 */
const SUPPLY_HEAVY_W = 0.2;

/** Strength floor in a risk ratio, so an unwatched city does not divide by zero. */
const HOLD_FLOOR = 2;
/** A garrison unit counts for this much strength when judging whether a city holds. */
const GARRISON_W = 1.5;
/** Risk of loss at which a city stops producing, and the lower bar for switching back. */
const DEACTIVATE_RISK = 0.72;
const REACTIVATE_RISK = 0.45;
/** City switches per call. Two is enough to hand a front over one city at a time. */
const MAX_CITY_TOGGLES = 2;
/** Managing individual cities is a skill; the weakest profiles never do it. */
const CITY_SKILL = 0.6;

/** Blend from where a sloppy bot leaves a slider toward the ideal, by `ecoEfficiency`. */
function mix(sloppy: number, ideal: number, efficiency: number): number {
  return lerp(sloppy, ideal, efficiency);
}

// ─────────────────────────────────────────────────────────────── the books ──

/** What the sliders are really spending: one pocket's treasury and its net income. */
interface Books {
  eco: number;
  rate: number;
}

function outranks(a: Pocket, b: Pocket | null): boolean {
  if (b === null) return true;
  if (a.cities.length !== b.cities.length) return a.cities.length > b.cities.length;
  return a.eco > b.eco;
}

/**
 * The pocket the sliders are really about: mine holding the most cities.
 *
 * Money is pooled per pocket (ADR-004) and `stepProduction` gates every spawn on *that*
 * pocket's treasury, while the sliders are per player — so the honest reading is the pocket
 * holding the bulk of the country, not the player-wide sum. Summing would let one cut-off
 * pocket, permanently bankrupt because it has more units than income, hold the whole
 * economy's slider down; its own empty treasury already stops it spawning anything.
 */
function mainBooks(world: World, view: StrategicView): Books {
  let best: Pocket | null = null;
  for (const pocket of world.influence.pockets) {
    if (pocket.player !== view.me || pocket.cities.length === 0) continue;
    if (outranks(pocket, best)) best = pocket;
  }
  if (best === null) return { eco: view.eco, rate: view.ecoRate };
  return { eco: best.eco, rate: best.ecoRate };
}

// ─────────────────────────────────────────────────────────── target army ──

/**
 * Army size, as a multiple of the supply cap, at which starvation exactly cancels
 * out-of-combat regeneration.
 *
 * `applyStarvation` bills `STARVE_DPS` to the `used - cap` healthiest units, and the
 * healthiest set rotates as they melt, so the drain shared across the army is
 * `(overflow / used) * STARVE_DPS` while every unit out of contact heals `HP_REGEN`. Set
 * those equal and the overflow share regeneration pays for is `HP_REGEN / STARVE_DPS` — a
 * third at the shipped numbers, i.e. an army half again its cap holds its HP indefinitely.
 * Derived rather than tuned, so a designer dragging either dial in the debug panel moves
 * the bot's policy with it.
 */
function sustainableMult(): number {
  const share = B.HP_REGEN / B.STARVE_DPS;
  // Written as `!(share < 1)` so a zeroed `STARVE_DPS` (Infinity, or NaN) lands here too.
  if (!(share < 1)) return OVERSHOOT_HARD;
  return Math.min(1 / (1 - share), OVERSHOOT_HARD);
}

/**
 * How badly the board wants bodies, 0..1.
 *
 * `planEconomy` is not handed the macro mode — `bot.ts` runs it on its own cadence — so the
 * demand signal is read off the same view the mode was chosen from. Being outnumbered is
 * exactly when numbers are worth paying starvation HP for, and a capital under threat is
 * worth every body that can be paid for, whatever the HP costs.
 */
function bodyDemand(view: StrategicView): number {
  if (view.capitalThreatened) return 1;
  const mine = view.myArmy.strength;
  const foe = view.enemyArmy.estStrength;
  const share = foe / (mine + foe + STRENGTH_EPS);
  return clamp(share / PARITY_SHARE, DEMAND_MIN, 1);
}

/**
 * The army the bot is trying to field, in units — deliberately above the supply cap.
 *
 * The trade is HP for numbers and it is worth taking: under the one-target rule an extra
 * body in contact fights at full effect (spec §4.3), while the overflow's `STARVE_DPS` is
 * 0.03 HP/sec spread across the army and largely paid back by regeneration, and ECO left in
 * a treasury buys nothing at all. Two bounds keep it from being reckless — the HP the army
 * can bleed and still hold its condition (`sustainableMult`), and the upkeep the surplus
 * income can carry, because an army that drives `pocket.ecoRate` below zero empties the
 * treasury and then starves *every* unit it owns rather than just the overflow.
 */
function targetArmy(view: StrategicView, rate: number): number {
  const cap = view.myArmy.supplyCap;
  if (cap <= 0) return 0;
  const starveRoom = cap * (sustainableMult() - 1);
  const upkeepRoom = B.UPKEEP > 0 ? (Math.max(0, rate) * UPKEEP_SHARE) / B.UPKEEP : starveRoom;
  return cap + Math.min(starveRoom, upkeepRoom) * bodyDemand(view);
}

// ──────────────────────────────────────────────────── the slider itself ──

/** ECO `spendFromPocket` will actually take for the next unit, at the current mix. */
function unitPrice(heavyShare: number): number {
  return lerp(UNIT_COST[Kind.Light]!, UNIT_COST[Kind.Heavy]!, clamp(heavyShare, 0, 1));
}

/**
 * Highest slider position at which the pocket's treasury does *not* clear the spawn gate.
 *
 * This is the number that makes "lower the slider" mean anything. A city spends once its
 * pocket holds `productionThreshold(kind, slider)`, which is linear in the slider, so two
 * evaluations at the ends invert it exactly and `balance.ts` stays the only owner of the
 * formula. It also shows why braking is not gradual: a pocket sitting on three units' worth
 * of ECO clears the gate at nearly every slider position, so a rich pocket needs the slider
 * pushed far down before anything changes — and a thin one needs barely a nudge.
 */
function brakeSlider(eco: number, heavyShare: number): number {
  const hs = clamp(heavyShare, 0, 1);
  const wide = lerp(
    productionThreshold(Kind.Light, SLIDER_WIDE),
    productionThreshold(Kind.Heavy, SLIDER_WIDE),
    hs,
  );
  const held = lerp(
    productionThreshold(Kind.Light, SLIDER_HOLD),
    productionThreshold(Kind.Heavy, SLIDER_HOLD),
    hs,
  );
  if (held <= wide) return THRESHOLD_MIN;
  const stops = (held - eco) / (held - wide) - BRAKE_MARGIN;
  // The floor is the difficulty invariant at `THRESHOLD_MIN`, not a judgement about this
  // treasury: below it the bot would be managing its economy worse than a sloppy one.
  return clamp(stops, THRESHOLD_MIN, SLIDER_WIDE);
}

/**
 * True when the overshoot has stopped paying for itself — the real feedback signal, in
 * place of the head count against the cap.
 *
 * Starvation is flat on normalised HP (`applyAttrition` does not divide by `MAX_HP`), so one
 * HP drained out of the army is exactly one unit's life, and the bleed compares directly
 * against the units the surplus income can buy back. Crediting the whole army with
 * regeneration is generous — a unit in contact heals nothing — which makes the flow test a
 * backstop rather than the primary bound: it fires when the cap collapses under the army,
 * which in practice means a city has just been lost. A negative rate is checked on its own
 * because a bankrupt pocket starves every unit it owns, and no rate of production outruns
 * that.
 */
function overshootHurts(view: StrategicView, rate: number, price: number): boolean {
  if (rate < 0) return true;
  const army = view.myArmy;
  const overflow = Math.max(0, army.supplyUsed - army.supplyCap);
  if (overflow > 0 && army.avgHp < STARVED_HP) return true;
  const bleed = overflow * B.STARVE_DPS - army.supplyUsed * B.HP_REGEN;
  const rebuild = price > 0 ? rate / price : 0;
  return bleed > rebuild;
}

/**
 * Spec §5.2 layer 4, read against `targetArmy` instead of against the cap.
 *
 * Below the target the slider goes to the top and stays there: at a wide-open slider the
 * gate is the unit's own price, so every ECO held above that price is a body not in the
 * line, and nothing else in this game spends money. Past the target it walks down to where
 * the treasury stops clearing the gate, and the feedback signals send it there at once.
 */
function idealThreshold(
  view: StrategicView,
  books: Books,
  target: number,
  heavyShare: number,
): number {
  const army = view.myArmy;
  // No city inside a pocket: there is nothing to produce from at any slider position.
  if (army.supplyCap <= 0) return SLIDER_HOLD;

  const brake = brakeSlider(books.eco, heavyShare);
  if (overshootHurts(view, books.rate, unitPrice(heavyShare))) return brake;
  if (target <= 0 || army.supplyUsed < target) return SLIDER_WIDE;

  const over = clamp((army.supplyUsed / target - 1) / OVER_BAND, 0, 1);
  return lerp(SLIDER_WIDE, brake, over);
}

// ─────────────────────────────────────────────────────────── heavy share ──

/**
 * How little room is left for more bodies, 0..1, measured against the target army and not
 * against the cap: the cap is deliberately exceeded now, so `supplyHeadroom` is negative
 * most of the match and this term would be a flat bias instead of a signal.
 */
function tightness(view: StrategicView, target: number): number {
  if (target <= 0) return 0;
  const fill = view.myArmy.supplyUsed / target;
  return clamp((fill - (1 - TIGHT_BAND)) / TIGHT_BAND, 0, 1);
}

/**
 * Terrain sets the scale, the enemy's mix and supply pressure modulate it — and they do so
 * *multiplicatively*, which matters. Added on, a tight-supply nudge and a counter-pick
 * would together triple the 0.1 a forest map asks for, and heavies in a forest deal a third
 * of their damage (spec §4.1). The map author's hint has to survive both adjustments.
 */
function idealHeavyShare(world: World, view: StrategicView, target: number): number {
  const hint = world.map.def.heavyHint;
  const terrain = hint ?? HEAVY_OPEN_MAX * (1 - clamp(view.roughShare, 0, 1));

  const seen = view.enemyArmy.estLight + view.enemyArmy.estHeavy;
  const enemyHeavy = seen > 0 ? view.enemyArmy.estHeavy / seen : COUNTER_MID;
  const counter = (COUNTER_MID - enemyHeavy) * COUNTER_W;

  const tight = tightness(view, target);
  return clamp(terrain * (1 + counter + tight * SUPPLY_HEAVY_W), 0, HEAVY_HARD_CAP);
}

// ─────────────────────────────────────────────────────────────── cities ──

/** How close a city is to being lost, from what the bot can see standing on it. */
function riskOf(city: CityView): number {
  const hold = city.myPressure + city.garrison * GARRISON_W + HOLD_FLOOR;
  return city.threat / (city.threat + hold);
}

function planCities(world: World, view: StrategicView, out: Command[]): void {
  let toggles = 0;
  for (const seen of view.cities) {
    if (seen.owner !== view.me) continue;
    const city = world.cities[seen.index]!;
    const risk = riskOf(seen);

    let active = city.active;
    if (city.active && risk > DEACTIVATE_RISK) active = false;
    else if (!city.active && risk < REACTIVATE_RISK) active = true;
    if (active === city.active) continue;

    out.push({ t: 'cityActive', player: view.me, city: seen.index, active });
    if (++toggles >= MAX_CITY_TOGGLES) return;
  }
}

export function planEconomy(
  world: World,
  view: StrategicView,
  profile: BotProfile,
  rng: RngState,
  out: Command[],
): void {
  const efficiency = clamp(profile.ecoEfficiency, 0, 1);
  // The whole of the profile's sloppiness is here: sometimes it does not look at the
  // panel at all, and when it does it only moves the sliders part of the way toward
  // what the board is asking for. Deliberately no per-call jitter — noise on the
  // slider would emit a command every second and spend APM the micro needs.
  if (chance(rng, (1 - efficiency) * LAZY_CHANCE)) return;

  const player = world.players[view.me]!;
  const books = mainBooks(world, view);
  const target = targetArmy(view, books.rate);
  // Heavy share first: it is the probability the next unit comes out heavy, so it sets the
  // price the accumulation slider is being asked to save up for.
  const heavyShare = clamp(
    mix(SLOPPY_HEAVY, idealHeavyShare(world, view, target), efficiency),
    0,
    1,
  );
  const ideal = idealThreshold(view, books, target, heavyShare);
  const threshold = clamp(mix(SLOPPY_THRESHOLD, ideal, efficiency), 0, 1);

  if (
    Math.abs(threshold - player.threshold) > EMIT_EPS ||
    Math.abs(heavyShare - player.heavyShare) > EMIT_EPS
  ) {
    out.push({ t: 'production', player: view.me, threshold, heavyShare });
  }

  if (efficiency >= CITY_SKILL) planCities(world, view, out);
}
