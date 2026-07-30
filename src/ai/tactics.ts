/**
 * Layer 3: tactics — every tick, inside the APM budget.
 *
 * This is where difficulty actually lives. The budget is a hard ceiling on commands per
 * tick, so the file is a strict priority list (spec §5.2 layer 3) that simply stops when
 * the money runs out: a Новобранец does not play badly on purpose, he runs out of actions
 * before he reaches the second item.
 *
 *   1. cycling — wounded out, reserves and healed units back in
 *   2. attack surface — spare bodies into contact, and stop the ones already there
 *   3/4. hard vetoes — nobody in water, no heavy in a wood
 *   5. flanking — two or three lights round an open flank
 *   6. the doomed — folded into (1) rather than left until last: a unit under
 *      `CYCLE.doomed` is already at the head of a list sorted by HP, and it is the one
 *      case where the profile's mistake dice and the re-order cooldown are both ignored
 *   7. the march — carry out the operational plan with whatever is left
 *
 * Two mechanisms let a 20-APM bot move an army at all. Orders are *batched*: units
 * standing near each other and bound for the same place go out as one `path` command,
 * which is one action however many units it moves. And the single `stop` that ends the
 * attack-surface pass is the best-value command in the file — a unit in contact that is
 * still walking pays `MOVING_PENALTY` on everything it deals, so standing still is free
 * damage, for any number of units, for one action.
 *
 * Routing goes through `findRoute` whenever a straight line is not demonstrably clear,
 * capped at `ROUTE.max` calls per tick on a reduced node budget. Walking an army into a
 * mountain is exactly the visible stupidity that costs a bot its credibility — but so is
 * a bot that spends four milliseconds a tick avoiding it.
 */

import { baseKindOf, Kind, Terrain } from '../core/types.ts';
import type { Command, RngState, UnitStore, World } from '../core/types.ts';
import { PROXIMITY_R, TILE_SIZE } from '../core/balance.ts';
import { chance } from '../core/rng.ts';
import { dist2 } from '../core/geometry.ts';
import { terrainAt } from '../core/terrain.ts';
import { slotOfId } from '../core/units.ts';
import { makeCellRange, queryInto } from '../core/spatial.ts';
import { findRoute } from '../core/pathfinding.ts';
import { GroupRole, MacroMode } from './types.ts';
import type { Assignment, BotDebug, BotProfile, Front } from './types.ts';
import type { MacroModeId, StrategicView } from './types.ts';
import type { OperationsState, Spot } from './operations.ts';
import { heavyPenalised, nearestOwnCity, safeSpot } from './operations.ts';
import { logDecision, syncRoles } from './debug.ts';

// ──────────────────────────────────────────────────────────────── weights ──
// Bot coefficients live beside the code that uses them (ADR-011).

/**
 * Cycling. `margin` is the hysteresis above the profile's threshold before a withdrawn
 * unit goes back in; `pullMargin` aims the retreat that much past `PROXIMITY_R`, because
 * an enemy inside it freezes HP regeneration entirely (spec §4.4); `cityR` is how far a
 * wounded unit will walk to heal at a city's doubled rate; `maxPull` bounds the work, and
 * the list is sorted by HP so the cap only ever drops the least urgent case.
 */
const CYCLE = {
  margin: 0.15, returnMax: 0.92, doomed: 0.1, pullMargin: 1.5, cityR: 100, maxPull: 48, maxOut: 200,
};
/**
 * Attack surface. `r` is how far a unit will step to join a fight, `gap` how far short of
 * the enemy centre it stops, `countR` what counts as already touching, and `touch` the
 * detour a body already on that enemy is worth — it pushes the next unit onto an
 * untouched one, which is where the one-target rule pays. `defend` is the front ratio
 * DEFEND demands before it will let the line step out of position at all.
 */
const ENGAGE = { maxFoes: 48, max: 24, r: 34, gap: 4, countR: 8, touch: 22, defend: 0.5 };
/**
 * Ticks. `reorder` is the floor between two orders to one unit, `march` how long an idle
 * unit waits before being re-sent, `hold` how stale an order must be before a unit in
 * contact counts as holding ground rather than marching. `fresh` is in *view* ticks:
 * perception refreshes at 2 Hz, so an assignment stamped one step back is "just now".
 */
const WAIT = { reorder: 12, march: 40, fresh: 10, arrive: 20, hold: 20 };
/**
 * Flanking: how often it is considered at all, the party size, the front ratio worth
 * thinning to send one, clearance round the enemy's outermost unit, how far past their
 * line to aim, and how many of mine may already be round that side before it stops
 * counting as an open flank.
 */
const FLANK = { interval: 40, group: 3, minRatio: 0.45, offset: 18, depth: 22, slack: 1 };
/** Units within `span` of each other, bound for the same place, travel as one order. */
const BATCH = { span: 32, grid: 64 };
/**
 * Routing. `max` A* calls per tick, `nodes` expansions each — a fraction of the
 * pathfinder's default, because a hop needing more comes back as a best-effort route
 * toward the closest reachable tile, and setting off now to be re-routed later is the
 * right answer anyway. A clear straight line up to `lineMax` skips the router entirely.
 */
const ROUTE = { max: 3, nodes: 2500, lineMax: 220 };

// ──────────────────────────────────────────────────────────────── scratch ──

interface Own {
  slot: number; id: number; x: number; y: number; hp: number; heavy: boolean; combat: boolean;
  /** The operational plan for this unit, or null for one that spawned since the last pass. */
  a: Assignment | null;
}

/** Rebuilt every tick but allocated once: a think pass creates no per-unit objects. */
const mine: Own[] = [];
let mineLen = 0;
const byId = new Map<number, Own>();

/** Shortlist, reused. Never nested — each stage is done with it before the next starts. */
const bench: Own[] = [];
const foeSlot = new Int32Array(ENGAGE.maxFoes);
const foeTouch = new Int32Array(ENGAGE.maxFoes);
let foeLen = 0;

const dest: Spot = { x: 0, y: 0 };
const routeAt: Spot = { x: 0, y: 0 };
const nearby = new Int32Array(512);
const range = makeCellRange();

interface Batch { sx: number; sy: number; tx: number; ty: number; n: number; heavy: boolean; ids: number[] }

const batches: Batch[] = [];
const batchKeys = new Map<number, Batch>();
/** Unit ids the last flush actually put on the wire. */
const sentIds: number[] = [];

// ────────────────────────────────────────────────────────────────── state ──

export interface TacticsState {
  lastOrderTick: Map<number, number>;
  pulledOut: Set<number>;
}

export function createTactics(): TacticsState {
  return { lastOrderTick: new Map(), pulledOut: new Set() };
}

interface Ctx {
  world: World; view: StrategicView; mode: MacroModeId; profile: BotProfile;
  ops: OperationsState; state: TacticsState; rng: RngState; dbg: BotDebug;
  out: Command[]; budget: number; me: number; u: UnitStore; spent: number; routes: number;
}

function sinceOrder(ctx: Ctx, id: number): number {
  const last = ctx.state.lastOrderTick.get(id);
  return last === undefined ? Infinity : ctx.world.tick - last;
}

/** Not withdrawn, and not ordered so recently that another command would be churn. */
function available(ctx: Ctx, m: Own, wait: number): boolean {
  return !ctx.state.pulledOut.has(m.id) && sinceOrder(ctx, m.id) >= wait;
}

function buildOwn(ctx: Ctx): void {
  const u = ctx.u;
  mineLen = 0;
  byId.clear();
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== ctx.me) continue;
    let m = mine[mineLen];
    if (m === undefined) mine.push((m = { slot: 0, id: 0, x: 0, y: 0, hp: 0, heavy: false, combat: false, a: null }));
    m.slot = i; m.id = u.id[i]!; m.x = u.x[i]!; m.y = u.y[i]!; m.hp = u.hp[i]!;
    m.heavy = baseKindOf(u.kind[i]!) === 1; m.combat = u.inCombat[i] === 1;
    m.a = ctx.ops.assignments.get(m.id) ?? null;
    byId.set(m.id, m);
    mineLen++;
  }
}

/** Drops the bookkeeping of units that have died. Runs at the operations cadence. */
function prune(ctx: Ctx): void {
  for (const id of ctx.state.pulledOut) if (!byId.has(id)) ctx.state.pulledOut.delete(id);
  for (const id of ctx.state.lastOrderTick.keys()) if (!byId.has(id)) ctx.state.lastOrderTick.delete(id);
}

/** Collects units into `bench` under a filter, cheapest first, capped. */
function shortlist(keep: (m: Own) => boolean, cost: (m: Own) => number, max: number): void {
  bench.length = 0;
  for (let k = 0; k < mineLen; k++) if (keep(mine[k]!)) bench.push(mine[k]!);
  bench.sort((a, b) => cost(a) - cost(b) || a.id - b.id);
  if (bench.length > max) bench.length = max;
}

// ────────────────────────────────────────────────────────────── emitting ──

/** True when a straight walk crosses nothing this unit is forbidden to enter. */
function lineClear(ctx: Ctx, x0: number, y0: number, to: Spot, heavy: boolean, escape: boolean): boolean {
  const dx = to.x - x0, dy = to.y - y0;
  const len = Math.hypot(dx, dy);
  if (len > ROUTE.lineMax) return false;
  const steps = Math.max(1, Math.ceil(len / TILE_SIZE));
  const aware = ctx.profile.usesTerrain && !escape;
  for (let i = 0; i <= steps; i++) {
    const t = terrainAt(ctx.world.map, x0 + (dx * i) / steps, y0 + (dy * i) / steps);
    if (t === Terrain.Mountain || (t === Terrain.Water && !escape)) return false;
    if (heavy && aware && heavyPenalised(t)) return false;
  }
  return true;
}

/**
 * One action: one `path` command for a whole batch. The destination is nudged onto ground
 * the unit may stand on before anything else happens, which — with `lineClear` — is where
 * the water and forest vetoes are actually enforced.
 */
function emitPath(ctx: Ctx, b: Batch, escape: boolean): boolean {
  if (ctx.spent >= ctx.budget || b.ids.length === 0) return false;
  const n = b.n === 0 ? 1 : b.n;
  const sx = b.sx / n, sy = b.sy / n;
  const kind = b.heavy ? Kind.Heavy : Kind.Light;
  if (!safeSpot(ctx.world.map, b.tx / n, b.ty / n, b.heavy, ctx.profile.usesTerrain, routeAt)) {
    return false;
  }
  let pts: number[] | null = null;
  if (lineClear(ctx, sx, sy, routeAt, b.heavy, escape)) pts = [sx, sy, routeAt.x, routeAt.y];
  else if (ctx.routes++ < ROUTE.max) {
    const route = findRoute(ctx.world.map, sx, sy, routeAt.x, routeAt.y, kind, ROUTE.nodes);
    if (route.length >= 4) pts = route;
  }
  if (pts === null) return false;

  ctx.out.push({ t: 'path', player: ctx.me, units: b.ids.slice(), pts, append: false });
  ctx.spent++;
  for (const id of b.ids) ctx.state.lastOrderTick.set(id, ctx.world.tick);
  return true;
}

/** Same neighbourhood, same destination, same kind ⇒ same order. */
function addBatch(m: Own, tx: number, ty: number): void {
  const cell = (x: number, y: number): number =>
    (((y / BATCH.span) | 0) % BATCH.grid) * BATCH.grid + (((x / BATCH.span) | 0) % BATCH.grid);
  const key = (cell(tx, ty) * BATCH.grid * BATCH.grid + cell(m.x, m.y)) * 2 + (m.heavy ? 1 : 0);
  let b = batchKeys.get(key);
  if (b === undefined) {
    b = { sx: 0, sy: 0, tx: 0, ty: 0, n: 0, heavy: m.heavy, ids: [] };
    batchKeys.set(key, b);
    batches.push(b);
  }
  b.sx += m.x; b.sy += m.y; b.tx += tx; b.ty += ty; b.n++;
  b.ids.push(m.id);
}

/**
 * Emits the batches, biggest first — the most units moved per action — and empties the
 * pending set on the way out, so the next stage always starts from nothing. Every stage
 * that calls `addBatch` must reach this function on every path.
 */
function flushBatches(ctx: Ctx, escape = false): number {
  sentIds.length = 0;
  batches.sort((a, b) => b.ids.length - a.ids.length || a.ids[0]! - b.ids[0]!);
  let commands = 0;
  for (const b of batches) {
    if (ctx.spent >= ctx.budget) break;
    if (!emitPath(ctx, b, escape)) continue;
    commands++;
    for (const id of b.ids) sentIds.push(id);
  }
  batches.length = 0;
  batchKeys.clear();
  return commands;
}

// ─────────────────────────────────────────────────────────── 1. cycling ──

function nearestEnemy(ctx: Ctx, x: number, y: number, r: number): number {
  const u = ctx.u;
  const count = queryInto(ctx.world.spatial, x, y, r, nearby, range);
  let best = -1;
  let bestD = r * r;
  for (let k = 0; k < count; k++) {
    const j = nearby[k]!;
    const owner = u.owner[j]!;
    if (!u.alive[j] || owner === ctx.me || owner === 0 || ctx.view.allies.includes(owner)) continue;
    const d = dist2(x, y, u.x[j]!, u.y[j]!);
    // Nearest, then lowest id: a tie must not depend on the order of the hash buckets.
    if (d < bestD || (d === bestD && best >= 0 && u.id[j]! < u.id[best]!)) { bestD = d; best = j; }
  }
  return best;
}

/** A city if one is near, otherwise straight back out of the enemy's proximity radius. */
function withdrawTo(ctx: Ctx, m: Own, enemy: number, out: Spot): void {
  const city = nearestOwnCity(ctx.view, m.x, m.y);
  const r2 = CYCLE.cityR * CYCLE.cityR;
  if (city !== null && dist2(m.x, m.y, city.x, city.y) <= r2) { out.x = city.x; out.y = city.y; return; }
  const ex = ctx.u.x[enemy]!;
  const ey = ctx.u.y[enemy]!;
  const away = PROXIMITY_R * CYCLE.pullMargin;
  const len = Math.hypot(m.x - ex, m.y - ey);
  const step = len < 1e-3 ? 0 : away / len;
  out.x = ex + (m.x - ex) * step;
  out.y = ey + (m.y - ey) * step - (len < 1e-3 ? away : 0);
}

/**
 * HP at which a withdrawn unit is worth having back. Capped, and that cap matters: a
 * Маршал pulls at 0.85, and a plain hysteresis margin on top of that would mean waiting
 * for a full heal — 40 seconds of regeneration at `HP_REGEN` — before the unit rejoined.
 * A cycle is a short trip out of the line, not a retirement.
 */
function returnHp(ctx: Ctx): number {
  return Math.min(ctx.profile.cycleHpThreshold + CYCLE.margin, CYCLE.returnMax);
}

/**
 * The other half of the cycle: healed units go back to their post and the fronts that
 * just lost somebody get a fresh reserve each. Both halves share one flush, so filling a
 * hole and returning a healed unit to the same place can cost a single action.
 */
function feedLine(ctx: Ctx, pulls: Map<number, number>): void {
  const ready = returnHp(ctx);
  for (const id of ctx.state.pulledOut) {
    const m = byId.get(id);
    if (m === undefined || m.a === null) continue;
    // Healed — or out long enough that it plainly is not healing. An enemy inside
    // `PROXIMITY_R` freezes regeneration outright (spec §4.4), so without the timeout a
    // withdrawal into a contested rear is a one-way trip and the army quietly drains away
    // into units that are neither fighting nor recovering.
    if (m.hp >= ready || sinceOrder(ctx, m.id) > CYCLE.maxOut) addBatch(m, m.a.targetX, m.a.targetY);
  }
  for (const [front, count] of pulls) {
    const f = ctx.view.fronts[front];
    if (f === undefined) continue;
    const fit = (m: Own): boolean =>
      m.a?.role === GroupRole.Reserve && m.a.front === f.id && !m.combat && m.hp >= ready;
    shortlist((m) => fit(m) && available(ctx, m, WAIT.reorder), (m) => dist2(m.x, m.y, f.x, f.y), count);
    for (const m of bench) addBatch(m, f.x, f.y);
  }
  if (flushBatches(ctx) === 0) return;
  // Reserves are not in the set, so this only clears the units that had been withdrawn.
  for (const id of sentIds) ctx.state.pulledOut.delete(id);
  logDecision(ctx.dbg, ctx.world.tick, `свежие силы в строй: ${sentIds.length}`);
}

function stageCycle(ctx: Ctx): void {
  const threshold = ctx.profile.cycleHpThreshold;
  shortlist(
    (m) =>
      m.hp < threshold && m.a?.role !== GroupRole.Garrison && !ctx.state.pulledOut.has(m.id) &&
      // The doomed skip the cooldown as well as the dice: there is nothing left to trade.
      (m.hp < CYCLE.doomed || sinceOrder(ctx, m.id) >= WAIT.reorder),
    (m) => m.hp,
    CYCLE.maxPull,
  );

  let held = 0;
  for (const m of bench) {
    // Nothing near: HP is already coming back and the action would be wasted.
    const enemy = nearestEnemy(ctx, m.x, m.y, PROXIMITY_R);
    if (enemy < 0) continue;
    // The plausible mistake — one more moment in the line, and it is one too many.
    if (chance(ctx.rng, ctx.profile.mistakeRate) && m.hp >= CYCLE.doomed) {
      held++;
      continue;
    }
    withdrawTo(ctx, m, enemy, dest);
    addBatch(m, dest.x, dest.y);
  }

  const pulls = new Map<number, number>();
  if (flushBatches(ctx) > 0) {
    for (const id of sentIds) {
      ctx.state.pulledOut.add(id);
      const front = byId.get(id)?.a?.front ?? -1;
      if (front >= 0) pulls.set(front, (pulls.get(front) ?? 0) + 1);
    }
    logDecision(ctx.dbg, ctx.world.tick, `отвод раненых: ${sentIds.length}`);
  }
  if (held > 0) logDecision(ctx.dbg, ctx.world.tick, `держу раненых в строю: ${held}`);
  feedLine(ctx, pulls);
}

// ─────────────────────────────────────────────────── 2. attack surface ──

/**
 * Live enemies of this front, with a count of how many of mine already touch each.
 * Counted through the spatial hash rather than by walking my whole army per enemy: this
 * runs for every front, every tick, and the army is the thing that grows.
 */
function countTouches(ctx: Ctx, f: Front): void {
  const u = ctx.u;
  foeLen = 0;
  for (const id of f.enemyUnits) {
    if (foeLen >= ENGAGE.maxFoes) break;
    const s = slotOfId(u, id);
    if (s < 0 || !u.alive[s]) continue;
    foeSlot[foeLen] = s; foeTouch[foeLen] = 0; foeLen++;
  }
  const reach = ENGAGE.countR * ENGAGE.countR;
  for (let e = 0; e < foeLen; e++) {
    const s = foeSlot[e]!;
    const found = queryInto(ctx.world.spatial, u.x[s]!, u.y[s]!, ENGAGE.countR, nearby, range);
    let touching = 0;
    for (let k = 0; k < found; k++) {
      const j = nearby[k]!;
      if (u.alive[j] && u.owner[j] === ctx.me && dist2(u.x[j]!, u.y[j]!, u.x[s]!, u.y[s]!) <= reach) {
        touching++;
      }
    }
    foeTouch[e] = touching;
  }
}

/** Steps second-rank units of this front into contact with whoever is least engaged. */
function engageFront(ctx: Ctx, f: Front): void {
  countTouches(ctx, f);
  if (foeLen === 0) return;
  const role = (m: Own): boolean =>
    m.a?.role === GroupRole.Frontline || m.a?.role === GroupRole.Escort;
  shortlist(
    (m) =>
      !m.combat && m.a?.front === f.id && role(m) && m.hp >= ctx.profile.cycleHpThreshold &&
      available(ctx, m, WAIT.reorder) && dist2(m.x, m.y, f.x, f.y) <= ENGAGE.r * ENGAGE.r,
    (m) => dist2(m.x, m.y, f.x, f.y),
    ENGAGE.max,
  );

  const u = ctx.u;
  for (const m of bench) {
    let best = -1;
    let bestScore = Infinity;
    for (let e = 0; e < foeLen; e++) {
      const s = foeSlot[e]!;
      const d = Math.hypot(m.x - u.x[s]!, m.y - u.y[s]!);
      // An untouched enemy is dealing damage for free — that is where the body goes.
      const score = d + foeTouch[e]! * ENGAGE.touch;
      if (d > 1e-3 && d <= ENGAGE.r && score < bestScore) { bestScore = score; best = e; }
    }
    if (best < 0) continue;
    // Stop a contact radius short rather than trying to walk through the enemy.
    const s = foeSlot[best]!;
    const step = ENGAGE.gap / Math.hypot(m.x - u.x[s]!, m.y - u.y[s]!);
    dest.x = u.x[s]! + (m.x - u.x[s]!) * step;
    dest.y = u.y[s]! + (m.y - u.y[s]!) * step;
    const t = terrainAt(ctx.world.map, dest.x, dest.y);
    if (t === Terrain.Mountain || t === Terrain.Water) continue;
    if (m.heavy && ctx.profile.usesTerrain && heavyPenalised(t)) continue;
    addBatch(m, dest.x, dest.y);
    foeTouch[best]!++;
  }
  flushBatches(ctx);
}

/**
 * Ends the pass with the cheapest command in the file: a unit in contact that is still
 * following a path pays `MOVING_PENALTY` on every point of damage it deals, and one
 * `stop` fixes that for the whole line at once.
 */
function stageAttackSurface(ctx: Ctx): void {
  for (const f of ctx.view.fronts) {
    if (ctx.spent >= ctx.budget) return;
    if (ctx.mode === MacroMode.Defend && f.ratio < ENGAGE.defend) continue;
    engageFront(ctx, f);
  }
  if (ctx.spent >= ctx.budget) return;

  const ids: number[] = [];
  for (let k = 0; k < mineLen; k++) {
    const m = mine[k]!;
    if (!m.combat || ctx.u.pathIdx[m.slot]! < 0 || m.hp < ctx.profile.cycleHpThreshold) continue;
    if (available(ctx, m, WAIT.hold)) ids.push(m.id);
  }
  if (ids.length === 0) return;
  ctx.out.push({ t: 'stop', player: ctx.me, units: ids });
  ctx.spent++;
  for (const id of ids) ctx.state.lastOrderTick.set(id, ctx.world.tick);
}

// ────────────────────────────────────────────────────── 3/4. hard vetoes ──

/**
 * Nobody stands in water, and no heavy stands in a wood. Corrective, not preventive: the
 * vetoes themselves live in `emitPath` and `lineClear`, but a unit still ends up on
 * forbidden ground by drifting, by separation, or because the front moved onto it.
 */
function stageEscape(ctx: Ctx): void {
  if (ctx.spent >= ctx.budget) return;
  const aware = ctx.profile.usesTerrain;
  for (let k = 0; k < mineLen; k++) {
    const m = mine[k]!;
    if (sinceOrder(ctx, m.id) < WAIT.reorder) continue;
    const t = terrainAt(ctx.world.map, m.x, m.y);
    if (t !== Terrain.Water && !(aware && m.heavy && heavyPenalised(t))) continue;
    if (safeSpot(ctx.world.map, m.x, m.y, m.heavy, aware, dest)) addBatch(m, dest.x, dest.y);
  }
  if (flushBatches(ctx, true) > 0) {
    logDecision(ctx.dbg, ctx.world.tick, `снимаю с запретной земли: ${sentIds.length}`);
  }
}

// ────────────────────────────────────────────────────────── 5. flanking ──

/** Units on each side of the front's axis, and how far the outermost one reaches. */
const tally = { high: 0, low: 0, reach: 0 };

function countSides(u: UnitStore, ids: number[], f: Front, nx: number, ny: number): void {
  tally.high = 0; tally.low = 0; tally.reach = 0;
  for (const id of ids) {
    const s = slotOfId(u, id);
    if (s < 0 || !u.alive[s]) continue;
    const p = (u.x[s]! - f.x) * nx + (u.y[s]! - f.y) * ny;
    if (p >= 0) tally.high++;
    else tally.low++;
    tally.reach = Math.max(tally.reach, Math.abs(p));
  }
}

/**
 * Finds a way round an enemy front, or gives up. The axis of the fight is the line from
 * the city behind me to the contact; the flank is the end of the enemy line with fewer
 * units on it, and it only counts as open while my own line does not already reach that
 * far round — otherwise the "flanking party" is three more units in the same fight.
 */
function planFlank(ctx: Ctx, f: Front, out: Spot): boolean {
  const home = nearestOwnCity(ctx.view, f.x, f.y);
  if (home === null) return false;
  let ax = f.x - home.x, ay = f.y - home.y;
  const len = Math.hypot(ax, ay);
  if (len < 1e-3) return false;
  ax /= len; ay /= len;

  countSides(ctx.u, f.enemyUnits, f, -ay, ax);
  const high = tally.high, low = tally.low, reach = tally.reach;
  if (high + low === 0) return false;
  const side = high <= low ? 1 : -1;
  countSides(ctx.u, f.myUnits, f, -ay, ax);
  if ((side > 0 ? tally.high : tally.low) > (side > 0 ? high : low) + FLANK.slack) return false;

  out.x = f.x - ay * side * (reach + FLANK.offset) + ax * FLANK.depth;
  out.y = f.y + ax * side * (reach + FLANK.offset) + ay * FLANK.depth;
  return true;
}

function stageFlank(ctx: Ctx): void {
  if (ctx.spent >= ctx.budget || ctx.world.tick % FLANK.interval !== 0) return;
  // «Забыть про фланг» is one of the spec's own examples of a plausible mistake.
  if (chance(ctx.rng, ctx.profile.mistakeRate)) return;

  let pick: Front | null = null;
  for (const f of ctx.view.fronts) {
    if (f.ratio >= FLANK.minRatio && (pick === null || f.priority > pick.priority)) pick = f;
  }
  if (pick === null || !planFlank(ctx, pick, dest)) return;

  const front = pick.id;
  const fit = (m: Own): boolean =>
    !m.heavy && !m.combat && m.hp >= ctx.profile.cycleHpThreshold &&
    (m.a?.front === front || m.a?.role === GroupRole.Reserve);
  shortlist((m) => fit(m) && available(ctx, m, WAIT.reorder), (m) => dist2(m.x, m.y, dest.x, dest.y), FLANK.group);
  if (bench.length === 0) return;

  for (const m of bench) addBatch(m, dest.x, dest.y);
  if (flushBatches(ctx) > 0) {
    logDecision(ctx.dbg, ctx.world.tick, `обход фланга, фронт ${front}: ${sentIds.length}`);
  }
}

// ────────────────────────────────────────────────────────────── 7. march ──

/**
 * Whatever is left of the budget carries out the operational plan. Last on purpose: a
 * unit already in contact is worth more attention than one that is merely late.
 *
 * A *fresh* assignment overrides the long idle timer, which is what `Assignment.since` is
 * for — operations leaves `since` alone while a plan stands, so a standing plan costs no
 * actions at all and only a real change re-orders anybody.
 */
function stageMarch(ctx: Ctx): void {
  if (ctx.spent >= ctx.budget) return;
  for (let k = 0; k < mineLen; k++) {
    const m = mine[k]!;
    const a = m.a;
    if (a === null || m.combat || ctx.state.pulledOut.has(m.id)) continue;
    if (dist2(m.x, m.y, a.targetX, a.targetY) <= WAIT.arrive * WAIT.arrive) continue;
    const waited = sinceOrder(ctx, m.id);
    const idle = ctx.u.pathIdx[m.slot]! < 0;
    const fresh = ctx.view.tick - a.since <= WAIT.fresh;
    if (fresh ? waited >= WAIT.reorder : idle && waited >= WAIT.march) addBatch(m, a.targetX, a.targetY);
  }
  flushBatches(ctx);
}

// ─────────────────────────────────────────────────────────────────── run ──

export function runTactics(args: {
  world: World; view: StrategicView; mode: MacroModeId; profile: BotProfile;
  ops: OperationsState; state: TacticsState; rng: RngState; budget: number;
  out: Command[]; dbg: BotDebug;
}): number {
  if (args.budget <= 0) return 0;
  const ctx: Ctx = { ...args, me: args.view.me, u: args.world.units, spent: 0, routes: 0 };

  buildOwn(ctx);
  // Operations ran on this very tick: republish roles for the overlay, and forget the
  // bookkeeping of everyone who has died since the last plan.
  if (args.ops.lastPlanTick === args.world.tick) {
    prune(ctx);
    syncRoles(args.dbg, args.ops.assignments);
  }

  stageCycle(ctx);
  stageAttackSurface(ctx);
  stageEscape(ctx);
  stageFlank(ctx);
  stageMarch(ctx);

  if (ctx.spent >= ctx.budget) logDecision(ctx.dbg, ctx.world.tick, 'бюджет APM исчерпан');
  return ctx.spent;
}
