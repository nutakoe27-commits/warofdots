/**
 * `npm run bench [-- --units 600 --ticks 1000 --map crossing]`
 *
 * The spec's performance gate (§6): 600 units must cost ≤ 4 ms/tick. Fails the
 * process on a regression so CI can hold the line.
 *
 * The load is deliberately not "600 units standing still". Units are seeded in
 * clusters whose owners alternate, and each cluster is given a route to its
 * neighbour, so the measured ticks contain what a real mid-game tick contains:
 * path following, separation, contact combat, captures and the influence cycle.
 * Routes are computed *before* the timed loop — pathfinding is the bot's cost, not
 * the simulation's — and re-issued from that cache mid-run so the army never settles
 * into an idle heap halfway through the sample.
 *
 * Casualties are replaced between measurements too. A benchmark that starts at 600
 * units and ends at 120 is quoting a number for a load it stopped carrying, and the
 * reported mean/min/max alive count is there so that claim can be checked.
 */

import { performance } from 'node:perf_hooks';
import { Kind, Terrain } from '../src/core/types.ts';
import type { Command, MapRuntime, World } from '../src/core/types.ts';
import { TICK_MS, TILE_SIZE } from '../src/core/balance.ts';
import { createWorld, defaultSettings } from '../src/core/world.ts';
import type { PlayerSetup } from '../src/core/world.ts';
import { allocUnit, armySize, DEFAULT_UNIT_CAPACITY, slotOfId } from '../src/core/units.ts';
import { terrainAt } from '../src/core/terrain.ts';
import { findRoute } from '../src/core/pathfinding.ts';
import { tick } from '../src/core/sim.ts';
import { chance, deriveRng, rand, randInDisc } from '../src/core/rng.ts';
import type { RngState } from '../src/core/types.ts';
import { getMapRuntime } from '../src/content/registry.ts';
import { loadMapsFromDisk } from './maps.ts';

/** SPEC §6: simulation budget at 600 units. */
const BUDGET_MS_PER_TICK = 4;
const FRAME_MS = 1000 / 60;
const DEFAULT_UNITS = 600;
const DEFAULT_TICKS = 1000;
const DEFAULT_MAP = 'crossing';
const DEFAULT_SEED = 1;
/** Excluded from the statistics: JIT warm-up plus the first full influence pass. */
const WARMUP_TICKS = 40;
const UNITS_PER_CLUSTER = 50;
const CLUSTER_SPREAD = 6 * TILE_SIZE;
const CLUSTER_JITTER = 6 * TILE_SIZE;
const HEAVY_SHARE = 0.3;
const PLACE_RINGS = 24;
const REORDER_TICKS = 300;
/** Reinforcement interval: keeps the measured load at the requested unit count. */
const TOPUP_TICKS = 50;
const P95 = 0.95;
/** Salt for the placement stream, so seeding units never disturbs the world's own rng. */
const PLACEMENT_SALT = 0x6265_6e63;

interface Cluster {
  owner: number;
  x: number;
  y: number;
  ids: number[];
}

function parseArgs(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (k: string, v: string): void => void out.set(k, [...(out.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      push('', a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      push(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) push(a.slice(2), argv[++i]!);
    else push(a.slice(2), '1');
  }
  return out;
}

/** Nearest spot that is neither mountain nor water, searched outward in rings. */
function findLand(map: MapRuntime, x: number, y: number): { x: number; y: number } {
  const clampX = Math.min(Math.max(x, 1), map.worldW - 1);
  const clampY = Math.min(Math.max(y, 1), map.worldH - 1);
  const t = terrainAt(map, clampX, clampY);
  if (t !== Terrain.Mountain && t !== Terrain.Water) return { x: clampX, y: clampY };
  for (let ring = 1; ring <= PLACE_RINGS; ring++) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const cx = Math.min(Math.max(clampX + Math.cos(ang) * ring * TILE_SIZE, 1), map.worldW - 1);
      const cy = Math.min(Math.max(clampY + Math.sin(ang) * ring * TILE_SIZE, 1), map.worldH - 1);
      const ct = terrainAt(map, cx, cy);
      if (ct !== Terrain.Mountain && ct !== Terrain.Water) return { x: cx, y: cy };
    }
  }
  return { x: clampX, y: clampY };
}

/** Jittered lattice of cluster centres, owners alternating so neighbours are enemies. */
function makeClusters(map: MapRuntime, count: number, rng: RngState): Cluster[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const out: Cluster[] = [];
  for (let k = 0; k < count; k++) {
    const col = k % cols;
    const row = (k / cols) | 0;
    const jx = (rand(rng) - 0.5) * CLUSTER_JITTER;
    const jy = (rand(rng) - 0.5) * CLUSTER_JITTER;
    const spot = findLand(
      map,
      ((col + 0.5) / cols) * map.worldW + jx,
      ((row + 0.5) / rows) * map.worldH + jy,
    );
    out.push({ owner: (k % map.playerCount) + 1, x: spot.x, y: spot.y, ids: [] });
  }
  return out;
}

/** Scratch vector for `randInDisc`, which writes through its out-parameter. */
const offset = { x: 0, y: 0 };

/**
 * Brings the seeded army back up to `want`, filling the emptiest clusters first.
 * Without this the measured cost decays with the casualty list: 600 units at tick 40
 * is 120 units by tick 1000, and the benchmark would be quoting a number for a load
 * it stopped carrying. Dead ids are pruned from the cluster in place, so the marches
 * planned once at startup keep addressing the units that exist.
 */
function fillClusters(world: World, clusters: readonly Cluster[], want: number, rng: RngState): void {
  const u = world.units;
  let have = 0;
  for (const c of clusters) {
    const alive = c.ids.filter((id) => slotOfId(u, id) >= 0);
    c.ids.length = 0;
    for (const id of alive) c.ids.push(id);
    have += alive.length;
  }

  const per = Math.ceil(want / clusters.length);
  for (const c of clusters) {
    while (have < want && c.ids.length < per) {
      randInDisc(rng, CLUSTER_SPREAD, offset);
      const spot = findLand(world.map, c.x + offset.x, c.y + offset.y);
      const kind = chance(rng, HEAVY_SHARE) ? Kind.Heavy : Kind.Light;
      const slot = allocUnit(u, c.owner, kind, spot.x, spot.y, world.tick);
      if (slot < 0) return;
      world.stats.players[c.owner]!.produced++;
      c.ids.push(u.id[slot]!);
      have++;
    }
  }
}

function seedArmies(world: World, want: number, rng: RngState): Cluster[] {
  const clusters = makeClusters(world.map, Math.max(1, Math.ceil(want / UNITS_PER_CLUSTER)), rng);
  fillClusters(world, clusters, want, rng);
  return clusters;
}

function reverseFlat(pts: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!);
  return out;
}

/**
 * Two command sets per cluster: march to the next cluster, then march back. Issued
 * alternately during the run so the army keeps moving and keeps meeting the enemy.
 */
function planMarches(world: World, clusters: readonly Cluster[]): [Command[], Command[]] {
  const forward: Command[] = [];
  const back: Command[] = [];
  for (let k = 0; k < clusters.length; k++) {
    const from = clusters[k]!;
    const to = clusters[(k + 1) % clusters.length]!;
    if (from.ids.length === 0) continue;
    const route = findRoute(world.map, from.x, from.y, to.x, to.y, Kind.Light);
    if (route.length < 4) continue;
    forward.push({ t: 'path', player: from.owner, units: from.ids, pts: route, append: false });
    back.push({ t: 'path', player: from.owner, units: from.ids, pts: reverseFlat(route), append: false });
  }
  return [forward, back];
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

interface Timing {
  ran: number;
  total: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
  /** Alive units per measured tick, to prove the load held. */
  unitsMean: number;
  unitsMin: number;
  unitsMax: number;
}

interface RunOptions {
  ticks: number;
  target: number;
  clusters: readonly Cluster[];
  marches: readonly Command[][];
  rng: RngState;
}

function runTimed(world: World, opts: RunOptions): Timing {
  const samples: number[] = [];
  let unitsSum = 0;
  let unitsMin = Infinity;
  let unitsMax = 0;
  for (let i = 0; i < opts.ticks && !world.outcome; i++) {
    // Reinforcement and route lookups are the bench's own bookkeeping, so they
    // happen between measurements; only `tick` is timed.
    let orders: readonly Command[] = [];
    if (i > 0 && i % TOPUP_TICKS === 0) fillClusters(world, opts.clusters, opts.target, opts.rng);
    if (i > 0 && i % REORDER_TICKS === 0) orders = opts.marches[(i / REORDER_TICKS) % 2]!;

    const t0 = performance.now();
    tick(world, orders);
    samples.push(performance.now() - t0);

    const alive = world.units.count;
    unitsSum += alive;
    if (alive < unitsMin) unitsMin = alive;
    if (alive > unitsMax) unitsMax = alive;
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  return {
    ran: samples.length,
    total,
    mean: samples.length === 0 ? 0 : total / samples.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, P95),
    max: sorted[sorted.length - 1] ?? 0,
    unitsMean: samples.length === 0 ? 0 : unitsSum / samples.length,
    unitsMin: Number.isFinite(unitsMin) ? unitsMin : 0,
    unitsMax,
  };
}

function buildWorld(mapId: string, units: number, seed: number): World {
  const map = getMapRuntime(mapId);
  const players: PlayerSetup[] = [];
  for (let p = 1; p <= map.playerCount; p++) {
    players.push({ kind: 'bot', team: p, name: `bench-${p}`, colorIndex: p - 1 });
  }
  return createWorld({
    map,
    players,
    settings: defaultSettings(seed),
    unitCapacity: Math.max(DEFAULT_UNIT_CAPACITY, units + 512),
  });
}

function report(world: World, requested: number, timing: Timing): void {
  const armies: string[] = [];
  for (let p = 1; p <= world.map.playerCount; p++) armies.push(`p${p} ${armySize(world, p)}`);
  const lost = world.stats.players.reduce((n, s) => n + s.lost, 0);
  const perFrame = timing.mean * (FRAME_MS / TICK_MS);
  const pass = timing.mean <= BUDGET_MS_PER_TICK;
  const pct = (timing.mean / BUDGET_MS_PER_TICK) * 100;

  console.log(`army now: ${armies.join(', ')}   deaths so far: ${lost}   tick ${world.tick}`);
  if (timing.ran < requested) {
    console.warn(`match ended early after ${timing.ran} measured ticks (${world.outcome?.reason})`);
  }
  console.log(
    `\nmeasured ${timing.ran} ticks carrying ${timing.unitsMean.toFixed(0)} units on average ` +
      `(${timing.unitsMin}–${timing.unitsMax} alive)`,
  );
  console.log(`  total      ${timing.total.toFixed(1)} ms`);
  console.log(`  mean       ${timing.mean.toFixed(3)} ms/tick`);
  console.log(`  median     ${timing.median.toFixed(3)} ms/tick`);
  console.log(`  p95        ${timing.p95.toFixed(3)} ms/tick`);
  console.log(`  max        ${timing.max.toFixed(3)} ms/tick`);
  console.log(`  per frame  ${perFrame.toFixed(3)} ms   (20 Hz sim amortised over 60 Hz frames)`);
  console.log(
    `\nbudget ${BUDGET_MS_PER_TICK.toFixed(2)} ms/tick → ${pass ? 'PASS' : 'FAIL'} ` +
      `(${pct.toFixed(0)}% of budget)`,
  );
  if (pass && timing.p95 > BUDGET_MS_PER_TICK) {
    console.warn('note: p95 is over budget even though the mean is not — check for spikes.');
  }
  if (!pass) process.exitCode = 1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log('usage: npm run bench [-- --units 600 --ticks 1000 --map crossing --seed 1]');
    return;
  }
  loadMapsFromDisk();
  const mapId = args.get('map')?.[0] ?? DEFAULT_MAP;
  const units = Number(args.get('units')?.[0] ?? DEFAULT_UNITS);
  const ticks = Number(args.get('ticks')?.[0] ?? DEFAULT_TICKS);
  const seed = Number(args.get('seed')?.[0] ?? DEFAULT_SEED);
  if (!Number.isFinite(units) || units < 1 || !Number.isFinite(ticks) || ticks < 1) {
    throw new Error(`bench: --units and --ticks must be positive (got ${units}, ${ticks})`);
  }

  const world = buildWorld(mapId, units, seed);
  const fromMap = world.units.count;
  const rng = deriveRng(seed, PLACEMENT_SALT);
  const clusters = seedArmies(world, units, rng);
  const total = world.units.count;

  console.log(
    `dotfront bench — map ${world.map.id} (${world.map.w}×${world.map.h}), ${total} units ` +
      `(${total - fromMap} seeded in ${clusters.length} clusters + ${fromMap} from the map), ` +
      `${ticks} ticks, seed ${seed}`,
  );
  console.log(
    `warm-up: ${WARMUP_TICKS} ticks (not measured); reinforced to ${units} every ${TOPUP_TICKS} ticks`,
  );

  const marches = planMarches(world, clusters);
  tick(world, marches[0]);
  for (let i = 1; i < WARMUP_TICKS && !world.outcome; i++) tick(world);
  report(world, ticks, runTimed(world, { ticks, target: units, clusters, marches, rng }));
}

try {
  main();
} catch (err) {
  // A bad map id or argument is a user error, not a crash: one clear line, no stack.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
