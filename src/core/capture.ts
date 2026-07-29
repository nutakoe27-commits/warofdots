/**
 * City capture.
 *
 * Presence-based rather than influence-based: you take a city by standing in it
 * with nobody contesting you. Influence decides where the map is coloured; boots
 * decide who owns the buildings.
 */

import type { World } from './types.ts';
import { CAPTURE_DECAY_MULT, CAPTURE_SEC } from './balance.ts';
import { cityAt } from './terrain.ts';

let presence = new Int32Array(0);

function ensurePresence(n: number): void {
  if (presence.length < n) presence = new Int32Array(n);
}

function flipOwner(world: World, cityIndex: number, to: number): void {
  const city = world.cities[cityIndex]!;
  const from = city.owner;
  city.owner = to;
  city.captureProgress = 0;
  city.capturingPlayer = -1;
  city.spawnCooldown = 0;
  // A captured city keeps producing for its new owner by default, and its
  // treasury share transfers with it — the money is physically in the city.
  city.active = true;
  world.stats.players[to]!.captured++;
  world.events.push({ t: 'capture', city: cityIndex, from, to });
}

export function stepCapture(world: World, dt: number): void {
  const cities = world.cities;
  const players = world.players.length;
  ensurePresence(cities.length * players);
  presence.fill(0, 0, cities.length * players);

  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    const ci = cityAt(world.map, u.x[i]!, u.y[i]!);
    if (ci < 0) continue;
    presence[ci * players + u.owner[i]!]!++;
  }

  for (let ci = 0; ci < cities.length; ci++) {
    const city = cities[ci]!;
    const base = ci * players;
    const defenders = presence[base + city.owner]!;

    let contender = -1;
    let contenders = 0;
    for (let p = 1; p < players; p++) {
      if (p === city.owner || presence[base + p]! === 0) continue;
      contenders++;
      contender = p;
    }

    const canCapture = defenders === 0 && contenders === 1;
    if (!canCapture) {
      city.captureProgress = Math.max(
        0,
        city.captureProgress - (dt / CAPTURE_SEC) * CAPTURE_DECAY_MULT,
      );
      if (city.captureProgress === 0) city.capturingPlayer = -1;
      continue;
    }

    if (city.capturingPlayer !== contender) {
      city.capturingPlayer = contender;
      city.captureProgress = 0;
    }
    city.captureProgress += dt / CAPTURE_SEC;
    if (city.captureProgress >= 1) flipOwner(world, ci, contender);
  }
}
