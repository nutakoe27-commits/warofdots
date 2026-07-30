/**
 * `npm run sim -- --map crossing --a general --b colonel --games 100`
 *
 * Headless bot-vs-bot batches: the main balance-tuning instrument (SPEC §5.4).
 *
 * Two things make its output trustworthy. First, every game runs on its own derived
 * seed (`deriveRng` from the `--seed` argument), so a batch is one reproducible
 * number rather than a hundred coin flips nobody can replay. Second, win rates come
 * with a Wilson 95% interval: at 100 games a 58% win rate is not distinguishable
 * from even, and a tuning tool that hides that fact will have you chasing noise.
 *
 * It also counts the spec's hard rules as they are actually broken on the field —
 * unit-ticks spent by heavies in forest and by anyone in water — because those are
 * mistakes a bot must not make, and a regression in the operations layer shows up
 * here long before it shows up in a win rate.
 *
 * Every side is its own team, so a batch is always a free-for-all. The default
 * victory mode has no clock of its own, so `--max-min` is enforced by the driver and
 * a game that reaches it is reported as unfinished rather than awarded to anybody.
 */

import { writeFileSync } from 'node:fs';
import { VictoryMode, Terrain, baseKindOf } from '../src/core/types.ts';
import type { Command, MatchSettings, PlayerStats, World } from '../src/core/types.ts';
import { TICK_SEC } from '../src/core/balance.ts';
import { createWorld } from '../src/core/world.ts';
import type { PlayerSetup } from '../src/core/world.ts';
import { deriveRng } from '../src/core/rng.ts';
import { terrainAt } from '../src/core/terrain.ts';
import { tick } from '../src/core/sim.ts';
import { getMapRuntime } from '../src/content/registry.ts';
import { LIEUTENANT, profileById } from '../src/ai/profiles.ts';
import type { BotProfile } from '../src/ai/types.ts';
import { createBot } from '../src/ai/bot.ts';
import { loadMapsFromDisk } from './maps.ts';

const DEFAULT_MAP = 'crossing';
const DEFAULT_GAMES = 10;
const DEFAULT_SEED = 1;
const DEFAULT_MAX_MIN = 20;
const MAJORITY_SHARE = 0.8;
/** Matches `game/session.ts`, so a headless game reproduces the in-game one. */
const BOT_SEED_MIX = 2654435761;
/** Cities held are time-averaged rather than read at the end, once a second. */
const CITY_SAMPLE_TICKS = 20;
const Z95 = 1.96;

interface GameResult {
  seed: number;
  ticks: number;
  /** Winning player, or 0 for a draw or a game that hit the cap. */
  winner: number;
  reason: string;
  capped: boolean;
  cities: number[];
  produced: number[];
  lost: number[];
  forest: number[];
  water: number[];
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

// ──────────────────────────────────────────────────────────── one match ──

/**
 * Unit-ticks spent where the spec says a bot should never be. Terrain is one value
 * per tile, so the two counters cannot both fire for the same unit-tick.
 */
function tallyViolations(world: World, forest: Float64Array, water: Float64Array): void {
  const u = world.units;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    const t = terrainAt(world.map, u.x[i]!, u.y[i]!);
    if (t === Terrain.Water) water[u.owner[i]!]!++;
    else if (t === Terrain.Forest && baseKindOf(u.kind[i]!) === 1) forest[u.owner[i]!]!++;
  }
}

function playGame(mapId: string, profiles: readonly BotProfile[], seed: number, maxTicks: number): GameResult {
  const map = getMapRuntime(mapId);
  const players: PlayerSetup[] = profiles.map((p, i) => ({
    kind: 'bot',
    team: i + 1,
    name: p.name,
    colorIndex: i,
    ecoHandicap: p.ecoHandicap,
  }));
  const settings: MatchSettings = {
    seed,
    victory: VictoryMode.CapitalAndMajority,
    timeLimitSec: maxTicks * TICK_SEC,
    majorityShare: MAJORITY_SHARE,
    starveStrategy: 'healthiestFirst',
  };
  const world = createWorld({ map, players, settings });
  const bots = profiles.map((p, i) =>
    createBot(world, i + 1, p, (seed ^ ((i + 1) * BOT_SEED_MIX)) >>> 0),
  );

  const sides = profiles.length;
  const forest = new Float64Array(sides + 1);
  const water = new Float64Array(sides + 1);
  const citySum = new Float64Array(sides + 1);
  let citySamples = 0;
  const cmds: Command[] = [];

  // The default victory mode has no timeout of its own, so the cap lives here.
  while (world.outcome === null && world.tick < maxTicks) {
    cmds.length = 0;
    for (const bot of bots) {
      for (const cmd of bot.think(world)) cmds.push(cmd);
    }
    tick(world, cmds);
    tallyViolations(world, forest, water);
    if (world.tick % CITY_SAMPLE_TICKS === 0) {
      for (let p = 1; p <= sides; p++) citySum[p]! += world.stats.players[p]!.citiesNow;
      citySamples++;
    }
  }

  const per = (arr: Float64Array): number[] => Array.from(arr.subarray(1, sides + 1));
  const stat = (get: (s: PlayerStats) => number): number[] => {
    const out: number[] = [];
    for (let p = 1; p <= sides; p++) out.push(get(world.stats.players[p]!));
    return out;
  };
  const samples = Math.max(1, citySamples);
  return {
    seed,
    ticks: world.tick,
    winner: world.outcome?.winners[0] ?? 0,
    reason: world.outcome?.reason ?? 'cap',
    capped: world.outcome === null,
    cities: per(citySum).map((v) => v / samples),
    produced: stat((s) => s.produced),
    lost: stat((s) => s.lost),
    forest: per(forest),
    water: per(water),
  };
}

// ──────────────────────────────────────────────────────────── reporting ──

/** Wilson score interval, the honest one for small n and rates near 0 or 1. */
function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const d = 1 + (Z95 * Z95) / n;
  const centre = (p + (Z95 * Z95) / (2 * n)) / d;
  const half = (Z95 / d) * Math.sqrt((p * (1 - p)) / n + (Z95 * Z95) / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function column(value: string, width: number): string {
  return value.padStart(width);
}

function sideRow(i: number, profile: BotProfile, results: readonly GameResult[]): string {
  const games = results.length;
  const wins = results.filter((r) => r.winner === i + 1).length;
  const [lo, hi] = wilson(wins, games);
  const pick = (get: (r: GameResult) => number): number => mean(results.map(get));
  return [
    `p${i + 1}`.padEnd(4),
    `${profile.id}`.padEnd(11),
    column(String(wins), 5),
    column(`${((wins / Math.max(1, games)) * 100).toFixed(1)}%`, 7),
    column(`[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]`, 16),
    column(pick((r) => r.cities[i] ?? 0).toFixed(2), 8),
    column(pick((r) => r.produced[i] ?? 0).toFixed(1), 10),
    column(pick((r) => r.lost[i] ?? 0).toFixed(1), 8),
    column(Math.round(pick((r) => r.forest[i] ?? 0)).toString(), 12),
    column(Math.round(pick((r) => r.water[i] ?? 0)).toString(), 10),
  ].join(' ');
}

function printSummary(profiles: readonly BotProfile[], results: readonly GameResult[], maxMin: number): void {
  const games = results.length;
  const minutes = results.map((r) => (r.ticks * TICK_SEC) / 60);
  const capped = results.filter((r) => r.capped).length;
  const draws = results.filter((r) => r.winner === 0 && !r.capped).length;

  console.log(
    `\n${'side'.padEnd(4)} ${'profile'.padEnd(11)} ${column('wins', 5)} ${column('rate', 7)} ` +
      `${column('95% CI', 16)} ${column('cities', 8)} ${column('produced', 10)} ${column('lost', 8)} ` +
      `${column('forest·ut', 12)} ${column('water·ut', 10)}`,
  );
  profiles.forEach((p, i) => console.log(sideRow(i, p, results)));

  console.log(
    `\nlength: mean ${mean(minutes).toFixed(1)} min, median ${median(minutes).toFixed(1)} min` +
      ` (cap ${maxMin.toFixed(1)} min)`,
  );
  console.log(`decided: ${games - capped - draws}/${games}   draws: ${draws}   hit the cap: ${capped}`);
  console.log(
    'forest·ut / water·ut are mean unit-ticks per game spent breaking a hard rule ' +
      '(heavies in forest, anyone in water). Both should stay near zero.',
  );
}

function writeCsv(file: string, profiles: readonly BotProfile[], results: readonly GameResult[]): void {
  const head = ['game', 'seed', 'winner', 'reason', 'ticks', 'minutes', 'capped'];
  profiles.forEach((_p, i) => {
    const p = `p${i + 1}`;
    head.push(`${p}_profile`, `${p}_cities`, `${p}_produced`, `${p}_lost`, `${p}_forest_ut`, `${p}_water_ut`);
  });
  const rows = [head.join(',')];
  results.forEach((r, g) => {
    const cells: (string | number)[] = [
      g + 1,
      r.seed,
      r.winner,
      r.reason,
      r.ticks,
      ((r.ticks * TICK_SEC) / 60).toFixed(3),
      r.capped ? 1 : 0,
    ];
    profiles.forEach((p, i) => {
      cells.push(
        p.id,
        (r.cities[i] ?? 0).toFixed(3),
        r.produced[i] ?? 0,
        r.lost[i] ?? 0,
        r.forest[i] ?? 0,
        r.water[i] ?? 0,
      );
    });
    rows.push(cells.join(','));
  });
  writeFileSync(file, `${rows.join('\n')}\n`);
  console.log(`\nwrote ${file}`);
}

// ─────────────────────────────────────────────────────────────── driver ──

/**
 * `--a`/`--b` first, then every `--bot`, cycled to fill the map's player count, so
 * two profiles on a four-player map alternate (p1 a, p2 b, p3 a, p4 b) instead of
 * being an error.
 */
function resolveProfiles(args: Map<string, string[]>, sides: number): BotProfile[] {
  const wanted: string[] = [];
  for (const key of ['a', 'b']) {
    const v = args.get(key)?.[0];
    if (v !== undefined) wanted.push(v);
  }
  for (const v of args.get('bot') ?? []) wanted.push(v);
  if (wanted.length === 0) wanted.push(LIEUTENANT.id);
  if (wanted.length > sides) {
    console.warn(`map takes ${sides} players; ignoring ${wanted.length - sides} extra profile(s)`);
  }
  const out: BotProfile[] = [];
  for (let i = 0; i < sides; i++) out.push(profileById(wanted[i % wanted.length]!));
  return out;
}

function num(args: Map<string, string[]>, key: string, fallback: number): number {
  const raw = args.get(key)?.[0];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`sim: --${key} must be a positive number, got "${raw}"`);
  return v;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log(
      'usage: npm run sim -- --map crossing --a general --b colonel --games 100 ' +
        '[--bot <profileId>…] [--seed 1] [--max-min 20] [--quiet] [--csv out.csv]',
    );
    return;
  }
  loadMapsFromDisk();
  const mapId = args.get('map')?.[0] ?? DEFAULT_MAP;
  const map = getMapRuntime(mapId);
  const profiles = resolveProfiles(args, map.playerCount);
  const games = Math.round(num(args, 'games', DEFAULT_GAMES));
  const baseSeed = Math.round(num(args, 'seed', DEFAULT_SEED));
  const maxMin = num(args, 'max-min', DEFAULT_MAX_MIN);
  const maxTicks = Math.round((maxMin * 60) / TICK_SEC);
  const quiet = args.has('quiet');

  console.log(
    `dotfront sim — ${map.name} (${map.id}), ${map.playerCount} sides, ${games} games, ` +
      `seed ${baseSeed}, cap ${maxMin} min (${maxTicks} ticks)`,
  );
  console.log(`matchup: ${profiles.map((p, i) => `p${i + 1} ${p.id}`).join('  vs  ')}`);

  const results: GameResult[] = [];
  const started = Date.now();
  for (let g = 0; g < games; g++) {
    const seed = deriveRng(baseSeed, g + 1).s;
    const r = playGame(mapId, profiles, seed, maxTicks);
    results.push(r);
    if (!quiet) {
      const who = r.winner === 0 ? '—' : `p${r.winner} ${profiles[r.winner - 1]!.id}`;
      console.log(
        `game ${String(g + 1).padStart(String(games).length)}/${games}  seed ${seed}  ` +
          `winner ${who.padEnd(16)} ${r.reason.padEnd(12)} ${((r.ticks * TICK_SEC) / 60).toFixed(1)} min`,
      );
    }
  }

  printSummary(profiles, results, maxMin);
  console.log(`batch took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const csv = args.get('csv')?.[0];
  if (csv !== undefined && csv !== '1') writeCsv(csv, profiles, results);
}

try {
  main();
} catch (err) {
  // An unknown profile or map id is a user error, not a crash: one clear line, no stack.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
