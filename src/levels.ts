/**
 * Ten battlefields.
 *
 * Each one is a script that paints tiles and says where the two armies form up.
 * They follow the shape of real ground — the plain Darius levelled at Gaugamela,
 * the ridge Harold held at Hastings, the gap between two woods at Agincourt —
 * because those shapes are what made those battles the battles they were, and
 * they make good maps for the same reason. They are sketches, not surveys: the
 * point is that the terrain gives you a decision to make, not that it matches an
 * ordnance map.
 *
 * The lesson each one teaches is different on purpose. Gaugamela has nothing to
 * hide behind, so it is pure manoeuvre. Teutoburg is a corridor, so numbers stop
 * mattering. Hastings gives one side the hill. Stalingrad is a city you have to
 * clear a block at a time with a river at your back.
 */

import { Terrain, TILE, blob, bridge, disc, meander, set, stampPath, tileAt } from './terrain.ts';
import type { City, GameMap } from './terrain.ts';
import { makeRng, range } from './rng.ts';
import type { Rng } from './rng.ts';

/** Where each side's line stands at a given latitude, in tiles. */
export interface Front {
  blue: number;
  red: number;
}

export interface Level {
  id: string;
  name: string;
  when: string;
  /** One line on what the ground does to the fight. */
  blurb: string;
  w: number;
  h: number;
  seed: number;
  build(m: GameMap, r: Rng): void;
  cities(m: GameMap): City[];
  front(m: GameMap, ty: number): Front;
  /** Latitudes the armies form up between, as fractions of map height. */
  span: [number, number];
}

/**
 * The banks of the widest stretch of water near `aim`, so armies that face each
 * other across a river line up on their own side of it.
 *
 * Widest rather than nearest: where a tributary joins the main channel the two
 * merge into one broad crossing, and picking the nearest run instead put troops
 * on a sandbank in the middle of it.
 */
export function banksAt(m: GameMap, ty: number, from: number, to: number, gap: number): Front {
  let run = -1;
  let bestS = -1;
  let bestE = -1;
  let bestW = 0;
  for (let x = from; x <= to; x++) {
    const t = tileAt(m, x, ty);
    const wet = t === Terrain.Water || t === Terrain.Bridge;
    if (wet && run < 0) run = x;
    if (run >= 0 && (!wet || x === to)) {
      const end = wet ? x : x - 1;
      if (end - run >= bestW) {
        bestW = end - run;
        bestS = run;
        bestE = end;
      }
      run = -1;
    }
  }
  const mid = (from + to) / 2;
  if (bestS < 0) return { blue: mid - gap, red: mid + gap };
  return { blue: bestS - gap, red: bestE + gap };
}

/** Two armies drawn up facing each other across open ground. */
function facing(w: number, gap: number): (m: GameMap, ty: number) => Front {
  void 0;
  return () => ({ blue: w / 2 - gap, red: w / 2 + gap });
}

/** Fills the whole map with one terrain before anything else is painted on it. */
function ground(m: GameMap, t: number): void {
  m.tiles.fill(t);
}

/** A long rolling rise: hills stamped along a wandering line. */
function ridge(m: GameMap, r: Rng, x: number, y0: number, y1: number, width: number, amp: number, t: number): void {
  stampPath(m, meander(r, x, y0, x, y1, amp), width, t as 0);
}

/** Scatters small blobs — copses, thickets, rubble, shell holes. */
function scatter(m: GameMap, r: Rng, n: number, x0: number, y0: number, x1: number, y1: number, rad: number, t: number): void {
  for (let i = 0; i < n; i++) {
    blob(m, r, range(r, x0, x1), range(r, y0, y1), range(r, rad * 0.5, rad), t as 0);
  }
}

function town(m: GameMap, r: Rng, cx: number, cy: number, rad: number): void {
  blob(m, r, cx, cy, rad, Terrain.Hills);
  blob(m, r, cx + range(r, -rad / 3, rad / 3), cy + range(r, -rad / 3, rad / 3), rad * 0.35, Terrain.Mountain);
}

function city(x: number, y: number, owner: number, capital = false): City {
  return { x, y, capital, owner };
}

/**
 * Symmetric line of points: a capital deep on each flank and three in between,
 * so both sides have somewhere to fall back to and something to take.
 */
function standardCities(w: number, h: number): City[] {
  return [
    city(Math.round(w * 0.07), Math.round(h / 2), 0, true),
    city(Math.round(w * 0.93), Math.round(h / 2), 1, true),
    city(Math.round(w * 0.24), Math.round(h * 0.25), 0),
    city(Math.round(w * 0.24), Math.round(h * 0.75), 0),
    city(Math.round(w * 0.38), Math.round(h * 0.5), 0),
    city(Math.round(w * 0.76), Math.round(h * 0.25), 1),
    city(Math.round(w * 0.76), Math.round(h * 0.75), 1),
    city(Math.round(w * 0.62), Math.round(h * 0.5), 1),
    city(Math.round(w * 0.5), Math.round(h * 0.16), -1),
    city(Math.round(w * 0.5), Math.round(h * 0.84), -1),
  ];
}

export const LEVELS: Level[] = [
  {
    id: 'gaugamela',
    name: 'Гавгамелы',
    when: '331 до н. э.',
    blurb: 'Равнина, которую Дарий приказал разровнять под колесницы. Спрятаться негде — только манёвр.',
    w: 460,
    h: 200,
    seed: 3310,
    span: [0.1, 0.9],
    build(m, r) {
      ground(m, Terrain.Plains);
      scatter(m, r, 14, 40, 20, 420, 180, 16, Terrain.Sand);
      scatter(m, r, 5, 60, 24, 400, 176, 13, Terrain.Hills);
      // Low bluffs along the northern edge, the only ground worth holding.
      blob(m, r, 230, 12, 26, Terrain.Hills);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(460, 11),
  },
  {
    id: 'cannae',
    name: 'Канны',
    when: '216 до н. э.',
    blurb: 'Плоское поле, прижатое рекой Ауфид. Фланг упирается в воду — обойти можно только с одной стороны.',
    w: 420,
    h: 210,
    seed: 2160,
    span: [0.16, 0.86],
    build(m, r) {
      ground(m, Terrain.Plains);
      const aufidus = meander(r, -8, 176, m.w + 8, 190, 16);
      stampPath(m, aufidus, 13, Terrain.Water);
      stampPath(m, meander(r, -8, 168, m.w + 8, 182, 16), 4, Terrain.Sand);
      bridge(m, aufidus, 0.5, 9);
      scatter(m, r, 6, 60, 20, 360, 140, 15, Terrain.Sand);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(420, 10),
  },
  {
    id: 'teutoburg',
    name: 'Тевтобургский лес',
    when: '9 н. э.',
    blurb: 'Тесный проход между лесом и болотом. Численность здесь почти ничего не решает.',
    w: 360,
    h: 260,
    seed: 9009,
    span: [0.3, 0.7],
    build(m, r) {
      ground(m, Terrain.Forest);
      // The defile: a passable corridor through the trees, boggy on both sides.
      const road = meander(r, -8, 128, m.w + 8, 132, 26);
      stampPath(m, road, 38, Terrain.Plains);
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9;
        const k = Math.floor((road.length >> 1) * t) * 2;
        blob(m, r, road[k]!, road[k + 1]! + (i % 2 ? 30 : -30), range(r, 12, 20), Terrain.Water);
      }
      scatter(m, r, 10, 30, 30, 330, 230, 16, Terrain.Hills);
      blob(m, r, 60, 40, 26, Terrain.Mountain);
      blob(m, r, 300, 220, 26, Terrain.Mountain);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(360, 9),
  },
  {
    id: 'hastings',
    name: 'Гастингс',
    when: '1066',
    blurb: 'Гряда Сенлак. Одна сторона стоит на холме, другая идёт вверх через болото у подножия.',
    w: 380,
    h: 220,
    seed: 1066,
    span: [0.14, 0.88],
    build(m, r) {
      ground(m, Terrain.Plains);
      // Harold's ridge, and the marsh the Normans had to cross to reach it.
      ridge(m, r, 236, -10, m.h + 10, 46, 14, Terrain.Hills);
      ridge(m, r, 206, -10, m.h + 10, 16, 18, Terrain.Water);
      scatter(m, r, 8, 250, 20, 360, 200, 15, Terrain.Forest);
      scatter(m, r, 6, 30, 20, 150, 200, 18, Terrain.Forest);
      blob(m, r, 300, 60, 20, Terrain.Mountain);
      blob(m, r, 312, 168, 18, Terrain.Mountain);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: (m, ty) => banksAt(m, ty, 150, 280, 4),
  },
  {
    id: 'agincourt',
    name: 'Азенкур',
    when: '1415',
    blurb: 'Узкое раскисшее поле между двумя лесами. Развернуть больше, чем влезает, невозможно.',
    w: 400,
    h: 240,
    seed: 1415,
    span: [0.36, 0.64],
    build(m, r) {
      ground(m, Terrain.Plains);
      // The woods of Agincourt and Tramecourt, squeezing the field to a corridor.
      for (let x = 20; x < m.w - 20; x += 26) {
        blob(m, r, x, range(r, 34, 52), range(r, 26, 36), Terrain.Forest);
        blob(m, r, x, range(r, m.h - 52, m.h - 34), range(r, 26, 36), Terrain.Forest);
      }
      // Ploughed and rained on for a week: mud the whole length of the gap.
      scatter(m, r, 16, 150, 96, 260, 148, 18, Terrain.Sand);
      blob(m, r, 40, 120, 22, Terrain.Forest);
      blob(m, r, 360, 120, 22, Terrain.Forest);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(400, 12),
  },
  {
    id: 'borodino',
    name: 'Бородино',
    when: '1812',
    blurb: 'Холмы, ручей Колоча и флеши на высотах. Всё решают несколько курганов.',
    w: 420,
    h: 230,
    seed: 1812,
    span: [0.12, 0.9],
    build(m, r) {
      ground(m, Terrain.Plains);
      const kolocha = meander(r, 196, -8, 214, m.h + 8, 22);
      stampPath(m, kolocha, 9, Terrain.Water);
      bridge(m, kolocha, 0.25, 8);
      bridge(m, kolocha, 0.55, 8);
      bridge(m, kolocha, 0.85, 8);
      // The redoubts: the high ground everything was thrown at.
      for (const [x, y, rad] of [[236, 78, 20], [244, 132, 22], [252, 186, 18], [176, 96, 18], [168, 158, 18]] as const) {
        blob(m, r, x, y, rad, Terrain.Hills);
      }
      scatter(m, r, 9, 40, 24, 380, 206, 17, Terrain.Forest);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: (m, ty) => banksAt(m, ty, 130, 290, 3),
  },
  {
    id: 'gettysburg',
    name: 'Геттисберг',
    when: '1863',
    blurb: 'Две параллельные гряды и долина между ними. Кто держит хребет, держит бой.',
    w: 400,
    h: 250,
    seed: 1863,
    span: [0.1, 0.9],
    build(m, r) {
      ground(m, Terrain.Plains);
      // Seminary Ridge to the west, Cemetery Ridge to the east.
      ridge(m, r, 150, -10, m.h + 10, 30, 12, Terrain.Hills);
      ridge(m, r, 254, -10, m.h + 10, 34, 12, Terrain.Hills);
      // Little Round Top: the rocky hill that anchored the southern flank.
      blob(m, r, 262, 214, 20, Terrain.Hills);
      blob(m, r, 262, 216, 11, Terrain.Mountain);
      blob(m, r, 148, 30, 18, Terrain.Hills);
      scatter(m, r, 10, 40, 24, 360, 226, 15, Terrain.Forest);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(400, 14),
  },
  {
    id: 'verdun',
    name: 'Верден',
    when: '1916',
    blurb: 'Форты на высотах над Маасом и перепаханная снарядами земля между ними.',
    w: 400,
    h: 240,
    seed: 1916,
    span: [0.12, 0.9],
    build(m, r) {
      ground(m, Terrain.Plains);
      const meuse = meander(r, 96, -8, 108, m.h + 8, 18);
      stampPath(m, meuse, 12, Terrain.Water);
      bridge(m, meuse, 0.3, 9);
      bridge(m, meuse, 0.7, 9);
      // The fort line east of the river, on every piece of high ground.
      for (const [x, y] of [[218, 58], [246, 116], [226, 176], [286, 84], [292, 156]] as const) {
        blob(m, r, x, y, 19, Terrain.Hills);
        blob(m, r, x, y, 7, Terrain.Mountain);
      }
      scatter(m, r, 12, 150, 30, 340, 210, 13, Terrain.Forest);
      // Ground churned to mud by a year of shelling.
      scatter(m, r, 20, 170, 40, 300, 200, 9, Terrain.Sand);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(400, 13),
  },
  {
    id: 'stalingrad',
    name: 'Сталинград',
    when: '1942',
    blurb: 'Город на берегу Волги. Драться приходится квартал за кварталом, и отступать некуда.',
    w: 380,
    h: 260,
    seed: 1942,
    span: [0.12, 0.9],
    build(m, r) {
      ground(m, Terrain.Plains);
      // The Volga along the eastern edge: one side fights with its back to it.
      const volga = meander(r, 322, -8, 336, m.h + 8, 14);
      stampPath(m, volga, 26, Terrain.Water);
      bridge(m, volga, 0.3, 16);
      bridge(m, volga, 0.72, 16);
      stampPath(m, meander(r, 300, -8, 314, m.h + 8, 14), 6, Terrain.Sand);
      // The city itself: blocks of rubble, impassable at the core. It straddles
      // the start line on purpose — the whole point of this one is that the fight
      // begins inside the streets rather than out on the approaches.
      for (let y = 26; y < m.h - 26; y += 28) {
        for (let x = 150; x < 290; x += 28) {
          town(m, r, x + range(r, -5, 5), y + range(r, -5, 5), range(r, 10, 15));
        }
      }
      scatter(m, r, 8, 30, 30, 120, 230, 16, Terrain.Sand);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(380, 16),
  },
  {
    id: 'kursk',
    name: 'Курская дуга',
    when: '1943',
    blurb: 'Открытая степь на десятки километров. Никаких укрытий — только глубина обороны.',
    w: 480,
    h: 240,
    seed: 1943,
    span: [0.08, 0.92],
    build(m, r) {
      ground(m, Terrain.Plains);
      scatter(m, r, 9, 60, 30, 420, 210, 20, Terrain.Forest);
      scatter(m, r, 7, 100, 40, 380, 200, 18, Terrain.Hills);
      const psel = meander(r, -8, 52, m.w + 8, 40, 20);
      stampPath(m, psel, 8, Terrain.Water);
      bridge(m, psel, 0.35, 7);
      bridge(m, psel, 0.72, 7);
      // Belt after belt of dug-in positions, which is what the battle actually was.
      for (const x of [188, 208, 228]) ridge(m, r, x, 70, m.h - 20, 7, 16, Terrain.Sand);
    },
    cities: (m) => standardCities(m.w, m.h),
    front: facing(480, 15),
  },
  {
    id: 'crossing',
    name: 'Переправа',
    when: 'без даты',
    blurb: 'Безымянная река с тремя мостами. Учебная карта: всё держится на том, кто владеет переправами.',
    w: 400,
    h: 225,
    seed: 4242,
    span: [0.1, 0.9],
    build(m, r) {
      ground(m, Terrain.Plains);
      for (const [cx, cy, rad] of [[70, 40, 22], [58, 176, 20], [330, 52, 24], [346, 180, 20], [210, 26, 18], [196, 200, 18]] as const) {
        blob(m, r, cx, cy, rad, Terrain.Forest);
      }
      for (const [cx, cy, rad] of [[252, 60, 30], [286, 108, 24], [140, 150, 26], [110, 96, 20], [312, 156, 20]] as const) {
        blob(m, r, cx, cy, rad, Terrain.Hills);
        blob(m, r, cx + range(r, -5, 5), cy + range(r, -5, 5), rad * 0.45, Terrain.Mountain);
      }
      const river = meander(r, 190, -8, 206, m.h + 8, 26);
      stampPath(m, river, 8, Terrain.Water);
      const east = meander(r, 206, 110, m.w + 8, 88, 24);
      stampPath(m, east, 8, Terrain.Water);
      bridge(m, river, 0.2, 9);
      bridge(m, river, 0.52, 9);
      bridge(m, river, 0.82, 9);
      bridge(m, east, 0.4, 8);
    },
    cities: () => [
      city(30, 112, 0, true), city(372, 112, 1, true),
      city(92, 56, 0), city(88, 168, 0), city(150, 108, 0),
      city(306, 60, 1), city(310, 170, 1), city(250, 112, 1),
      city(198, 40, -1), city(200, 186, -1),
    ],
    front: (m, ty) => banksAt(m, ty, 140, 270, 2),
  },
];

export function levelById(id: string): Level {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0]!;
}

/**
 * Makes sure every point can actually be walked to.
 *
 * Clearing a disc around a point is not enough. Drop one inside a mountain and
 * the disc becomes a walled courtyard with the point standing in the middle of
 * it: nobody can reach it, nobody can take it, and it feeds supply to a pocket
 * of ground the size of a tennis court. Hastings had one. So: flood the main
 * body of the map, and cut a path out to anything the flood did not reach.
 */
function connectCities(m: GameMap): void {
  const n = m.w * m.h;
  const seen = new Uint8Array(n);
  const q = new Int32Array(n);

  let start = -1;
  let bestD = Infinity;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.tiles[y * m.w + x] === Terrain.Mountain) continue;
      const d = Math.hypot(x - m.w / 2, y - m.h / 2);
      if (d < bestD) {
        bestD = d;
        start = y * m.w + x;
      }
    }
  }
  if (start < 0) return;

  let head = 0;
  let tail = 0;
  seen[start] = 1;
  q[tail++] = start;
  while (head < tail) {
    const i = q[head++]!;
    const x = i % m.w;
    const y = (i / m.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
      const j = ny * m.w + nx;
      if (seen[j] || m.tiles[j] === Terrain.Mountain) continue;
      seen[j] = 1;
      q[tail++] = j;
    }
  }

  for (const c of m.cities) {
    if (seen[c.y * m.w + c.x]) continue;
    // Nearest tile the main body did reach, then a corridor straight to it.
    let tx = -1;
    let ty = -1;
    for (let r = 1; r < Math.max(m.w, m.h) && tx < 0; r++) {
      for (let dy = -r; dy <= r && tx < 0; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          if (x < 1 || y < 1 || x >= m.w - 1 || y >= m.h - 1) continue;
          if (!seen[y * m.w + x]) continue;
          tx = x;
          ty = y;
          break;
        }
      }
    }
    if (tx >= 0) stampPath(m, [c.x, c.y, tx, ty], 5, Terrain.Plains);
  }
}

export function createMap(level: Level): GameMap {
  const m: GameMap = {
    w: level.w,
    h: level.h,
    tiles: new Uint8Array(level.w * level.h).fill(Terrain.Plains),
    cities: [],
    worldW: level.w * TILE,
    worldH: level.h * TILE,
  };
  const r = makeRng(level.seed);
  level.build(m, r);
  m.cities = level.cities(m);
  // Nobody has to storm a cliff to stand on a point, and nobody has to be able
  // to get to it either — those are two different problems.
  for (const c of m.cities) disc(m, c.x, c.y, 4, Terrain.Plains);
  // A rim of cliff, so an army driven to the edge is driven into something.
  for (let x = 0; x < m.w; x++) {
    set(m, x, 0, Terrain.Mountain);
    set(m, x, m.h - 1, Terrain.Mountain);
  }
  for (let y = 0; y < m.h; y++) {
    set(m, 0, y, Terrain.Mountain);
    set(m, m.w - 1, y, Terrain.Mountain);
  }
  connectCities(m);
  return m;
}
