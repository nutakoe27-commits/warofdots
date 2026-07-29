/**
 * Command application — the only way anything outside the simulation can change
 * the world. Player input and bot decisions go through the same door, which is
 * what makes replays and headless bot-vs-bot runs possible.
 *
 * Commands address units by stable id, never by slot, and every command is
 * re-validated here: ownership is checked on arrival, so a bug in a bot cannot
 * move somebody else's army.
 */

import type { Command, World } from './types.ts';
import { FORMATION_MAX_FILES, FORMATION_SPACING, PATH_SIMPLIFY_EPS } from './balance.ts';
import { allocPath, releasePath, retainPath, samplePath, makePathSample, pathLength } from './paths.ts';
import { rdpSimplify } from './geometry.ts';
import { clamp } from './geometry.ts';
import { slotOfId } from './units.ts';

const sample = makePathSample();

/** Resolves ids to slots, dropping anything dead or not owned by `player`. */
function resolveUnits(world: World, player: number, ids: number[]): number[] {
  const u = world.units;
  const out: number[] = [];
  for (const id of ids) {
    const slot = slotOfId(u, id);
    if (slot < 0 || !u.alive[slot] || u.owner[slot] !== player) continue;
    out.push(slot);
  }
  return out;
}

function clearPath(world: World, slot: number, halt: boolean): void {
  const u = world.units;
  releasePath(world.paths, u.pathIdx[slot]!);
  u.pathIdx[slot] = -1;
  u.pathPos[slot] = 0;
  u.lateral[slot] = 0;
  if (halt) {
    u.vx[slot] = 0;
    u.vy[slot] = 0;
  }
}

/**
 * Spreads a selection across the width of the drawn path.
 *
 * Units keep their left-to-right order relative to the path's heading, so a line
 * of infantry ordered forward stays a line instead of shuffling. Selections wider
 * than `FORMATION_MAX_FILES` wrap, and the extra units stack up behind their file —
 * separation then pushes them into ranks on its own.
 */
function assignFormation(world: World, slots: number[], pathIdx: number): void {
  const u = world.units;
  samplePath(world.paths, pathIdx, 0, sample);
  const nx = -sample.ty;
  const ny = sample.tx;

  const ordered = slots.slice().sort((a, b) => {
    const pa = u.x[a]! * nx + u.y[a]! * ny;
    const pb = u.x[b]! * nx + u.y[b]! * ny;
    return pa !== pb ? pa - pb : u.id[a]! - u.id[b]!;
  });

  const files = Math.max(1, Math.min(ordered.length, FORMATION_MAX_FILES));
  const centre = (files - 1) / 2;
  for (let i = 0; i < ordered.length; i++) {
    u.lateral[ordered[i]!] = ((i % files) - centre) * FORMATION_SPACING;
  }
}

/** Remaining vertices of a unit's current path, used when a new order is appended. */
function remainingPath(world: World, slot: number): number[] {
  const u = world.units;
  const idx = u.pathIdx[slot]!;
  if (idx < 0) return [];
  const total = pathLength(world.paths, idx);
  const out: number[] = [];
  const step = 6;
  for (let s = u.pathPos[slot]!; s < total; s += step) {
    samplePath(world.paths, idx, s, sample);
    out.push(sample.x, sample.y);
  }
  return out;
}

function applyPath(world: World, cmd: Extract<Command, { t: 'path' }>): void {
  const slots = resolveUnits(world, cmd.player, cmd.units);
  if (slots.length === 0 || cmd.pts.length < 4) return;

  const simplified = rdpSimplify(cmd.pts, PATH_SIMPLIFY_EPS);
  const u = world.units;

  if (cmd.append) {
    // Appending is per-unit: each unit's remaining route differs, so they cannot
    // share one pooled polyline.
    for (const slot of slots) {
      const joined = [...remainingPath(world, slot), ...simplified];
      const idx = allocPath(world.paths, joined);
      clearPath(world, slot, false);
      if (idx < 0) continue;
      retainPath(world.paths, idx);
      u.pathIdx[slot] = idx;
      u.pathPos[slot] = 0;
    }
    return;
  }

  const idx = allocPath(world.paths, simplified);
  if (idx < 0) return;
  for (const slot of slots) {
    clearPath(world, slot, false);
    retainPath(world.paths, idx);
    u.pathIdx[slot] = idx;
    u.pathPos[slot] = 0;
  }
  assignFormation(world, slots, idx);
}

export function applyCommands(world: World, commands: readonly Command[]): void {
  for (const cmd of commands) {
    if (cmd.player < 1 || cmd.player >= world.players.length) continue;
    switch (cmd.t) {
      case 'path':
        applyPath(world, cmd);
        break;
      case 'stop':
        for (const slot of resolveUnits(world, cmd.player, cmd.units)) clearPath(world, slot, true);
        break;
      case 'clear':
        for (const slot of resolveUnits(world, cmd.player, cmd.units)) clearPath(world, slot, false);
        break;
      case 'production': {
        const player = world.players[cmd.player]!;
        player.threshold = clamp(cmd.threshold, 0, 1);
        player.heavyShare = clamp(cmd.heavyShare, 0, 1);
        break;
      }
      case 'cityActive': {
        const city = world.cities[cmd.city];
        if (city && city.owner === cmd.player) city.active = cmd.active;
        break;
      }
      case 'resign':
        world.players[cmd.player]!.alive = false;
        break;
    }
  }
}
