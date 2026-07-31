/**
 * The simulation: pick a target, walk toward it, fight whatever you bump into.
 *
 * Deliberately small. Units head for the nearest enemy and push each other apart,
 * and that alone is enough to make the two armies settle into a line — which is the
 * thing the front-line contour is drawn from.
 */

import { Terrain, terrainAt, TILE } from './terrain.ts';
import { computeFront } from './frontline.ts';
import { BLUE, RED, findOpenSpot, reinforce } from './world.ts';
import type { Unit, World } from './world.ts';
import { rand } from './rng.ts';

export const TICK = 1 / 30;

/** World units per second on open ground. */
const SPEED_LIGHT = 26;
const SPEED_HEAVY = 17;
const CONTACT = 17;
const SEPARATION = 15;
const DAMAGE_LIGHT = 0.13;
const DAMAGE_HEAVY = 0.24;
/** Terrain speed multiplier, indexed by TerrainId. */
const TERRAIN_SPEED = [1, 0.62, 0.72, 0, 0, 1.1];
/** Rebuild the contour a few times a second; it does not need to be per-frame. */
const FRONT_EVERY = 6;
const REINFORCE_EVERY = 11;
const REINFORCE_COUNT = 5;

function speedOf(w: World, u: Unit): number {
  const base = u.heavy ? SPEED_HEAVY : SPEED_LIGHT;
  const t = terrainAt(w.map, u.x, u.y);
  return base * (TERRAIN_SPEED[t] ?? 1);
}

/** Nearest living enemy, or null. */
function nearestEnemy(w: World, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const o of w.units) {
    if (!o.alive || o.side === u.side) continue;
    const d = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * Beyond this a unit ignores the enemy it can see and just advances.
 *
 * Without it every unit walks at whichever single enemy happens to be nearest, the
 * whole army converges on one point, and instead of a front you get a knot. Holding
 * your own lane until the enemy is genuinely close is what spreads the two sides
 * into facing lines.
 */
const ENGAGE_RANGE = 190;

function retarget(w: World, u: Unit): void {
  const enemy = nearestEnemy(w, u);
  if (enemy && Math.hypot(enemy.x - u.x, enemy.y - u.y) < ENGAGE_RANGE) {
    u.tx = enemy.x;
    u.ty = enemy.y;
    return;
  }
  // Otherwise push straight across at the enemy's half, keeping this unit's own
  // latitude, so the army advances as a broad line rather than a column.
  const capital = w.map.cities[u.side === BLUE ? 1 : 0]!;
  u.tx = capital.x * TILE;
  u.ty = u.y + (capital.y * TILE - u.y) * 0.12;
}

/** Steps the unit, sliding along water and cliffs instead of walking into them. */
function move(w: World, u: Unit, dt: number): void {
  const dx = u.tx - u.x;
  const dy = u.ty - u.y;
  const dist = Math.hypot(dx, dy);
  const speed = speedOf(w, u);

  let ax = 0;
  let ay = 0;
  if (dist > CONTACT * 0.8 && speed > 0) {
    ax = (dx / dist) * speed;
    ay = (dy / dist) * speed;
  }

  // Separation: keeps the mass from collapsing into a single dot and is what
  // spreads a crowd out into a line along the contact edge.
  let sx = 0;
  let sy = 0;
  for (const o of w.units) {
    if (o === u || !o.alive) continue;
    const ox = u.x - o.x;
    const oy = u.y - o.y;
    const d = Math.hypot(ox, oy);
    if (d > SEPARATION || d < 1e-4) continue;
    const push = (1 - d / SEPARATION) / d;
    sx += ox * push;
    sy += oy * push;
  }

  u.vx += (ax + sx * speed * 2.2 - u.vx) * 0.25;
  u.vy += (ay + sy * speed * 2.2 - u.vy) * 0.25;

  const nx = u.x + u.vx * dt;
  const ny = u.y + u.vy * dt;
  const blockedX = passable(w, nx, u.y);
  const blockedY = passable(w, u.x, ny);
  if (passable(w, nx, ny)) {
    u.x = nx;
    u.y = ny;
  } else if (blockedX) {
    u.x = nx;
  } else if (blockedY) {
    u.y = ny;
  }
  u.x = Math.min(Math.max(u.x, 4), w.map.worldW - 4);
  u.y = Math.min(Math.max(u.y, 4), w.map.worldH - 4);
}

function passable(w: World, x: number, y: number): boolean {
  const t = terrainAt(w.map, x, y);
  return t !== Terrain.Mountain && t !== Terrain.Water;
}

function fight(w: World, dt: number): void {
  for (const u of w.units) u.inCombat = false;

  for (let i = 0; i < w.units.length; i++) {
    const a = w.units[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < w.units.length; j++) {
      const b = w.units[j]!;
      if (!b.alive || b.side === a.side) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > CONTACT) continue;
      a.inCombat = true;
      b.inCombat = true;
      b.hp -= (a.heavy ? DAMAGE_HEAVY : DAMAGE_LIGHT) * dt;
      a.hp -= (b.heavy ? DAMAGE_HEAVY : DAMAGE_LIGHT) * dt;
    }
  }

  for (const u of w.units) {
    if (u.alive && u.hp <= 0) {
      u.alive = false;
      u.hp = 0;
    }
  }
}

export function step(w: World): void {
  w.tick++;
  const dt = TICK;

  for (const u of w.units) {
    if (!u.alive) continue;
    // Re-aiming every unit every tick is wasted work and makes them jitter, so
    // each one re-checks roughly twice a second on its own offset.
    if ((w.tick + (u.heavy ? 7 : 0)) % 15 === 0 || u.tx === u.x) retarget(w, u);
    move(w, u, dt);
  }

  fight(w, dt);

  for (const side of [BLUE, RED]) {
    w.reinforce[side] -= dt;
    if (w.reinforce[side]! <= 0) {
      w.reinforce[side] = REINFORCE_EVERY;
      reinforce(w, side, REINFORCE_COUNT);
    }
  }

  // Bodies are dropped once in a while rather than every tick, to keep the array
  // stable while the render loop is walking it.
  if (w.tick % 60 === 0) {
    w.units = w.units.filter((u) => u.alive);
    if (w.units.length > 400) w.units.length = 400;
  }

  if (w.tick % FRONT_EVERY === 0) {
    w.front = computeFront(w.units, w.map.worldW, w.map.worldH);
  }
}

/** Scatters a few units at the start so the opening does not look like a parade. */
export function jostle(w: World): void {
  for (const u of w.units) {
    const spot = findOpenSpot(w, u.x, u.y, 6);
    u.x = spot.x;
    u.y = spot.y;
    u.vx = rand(w.rng) * 2 - 1;
    u.vy = rand(w.rng) * 2 - 1;
  }
}
