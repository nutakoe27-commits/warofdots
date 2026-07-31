/** Boots straight into the match: one map, no menu. */

import './style.css';
import { createWorld, pruneSelection, BLUE, RED } from './world.ts';
import { step, TICK, troopCount } from './sim.ts';
import { createCamera, clamp } from './camera.ts';
import { attachInput, clearOrders, confirmOrders, createInput, stopSelected, updateCamera } from './input.ts';
import { render } from './render.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('index.html is missing #game');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d context unavailable');
const hud = document.getElementById('hud');

const world = createWorld();
const camera = createCamera(world.map.worldW, world.map.worldH, window.innerWidth, window.innerHeight);
const input = createInput();
const keys = new Set<string>();
let fogOn = true;
let paused = false;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  camera.vw = window.innerWidth;
  camera.vh = window.innerHeight;
  canvas!.width = Math.round(camera.vw * dpr);
  canvas!.height = Math.round(camera.vh * dpr);
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  clamp(camera, world.map.worldW, world.map.worldH);
}
window.addEventListener('resize', resize);
resize();

attachInput(canvas, { world, camera, input });

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (e.key === 'Enter') confirmOrders(world);
  else if (k === 'c') clearOrders(world);
  else if (k === 's' && !keys.has('shift')) stopSelected(world);
  else if (k === 'f') fogOn = !fogOn;
  else if (k === 'escape') world.selection.clear();
  else if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateHud(): void {
  if (!hud) return;
  hud.innerHTML =
    `<div class="time">${clock(world.time)}</div>` +
    `<div class="troops"><b>Войска</b>` +
    `<span class="blue">${troopCount(world, BLUE)}</span>` +
    `<span class="red">${troopCount(world, RED)}</span></div>` +
    `<div class="losses"><b>Потери</b>` +
    `<span class="blue">${world.casualties[BLUE]}</span>` +
    `<span class="red">${world.casualties[RED]}</span></div>` +
    `<div class="sel">Выделено: ${world.selection.size}` +
    (world.pending.size ? ` · приказов к подтверждению: ${world.pending.size} <b>[Enter]</b>` : '') +
    `</div>`;
}

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  updateCamera({ world, camera, input }, keys, dt);

  if (!paused) {
    acc += dt;
    let guard = 0;
    while (acc >= TICK && guard++ < 5) {
      step(world);
      acc -= TICK;
    }
    pruneSelection(world);
  }

  render(ctx!, world, camera, input, fogOn);
  updateHud();
}
requestAnimationFrame(frame);
