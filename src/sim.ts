/**
 * Movement, combat, morale and healing.
 *
 * Two rules shape everything.
 *
 * Combat happens automatically on contact, and whichever unit is *advancing*
 * counts as the attacker: it deals more damage but takes more and burns morale
 * faster, which is why the guide says to avoid attacking constantly — standing
 * your ground is a real choice.
 *
 * And contact holds you. A unit anybody is fighting is down to a shove, so troops
 * meet, stop and grind instead of walking through each other. That single cap is
 * what turns the front into a line: a head-on push into a prepared line now costs
 * three quarters of the attacking force, where before it cost three men and the
 * attacker came out the far side.
 */

import { Terrain, TERRAIN_DAMAGE, TERRAIN_SPEED, TILE, passable, terrainAt } from './terrain.ts';
import { computeFront } from './frontline.ts';
import { BLUE, RED } from './world.ts';
import type { Unit, World } from './world.ts';

export const TICK = 1 / 30;

/** World units per second. */
const SPEED = [78, 52];
/** Contact radius, world units. */
const RADIUS = [9, 10.5];
/** Friendly units closer than this shove each other apart. */
const SEPARATION = 17;
/** Separation strength as a fraction of walking speed. */
const SEPARATION_FORCE = 0.75;
/** Base damage per second at full health and morale. */
const DAMAGE = [0.115, 0.2];

/**
 * Frontage a unit fights across, on top of the two bodies' radii. Fighting starts
 * here, not at touching distance — in the original two units trading blows stand
 * about their own width apart rather than merged into one dot.
 */
const ENGAGE_GAP = 11;
/** All a unit can manage while somebody is fighting it, world units per second. */
const PRESS_SPEED = 6;
/**
 * Share of an overlap the *advancing* unit gives up. Bodies are solid — nobody
 * ends a tick standing inside anybody — and the one pressing keeps its ground
 * while the one holding gives it up, so leaning on an attack is literally how
 * ground changes hands.
 */
const GIVE = 0.15;

const ATTACK_DAMAGE = 1.5;
const ATTACK_TAKEN = 1.35;
const ATTACK_MORALE_DRAIN = 0.11;
const DEFEND_MORALE_DRAIN = 0.045;
/** Even at zero morale a unit still fights this hard. */
const MORALE_FLOOR = 0.25;
/** Speed below which a unit counts as holding rather than advancing. */
const ADVANCING_SPEED = 3;

const HEAL_FAR = 0.05;
const HEAL_NEAR = 0.012;
const MORALE_REGEN = 0.09;
/** An enemy within this many world units slows healing right down. */
const ENEMY_NEAR = 150;

/**
 * Points give supply and nothing else for now: standing on one of your own heals
 * and steadies a unit faster. They hold no ground of their own — taking one does
 * not move the front line an inch, that still takes troops standing there.
 */
const SUPPLY_RADIUS = 5 * TILE;
const SUPPLY_MULT = 2;
/** Sole occupation takes a point. Checked twice a second; nobody is that quick. */
const CAPTURE_RADIUS = 6 * TILE;
const CAPTURE_EVERY = 15;

/**
 * Rebuild cadence for the border, in ticks. At 30 Hz this is six times a second;
 * slower than that and the line visibly jumps along behind an advancing column
 * instead of being carried by it.
 */
const FRONT_EVERY = 5;
/** How close is close enough to a waypoint before walking to the next one. */
const WAYPOINT_EPS = 16;

function kindIndex(u: Unit): number {
  return u.heavy ? 1 : 0;
}

function speedOf(w: World, u: Unit): number {
  const t = terrainAt(w.map, u.x, u.y);
  return SPEED[kindIndex(u)]! * (TERRAIN_SPEED[t]?.[kindIndex(u)] ?? 1);
}

function damageOf(w: World, u: Unit): number {
  const t = terrainAt(w.map, u.x, u.y);
  const terrain = TERRAIN_DAMAGE[t]?.[kindIndex(u)] ?? 1;
  const health = Math.sqrt(Math.max(0, u.hp));
  const morale = MORALE_FLOOR + (1 - MORALE_FLOOR) * Math.max(0, u.morale);
  return DAMAGE[kindIndex(u)]! * health * morale * terrain;
}

/**
 * Point on the unit's route it is walking toward, offset sideways so a group
 * ordered along one drawn route walks abreast instead of in single file.
 *
 * The offset direction comes from the route's own geometry and never from the
 * unit's position. Deriving it from the unit made the target move as the unit
 * moved, and any unit whose offset pointed backwards chased it in a circle
 * forever — three of six never left the first waypoint.
 */
function waypoint(u: Unit): { x: number; y: number } | null {
  const p = u.path;
  if (!p || u.leg * 2 + 1 >= p.length) return null;
  const i = u.leg * 2;
  const tx = p[i]!;
  const ty = p[i + 1]!;
  if (u.lateral === 0 || p.length < 4) return { x: tx, y: ty };

  const ax = u.leg > 0 ? p[i - 2]! : tx;
  const ay = u.leg > 0 ? p[i - 1]! : ty;
  const bx = u.leg > 0 ? tx : p[2]!;
  const by = u.leg > 0 ? ty : p[3]!;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { x: tx + (-dy / len) * u.lateral, y: ty + (dx / len) * u.lateral };
}

/** True once the unit is level with the waypoint, even if it passed wide of it. */
function passedWaypoint(u: Unit, target: { x: number; y: number }): boolean {
  const p = u.path;
  if (!p || p.length < 4) return false;
  const i = u.leg * 2;
  const ax = u.leg > 0 ? p[i - 2]! : p[0]!;
  const ay = u.leg > 0 ? p[i - 1]! : p[1]!;
  const dx = p[i]! - ax;
  const dy = p[i + 1]! - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return true;
  return ((u.x - target.x) * dx + (u.y - target.y) * dy) / len > 0;
}

/** Distance at which two enemies are fighting each other. */
function engageRange(a: Unit, b: Unit): number {
  return RADIUS[kindIndex(a)]! + RADIUS[kindIndex(b)]! + ENGAGE_GAP;
}

/**
 * Once anybody is fighting a unit, it can only move at a shove.
 *
 * The first version of this cancelled the part of the order that pointed at each
 * enemy, which sounds right and is useless: troops stand about a body's width
 * apart, so a unit heading for the gap between two of them has them off both
 * shoulders, nothing of its heading points *at* either one, and it strolls
 * through the line at full speed. Sixty-one of sixty-four did exactly that.
 *
 * So the cap is on speed itself and does not care where the enemy is standing.
 * Walk into a line and you are down to a fifth of your pace with everyone in
 * reach shooting at you, which is long enough for that to matter. Getting past
 * people means killing them or going round, not walking between them.
 */
function blockOnContact(w: World, u: Unit, vx: number, vy: number): [number, number] {
  const speed = Math.hypot(vx, vy);
  if (speed <= PRESS_SPEED) return [vx, vy];
  for (const o of w.units) {
    if (!o.alive || o.side === u.side) continue;
    if (Math.hypot(o.x - u.x, o.y - u.y) > engageRange(u, o)) continue;
    const k = PRESS_SPEED / speed;
    return [vx * k, vy * k];
  }
  return [vx, vy];
}

function advance(w: World, u: Unit, dt: number): void {
  const target = waypoint(u);
  let ax = 0;
  let ay = 0;
  const speed = speedOf(w, u);

  if (target && speed > 0) {
    const dx = target.x - u.x;
    const dy = target.y - u.y;
    const d = Math.hypot(dx, dy);
    if (d < WAYPOINT_EPS || passedWaypoint(u, target)) {
      u.leg++;
      if (u.leg * 2 + 1 >= (u.path?.length ?? 0)) {
        u.path = null;
        u.leg = 0;
        u.lateral = 0;
      }
    } else {
      ax = (dx / d) * speed;
      ay = (dy / d) * speed;
    }
  }

  // Own side only. Enemies are handled by the contact rule above and by the hard
  // separation in combat; letting them into this soft push as well made a unit
  // drift round an enemy it was supposed to be fighting.
  let sxv = 0;
  let syv = 0;
  for (const o of w.units) {
    if (o === u || !o.alive || o.side !== u.side) continue;
    const dx = u.x - o.x;
    const dy = u.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d > SEPARATION || d < 1e-4) continue;
    const k = (1 - d / SEPARATION) / d;
    sxv += dx * k;
    syv += dy * k;
  }
  // Clamped, and scaled against walking speed. Unclamped it reached several
  // hundred world units per second in a crowd, drowning the movement it was
  // supposed to tidy up: the group sat still and vibrated instead of advancing.
  const push = Math.hypot(sxv, syv);
  if (push > 1e-4) {
    const scale = (Math.min(push, 1) / push) * speed * SEPARATION_FORCE;
    sxv *= scale;
    syv *= scale;
  }

  // The cap goes on last, over the crowd shove as well as the order. Applying it
  // to the order alone let a unit in a melee be jostled clear of the fight at
  // three times the speed it was allowed to walk.
  const [tx, ty] = blockOnContact(w, u, ax + sxv, ay + syv);
  u.vx += (tx - u.vx) * 0.3;
  u.vy += (ty - u.vy) * 0.3;

  const nx = u.x + u.vx * dt;
  const ny = u.y + u.vy * dt;
  if (passable(w.map, nx, ny)) {
    u.x = nx;
    u.y = ny;
  } else if (passable(w.map, nx, u.y)) {
    u.x = nx;
  } else if (passable(w.map, u.x, ny)) {
    u.y = ny;
  }
  u.x = Math.min(Math.max(u.x, 8), w.map.worldW - 8);
  u.y = Math.min(Math.max(u.y, 8), w.map.worldH - 8);
}

/** Displaces a unit, but never into a cliff or off the map. */
function shove(w: World, u: Unit, dx: number, dy: number): void {
  const nx = Math.min(Math.max(u.x + dx, 8), w.map.worldW - 8);
  const ny = Math.min(Math.max(u.y + dy, 8), w.map.worldH - 8);
  if (passable(w.map, nx, u.y)) u.x = nx;
  if (passable(w.map, u.x, ny)) u.y = ny;
}

function resolveCombat(w: World, dt: number): void {
  for (const u of w.units) {
    u.inCombat = false;
    u.attacking = false;
  }

  for (let i = 0; i < w.units.length; i++) {
    const a = w.units[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < w.units.length; j++) {
      const b = w.units[j]!;
      if (!b.alive || b.side === a.side) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > engageRange(a, b)) continue;

      a.inCombat = true;
      b.inCombat = true;
      // The one still pushing forward is the attacker.
      const aMoving = Math.hypot(a.vx, a.vy) > ADVANCING_SPEED && a.path !== null;
      const bMoving = Math.hypot(b.vx, b.vy) > ADVANCING_SPEED && b.path !== null;
      a.attacking = aMoving;
      b.attacking = bMoving;

      const aOut = damageOf(w, a) * (aMoving ? ATTACK_DAMAGE : 1) * (bMoving ? ATTACK_TAKEN : 1);
      const bOut = damageOf(w, b) * (bMoving ? ATTACK_DAMAGE : 1) * (aMoving ? ATTACK_TAKEN : 1);
      b.hp -= aOut * dt;
      a.hp -= bOut * dt;

      // Fighting starts at the engagement frontage, but bodies stay solid at their
      // own radii: pressing an attack closes the gap and shoves the defender, and
      // the two still never end up standing in the same place.
      const solid = RADIUS[kindIndex(a)]! + RADIUS[kindIndex(b)]!;
      if (d > 1e-4 && d < solid) {
        const ux = dx / d;
        const uy = dy / d;
        const overlap = solid - d;
        const aShare = aMoving && !bMoving ? GIVE : bMoving && !aMoving ? 1 - GIVE : 0.5;
        shove(w, a, -ux * overlap * aShare, -uy * overlap * aShare);
        shove(w, b, ux * overlap * (1 - aShare), uy * overlap * (1 - aShare));
      }
    }
  }

  for (const u of w.units) {
    if (!u.alive) continue;
    if (u.inCombat) {
      u.morale -= (u.attacking ? ATTACK_MORALE_DRAIN : DEFEND_MORALE_DRAIN) * dt;
      u.morale = Math.max(0, u.morale);
    }
    if (u.hp <= 0) {
      u.alive = false;
      u.hp = 0;
      w.casualties[u.side]!++;
    }
  }
}

function nearestEnemyDistance(w: World, u: Unit): number {
  let best = Infinity;
  for (const o of w.units) {
    if (!o.alive || o.side === u.side) continue;
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    if (d < best) best = d;
  }
  return best;
}

/** Whether the unit is close enough to one of its own points to be in supply. */
function inSupply(w: World, u: Unit): boolean {
  for (const c of w.map.cities) {
    if (c.owner !== u.side) continue;
    if (Math.hypot(u.x - c.x * TILE, u.y - c.y * TILE) < SUPPLY_RADIUS) return true;
  }
  return false;
}

/**
 * A point goes to whoever is standing on it with nobody contesting it. That is
 * all taking one does: no money yet, and — deliberately — no territory. Points
 * claim no ground of their own, so the front line is drawn by troops and only by
 * troops, and a point deep behind the line is worth exactly its supply.
 */
function captureCities(w: World): void {
  for (const c of w.map.cities) {
    const cx = c.x * TILE;
    const cy = c.y * TILE;
    let blue = 0;
    let red = 0;
    for (const u of w.units) {
      if (!u.alive) continue;
      if (Math.hypot(u.x - cx, u.y - cy) > CAPTURE_RADIUS) continue;
      if (u.side === BLUE) blue++;
      else red++;
    }
    if (blue > 0 && red === 0) c.owner = BLUE;
    else if (red > 0 && blue === 0) c.owner = RED;
  }
}

function recover(w: World, dt: number): void {
  for (const u of w.units) {
    if (!u.alive || u.inCombat) continue;
    const supply = inSupply(w, u) ? SUPPLY_MULT : 1;
    u.morale = Math.min(1, u.morale + MORALE_REGEN * supply * dt);
    if (u.hp >= 1) continue;
    // Healing is faster away from the enemy, and faster again in supply.
    const far = nearestEnemyDistance(w, u) > ENEMY_NEAR;
    u.hp = Math.min(1, u.hp + (far ? HEAL_FAR : HEAL_NEAR) * supply * dt);
  }
}

export function step(w: World): void {
  w.tick++;
  w.time += TICK;

  for (const u of w.units) {
    if (u.alive) advance(w, u, TICK);
  }
  resolveCombat(w, TICK);
  recover(w, TICK);

  if (w.tick % CAPTURE_EVERY === 0) captureCities(w);
  if (w.tick % 90 === 0) w.units = w.units.filter((u) => u.alive);
  if (w.tick % FRONT_EVERY === 0) {
    w.front = computeFront(w.units, w.map.worldW, w.map.worldH);
  }
}

export function troopCount(w: World, side: number): number {
  let n = 0;
  for (const u of w.units) if (u.alive && u.side === side) n++;
  return n;
}

export { BLUE, RED, Terrain };
