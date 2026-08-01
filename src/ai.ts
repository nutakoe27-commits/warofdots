/**
 * The enemy general.
 *
 * It plays the same game the player does — it can only select units and draw them
 * routes. No extra speed, no extra damage, no seeing through fog it has not
 * earned. Difficulty is entirely a matter of how well it decides, which means a
 * hard setting is beatable by playing better rather than by out-clicking a
 * handicap.
 *
 * The whole plan is built out of sectors. The front is cut into horizontal bands;
 * each band gets a strength for both sides; and every decision is a comparison
 * between two numbers in a band. That is crude, and it is also roughly what a
 * commander with a map and a grease pencil is doing.
 */

import { findPath } from './nav.ts';
import { TILE } from './terrain.ts';
import { supplied } from './sim.ts';
import { RED } from './world.ts';
import type { Unit, World } from './world.ts';

export interface Difficulty {
  name: string;
  blurb: string;
  /** Ticks between plans. Slower is not just weaker, it is visibly slower to react. */
  thinkEvery: number;
  /**
   * Local superiority it wants before it will attack a sector.
   *
   * Under 1 means it attacks even at parity, which is reckless — attacking costs
   * far more than holding — and is exactly what makes the easy settings easy. The
   * hard ones sit above 1 and get their superiority by *making* it: shifting
   * troops out of quiet sectors unbalances a band, which is what unlocks the
   * attack. That is the whole difference between the two halves of this list.
   */
  attackRatio: number;
  /** Whether it will move troops out of quiet sectors to mass somewhere else. */
  concentrate: boolean;
  /** Pull a unit out of the line to heal below this health. 0 never does. */
  withdrawAt: number;
  /** Whether it sends spare troops to take undefended points. */
  takePoints: boolean;
  /** Whether it tries to get behind a weak sector and cut it off rather than just push. */
  encircle: boolean;
}

export const DIFFICULTIES: Difficulty[] = [
  {
    name: 'Новобранец',
    blurb: 'Лезет вперёд почти всегда и по всему фронту сразу. Обороняйтесь — он сам себя выбьет.',
    thinkEvery: 180,
    attackRatio: 0.9,
    concentrate: false,
    withdrawAt: 0,
    takePoints: false,
    encircle: false,
  },
  {
    name: 'Обычный',
    blurb: 'Держит ровный фронт, давит при первой возможности, подбирает ничейные точки.',
    thinkEvery: 110,
    attackRatio: 0.98,
    concentrate: false,
    withdrawAt: 0,
    takePoints: true,
    encircle: false,
  },
  {
    name: 'Ветеран',
    blurb: 'Снимает войска с тихих участков, бьёт в слабое место, уводит раненых лечиться.',
    thinkEvery: 70,
    attackRatio: 1.05,
    concentrate: true,
    withdrawAt: 0.35,
    takePoints: true,
    encircle: false,
  },
  {
    name: 'Генерал',
    blurb: 'То же, но быстрее — и заходит в тыл, чтобы отрезать вас от снабжения.',
    thinkEvery: 45,
    attackRatio: 0.95,
    concentrate: true,
    withdrawAt: 0.4,
    takePoints: true,
    encircle: true,
  },
];

/** Bands the front is cut into. Fewer and it cannot tell a flank from the centre. */
const SECTORS = 7;
/** How far up and down the band a unit counts toward it. */
const SECTOR_PAD = 40;
/** Searches it may run per plan, for the same reason the player's orders are capped. */
const SEARCH_BUDGET = 4;
/**
 * How far the target can drift before a route already being walked is re-cut.
 * Purely an anti-thrash number.
 */
const SETTLED = 90;
/**
 * How close a unit that has *finished* its route has to be to where it should be
 * standing before it is left alone.
 *
 * This started out as the same number as SETTLED, which quietly turned it into a
 * standoff distance: a unit walked to where it was sent, arrived, and every plan
 * after that decided it was near enough. Combined with the twenty-two it was
 * supposed to close to, the whole army halted a hundred and twelve units from the
 * enemy and three of the four difficulties never fought at all.
 */
const ARRIVED = 18;
/** Close enough to a point to be resupplied by it; no need to stand on its toes. */
const SUPPLY_CLOSE = 60;
/**
 * Fraction of the opposing strength a sector needs to keep in order to hold.
 * Under one because holding beats attacking here — that is the surplus the whole
 * idea of a schwerpunkt is paid for out of.
 */
const HOLD_MARGIN = 0.8;
/**
 * How close a holding unit forms up to the enemy, world units. Inside engagement
 * range on purpose: at forty it hovered just out of reach and two armies spent
 * eight minutes looking at each other.
 */
const HOLD_AT = 22;

export interface Brain {
  side: number;
  level: Difficulty;
  nextThink: number;
  budget: number;
}

export function createBrain(side: number, level: Difficulty): Brain {
  return { side, level, nextThink: 30, budget: 0 };
}

interface Sector {
  /** Band centre, world units. */
  y: number;
  own: number;
  foe: number;
  /** Where the fighting is in this band, world x. */
  frontX: number;
}

/** Health-weighted, because ten men at a tenth are not ten men. */
function strength(u: Unit): number {
  return (u.heavy ? 1.5 : 1) * Math.max(0.15, u.hp);
}

function survey(w: World, side: number): Sector[] {
  const band = w.map.worldH / SECTORS;
  const out: Sector[] = [];
  for (let i = 0; i < SECTORS; i++) {
    const y = (i + 0.5) * band;
    let own = 0;
    let foe = 0;
    let sum = 0;
    let n = 0;
    for (const u of w.units) {
      if (!u.alive || Math.abs(u.y - y) > band / 2 + SECTOR_PAD) continue;
      if (u.side === side) own += strength(u);
      else {
        foe += strength(u);
        sum += u.x;
        n++;
      }
    }
    out.push({ y, own, foe, frontX: n > 0 ? sum / n : w.map.worldW / 2 });
  }
  return out;
}

function send(w: World, brain: Brain, u: Unit, x: number, y: number): void {
  const tx = Math.min(Math.max(x, 30), w.map.worldW - 30);
  const ty = Math.min(Math.max(y, 30), w.map.worldH - 30);
  if (brain.budget > 0) {
    brain.budget--;
    const p = findPath(w.map, u.x, u.y, tx, ty);
    if (p && p.length > 2) {
      u.path = p.slice(2);
      u.leg = 0;
      u.lateral = 0;
      u.stuck = 0;
      return;
    }
  }
  // No search left: walk at it and let the stuck check sort out the detour, the
  // same deal the player's own orders get when a whole army moves at once.
  u.path = [tx, ty];
  u.leg = 0;
  u.lateral = 0;
  u.stuck = 0;
}

/**
 * Issues an order unless the unit is already carrying out that same one.
 *
 * Without this the plan re-cuts every unit's route several times a second at the
 * hard settings, and a unit whose orders keep being replaced never gets anywhere:
 * it spends its life on the first leg of successive routes.
 */
function order(w: World, brain: Brain, u: Unit, x: number, y: number): void {
  const p = u.path;
  if (p && p.length >= 2 && Math.hypot(p[p.length - 2]! - x, p[p.length - 1]! - y) < SETTLED) return;
  if (!p && Math.hypot(u.x - x, u.y - y) < ARRIVED) return;
  send(w, brain, u, x, y);
}

/** Which way is forward for this side, in world x. */
function forward(side: number): number {
  return side === RED ? -1 : 1;
}

function nearestFoe(w: World, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const o of w.units) {
    if (!o.alive || o.side === u.side) continue;
    const d = Math.hypot(o.x - u.x, o.y - u.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function nearestPoint(w: World, u: Unit, want: (owner: number) => boolean): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const c of w.map.cities) {
    if (!want(c.owner)) continue;
    const x = c.x * TILE;
    const y = c.y * TILE;
    const d = Math.hypot(x - u.x, y - u.y);
    if (d < bestD) {
      bestD = d;
      best = { x, y };
    }
  }
  return best;
}

/**
 * One plan.
 *
 * Order matters: the jobs that take a unit out of the line are decided first, so
 * a man who is being pulled back to heal is not also being sent to attack.
 */
function think(w: World, brain: Brain): void {
  const side = brain.side;
  const lvl = brain.level;
  brain.budget = SEARCH_BUDGET;

  const sectors = survey(w, side);
  const dir = forward(side);

  // Every sector it is strong enough to push in, and the one worst off.
  //
  // Every, not the best one: with the front cut into seven, attacking in only the
  // single best band means six sevenths of the army stands still and the two easy
  // settings — whose whole character is supposed to be that they attack too
  // readily — could not tell themselves apart from each other in eight minutes.
  const pushing: boolean[] = [];
  // The thinnest sector the enemy is actually in. "Actually in" matters: the top
  // and bottom bands run off the end of the deployment, so they hold almost
  // nobody, and an army that masses on the emptiest band walks the whole force
  // into a corner of the map to fight two men.
  let weakest = -1;
  sectors.forEach((s, i) => {
    pushing[i] = s.own > 0 && s.own / Math.max(0.6, s.foe) > lvl.attackRatio;
    if (s.foe > 0 && (weakest < 0 || s.foe < sectors[weakest]!.foe)) weakest = i;
  });
  if (weakest < 0) weakest = 0;

  /**
   * How much each sector can send elsewhere.
   *
   * The trick that makes concentration possible at all: holding costs less than
   * attacking in this game, so a sector can hold with rather fewer men than it
   * faces and release the difference. The old rule only released troops from a
   * sector that was already a third stronger than its opposite number, which at
   * the start of a symmetrical battle is nowhere — so the settings that were
   * supposed to mass never massed, never got the local superiority their attack
   * threshold wanted, and stood still for the whole match.
   */
  const spare = sectors.map((s, i) => (i === weakest ? 0 : Math.max(0, s.own - s.foe * HOLD_MARGIN)));

  const band = w.map.worldH / SECTORS;
  const taken = new Set<number>();

  for (const u of w.units) {
    if (!u.alive || u.side !== side) continue;

    // In contact: leave it there. Pulling a unit out of a fight it is holding is
    // how a line comes apart, and it walks away at a shove anyway.
    if (u.inCombat && u.hp > lvl.withdrawAt) continue;

    // Cut off, or too hurt to be useful: get it home.
    const home = nearestPoint(w, u, (o) => o === side);
    if (!home) continue;
    if (!supplied(u) || (lvl.withdrawAt > 0 && u.hp < lvl.withdrawAt)) {
      if (Math.hypot(u.x - home.x, u.y - home.y) > SUPPLY_CLOSE) {
        send(w, brain, u, home.x, home.y);
        taken.add(u.id);
      }
    }
  }

  // One spare man per plan goes and takes something nobody is holding. One,
  // because a point is worth a unit's time and not a detachment's.
  if (lvl.takePoints) {
    for (const u of w.units) {
      if (!u.alive || u.side !== side || taken.has(u.id) || u.inCombat) continue;
      const grab = nearestPoint(w, u, (o) => o !== side);
      if (!grab) continue;
      const mine = Math.hypot(u.x - grab.x, u.y - grab.y);
      const contested = w.units.some(
        (o) => o.alive && o.side !== side && Math.hypot(o.x - grab.x, o.y - grab.y) < mine,
      );
      if (contested) continue;
      send(w, brain, u, grab.x, grab.y);
      taken.add(u.id);
      break;
    }
  }

  for (const u of w.units) {
    if (!u.alive || u.side !== side || taken.has(u.id)) continue;

    const mine = Math.min(SECTORS - 1, Math.max(0, Math.floor(u.y / band)));
    // Spare men from a sector that can hold without them go to the schwerpunkt.
    if (!u.inCombat && lvl.concentrate && mine !== weakest && spare[mine]! > 0) {
      spare[mine]! -= strength(u);
      const s = sectors[weakest]!;
      order(w, brain, u, s.frontX - dir * 60, s.y);
      continue;
    }

    // Everything else is relative to the nearest enemy rather than to the band's
    // average, which turned out to matter enormously: the average of nine men
    // spread across a band is a spot with nobody standing on it, so a line formed
    // up on it ended up nowhere near anybody and the two armies drifted about
    // trading a dozen casualties in eight minutes.
    const foe = nearestFoe(w, u);
    if (!foe) {
      const goal = nearestPoint(w, u, (o) => o !== side);
      if (goal) order(w, brain, u, goal.x, goal.y);
      continue;
    }

    if (pushing[mine]) {
      // Press, and press with the units already in contact too. Being under
      // orders is precisely what makes a unit an attacker in this game, so an AI
      // that leaves its front line unordered is permanently on the defensive
      // whatever it thinks it is doing.
      //
      // A general aims further through rather than round: a push that carries on
      // into the rear cuts the corridor behind it, and that starves a pocket
      // without having to kill it.
      const depth = lvl.encircle ? 320 : 140;
      order(w, brain, u, foe.x + dir * depth, foe.y);
      continue;
    }

    // Not attacking here: anyone in contact is holding, and holding is the
    // stronger posture. Leave them.
    if (u.inCombat) continue;

    // Close on that particular enemy along the line joining them, stopping just
    // inside reach. Lining up on the enemy's *x* while keeping your own *y* puts
    // you twenty units from a spot where nobody is standing, which is how three
    // of the four difficulties managed to fight nobody for eight minutes.
    const dx = foe.x - u.x;
    const dy = foe.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, d - HOLD_AT) / d;
    order(w, brain, u, u.x + dx * k, u.y + dy * k);
  }
}

export function runBrain(w: World, brain: Brain): void {
  if (w.winner >= 0) return;
  if (w.tick < brain.nextThink) return;
  brain.nextThink = w.tick + brain.level.thinkEvery;
  think(w, brain);
}
