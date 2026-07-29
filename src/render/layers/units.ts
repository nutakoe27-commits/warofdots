/**
 * Unit layer: 600 dots without 600 state changes.
 *
 * Units are counting-sorted into buckets keyed by (owner, kind, HP level) once per
 * frame, so `fillStyle` is assigned a hundred times at most and every bucket is a
 * single `beginPath`/`fill` holding all of its circles. The HP level is quantised
 * on purpose: brightness has to track health, but building an `rgb()` string per
 * unit per frame would cost more than the drawing does.
 *
 * Combat shake is hashed from `(tick, unit id)` rather than sampled from a random
 * source, so a replay of the same match shakes in exactly the same places.
 */

import type { World } from '../../core/types.ts';
import { KIND_COUNT, Kind } from '../../core/types.ts';
import { DRAW_R } from '../../core/balance.ts';
import { slotOfId } from '../../core/units.ts';
import type { ViewBounds } from '../camera.ts';
import { visibleBounds, worldToScreenX, worldToScreenY } from '../camera.ts';
import type { FrameState, Layer } from '../frame.ts';
import { lerpX, lerpY } from '../frame.ts';
import { playerColor, playerColorDim } from '../theme.ts';

const TAU = Math.PI * 2;
/** Quantisation of HP into brightness steps. */
const HP_LEVELS = 6;
/** Brightness at zero HP, as a mix toward the full player colour. */
const LEVEL_FLOOR = 0.3;
/** Floor on the drawn radius so an army stays visible at minimum zoom. */
const MIN_RADIUS = 1.6;
/** Extra world units of cull padding, generous enough for rings and arcs. */
const CULL_PAD = 6;

const HEAVY_RING_FRAC = 0.46;
const HEAVY_RING_WIDTH = 1.2;
/** Below this drawn radius the inner ring is mush, so it is skipped. */
const HEAVY_RING_MIN_R = 3;
const HEAVY_RING_DARK = 'rgba(8,10,14,0.55)';
const HEAVY_RING_LIGHT = 'rgba(250,248,244,0.72)';

const HP_ARC_GAP = 1.6;
const HP_ARC_WIDTH = 1.4;
const HP_ARC_MIN_R = 3;
const HP_FULL = 0.995;
const HP_ARC_DARK = 'rgba(236,240,246,0.85)';
const HP_ARC_LIGHT = 'rgba(28,30,36,0.8)';

const JITTER_PX = 0.9;
/** Three bits of the hash per axis, mapped onto [-1, 1]. */
const JITTER_MASK = 7;
const JITTER_HALF = JITTER_MASK / 2;
const ENCIRCLE_DASH = [2, 2];
const NO_DASH: number[] = [];
const ENCIRCLE_WIDTH = 1.2;
const ENCIRCLE_GAP = 1;
const ENCIRCLE_DARK = 'rgba(255,236,180,0.9)';
const ENCIRCLE_LIGHT = 'rgba(120,60,10,0.85)';

const SELECT_GAP = 2.6;
const SELECT_WIDTH = 1.6;

interface UnitScratch {
  /** Bucket key per slot, or -1 when the slot is dead or off screen. */
  keys: Int32Array;
  sx: Float32Array;
  sy: Float32Array;
  /** Slots sorted by bucket, contiguous in `[0, visible)`. */
  order: Int32Array;
  start: Int32Array;
  end: Int32Array;
  fills: string[];
  levels: number;
  visible: number;
  bounds: ViewBounds;
}

function mixHex(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const mix = (shift: number): number => {
    const va = (na >> shift) & 0xff;
    const vb = (nb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t) & 0xff;
  };
  const packed = (mix(16) << 16) | (mix(8) << 8) | mix(0);
  return `#${packed.toString(16).padStart(6, '0')}`;
}

/** One colour per (player, HP level), dim at zero health, full colour at full. */
function buildFills(world: World, levels: number): string[] {
  const out: string[] = [];
  for (let p = 0; p < world.players.length; p++) {
    const ci = world.players[p]?.colorIndex ?? 0;
    const dim = playerColorDim(ci);
    const full = playerColor(ci);
    for (let l = 0; l < levels; l++) {
      const t = LEVEL_FLOOR + (1 - LEVEL_FLOOR) * (levels === 1 ? 1 : l / (levels - 1));
      out.push(mixHex(dim, full, t));
    }
  }
  return out;
}

function makeScratch(world: World): UnitScratch {
  const buckets = world.players.length * KIND_COUNT * HP_LEVELS;
  return {
    keys: new Int32Array(world.units.capacity),
    sx: new Float32Array(world.units.capacity),
    sy: new Float32Array(world.units.capacity),
    order: new Int32Array(world.units.capacity),
    start: new Int32Array(buckets),
    end: new Int32Array(buckets),
    fills: buildFills(world, HP_LEVELS),
    levels: HP_LEVELS,
    visible: 0,
    bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
  };
}

/** 32-bit avalanche of (tick, id). Deterministic, so replays shake identically. */
function jitterHash(tick: number, id: number): number {
  let h = (Math.imul(tick, 0x9e3779b1) + Math.imul(id, 0x85ebca6b)) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

function hpLevel(hp: number, levels: number): number {
  const l = (hp * levels) | 0;
  return l < 0 ? 0 : l >= levels ? levels - 1 : l;
}

function radiusOf(kind: number, zoom: number): number {
  const r = DRAW_R[kind]! * zoom;
  return r < MIN_RADIUS ? MIN_RADIUS : r;
}

/** Culls, interpolates, shakes, and counting-sorts the live units into buckets. */
function collect(world: World, frame: FrameState, s: UnitScratch): void {
  const u = world.units;
  const cam = frame.camera;
  const b = visibleBounds(cam, CULL_PAD, s.bounds);
  s.end.fill(0);

  for (let i = 0; i < u.capacity; i++) {
    s.keys[i] = -1;
    if (!u.alive[i]) continue;
    const wx = lerpX(frame, i);
    const wy = lerpY(frame, i);
    if (wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1) continue;

    let px = worldToScreenX(cam, wx);
    let py = worldToScreenY(cam, wy);
    if (u.inCombat[i]) {
      const h = jitterHash(world.tick, u.id[i]!);
      px += ((h & JITTER_MASK) / JITTER_HALF - 1) * JITTER_PX;
      py += (((h >>> 3) & JITTER_MASK) / JITTER_HALF - 1) * JITTER_PX;
    }
    s.sx[i] = px;
    s.sy[i] = py;

    const key = (u.owner[i]! * KIND_COUNT + u.kind[i]!) * s.levels + hpLevel(u.hp[i]!, s.levels);
    s.keys[i] = key;
    s.end[key]!++;
  }

  let sum = 0;
  for (let k = 0; k < s.end.length; k++) {
    s.start[k] = sum;
    sum += s.end[k]!;
    s.end[k] = sum;
  }
  s.visible = sum;

  // Walking backwards keeps each bucket in ascending slot order once `end` has
  // been consumed as a write head, which keeps the draw order stable frame to frame.
  for (let i = u.capacity - 1; i >= 0; i--) {
    const k = s.keys[i]!;
    if (k >= 0) s.order[--s.end[k]!] = i;
  }
  for (let k = 0; k < s.end.length; k++) s.end[k] = k + 1 < s.start.length ? s.start[k + 1]! : sum;
}

function bucketKind(bucket: number, levels: number): number {
  return ((bucket / levels) | 0) % KIND_COUNT;
}

function drawBodies(ctx: CanvasRenderingContext2D, frame: FrameState, s: UnitScratch): void {
  const zoom = frame.camera.zoom;
  for (let bucket = 0; bucket < s.start.length; bucket++) {
    const from = s.start[bucket]!;
    const to = s.end[bucket]!;
    if (from === to) continue;
    const level = bucket % s.levels;
    const owner = (bucket / (s.levels * KIND_COUNT)) | 0;
    ctx.fillStyle = s.fills[owner * s.levels + level]!;
    const r = radiusOf(bucketKind(bucket, s.levels), zoom);
    ctx.beginPath();
    for (let n = from; n < to; n++) {
      const i = s.order[n]!;
      ctx.moveTo(s.sx[i]! + r, s.sy[i]!);
      ctx.arc(s.sx[i]!, s.sy[i]!, r, 0, TAU);
    }
    ctx.fill();
  }
}

/** The inner ring that tells a heavy from a light at a glance. */
function drawHeavyRings(ctx: CanvasRenderingContext2D, frame: FrameState, s: UnitScratch): void {
  const zoom = frame.camera.zoom;
  ctx.strokeStyle = frame.theme.name === 'dark' ? HEAVY_RING_DARK : HEAVY_RING_LIGHT;
  ctx.lineWidth = HEAVY_RING_WIDTH;
  ctx.beginPath();
  for (let bucket = 0; bucket < s.start.length; bucket++) {
    const from = s.start[bucket]!;
    const to = s.end[bucket]!;
    if (from === to) continue;
    const kind = bucketKind(bucket, s.levels);
    if (kind !== Kind.Heavy && kind !== Kind.HeavyShip) continue;
    const outer = radiusOf(kind, zoom);
    if (outer < HEAVY_RING_MIN_R) continue;
    const r = outer * HEAVY_RING_FRAC;
    for (let n = from; n < to; n++) {
      const i = s.order[n]!;
      ctx.moveTo(s.sx[i]! + r, s.sy[i]!);
      ctx.arc(s.sx[i]!, s.sy[i]!, r, 0, TAU);
    }
  }
  ctx.stroke();
}

function drawHpArcs(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  s: UnitScratch,
  world: World,
): void {
  const u = world.units;
  const zoom = frame.camera.zoom;
  const from = -Math.PI / 2;
  ctx.strokeStyle = frame.theme.name === 'dark' ? HP_ARC_DARK : HP_ARC_LIGHT;
  ctx.lineWidth = HP_ARC_WIDTH;
  ctx.beginPath();
  for (let n = 0; n < s.visible; n++) {
    const i = s.order[n]!;
    const hp = u.hp[i]!;
    if (hp >= HP_FULL) continue;
    const r = radiusOf(u.kind[i]!, zoom) + HP_ARC_GAP;
    if (r < HP_ARC_MIN_R) continue;
    ctx.moveTo(s.sx[i]!, s.sy[i]! - r);
    ctx.arc(s.sx[i]!, s.sy[i]!, r, from, from + TAU * (hp > 0 ? hp : 0));
  }
  ctx.stroke();
}

function drawEncircled(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  s: UnitScratch,
  world: World,
): void {
  const u = world.units;
  const zoom = frame.camera.zoom;
  ctx.strokeStyle = frame.theme.name === 'dark' ? ENCIRCLE_DARK : ENCIRCLE_LIGHT;
  ctx.lineWidth = ENCIRCLE_WIDTH;
  ctx.setLineDash(ENCIRCLE_DASH);
  ctx.beginPath();
  for (let n = 0; n < s.visible; n++) {
    const i = s.order[n]!;
    if (!u.encircled[i]) continue;
    const r = radiusOf(u.kind[i]!, zoom) + ENCIRCLE_GAP;
    ctx.moveTo(s.sx[i]! + r, s.sy[i]!);
    ctx.arc(s.sx[i]!, s.sy[i]!, r, 0, TAU);
  }
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  s: UnitScratch,
  world: World,
): void {
  const u = world.units;
  const zoom = frame.camera.zoom;
  if (frame.selection.units.size === 0) return;
  ctx.strokeStyle = frame.theme.selection;
  ctx.lineWidth = SELECT_WIDTH;
  ctx.beginPath();
  for (const id of frame.selection.units) {
    const i = slotOfId(u, id);
    if (i < 0 || s.keys[i]! < 0) continue;
    const r = radiusOf(u.kind[i]!, zoom) + SELECT_GAP;
    ctx.moveTo(s.sx[i]! + r, s.sy[i]!);
    ctx.arc(s.sx[i]!, s.sy[i]!, r, 0, TAU);
  }
  ctx.stroke();
}

export function createUnitsLayer(world: World): Layer {
  const s = makeScratch(world);
  return {
    name: 'units',
    draw(ctx: CanvasRenderingContext2D, frame: FrameState): void {
      collect(world, frame, s);
      if (s.visible === 0) return;
      drawBodies(ctx, frame, s);
      drawHeavyRings(ctx, frame, s);
      drawHpArcs(ctx, frame, s, world);
      drawEncircled(ctx, frame, s, world);
      drawSelection(ctx, frame, s, world);
    },
  };
}
