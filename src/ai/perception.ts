/**
 * Layer 1a of the bot: folding the `World` into a `StrategicView`.
 *
 * Written under one constraint. The bot may look at exactly what a human sees on
 * screen — unit positions, kinds and HP bars, cities and their owners, the
 * territory grid, its own books — and at nothing else. An enemy treasury, a
 * production slider, a queued unit kind: never read here. The other half of honesty
 * is `profile.perceptionNoise`, which blurs every estimate of the *enemy* and
 * nothing else, because a commander does not misjudge the size of their own army.
 *
 * The interesting decision is the cut search. Encirclement is the decisive mechanic
 * of the game, so necks are found the honest way: articulation cells of the enemy's
 * territory (Hopcroft–Tarjan), with a census of units and cities accumulated up the
 * DFS tree so a candidate is judged by what removing it would actually strand.
 * Rooting each search at a cell that holds an enemy city is what keeps it cheap —
 * the remainder side then always has a city, so a stranded garrison can only ever be
 * a child subtree, and one rule covers every case.
 */

import { baseKindOf, Kind, Terrain, TERRAIN_COUNT } from '../core/types.ts';
import type { InfluenceState, MapRuntime, RngState, World } from '../core/types.ts';
import { TERRAIN_DAMAGE } from '../core/balance.ts';
import { deriveRng, randRange } from '../core/rng.ts';
import { cellAt, cellCenterX, cellCenterY, territoryShares } from '../core/influence.ts';
import { ecoRateOf, supplyOf } from '../core/economy.ts';
import { armyCondition, armyStrength, countByKind, unitStrength } from '../core/units.ts';
import { playerEco } from '../core/world.ts';
import { cityAt, terrainAt, terrainHistogram } from '../core/terrain.ts';
import { makeCellRange, queryInto } from '../core/spatial.ts';
import { clamp, dist2 } from '../core/geometry.ts';
import type { ArmyView, BotProfile, CityView, EnemyArmyView } from './types.ts';
import type { Front, StrategicView } from './types.ts';

// ──────────────────────────────────────────────────────────────── weights ──
// Bot coefficients live beside the code that uses them (ADR-011): they tune a
// heuristic, not the game.

/** World units. An enemy this close to one of my units counts as contact. */
const CONTACT_RANGE = 26;
/** Two of my units in contact this close together are fighting the same battle. */
const FRONT_LINK = 40;
/** Fronts handed downstream, highest priority first. */
const MAX_FRONTS = 8;
/** Front priority: floor, stake nearby, capital multiplier, winnability, battle size. */
const FRONT = { base: 0.15, stake: 1, capital: 2.2, win: 0.45, mass: 0.5, massScale: 12 };
/** Distance at which a friendly city stops feeling at stake, world units. */
const STAKE_SCALE = 140;
/** Heavy column of `TERRAIN_DAMAGE` at or above which heavies fight at full effect. */
const HEAVY_OK_DAMAGE = 0.9;
/** Radius counted as present pressure on a city — and as the alarm around a capital. */
const PRESSURE_R = 56;
/** Radius from which enemy strength counts as threat, and its distance falloff. */
const THREAT_R = 180;
const THREAT_FALLOFF = 60;
/** City value terms, spec §5.1: base + capital + near mine + cut − distance − threat. */
const CITY = { base: 1, capital: 0.9, near: 0.55, nearScale: 120, cut: 0.7, far: 1.1, threat: 0.8 };
/** Strength floor in the threat ratio, so a dead army does not divide by zero. */
const THREAT_FLOOR = 1;
/** Distance at which a cut cell loses half its appeal, and the limit of ambition. */
const CUT_DIST_SCALE = 200;
const CUT_MAX_DIST_FRAC = 0.55;

/** 4-connected neighbour offsets, for the walks over the influence grid. */
const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];
const range = makeCellRange();
const neighbours = new Int32Array(1024);

/** What the pass carries around: who I am and how well I see. `foe[p]` is 1 for hostiles. */
interface Eyes { world: World; me: number; foe: Uint8Array; rng: RngState; noise: number }

export interface PerceptionState {
  rng: RngState;
  lastView: StrategicView | null;
}

export function createPerception(seed: number, player: number): PerceptionState {
  // One stream per player: two bots perceiving on the same tick must not be able to
  // shift each other's misjudgements.
  return { rng: deriveRng(seed, 0x5eed ^ (player * 0x27d4eb2d)), lastView: null };
}

/** Multiplicative misjudgement of an enemy quantity. Own-side numbers never come here. */
function fog(e: Eyes): number {
  return e.noise <= 0 ? 1 : Math.max(0, 1 + randRange(e.rng, -e.noise, e.noise));
}

/** Walks a cell and its four neighbours, returning the first that passes, or -1. */
function around4(inf: InfluenceState, cell: number, hit: (c: number) => boolean): number {
  if (hit(cell)) return cell;
  const cx = cell % inf.cw;
  const cy = (cell / inf.cw) | 0;
  for (let d = 0; d < 4; d++) {
    const nx = cx + DX4[d]!;
    const ny = cy + DY4[d]!;
    if (nx < 0 || ny < 0 || nx >= inf.cw || ny >= inf.ch) continue;
    if (hit(ny * inf.cw + nx)) return ny * inf.cw + nx;
  }
  return -1;
}

function pushInto(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// ─────────────────────────────────────────────────────────────── armies ──

function buildArmy(world: World, me: number): ArmyView {
  const mix = countByKind(world, me);
  const cond = armyCondition(world, me);
  const supply = supplyOf(world, me);
  return {
    light: mix.light, heavy: mix.heavy, avgHp: cond.hp, avgMorale: cond.morale,
    strength: armyStrength(world, me),
    supplyCap: supply.cap, supplyUsed: supply.used, supplyHeadroom: supply.cap - supply.used,
  };
}

/**
 * The enemy army as seen from across the field: a count of dots and their HP bars,
 * blurred by the profile's noise. Nothing here touches a treasury or a slider —
 * those are not on screen for a human either.
 */
function estimateEnemy(e: Eyes): EnemyArmyView {
  const u = e.world.units;
  let light = 0, heavy = 0, strength = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || e.foe[u.owner[i]!] !== 1) continue;
    if (baseKindOf(u.kind[i]!) === 1) heavy++;
    else light++;
    strength += unitStrength(u, i);
  }
  const blur = (n: number): number => Math.max(0, Math.round(n * fog(e)));
  return { estLight: blur(light), estHeavy: blur(heavy), estStrength: strength * fog(e) };
}

// ─────────────────────────────────────────────────────────────── fronts ──

function makeFront(e: Eyes, mySlots: number[], foeSlots: number[], cities: CityView[]): Front {
  const u = e.world.units;
  let myStrength = 0, foeStrength = 0;
  for (const s of mySlots) myStrength += unitStrength(u, s);
  for (const s of foeSlots) foeStrength += unitStrength(u, s);
  foeStrength *= fog(e);

  const members = mySlots.concat(foeSlots);
  const hist = new Int32Array(TERRAIN_COUNT);
  let cx = 0, cy = 0;
  for (const s of members) {
    cx += u.x[s]! / members.length;
    cy += u.y[s]! / members.length;
    hist[terrainAt(e.world.map, u.x[s]!, u.y[s]!)]!++;
  }
  let terrain: number = Terrain.Plains;
  for (let t = 0; t < TERRAIN_COUNT; t++) if (hist[t]! > hist[terrain]!) terrain = t;

  let nearestCity = -1, nearD = Infinity, capital = false;
  for (const c of cities) {
    if (c.owner !== e.me) continue;
    const d = Math.sqrt(dist2(cx, cy, c.x, c.y));
    if (d < nearD) { nearD = d; nearestCity = c.index; capital = c.capital; }
  }

  // What is at stake here, and how winnable it looks — the two things that decide
  // which front gets the reserve.
  const stake = nearestCity < 0 ? 0 : (capital ? FRONT.capital : 1) / (1 + nearD / STAKE_SCALE);
  const total = myStrength + foeStrength;
  const ratio = total > 0 ? myStrength / total : 0.5;
  const priority =
    FRONT.base +
    FRONT.stake * stake +
    FRONT.win * clamp((ratio - 0.5) * 2, -1, 1) +
    FRONT.mass * (total / (total + FRONT.massScale));
  return {
    id: 0, x: cx, y: cy,
    myUnits: mySlots.map((s) => u.id[s]!).sort((a, b) => a - b),
    enemyUnits: foeSlots.map((s) => u.id[s]!).sort((a, b) => a - b),
    myStrength, enemyStrength: foeStrength, ratio, terrain,
    heavyFriendly: TERRAIN_DAMAGE[terrain]![Kind.Heavy]! >= HEAVY_OK_DAMAGE,
    nearestCity, priority,
  };
}

/** First unit within `r2` of slot `i` that passes `ok`, or -1. Stops at the first hit. */
function firstNear(e: Eyes, i: number, r2: number, ok: (j: number) => boolean): number {
  const u = e.world.units;
  const n = queryInto(e.world.spatial, u.x[i]!, u.y[i]!, CONTACT_RANGE, neighbours, range);
  for (let k = 0; k < n; k++) {
    const j = neighbours[k]!;
    if (!u.alive[j] || !ok(j)) continue;
    if (dist2(u.x[i]!, u.y[i]!, u.x[j]!, u.y[j]!) <= r2) return j;
  }
  return -1;
}

/** Slot → the slot that roots its front, or -1 for a unit that is not in contact. */
let groupOf = new Int32Array(0);

/**
 * Fronts are clusters of contact, found by single linkage: two of my units that are
 * touching an enemy join the same front when they are within `FRONT_LINK` of each
 * other. That follows a battle line however it curves, while two skirmishes a screen
 * apart stay two fronts.
 *
 * Deliberately never materialises the contact pairs. In a real melee each unit touches
 * a dozen others, and building those lists cost more than the rest of the pass put
 * together; both probes stop at the first hit instead.
 */
function buildFronts(e: Eyes, cities: CityView[]): Front[] {
  const u = e.world.units;
  const r2 = CONTACT_RANGE * CONTACT_RANGE, link2 = FRONT_LINK * FRONT_LINK;
  if (groupOf.length < u.capacity) groupOf = new Int32Array(u.capacity);
  groupOf.fill(-1, 0, u.capacity);

  const touching: number[] = [];
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== e.me) continue;
    if (firstNear(e, i, r2, (j) => e.foe[u.owner[j]!] === 1) >= 0) touching.push(i);
  }

  const parent = touching.map((_, k) => k);
  const find = (a: number): number => {
    while (parent[a]! !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let a = 0; a < touching.length; a++) {
    const p = touching[a]!;
    for (let b = a + 1; b < touching.length; b++) {
      const q = touching[b]!;
      if (dist2(u.x[p]!, u.y[p]!, u.x[q]!, u.y[q]!) <= link2) parent[find(a)] = find(b);
    }
  }
  const mineOf = new Map<number, number[]>();
  const foesOf = new Map<number, number[]>();
  for (let a = 0; a < touching.length; a++) {
    groupOf[touching[a]!] = touching[find(a)]!;
    pushInto(mineOf, touching[find(a)]!, touching[a]!);
  }
  // Each enemy hangs on the first front it touches. Two fronts reaching the same unit
  // is ambiguous by nature, so the lowest slot wins and the choice stays reproducible.
  for (let j = 0; j < u.capacity; j++) {
    if (!u.alive[j] || e.foe[u.owner[j]!] !== 1) continue;
    const anchor = firstNear(e, j, r2, (k) => groupOf[k]! >= 0);
    if (anchor >= 0) pushInto(foesOf, groupOf[anchor]!, j);
  }

  const fronts: Front[] = [];
  for (const [root, slots] of mineOf) fronts.push(makeFront(e, slots, foesOf.get(root) ?? [], cities));
  fronts.sort((a, b) => b.priority - a.priority || a.x - b.x || a.y - b.y);
  if (fronts.length > MAX_FRONTS) fronts.length = MAX_FRONTS;
  // `id` is the index in this array, so any consumer can look a front back up.
  for (let i = 0; i < fronts.length; i++) fronts[i]!.id = i;
  return fronts;
}

// ─────────────────────────────────────────────────────────────── cities ──

/** Distance to my nearest *other* city — how well supported a spot already is. */
function supportDist(world: World, me: number, index: number): number {
  const from = world.cities[index]!;
  let best = Infinity;
  for (const c of world.cities) {
    if (c.owner === me && c.index !== index) best = Math.min(best, dist2(from.x, from.y, c.x, c.y));
  }
  return Math.sqrt(best);
}

function cityView(e: Eyes, index: number, neck: Uint8Array, mine: number, diag: number): CityView {
  const { world } = e;
  const city = world.cities[index]!;
  const u = world.units;
  const pr2 = PRESSURE_R * PRESSURE_R, tr2 = THREAT_R * THREAT_R;
  let myPressure = 0, enemyPressure = 0, threat = 0, garrison = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i]) continue;
    const isMine = u.owner[i]! === e.me;
    if (!isMine && e.foe[u.owner[i]!] !== 1) continue;
    const d2 = dist2(u.x[i]!, u.y[i]!, city.x, city.y);
    const s = unitStrength(u, i);
    if (isMine) {
      if (d2 <= pr2) myPressure += s;
      if (cityAt(world.map, u.x[i]!, u.y[i]!) === index) garrison++;
      continue;
    }
    if (d2 <= pr2) enemyPressure += s;
    if (d2 <= tr2) threat += s / (1 + Math.sqrt(d2) / THREAT_FALLOFF);
  }
  threat *= fog(e);
  const support = supportDist(world, e.me, index);
  const cell = cellAt(world, city.x, city.y);
  const cuts = city.owner !== e.me && around4(world.influence, cell, (c) => neck[c] === 1) >= 0;
  // The two distances are different questions. `support` is how well backed up the
  // spot is, which has to ignore the city itself or every city I hold would look
  // perfectly supported. `reach` is how far I have to go to act on it, and a city
  // already in my hands costs nothing to reach.
  const reach = city.owner === e.me ? 0 : support;
  // Spec §5.1 verbatim, and deliberately mode-blind: re-weighting the list for the
  // current macro mode is `rankCityTargets`' job, not perception's.
  const value =
    CITY.base +
    (city.capital ? CITY.capital : 0) +
    CITY.near / (1 + support / CITY.nearScale) +
    (cuts ? CITY.cut : 0) -
    CITY.far * Math.min(1, reach / diag) -
    CITY.threat * (threat / (threat + mine + THREAT_FLOOR));
  return {
    index, id: city.id, owner: city.owner, x: city.x, y: city.y, capital: city.capital,
    value, threat, myPressure, enemyPressure: enemyPressure * fog(e), garrison, cutsEnemy: cuts,
  };
}

// ──────────────────────────────────────────────────────────── cut search ──

interface CutScratch {
  disc: Int32Array; low: Int32Array; par: Int32Array; iter: Int32Array; stack: Int32Array;
  /** Census of the owning player's units, cities and strength; becomes subtree sums. */
  units: Int32Array; cities: Int32Array; str: Float64Array;
  /** Largest city-less subtree this cell holds together, as strength. */
  strand: Float64Array;
  art: Uint8Array;
}

let scratch: CutScratch | null = null;

function scratchFor(cells: number): CutScratch {
  const ints = (): Int32Array => new Int32Array(cells);
  const s: CutScratch =
    scratch !== null && scratch.disc.length >= cells
      ? scratch
      : {
          disc: ints(), low: ints(), par: ints(), iter: ints(), stack: ints(),
          units: ints(), cities: ints(),
          str: new Float64Array(cells), strand: new Float64Array(cells),
          art: new Uint8Array(cells),
        };
  scratch = s;
  // `low`, `par` and `iter` are written at discovery, so only what is read before it
  // is written needs clearing.
  for (const a of [s.disc, s.units, s.cities]) a.fill(0, 0, cells);
  for (const a of [s.str, s.strand]) a.fill(0, 0, cells);
  s.art.fill(0, 0, cells);
  return s;
}

/**
 * Iterative Tarjan over one territory component, rooted at a cell holding a city.
 * Marks articulation cells and records, for each, the strength of the largest
 * city-less subtree hanging off it — the army that cell is keeping supplied.
 */
function walkComponent(world: World, seed: number, owner: number, s: CutScratch): void {
  const inf = world.influence;
  let timer = 1, rootKids = 0, sp = 1;
  s.disc[seed] = s.low[seed] = timer++;
  s.par[seed] = -1;
  s.iter[seed] = 0;
  s.stack[0] = seed;

  while (sp > 0) {
    const v = s.stack[sp - 1]!;
    if (s.iter[v]! < 4) {
      const d = s.iter[v]!;
      s.iter[v] = d + 1;
      const nx = (v % inf.cw) + DX4[d]!, ny = ((v / inf.cw) | 0) + DY4[d]!;
      if (nx < 0 || ny < 0 || nx >= inf.cw || ny >= inf.ch) continue;
      const w = ny * inf.cw + nx;
      if (inf.owner[w] !== owner) continue;
      if (s.disc[w] !== 0) {
        if (w !== s.par[v] && s.disc[w]! < s.low[v]!) s.low[v] = s.disc[w]!;
        continue;
      }
      s.disc[w] = s.low[w] = timer++;
      s.par[w] = v;
      s.iter[w] = 0;
      s.stack[sp++] = w;
      if (v === seed) rootKids++;
      continue;
    }

    sp--;
    const p = s.par[v]!;
    if (p < 0) continue;
    if (s.low[v]! < s.low[p]!) s.low[p] = s.low[v]!;
    if (s.low[v]! >= s.disc[p]!) {
      if (s.cities[v]! === 0 && s.units[v]! > 0 && s.str[v]! > s.strand[p]!) s.strand[p] = s.str[v]!;
      if (p !== seed) s.art[p] = 1;
    }
    // Sums accumulate in place: once v is popped its cells hold the whole subtree.
    s.units[p]! += s.units[v]!;
    s.cities[p]! += s.cities[v]!;
    s.str[p]! += s.str[v]!;
  }
  // The root only separates anything when it holds two or more subtrees together.
  if (rootKids > 1) s.art[seed] = 1;
}

/** Best articulation cell: most stranded strength, discounted by how far away it is. */
function pickCut(world: World, me: number, s: CutScratch): number {
  // Anchors are where an operation could set out from: my cities and my army's centre.
  const anchors: number[] = [];
  for (const c of world.cities) if (c.owner === me) anchors.push(c.x, c.y);
  const u = world.units;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== me) continue;
    sx += u.x[i]!; sy += u.y[i]!; n++;
  }
  if (n > 0) anchors.push(sx / n, sy / n);

  const maxDist = Math.hypot(world.map.worldW, world.map.worldH) * CUT_MAX_DIST_FRAC;
  const cost = world.map.coarseCost;
  let bestCell = -1, bestScore = 0;
  for (let v = 0; v < s.art.length; v++) {
    if (s.art[v] !== 1 || s.strand[v]! <= 0 || !Number.isFinite(cost[v]!)) continue;
    const x = cellCenterX(world, v), y = cellCenterY(world, v);
    let near = Infinity;
    for (let a = 0; a < anchors.length; a += 2) {
      near = Math.min(near, dist2(x, y, anchors[a]!, anchors[a + 1]!));
    }
    const d = Math.sqrt(near);
    const score = s.strand[v]! / (1 + d / CUT_DIST_SCALE);
    if (d <= maxDist && score > bestScore) { bestScore = score; bestCell = v; }
  }
  return bestCell;
}

/**
 * Articulation cells of every enemy territory that holds a city, plus the best one to
 * actually take. `neck` is module scratch, valid only until the next call: it is
 * consumed inside `perceive` and never stored on the view.
 *
 * Weak profiles still get `neck`, so a city on a bottleneck reads as valuable to
 * them, but never a plan — `cell` stays -1 unless the profile uses encirclement.
 */
function analyseCuts(e: Eyes, uses: boolean): { neck: Uint8Array; cell: number } {
  const { world } = e;
  const inf = world.influence;
  const u = world.units;
  const s = scratchFor(inf.cw * inf.ch);
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || e.foe[u.owner[i]!] !== 1) continue;
    const cell = cellAt(world, u.x[i]!, u.y[i]!);
    // A unit already standing off its own territory is beyond cutting off.
    if (inf.owner[cell] !== u.owner[i]) continue;
    s.units[cell]!++;
    s.str[cell]! += unitStrength(u, i);
  }
  // Cities are counted before any walk starts, because a component is judged by the
  // whole census, not by the part of it the DFS happened to reach first.
  const seeds: number[] = [];
  for (const city of world.cities) {
    if (e.foe[city.owner] !== 1) continue;
    const at = around4(inf, cellAt(world, city.x, city.y), (c) => inf.owner[c] === city.owner);
    if (at < 0) continue;
    s.cities[at]!++;
    seeds.push(at, city.owner);
  }
  for (let k = 0; k < seeds.length; k += 2) {
    if (s.disc[seeds[k]!] === 0) walkComponent(world, seeds[k]!, seeds[k + 1]!, s);
  }
  return { neck: s.art, cell: uses ? pickCut(world, e.me, s) : -1 };
}

// ─────────────────────────────────────────────────────────────── perceive ──

/** The terrain mix never changes during a match, so it is worth computing once. */
const roughCache = new WeakMap<MapRuntime, number>();

function roughShareOf(map: MapRuntime): number {
  const cached = roughCache.get(map);
  if (cached !== undefined) return cached;
  const hist = terrainHistogram(map);
  const share = hist[Terrain.Forest]! + hist[Terrain.Hills]!;
  roughCache.set(map, share);
  return share;
}

export function perceive(
  world: World,
  player: number,
  profile: BotProfile,
  state: PerceptionState,
): StrategicView {
  const team = world.players[player]!.team;
  const foe = new Uint8Array(world.players.length);
  const e: Eyes = { world, me: player, foe, rng: state.rng, noise: profile.perceptionNoise };
  const allies: number[] = [], enemies: number[] = [];
  for (let p = 1; p < world.players.length; p++) {
    if (p === player || !world.players[p]!.alive) continue;
    if (world.players[p]!.team === team) allies.push(p);
    else { enemies.push(p); foe[p] = 1; }
  }

  const myArmy = buildArmy(world, player);
  const cuts = analyseCuts(e, profile.usesEncirclement);
  const diag = Math.hypot(world.map.worldW, world.map.worldH);
  const cities = world.cities.map((c) => cityView(e, c.index, cuts.neck, myArmy.strength, diag));
  const inf = world.influence;

  const view: StrategicView = {
    tick: world.tick, me: player, team, allies, enemies, cities,
    fronts: buildFronts(e, cities),
    myArmy,
    enemyArmy: estimateEnemy(e),
    // My own books, exact — a commander knows their income to the last coin.
    ecoRate: ecoRateOf(world, player),
    eco: playerEco(world, player),
    territoryShare: territoryShares(world)[player] ?? 0,
    roughShare: roughShareOf(world.map),
    cutCell: cuts.cell,
    // An enemy at the gates, or the ground under the capital already gone.
    capitalThreatened: cities.some(
      (c) =>
        c.owner === player &&
        c.capital &&
        (c.enemyPressure > 0 || inf.owner[cellAt(world, c.x, c.y)] !== player),
    ),
  };
  state.lastView = view;
  return view;
}
