/**
 * Layer 2: operations — who goes where.
 *
 * Runs at 4 Hz and gives every living unit exactly one `Assignment`: a role, the front
 * or city it belongs to, and a destination. Tactics then spends the APM budget making
 * that happen, and everything the F3 overlay says about the bot's intent is read back
 * out of here.
 *
 * Three decisions shape the file.
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
 * cannot then be held.
 */
const RAID = { snipe: 3, capture: 2, parties: 2, encircleShare: 0.35, encircleMin: 4 };
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
 * Distance beyond my own nearest city at which an objective is worth half as much, and the
 * hard limit on how far a detached party will be sent.
 *
 * This is the number bot-vs-bot runs shouted about. Territory is projected by cities and
 * by units, and a group that walks far enough past its own ground stops being connected to
 * any pocket at all — at which point it takes `ENCIRCLED_DPS`, which is several times
 * starvation (spec §4.6). Two bots that both marched at the far side of the map spent the
 * match melting in no-man's-land without ever meeting. Expansion has to be contiguous, and
 * once the near cities are taken what is left nearby is the enemy — which is also how the
 * bots end up in contact at all.
 */
const REACH_SCALE = 260;
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
 * How each macro mode reads the city list; ownership picks the row. A zero weight drops
 * that class of city entirely, so DEFEND never declares an enemy capital an objective and
 * SNIPE never bothers with my own back line. `urgency` is signed: on my cities it is
 * pressure to defend, on theirs it is how well covered they are, which is why the raiding
 * modes weight it negative.
 */
interface TargetWeights {
  own: number; neutral: number; enemy: number; urgency: number;
}

const TARGET_W: Record<MacroModeId, TargetWeights> = {
  [MacroMode.Expand]: { own: 0.2, neutral: 1.4, enemy: 0.4, urgency: -0.4 },
  [MacroMode.Defend]: { own: 1.5, neutral: 0.2, enemy: 0, urgency: 1 },
  [MacroMode.Pressure]: { own: 0.6, neutral: 1, enemy: 0.9, urgency: 0.2 },
  [MacroMode.Push]: { own: 0.2, neutral: 0.6, enemy: 1.5, urgency: -0.2 },
  [MacroMode.Encircle]: { own: 0.3, neutral: 0.7, enemy: 1.2, urgency: 0 },
  [MacroMode.Snipe]: { own: 0, neutral: 0.8, enemy: 1.2, urgency: -0.6 },
};

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
}

export function createOperations(): OperationsState {
  return { assignments: new Map(), targetCities: [], encircleCell: -1, reserveTarget: 0, lastPlanTick: -1 };
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

function urgencyOf(view: StrategicView, c: CityView): number {
  return c.owner === view.me
    ? c.threat / (c.threat + c.myPressure + HOLD_FLOOR)
    : c.enemyPressure / (c.enemyPressure + HOLD_FLOOR);
}

/**
 * The cities this mode is playing for, best first. Deliberately a smaller reading than
 * the strategic one: operations only needs somewhere to march.
 */
function rankTargets(view: StrategicView, mode: MacroModeId, prev: number[]): number[] {
  const w = TARGET_W[mode];
  const scored: { index: number; score: number }[] = [];
  for (const c of view.cities) {
    let own = 0;
    if (c.owner === view.me) own = w.own;
    else if (c.owner === 0) own = w.neutral;
    else if (view.enemies.includes(c.owner)) own = w.enemy;
    if (own <= 0) continue;
    const reach = 1 / (1 + supportDist(view, c) / REACH_SCALE);
    scored.push({ index: c.index, score: own * c.value * reach + w.urgency * urgencyOf(view, c) });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length > MAX_TARGETS) scored.length = MAX_TARGETS;
  const list = scored.map((s) => s.index);
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

function garrisonNeed(c: CityView): number {
  const risk = c.threat / (c.threat + c.myPressure + HOLD_FLOOR);
  const worth = clamp(c.value / GARRISON.valueRef, 0, 1);
  let need = Math.round(risk * worth * GARRISON.max);
  if (c.capital) need = Math.max(need, GARRISON.capital);
  else if (c.threat > 0) need = Math.max(need, 1);
  return Math.min(need, GARRISON.max);
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

/** SNIPE takes a weakly held city with lights; EXPAND walks parties onto the neutrals. */
function planRaids(plan: Plan): void {
  const snipe = plan.mode === MacroMode.Snipe;
  if (!snipe && plan.mode !== MacroMode.Expand) return;
  const want = job(GroupRole.Raid, -1, snipe);
  let parties = 0;
  for (const index of plan.state.targetCities) {
    const c = plan.view.cities[index]!;
    const eligible = snipe ? c.owner !== plan.view.me && c.owner !== 0 : c.owner === 0;
    // A party sent past `RAID_REACH` is a party that dies of encirclement on the way.
    if (!eligible || parties >= (snipe ? 1 : RAID.parties)) continue;
    if (supportDist(plan.view, c) > RAID_REACH) continue;
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

function frontWeight(plan: Plan, front: Front): number {
  const base = Math.max(PICK.frontMin, front.priority);
  return front.id === plan.overcommit ? base * OVERCOMMIT : base;
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
  state.targetCities = rankTargets(view, mode, state.targetCities);
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

  const plan: Plan = { world, view, mode, profile, state, overcommit };
  planBreakout(plan);
  planGarrisons(plan);
  planEncircle(plan);
  planRaids(plan);
  if (view.fronts.length === 0) advanceOnObjective(plan);
  else planFronts(plan, freeCount());
}
