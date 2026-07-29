/** Per-player aggregates for the HUD, the end screen and the bots' strategic view. */

import type { World } from './types.ts';
import { SCORE_PER_CITY, SCORE_PER_UNIT, SCORE_TERRITORY, STATS_SAMPLE_TICKS } from './balance.ts';
import { territoryShares } from './influence.ts';
import { ecoRateOf, supplyOf } from './economy.ts';
import { armySize } from './units.ts';
import { playerEco } from './world.ts';

export function updateStats(world: World): void {
  const shares = territoryShares(world);
  for (let p = 1; p < world.players.length; p++) {
    const s = world.stats.players[p]!;
    const supply = supplyOf(world, p);
    s.citiesNow = world.cities.reduce((n, c) => n + (c.owner === p ? 1 : 0), 0);
    s.armyNow = armySize(world, p);
    s.ecoNow = playerEco(world, p);
    s.ecoRate = ecoRateOf(world, p);
    s.supplyCap = supply.cap;
    s.territory = shares[p] ?? 0;
    if (s.armyNow > s.peakArmy) s.peakArmy = s.armyNow;
    s.score =
      s.citiesNow * SCORE_PER_CITY + s.armyNow * SCORE_PER_UNIT + s.territory * SCORE_TERRITORY;
  }
}

export function sampleHistory(world: World): void {
  if (world.tick % STATS_SAMPLE_TICKS !== 0) return;
  const eco: number[] = [world.tick];
  const army: number[] = [world.tick];
  for (let p = 1; p < world.players.length; p++) {
    eco.push(Math.round(world.stats.players[p]!.ecoNow));
    army.push(world.stats.players[p]!.armyNow);
  }
  world.stats.ecoHistory.push(eco);
  world.stats.armyHistory.push(army);
}

/** Combined score of a team, used by the timed victory mode. */
export function teamScore(world: World, team: number): number {
  let total = 0;
  for (let p = 1; p < world.players.length; p++) {
    if (world.players[p]!.team === team) total += world.stats.players[p]!.score;
  }
  return total;
}

export function teamsInPlay(world: World): number[] {
  const teams = new Set<number>();
  for (let p = 1; p < world.players.length; p++) teams.add(world.players[p]!.team);
  return [...teams].sort((a, b) => a - b);
}
