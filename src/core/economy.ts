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

function pocketTreasury(world: World, pocket: Pocket): number {
  let total = 0;
  for (const ci of pocket.cities) total += world.cities[ci]!.eco;
  return total;
}

/**
 * Takes `amount` out of a pocket, drawing from each city in proportion to what it
 * holds, and returns whatever could not be covered.
 *
 * Proportional rather than even: an even split would let one broke city report a
 * shortfall — and so starve the whole pocket — while the city next door is sitting
 * on a treasury.
 */
function withdraw(world: World, pocket: Pocket, amount: number): number {
  if (amount <= 0) return 0;
  const total = pocketTreasury(world, pocket);
  if (total <= 0) return amount;
  if (total <= amount) {
    for (const ci of pocket.cities) world.cities[ci]!.eco = 0;
    return amount - total;
  }
  let remaining = amount;
  const last = pocket.cities.length - 1;
  for (let i = 0; i <= last; i++) {
    const city = world.cities[pocket.cities[i]!]!;
    const take = i === last ? remaining : Math.min(city.eco, (city.eco / total) * amount);
    city.eco = Math.max(0, city.eco - take);
    remaining -= take;
  }
  return 0;
}

/** Applies a per-second delta to a pocket's treasury and reports the shortfall. */
function creditPocket(world: World, pocket: Pocket, delta: number): number {
  if (pocket.cities.length === 0) return delta < 0 ? -delta : 0;
  if (delta < 0) return withdraw(world, pocket, -delta);
  const share = delta / pocket.cities.length;
  for (const ci of pocket.cities) world.cities[ci]!.eco += share;
  return 0;
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

/** Spends `amount` from a pocket. Fails, changing nothing, if it cannot afford it. */
export function spendFromPocket(world: World, pocket: Pocket, amount: number): boolean {
  if (amount <= 0 || pocketTreasury(world, pocket) < amount) return false;
  withdraw(world, pocket, amount);
  pocket.eco = pocketTreasury(world, pocket);
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
