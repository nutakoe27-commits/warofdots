/**
 * Victory conditions and player elimination.
 *
 * All three modes are evaluated per *team*, so a 2v2 with a bot ally works without
 * a special case. The default mode needs both halves of the condition — an enemy
 * capital in hand and control of most of the map — so a lucky capital snipe does
 * not end a match that is otherwise even.
 */

import { VictoryMode } from './types.ts';
import type { World } from './types.ts';
import { TICK_SEC } from './balance.ts';
import { armySize } from './units.ts';
import { teamScore, teamsInPlay } from './stats.ts';

function updateElimination(world: World): void {
  for (let p = 1; p < world.players.length; p++) {
    const player = world.players[p]!;
    if (!player.alive) continue;
    const hasCity = world.cities.some((c) => c.owner === p);
    if (hasCity || armySize(world, p) > 0) continue;
    player.alive = false;
    world.events.push({ t: 'eliminated', player: p });
  }
}

function liveTeams(world: World): number[] {
  const teams = new Set<number>();
  for (let p = 1; p < world.players.length; p++) {
    if (world.players[p]!.alive) teams.add(world.players[p]!.team);
  }
  return [...teams].sort((a, b) => a - b);
}

function playersOfTeam(world: World, team: number): number[] {
  const out: number[] = [];
  for (let p = 1; p < world.players.length; p++) {
    if (world.players[p]!.team === team) out.push(p);
  }
  return out;
}

/** True when `team` holds ≥ `majorityShare` of the cities and an enemy capital. */
function holdsCapitalAndMajority(world: World, team: number): boolean {
  const members = new Set(playersOfTeam(world, team));
  let owned = 0;
  let enemyCapital = false;
  for (const city of world.cities) {
    if (!members.has(city.owner)) continue;
    owned++;
    if (city.capital && !members.has(city.originalOwner)) enemyCapital = true;
  }
  if (!enemyCapital) return false;
  return owned / world.cities.length >= world.settings.majorityShare;
}

function finish(
  world: World,
  team: number,
  reason: 'capital' | 'annihilation' | 'timeout' | 'lastStanding' | 'draw',
): void {
  world.outcome = {
    team,
    winners: team < 0 ? [] : playersOfTeam(world, team),
    reason,
    tick: world.tick,
  };
}

function checkTimeout(world: World): void {
  if (world.tick * TICK_SEC < world.settings.timeLimitSec) return;
  let bestTeam = -1;
  let best = -Infinity;
  let tie = false;
  for (const team of teamsInPlay(world)) {
    const score = teamScore(world, team);
    if (score > best) {
      best = score;
      bestTeam = team;
      tie = false;
    } else if (score === best) {
      tie = true;
    }
  }
  finish(world, tie ? -1 : bestTeam, tie ? 'draw' : 'timeout');
}

export function stepVictory(world: World): void {
  if (world.outcome) return;
  updateElimination(world);

  const alive = liveTeams(world);
  if (alive.length === 0) {
    finish(world, -1, 'draw');
    return;
  }
  if (alive.length === 1) {
    finish(world, alive[0]!, world.settings.victory === VictoryMode.Annihilation ? 'annihilation' : 'lastStanding');
    return;
  }

  if (world.settings.victory === VictoryMode.CapitalAndMajority) {
    for (const team of alive) {
      if (holdsCapitalAndMajority(world, team)) {
        finish(world, team, 'capital');
        return;
      }
    }
  }
  if (world.settings.victory === VictoryMode.TimedScore) checkTimeout(world);
}
