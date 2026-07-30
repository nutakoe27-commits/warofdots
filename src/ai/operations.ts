/**
 * Layer 2: operations — who goes where.
 *
 * Runs at 4 Hz and gives every living unit exactly one `Assignment`: a role, the front
 * or city it belongs to, and a destination. Tactics then spends the APM budget making
 * that happen, and everything the F3 overlay says about the bot's intent is read back
 * out of here.
 *
 * Five decisions shape the file.
 *
 * The attacking modes concentrate; the others do not. Splitting the frontline across every
 * front in proportion to its priority is the right answer for PRESSURE, and it is exactly
 * why PUSH used to achieve nothing: a bot with twice the cities and twice the income divided
 * its army three ways and broke none of the three lines. In PUSH and SNIPE one direction gets
 * the weight and the rest keep a screen.
 *
 * Everything is judged by *reach*. Territory is projected by cities and units, and a group
 * that walks far enough past its own ground belongs to no supply pocket at all, at which
 * point it takes `ENCIRCLED_DPS` — several times starvation (spec §4.6). So objectives are
 * discounted by distance from my nearest city, parties have a hard range, and a cut has to
 * be reachable before it is worth taking. Without that, two bots march past each other at
 * opposite ends of the map and dissolve in no-man's-land without ever making contact; it is
 * the single change that did most for how these bots play.
 *
 * Assignments are *reused*. One that comes out the same keeps its old `since` tick,
 * because tactics treats a fresh `since` as permission to re-order the unit; a plan that
 * churns every 250 ms produces an army twitching in place, which reads as stupid even
 * when the macro call behind it was right.
 *
 * "Ground that ruins heavies" is derived from `TERRAIN_DAMAGE` *relative to lights*
 * rather than from an absolute threshold. Snow and mud are bad for everybody, and an
 * absolute test would bench every heavy the bot builds on a snow map; forest and hills
 * are the terrain that specifically ruins heavies, and the ratio is what says so. Water
 * and mountain are vetoed separately — no ratio makes a lake acceptable.
 *
 * The reserve is not what is left over. It is sized at a share of the frontline and
 * parked past `PROXIMITY_R` of the fighting, because a reserve inside the enemy's
 * proximity radius does not heal (spec §4.4), and a bot with nothing healed to cycle in
 * has no micro left to spend its APM on.
 */

import { baseKindOf, Kind, Terrain } from '../core/types.ts';
import type { MapRuntime, RngState, World } from '../core/types.ts';
import { PROXIMITY_R, TERRAIN_DAMAGE, TILE_SIZE, isPassable } from '../core/balance.ts';
import { chance } from '../core/rng.ts';
import { cellCenterX, cellCenterY } from '../core/influence.ts';
import { terrainAt } from '../core/terrain.ts';
import { clamp, dist2 } from '../core/geometry.ts';
import { slotOfId } from '../core/units.ts';
import { GroupRole, MacroMode } from './types.ts';
import type { Assignment, BotProfile, CityView, Front } from './types.ts';
import type { GroupRoleId, MacroModeId, StrategicView } from './types.ts';
import { rankCityTargets } from './strategy.ts';

// ──────────────────────────────────────────────────────────────── weights ──
// Bot coefficients live beside the code that uses them (ADR-011).

/** Spec §5.2: «размер резерва ~30% от фронтовой группы», and how far behind it waits. */
const RESERVE = { share: 0.3, standoff: PROXIMITY_R * 2.2 };
/** Heavy damage as a fraction of light damage, under which the ground ruins heavies. */
const HEAVY_PARITY = 0.9;
/**
 * Garrisons, sized by «риск потери × ценность»: the ceiling one city can ask for, the
 * share of the army they may eat between them, the city value that counts as a full
 * prize, and the floor under a capital — which is never left completely empty.
 */
const GARRISON = { max: 5, armyCap: 0.35, valueRef: 2, capital: 1 };
/**
 * Detachments. A snipe is a handful of lights because it has to arrive before the
 * defence does; expansion sends the smallest party that can sit on a neutral city; an
 * encirclement gets a real share of the army, since taking a neck is worth nothing if it
 * cannot then be held. `freeParties` and `spare` are what a mode other than EXPAND will
 * detach for an unclaimed city, and the army it wants before detaching anything at all.
 */
const RAID = { snipe: 3, capture: 2, parties: 2, encircleShare: 0.35, encircleMin: 4,
  freeParties: 1, spare: 8 };
/**
 * Choosing who goes: priority floor so even a hopeless front keeps somebody in front of
 * it, the discount for staying where you are, the detour charged for sending the wrong
 * kind of unit, how far the wounded drift toward the back of the queue for the line, and
 * the target movement small enough that the old assignment still stands.
 */
const PICK = { frontMin: 0.05, sticky: 0.55, kind: 60, hp: 40, retarget: 8 };
/** The plausible mistake: reinforce the front that is already being lost. */
const OVERCOMMIT = 2.2;
/** Rings, step and directions searched when nudging a destination onto usable ground. */
const SAFE = { rings: 6, step: TILE_SIZE * 2, dirs: 8 };
/** Strength floor in a risk ratio, so an unwatched city does not divide by zero. */
const HOLD_FLOOR = 2;
/** Cities declared as objectives, for the overlay and the raid planner. */
const MAX_TARGETS = 3;
/**
 * The hard limit on how far a detached party will be sent. Two or three units project
 * almost no influence of their own, so past this distance the party arrives outside every
 * friendly pocket and melts at `ENCIRCLED_DPS` instead of taking anything. The softer
 * version of the same rule — objectives discounted by how far past my own ground they lie
 * — is `rankCityTargets`' business, one layer up.
 */
const RAID_REACH = 340;
/**
 * How far a cut is still worth taking. Perception will happily find an articulation cell
 * most of a map away, and spec §5.2 asks for the one that is «достижима и удержима» —
 * reachable *and* holdable. A third of the army walked to the far side of enemy territory
 * is neither: it arrives outside every friendly pocket and dies of encirclement itself,
 * which is how a profile with `usesEncirclement` ended up weaker than one without it.
 * Larger than `RAID_REACH` because a group this size projects influence of its own.
 */
const ENCIRCLE_REACH = 420;
/**
 * Concentration. Spec §5.1 asks PUSH to «концентрирует силы на одном направлении, ломает
 * фронт», and `weight` is how much heavier the chosen direction counts when the frontline is
 * split — enough that every other front is left with the one-unit floor `quotaOf` keeps.
 * Spreading proportionally is PRESSURE's job; doing it in PUSH is what made PUSH toothless,
 * because an army divided evenly across three fronts breaks none of them.
 *
 * `win` and `prize` choose the direction: the most winnable front with something takeable
 * behind it. `hold` is hysteresis — front ids are positions in a list perception re-sorts
 * every pass, so the axis is remembered as a point on the map instead.
 */
const FOCUS = { weight: 6, win: 0.6, prize: 1.2, prizeScale: 200, hold: 140, keep: 0.5 };

// ──────────────────────────────────────────────────────── module scratch ──

interface Candidate {
  id: number; slot: number; x: number; y: number; hp: number; heavy: boolean; taken: boolean;
}

/** Reused across plans: a plan allocates no per-unit objects at all. */
const pool: Candidate[] = [];
let poolLen = 0;
let poolTaken = 0;
/** Centre of mass of the army, the fallback direction for a reserve with no city behind it. */
let poolCx = 0;
let poolCy = 0;
let costs = new Float64Array(0);

export interface Spot {
  x: number; y: number;
}

const lightAt: Spot = { x: 0, y: 0 };
const heavyAt: Spot = { x: 0, y: 0 };
const standoff: Spot = { x: 0, y: 0 };

// ────────────────────────────────────────────────────────────────── state ──

export interface OperationsState {
  /** Keyed by unit id — a slot is only valid for the tick it was read on. */
  assignments: Map<number, Assignment>;
  targetCities: number[];
  encircleCell: number;
  reserveTarget: number;
  lastPlanTick: number;
  /** Where the last PUSH decided to break through, or -1. World units, not a front id. */
  focusX: number;
  focusY: number;
}

export function createOperations(): OperationsState {
  return { assignments: new Map(), targetCities: [], encircleCell: -1, reserveTarget: 0,
    lastPlanTick: -1, focusX: -1, focusY: -1 };
}

export function assignmentFor(state: OperationsState, unitId: number): Assignment | undefined {
  return state.assignments.get(unitId);
}

/** What the plan carries around while it works. */
interface Plan {
  world: World; view: StrategicView; mode: MacroModeId; profile: BotProfile;
  state: OperationsState;
  /** Front the mistake dice picked to over-commit to, or -1. */
  overcommit: number;
  /** Front PUSH is massing on, or -1 when the army spreads by priority. */
  focus: number;
}

/** One job: what role, where it belongs, and who is fit to do it. */
interface Want {
  role: GroupRoleId; front: number; city: number;
  /** +1 prefer heavies, -1 prefer lights, 0 take whoever is closest. */
  prefer: number;
  banHeavy: boolean;
}

function job(role: GroupRoleId, prefer = 0, banHeavy = false): Want {
  return { role, front: -1, city: -1, prefer, banHeavy };
}

// ───────────────────────────────────────────────────────────────── terrain ──

/** True when this ground costs a heavy most of its damage — forest and hills. */
export function heavyPenalised(terrain: number): boolean {
  const heavy = TERRAIN_DAMAGE[terrain]![Kind.Heavy]!;
  return !(heavy >= TERRAIN_DAMAGE[terrain]![Kind.Light]! * HEAVY_PARITY);
}

function spotOk(map: MapRuntime, x: number, y: number, heavy: boolean, aware: boolean): boolean {
  const t = terrainAt(map, x, y);
  if (!isPassable(t) || t === Terrain.Water) return false;
  return !(heavy && aware && heavyPenalised(t));
}

/**
 * Nudges a destination onto ground the unit can use, searching outward in rings. Shared
 * with tactics, which needs the same answer when it pulls a unit out of water or a heavy
 * out of a wood.
 */
export function safeSpot(
  map: MapRuntime,
  x: number,
  y: number,
  heavy: boolean,
  aware: boolean,
  out: Spot,
): boolean {
  out.x = clamp(x, 1, map.worldW - 1);
  out.y = clamp(y, 1, map.worldH - 1);
  if (spotOk(map, out.x, out.y, heavy, aware)) return true;

  for (let ring = 1; ring <= SAFE.rings; ring++) {
    for (let a = 0; a < SAFE.dirs; a++) {
      const angle = (a / SAFE.dirs) * Math.PI * 2;
      const cx = clamp(x + Math.cos(angle) * ring * SAFE.step, 1, map.worldW - 1);
      const cy = clamp(y + Math.sin(angle) * ring * SAFE.step, 1, map.worldH - 1);
      if (!spotOk(map, cx, cy, heavy, aware)) continue;
      out.x = cx; out.y = cy;
      return true;
    }
  }
  return false;
}

/** Nearest city I hold. Shared with tactics, which withdraws wounded units to one. */
export function nearestOwnCity(view: StrategicView, x: number, y: number): CityView | null {
  let best: CityView | null = null;
  let bestD = Infinity;
  for (const c of view.cities) {
    if (c.owner !== view.me) continue;
    const d = dist2(x, y, c.x, c.y);
    if (d < bestD) {
      bestD = d; best = c;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────── the pool ──

function buildPool(world: World, me: number): void {
  const u = world.units;
  poolLen = 0;
  poolTaken = 0;
  poolCx = 0;
  poolCy = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== me) continue;
    let c = pool[poolLen];
    if (c === undefined) {
      c = { id: 0, slot: 0, x: 0, y: 0, hp: 0, heavy: false, taken: false };
      pool.push(c);
    }
    c.id = u.id[i]!; c.slot = i; c.x = u.x[i]!; c.y = u.y[i]!; c.hp = u.hp[i]!;
    c.heavy = baseKindOf(u.kind[i]!) === 1; c.taken = false;
    poolCx += c.x; poolCy += c.y;
    poolLen++;
  }
  if (poolLen > 0) {
    poolCx /= poolLen; poolCy /= poolLen;
  }
  if (costs.length < poolLen) costs = new Float64Array(poolLen * 2);
}

function freeCount(): number {
  return poolLen - poolTaken;
}

/** Keeps the old assignment — and crucially its `since` — when nothing material changed. */
function assign(plan: Plan, c: Candidate, want: Want, tx: number, ty: number): void {
  const prev = plan.state.assignments.get(c.id);
  const near = prev !== undefined && dist2(prev.targetX, prev.targetY, tx, ty) <= PICK.retarget ** 2;
  if (prev !== undefined && near && prev.role === want.role && prev.front === want.front && prev.city === want.city) {
    return;
  }
  const a: Assignment =
    prev ??
    { unitId: c.id, role: want.role, front: -1, city: -1, targetX: tx, targetY: ty, since: 0 };
  a.role = want.role; a.front = want.front; a.city = want.city;
  a.targetX = tx; a.targetY = ty; a.since = plan.view.tick;
  if (prev === undefined) plan.state.assignments.set(c.id, a);
}

/**
 * Selects and assigns the cheapest `count` untaken units for this job, spotting the
 * destination once per kind so a heavy is never sent into a wood.
 */
function take(plan: Plan, want: Want, x: number, y: number, count: number): number {
  if (count <= 0) return 0;
  const chosen: number[] = [];
  for (let k = 0; k < poolLen; k++) {
    const c = pool[k]!;
    if (c.taken || (want.banHeavy && c.heavy)) continue;
    let cost = Math.sqrt(dist2(x, y, c.x, c.y));
    if (want.prefer !== 0 && want.prefer > 0 !== c.heavy) cost += PICK.kind;
    // The wounded sink down the queue for the line, and so into the reserve on their own.
    if (want.role === GroupRole.Frontline) cost += (1 - c.hp) * PICK.hp;
    const prev = plan.state.assignments.get(c.id);
    if (prev?.role === want.role && prev.front === want.front && prev.city === want.city) {
      cost *= PICK.sticky;
    }
    costs[k] = cost;
    chosen.push(k);
  }
  chosen.sort((a, b) => costs[a]! - costs[b]! || pool[a]!.id - pool[b]!.id);
  if (chosen.length > count) chosen.length = count;
  if (chosen.length === 0) return 0;

  const aware = plan.profile.usesTerrain;
  safeSpot(plan.world.map, x, y, false, aware, lightAt);
  safeSpot(plan.world.map, x, y, true, aware, heavyAt);
  for (const k of chosen) {
    const c = pool[k]!;
    c.taken = true;
    poolTaken++;
    assign(plan, c, want, c.heavy ? heavyAt.x : lightAt.x, c.heavy ? heavyAt.y : lightAt.y);
  }
  return chosen.length;
}

// ───────────────────────────────────────────────────────────── objectives ──

/** How far this city lies beyond my own nearest one. Zero for a city I already hold. */
function supportDist(view: StrategicView, c: CityView): number {
  const home = nearestOwnCity(view, c.x, c.y);
  return home === null ? 0 : Math.sqrt(dist2(c.x, c.y, home.x, home.y));
}

/**
 * The cities this mode is playing for, best first. The scoring is `rankCityTargets`', so
 * strategy and operations cannot drift apart on what the objective is — including the
 * victory arithmetic, which is what makes an enemy capital an objective once the bot is
 * ahead. Operations adds only the two things that are its own business: how many objectives
 * to declare at once, and not turning the army round when the top two swap places.
 */
function rankTargets(view: StrategicView, mode: MacroModeId, profile: BotProfile,
  prev: number[]): number[] {
  const list = rankCityTargets(view, mode, profile);
  if (list.length > MAX_TARGETS) list.length = MAX_TARGETS;
  // Hysteresis on the objective itself: while the city the army is already marching on is
  // still one of the best few, it stays the objective. Strategy re-scores twice a second,
  // and taking the new leader every time is how a bot turns its army round on the spot.
  const held = prev[0];
  const at = held === undefined ? -1 : list.indexOf(held);
  if (at > 0) { list.splice(at, 1); list.unshift(held!); }
  return list;
}

/**
 * Cut-off units come before everything else: `ENCIRCLED_DPS` is several times starvation,
 * so a pocket that cannot be reconnected has to be walked home before there is any point
 * planning anything else with it.
 */
function planBreakout(plan: Plan): void {
  const u = plan.world.units;
  const want = job(GroupRole.Garrison);
  for (let k = 0; k < poolLen; k++) {
    const c = pool[k]!;
    if (c.taken || !u.encircled[c.slot]) continue;
    const home = nearestOwnCity(plan.view, c.x, c.y);
    if (home === null) continue;
    c.taken = true;
    poolTaken++;
    want.city = home.index;
    assign(plan, c, want, home.x, home.y);
  }
}

/**
 * «риск потери × ценность» — and no risk means no garrison, capital included. A city with
 * nothing inside `THREAT_R` is held by the territory it projects, not by the dots standing
 * in it, and units parked in a quiet back city are the army the frozen bot never brought
 * to the front. An approach shows up as threat long before it arrives, and this runs at
 * 4 Hz, so the garrison forms again while the enemy is still walking.
 */
function garrisonNeed(c: CityView): number {
  if (c.threat <= 0) return 0;
  const risk = c.threat / (c.threat + c.myPressure + HOLD_FLOOR);
  const worth = clamp(c.value / GARRISON.valueRef, 0, 1);
  const floor = c.capital ? GARRISON.capital : 1;
  return Math.min(Math.max(Math.round(risk * worth * GARRISON.max), floor), GARRISON.max);
}

function planGarrisons(plan: Plan): void {
  const wanted: { c: CityView; need: number }[] = [];
  for (const c of plan.view.cities) {
    if (c.owner !== plan.view.me) continue;
    const need = garrisonNeed(c);
    if (need > 0) wanted.push({ c, need });
  }
  wanted.sort((a, b) => b.need - a.need || a.c.index - b.c.index);

  // City ground is plains, so a heavy standing in one is worth more than a light.
  const want = job(GroupRole.Garrison, 1);
  let budget = Math.floor(poolLen * GARRISON.armyCap);
  for (const entry of wanted) {
    if (budget <= 0) return;
    want.city = entry.c.index;
    budget -= take(plan, want, entry.c.x, entry.c.y, Math.min(entry.need, budget));
  }
}

/** The planned cut: take the neck with whoever is nearest, in enough strength to hold it. */
function planEncircle(plan: Plan): void {
  const cell = plan.view.cutCell;
  plan.state.encircleCell = -1;
  if (plan.mode !== MacroMode.Encircle || cell < 0 || !plan.profile.usesEncirclement) return;

  const x = cellCenterX(plan.world, cell);
  const y = cellCenterY(plan.world, cell);
  const home = nearestOwnCity(plan.view, x, y);
  if (home === null || dist2(x, y, home.x, home.y) > ENCIRCLE_REACH * ENCIRCLE_REACH) return;
  const count = Math.max(RAID.encircleMin, Math.round(poolLen * RAID.encircleShare));
  const banHeavy = plan.profile.usesTerrain && heavyPenalised(terrainAt(plan.world.map, x, y));
  // Escort rather than Raid: this group holds ground on a schedule the rest of the army
  // depends on, and must not be re-tasked to the nearest fight like a raiding party.
  if (take(plan, job(GroupRole.Escort, 0, banHeavy), x, y, count) > 0) {
    plan.state.encircleCell = cell;
  }
}

/**
 * SNIPE takes a weakly held city with lights; EXPAND walks parties onto the neutrals — and
 * every other mode still detaches one party for a free city it can reach.
 *
 * That last clause is `majorityShare` arithmetic. An unclaimed city is income, supply and a
 * step toward the victory line for the price of walking onto it, and 40-minute runs found
 * two of them sitting neutral while a bot six cities up spent the whole match pushing at a
 * capital it could not have converted anyway. DEFEND is excluded and a small army is
 * excluded: two bodies out of eight is a hole in the line, not a detachment.
 */
function planRaids(plan: Plan): void {
  const snipe = plan.mode === MacroMode.Snipe;
  const grab = plan.mode !== MacroMode.Defend && poolLen >= RAID.spare;
  const maxParties =
    snipe ? 1 : plan.mode === MacroMode.Expand ? RAID.parties : grab ? RAID.freeParties : 0;
  if (maxParties === 0) return;

  const want = job(GroupRole.Raid, -1, snipe);
  let parties = 0;
  for (const index of plan.state.targetCities) {
    if (parties >= maxParties) break;
    const c = plan.view.cities[index]!;
    const eligible = snipe ? c.owner !== plan.view.me && c.owner !== 0 : c.owner === 0;
    // A party sent past `RAID_REACH` is a party that dies of encirclement on the way.
    if (!eligible || supportDist(plan.view, c) > RAID_REACH) continue;
    want.city = index;
    if (take(plan, want, c.x, c.y, snipe ? RAID.snipe : RAID.capture) > 0) parties++;
  }
}

// ───────────────────────────────────────────────────────────────── fronts ──

/**
 * Where a front's reserve waits: `RESERVE.standoff` behind the contact, on the side the
 * nearest friendly city is on, so the walk back into the line is the short one.
 */
function reservePoint(plan: Plan, front: Front, out: Spot): void {
  const home = nearestOwnCity(plan.view, front.x, front.y);
  let dx = (home === null ? poolCx : home.x) - front.x;
  let dy = (home === null ? poolCy : home.y) - front.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-3) {
    dx = 0; dy = -1; len = 1;
  }
  out.x = front.x + (dx / len) * RESERVE.standoff;
  out.y = front.y + (dy / len) * RESERVE.standoff;
}

/** Distance to the nearest declared objective I do not already hold, or Infinity. */
function prizeDist(plan: Plan, front: Front): number {
  let best = Infinity;
  for (const index of plan.state.targetCities) {
    const c = plan.view.cities[index]!;
    if (c.owner === plan.view.me) continue;
    best = Math.min(best, dist2(front.x, front.y, c.x, c.y));
  }
  // `Math.sqrt(Infinity)` is Infinity, which the caller's falloff reads as "no prize here".
  return Math.sqrt(best);
}

/**
 * The one direction an attack commits to: the front it is already winning, with a city it
 * can actually take behind it. A front with no takeable city behind it can still be chosen,
 * because a breakthrough has to happen somewhere.
 *
 * PUSH and SNIPE both concentrate. DEFEND has to answer every threat and PRESSURE is
 * *supposed* to spread, but SNIPE is an attack with a raiding party attached — the three
 * lights are `planRaids`' business, and what the rest of the army does is the same problem
 * PUSH has. Runs show the two modes alternating under hysteresis while the board stays won,
 * and concentration that switched itself off every other decision would be no fix at all.
 */
function pickFocus(plan: Plan): number {
  // The axis is left in state on purpose when the mode moves off an attack: a bot that comes
  // back to PUSH after an interlude of DEFEND should come back to the same direction.
  if (plan.mode !== MacroMode.Push && plan.mode !== MacroMode.Snipe) return -1;
  const st = plan.state;
  let best = -1, bestScore = -Infinity;
  for (const f of plan.view.fronts) {
    const held = st.focusX >= 0 && dist2(f.x, f.y, st.focusX, st.focusY) <= FOCUS.hold ** 2;
    const score =
      f.priority +
      FOCUS.win * clamp((f.ratio - 0.5) * 2, 0, 1) +
      FOCUS.prize / (1 + prizeDist(plan, f) / FOCUS.prizeScale) +
      (held ? FOCUS.keep : 0);
    if (score > bestScore) { bestScore = score; best = f.id; }
  }
  const f = plan.view.fronts[best];
  st.focusX = f === undefined ? -1 : f.x;
  st.focusY = f === undefined ? -1 : f.y;
  return best;
}

function frontWeight(plan: Plan, front: Front): number {
  const base = Math.max(PICK.frontMin, front.priority);
  const massed = front.id === plan.focus ? base * FOCUS.weight : base;
  return front.id === plan.overcommit ? massed * OVERCOMMIT : massed;
}

/** Splits `total` units across the fronts by priority; the last front takes the remainder. */
function quotaOf(plan: Plan, index: number, total: number, sum: number, left: number): number {
  const fronts = plan.view.fronts;
  if (index === fronts.length - 1) return left;
  const share = Math.round((total * frontWeight(plan, fronts[index]!)) / sum);
  return Math.min(left, Math.max(1, share));
}

/**
 * Whatever the fronts did not take waits behind one of them, split by the same
 * priorities — a reserve parked behind the quiet front is not a reserve.
 */
function assignReserve(plan: Plan, sum: number): void {
  const fronts = plan.view.fronts;
  const total = freeCount();
  const want = job(GroupRole.Reserve);
  let left = total;
  for (let i = 0; i < fronts.length && left > 0; i++) {
    want.front = fronts[i]!.id;
    reservePoint(plan, fronts[i]!, standoff);
    // Drawn from whoever is closest to the waiting position, so nobody crosses the map to
    // stand behind a front they were never near.
    left -= take(plan, want, standoff.x, standoff.y, quotaOf(plan, i, total, sum, left));
  }
}

function planFronts(plan: Plan, available: number): void {
  const fronts = plan.view.fronts;
  const frontline = Math.round(available / (1 + RESERVE.share));
  plan.state.reserveTarget = Math.max(0, available - frontline);

  let sum = 0;
  for (const f of fronts) sum += frontWeight(plan, f);
  let left = frontline;
  for (let i = 0; i < fronts.length && left > 0; i++) {
    const f = fronts[i]!;
    const banHeavy = plan.profile.usesTerrain && heavyPenalised(f.terrain);
    const want = job(GroupRole.Frontline, banHeavy ? -1 : f.heavyFriendly ? 1 : 0, banHeavy);
    want.front = f.id;
    want.city = f.nearestCity;
    left -= take(plan, want, f.x, f.y, quotaOf(plan, i, frontline, sum, left));
  }
  assignReserve(plan, sum);
}

/**
 * Nothing is in contact: march the free army at the declared objective — but never at one
 * of my own quiet cities. DEFEND ranks those first by design, and a capital whose
 * territory cell is merely contested is enough to put the mode there; an army standing in
 * its own back yard while three neutral cities go unclaimed is the worst reading of that.
 */
function advanceOnObjective(plan: Plan): void {
  plan.state.reserveTarget = 0;
  const worth = (i: number): boolean => {
    const c = plan.view.cities[i]!;
    return c.owner !== plan.view.me || c.threat > 0;
  };
  const index = plan.state.targetCities.find(worth) ?? plan.state.targetCities[0];
  if (index === undefined) return;
  const city = plan.view.cities[index]!;
  const want = job(GroupRole.Frontline);
  want.city = index;
  take(plan, want, city.x, city.y, poolLen);
}

// ─────────────────────────────────────────────────────────────────── plan ──

export function planOperations(
  world: World,
  view: StrategicView,
  mode: MacroModeId,
  profile: BotProfile,
  state: OperationsState,
  rng: RngState,
): void {
  for (const id of state.assignments.keys()) {
    if (slotOfId(world.units, id) < 0) state.assignments.delete(id);
  }
  buildPool(world, view.me);
  state.lastPlanTick = world.tick;
  state.targetCities = rankTargets(view, mode, profile, state.targetCities);
  if (poolLen === 0) {
    state.reserveTarget = 0;
    state.encircleCell = -1;
    return;
  }

  // Drawn every plan, used or not, so the stream cannot depend on the state of the board.
  const misjudge = chance(rng, profile.mistakeRate);
  let overcommit = -1;
  if (misjudge && view.fronts.length > 1) {
    let worst = view.fronts[0]!;
    for (const f of view.fronts) if (f.ratio < worst.ratio) worst = f;
    overcommit = worst.id;
  }

  const plan: Plan = { world, view, mode, profile, state, overcommit, focus: -1 };
  plan.focus = pickFocus(plan);
  planBreakout(plan);
  planGarrisons(plan);
  planEncircle(plan);
  planRaids(plan);
  if (view.fronts.length === 0) advanceOnObjective(plan);
  else planFronts(plan, freeCount());
}
