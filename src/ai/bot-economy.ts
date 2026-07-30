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
 * The city switch exists for one reason. Money is pooled per pocket (ADR-004), so a
 * city that is about to fall keeps spending its pocket's treasury on units that spawn
 * one at a time into a fight that is already lost. Switching it off moves that money
 * to the cities behind the line, and the city keeps earning and supplying either way.
 */

import type { Command, RngState, World } from '../core/types.ts';
import { chance } from '../core/rng.ts';
import { clamp } from '../core/geometry.ts';
import type { BotProfile, CityView, StrategicView } from './types.ts';

// ──────────────────────────────────────────────────────────────── weights ──
// Bot coefficients live beside the code that uses them (ADR-011).

/** Supply headroom, as a share of the cap, at which production runs wide open. */
const HEADROOM_REF = 0.25;
/**
 * Average HP at which an over-supplied army stops being worth reinforcing.
 *
 * This is the number that decides how the supply cap is read, and it took bot-vs-bot runs
 * to get right. Stopping production dead at the cap looks tidy and loses: under the
 * one-target rule an extra body in contact is worth more than the HP the overflow costs
 * the rest (spec §4.3), `STARVE_DPS` is slow, and ECO left in a treasury buys nothing at
 * all. So the throttle watches the army's *condition* instead of its head count — over the
 * cap and still healthy, keep building; over the cap and visibly melting, stop.
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
/**
 * A heavy and a light each eat one supply slot but the heavy carries far more of the
 * fight, so an army pressed against its cap should be getting heavier.
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

function mix(sloppy: number, ideal: number, efficiency: number): number {
  return sloppy + (ideal - sloppy) * efficiency;
}

/**
 * Spec §5.2 layer 4: hold the slider high while supply allows, lower it past the limit.
 * Past the cap the slider tracks how well the army is bearing the overflow, for the reason
 * given at `STARVED_HP`.
 */
function idealThreshold(view: StrategicView): number {
  const army = view.myArmy;
  if (army.supplyCap <= 0) return 0;
  if (army.supplyUsed <= army.supplyCap) return 1;
  const condition = clamp((army.avgHp - STARVED_HP) / (1 - STARVED_HP), 0, 1);
  return THRESHOLD_MIN + (1 - THRESHOLD_MIN) * condition;
}

/**
 * Terrain sets the scale, the enemy's mix and supply pressure modulate it — and they do so
 * *multiplicatively*, which matters. Added on, a tight-supply nudge and a counter-pick
 * would together triple the 0.1 a forest map asks for, and heavies in a forest deal a third
 * of their damage (spec §4.1). The map author's hint has to survive both adjustments.
 */
function idealHeavyShare(world: World, view: StrategicView): number {
  const hint = world.map.def.heavyHint;
  const terrain = hint ?? HEAVY_OPEN_MAX * (1 - clamp(view.roughShare, 0, 1));

  const seen = view.enemyArmy.estLight + view.enemyArmy.estHeavy;
  const enemyHeavy = seen > 0 ? view.enemyArmy.estHeavy / seen : COUNTER_MID;
  const counter = (COUNTER_MID - enemyHeavy) * COUNTER_W;

  const cap = view.myArmy.supplyCap;
  const tight =
    cap > 0 ? 1 - clamp(view.myArmy.supplyHeadroom / (cap * HEADROOM_REF), 0, 1) : 0;

  return clamp(terrain * (1 + counter + tight * SUPPLY_HEAVY_W), 0, HEAVY_HARD_CAP);
}

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
  const threshold = clamp(mix(SLOPPY_THRESHOLD, idealThreshold(view), efficiency), 0, 1);
  const heavyShare = clamp(mix(SLOPPY_HEAVY, idealHeavyShare(world, view), efficiency), 0, 1);

  if (
    Math.abs(threshold - player.threshold) > EMIT_EPS ||
    Math.abs(heavyShare - player.heavyShare) > EMIT_EPS
  ) {
    out.push({ t: 'production', player: view.me, threshold, heavyShare });
  }

  if (efficiency >= CITY_SKILL) planCities(world, view, out);
}
