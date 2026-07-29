/**
 * Income, upkeep, supply and the three kinds of attrition.
 *
 * Money is held per city rather than per player (ADR-004). A pocket's treasury is
 * the sum of its cities' shares, which means splitting and re-merging a front
 * needs no bookkeeping: cut a player in half and each half automatically keeps the
 * money that sits behind its own cities.
 */

import type { Pocket, World } from './types.ts';
import { B, CAPITAL_INCOME_MULT } from './balance.ts';
import { isInsideCity } from './terrain.ts';
import { applyAttrition } from './combat.ts';

/** ECO/sec a pocket earns. Disabled cities still pay — they only stop producing. */
function pocketIncome(world: World, pocket: Pocket): number {
  const handicap = world.players[pocket.player]!.ecoHandicap;
  let income = 0;
  for (const ci of pocket.cities) {
    const city = world.cities[ci]!;
    income += B.CITY_INCOME * (city.capital ? CAPITAL_INCOME_MULT : 1);
  }
  return income * handicap;
}

function pocketUpkeep(world: World, pocket: Pocket): number {
  const u = world.units;
  let outside = 0;
  for (const slot of pocket.units) {
    if (!isInsideCity(world.map, u.x[slot]!, u.y[slot]!)) outside++;
  }
  return outside * B.UPKEEP;
}

/** Spreads a delta evenly across the pocket's cities and reports the shortfall. */
function creditPocket(world: World, pocket: Pocket, delta: number): number {
  if (pocket.cities.length === 0) return delta < 0 ? -delta : 0;
  const share = delta / pocket.cities.length;
  let debt = 0;
  for (const ci of pocket.cities) {
    const city = world.cities[ci]!;
    const next = city.eco + share;
    if (next < 0) {
      debt -= next;
      city.eco = 0;
    } else {
      city.eco = next;
    }
  }
  return debt;
}

/**
 * Picks which units go hungry when a pocket is over its supply cap.
 * `healthiestFirst` is the default: it spreads the pain so a player loses combat
 * effectiveness gradually instead of watching their wounded evaporate at once.
 */
function orderForStarvation(world: World, pocket: Pocket): number[] {
  const u = world.units;
  const order = pocket.units.slice();
  const strategy = world.settings.starveStrategy;
  order.sort((a, b) => {
    let cmp: number;
    if (strategy === 'newestFirst') cmp = u.bornTick[b]! - u.bornTick[a]!;
    else if (strategy === 'weakestFirst') cmp = u.hp[a]! - u.hp[b]!;
    else cmp = u.hp[b]! - u.hp[a]!;
    return cmp !== 0 ? cmp : u.id[a]! - u.id[b]!;
  });
  return order;
}

function applyStarvation(world: World, pocket: Pocket, dt: number, bankrupt: boolean): void {
  const overflow = Math.max(0, pocket.supplyUsed - pocket.supplyCap);
  if (overflow === 0 && !bankrupt) return;

  if (bankrupt) {
    for (const slot of pocket.units) applyAttrition(world, slot, B.STARVE_DPS * dt);
    return;
  }
  const order = orderForStarvation(world, pocket);
  for (let i = 0; i < overflow && i < order.length; i++) {
    applyAttrition(world, order[i]!, B.STARVE_DPS * dt);
  }
}

function applyEncirclement(world: World, dt: number): void {
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || !u.encircled[i]) continue;
    applyAttrition(world, i, B.ENCIRCLED_DPS * dt);
  }
}

export function stepEconomy(world: World, dt: number): void {
  for (const pocket of world.influence.pockets) {
    const income = pocketIncome(world, pocket);
    const upkeep = pocketUpkeep(world, pocket);
    pocket.ecoRate = income - upkeep;
    const debt = creditPocket(world, pocket, pocket.ecoRate * dt);

    let eco = 0;
    for (const ci of pocket.cities) eco += world.cities[ci]!.eco;
    pocket.eco = eco;

    applyStarvation(world, pocket, dt, debt > 0);
  }
  applyEncirclement(world, dt);
}

/** Spends `amount` from a pocket, pulling proportionally from its cities. */
export function spendFromPocket(world: World, pocket: Pocket, amount: number): boolean {
  if (pocket.eco < amount || amount <= 0) return false;
  let remaining = amount;
  const total = pocket.eco;
  for (let i = 0; i < pocket.cities.length; i++) {
    const city = world.cities[pocket.cities[i]!]!;
    const take = i === pocket.cities.length - 1 ? remaining : Math.min(city.eco, (city.eco / total) * amount);
    city.eco -= take;
    if (city.eco < 0) city.eco = 0;
    remaining -= take;
  }
  pocket.eco = Math.max(0, pocket.eco - amount);
  return true;
}

/** Total supply capacity and usage for a player, summed over their pockets. */
export function supplyOf(world: World, player: number): { cap: number; used: number } {
  let cap = 0;
  let used = 0;
  for (const pocket of world.influence.pockets) {
    if (pocket.player !== player) continue;
    cap += pocket.supplyCap;
    used += pocket.supplyUsed;
  }
  return { cap, used };
}

export function ecoRateOf(world: World, player: number): number {
  let rate = 0;
  for (const pocket of world.influence.pockets) {
    if (pocket.player === player) rate += pocket.ecoRate;
  }
  return rate;
}
