/**
 * Boots into the menu, runs a match, and comes back.
 *
 * The frame loop always runs; what changes is the mode. Paused and finished
 * leave the simulation frozen with the last frame still on screen behind the
 * card, which is cheaper than tearing the canvas down and looks better than a
 * blank one.
 */

import './style.css';
import { createWorld, pruneSelection, BLUE, RED } from './world.ts';
import type { World } from './world.ts';
import { cutOffCount, step, TICK, troopCount } from './sim.ts';
import { createBrain, runBrain, DIFFICULTIES } from './ai.ts';
import type { Brain } from './ai.ts';
import { createCamera, clamp } from './camera.ts';
import { attachInput, clearOrders, createInput, stopSelected, updateCamera } from './input.ts';
import { render } from './render.ts';
import { hideScreen, renderMenu, renderPause, renderResult } from './menu.ts';
import type { Choice } from './menu.ts';
import { initAudio, resume, setCombat, sfxCapture, sfxCutOff, sfxDeath, sfxEnd } from './audio.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('index.html is missing #game');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d context unavailable');
const hud = document.getElementById('hud')!;
const hint = document.getElementById('hint')!;
const screen = document.getElementById('screen')!;

type Mode = 'menu' | 'playing' | 'paused' | 'over';

let mode: Mode = 'menu';
let world: World | null = null;
let brain: Brain | null = null;
let choice: Choice | null = null;
let camera = createCamera(1000, 1000, window.innerWidth, window.innerHeight);
const input = createInput();
const keys = new Set<string>();
let fogOn = true;
let lastCutOff = 0;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  camera.vw = window.innerWidth;
  camera.vh = window.innerHeight;
  canvas!.width = Math.round(camera.vw * dpr);
  canvas!.height = Math.round(camera.vh * dpr);
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (world) clamp(camera, world.map.worldW, world.map.worldH);
}
window.addEventListener('resize', resize);
resize();

attachInput(canvas, {
  get world() {
    return world!;
  },
  get camera() {
    return camera;
  },
  input,
  get enabled() {
    return mode === 'playing';
  },
});

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pause(): void {
  mode = 'paused';
  renderPause(screen, () => {
    mode = 'playing';
    hideScreen(screen);
  }, toMenu);
}

function startMatch(c: Choice): void {
  // The audio context can only be created inside a real click, which is exactly
  // what this is.
  initAudio();
  resume();
  choice = c;
  world = createWorld({ level: c.level, difficulty: c.difficulty, perSide: c.perSide });
  brain = createBrain(RED, DIFFICULTIES[c.difficulty]!);
  camera = createCamera(world.map.worldW, world.map.worldH, window.innerWidth, window.innerHeight);
  input.lasso = [];
  input.route = [];
  input.drag = 'none';
  lastCutOff = 0;
  keys.clear();
  mode = 'playing';
  hideScreen(screen);
  hud.hidden = false;
  hint.hidden = false;
  resize();
}

function toMenu(): void {
  mode = 'menu';
  world = null;
  brain = null;
  setCombat(0);
  hud.hidden = true;
  hint.hidden = true;
  renderMenu(screen, startMatch);
}

function finish(): void {
  const w = world!;
  mode = 'over';
  setCombat(0);
  const won = w.winner === BLUE;
  sfxEnd(won);
  hud.hidden = true;
  hint.hidden = true;
  renderResult(
    screen,
    {
      won,
      level: choice!.level,
      difficulty: choice!.difficulty,
      time: clock(w.time),
      lost: w.casualties[BLUE],
      killed: w.casualties[RED],
      left: troopCount(w, BLUE),
    },
    () => startMatch(choice!),
    toMenu,
  );
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    e.preventDefault();
    // Esc clears a selection first and only opens the menu when there is nothing
    // to clear, so it never yanks you out in the middle of giving an order.
    if (mode === 'playing') {
      if (world && world.selection.size > 0) world.selection.clear();
      else pause();
    } else if (mode === 'paused') {
      mode = 'playing';
      hideScreen(screen);
    }
    return;
  }
  if (mode !== 'playing' || !world) return;

  keys.add(k);
  if (k === 'c') clearOrders(world);
  else if (k === 's' && !keys.has('shift')) stopSelected(world);
  else if (k === 'f') fogOn = !fogOn;
  else if (e.code === 'Space') {
    e.preventDefault();
    pause();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function updateHud(w: World): void {
  const cut = cutOffCount(w, BLUE);
  hud.innerHTML =
    `<div class="time">${clock(w.time)}</div>` +
    `<div class="troops"><b>Войска</b>` +
    `<span class="blue">${troopCount(w, BLUE)}</span>` +
    `<span class="red">${troopCount(w, RED)}</span></div>` +
    `<div class="losses"><b>Потери</b>` +
    `<span class="blue">${w.casualties[BLUE]}</span>` +
    `<span class="red">${w.casualties[RED]}</span></div>` +
    `<div class="sel">Выделено: ${w.selection.size}` +
    (cut ? ` · <b class="cut">без снабжения: ${cut}</b>` : '') +
    `</div>`;
}

/** Turns what happened this frame into noise, then clears the tally. */
function playEvents(w: World): void {
  // One thud per frame however many fell. A line coming apart kills a dozen men
  // in the same tick, and a dozen overlapping thuds is a burst of static.
  if (w.events.deaths > 0) sfxDeath();
  if (w.events.captured > 0) sfxCapture(true);
  w.events.deaths = 0;
  w.events.captured = 0;

  const cut = cutOffCount(w, BLUE);
  if (cut > lastCutOff) sfxCutOff();
  lastCutOff = cut;

  let engaged = 0;
  for (const u of w.units) if (u.alive && u.inCombat) engaged++;
  setCombat(engaged);
}

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (!world) return;
  const w = world;

  if (mode === 'playing') {
    updateCamera({ world: w, camera, input, enabled: true }, keys, dt);
    acc += dt;
    let guard = 0;
    while (acc >= TICK && guard++ < 5) {
      if (brain) runBrain(w, brain);
      step(w);
      acc -= TICK;
    }
    pruneSelection(w);
    playEvents(w);
    updateHud(w);
    if (w.winner >= 0) finish();
  }

  render(ctx!, w, camera, input, fogOn);
}

toMenu();
requestAnimationFrame(frame);
