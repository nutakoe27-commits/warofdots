/** Boots straight into the match: no menu, one map. */

import './style.css';
import { createWorld } from './world.ts';
import { jostle, step, TICK } from './sim.ts';
import { computeView, render } from './render.ts';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('index.html is missing #game');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d context unavailable');

const world = createWorld();
jostle(world);

let fogOn = true;
let paused = false;
let cssW = 1;
let cssH = 1;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  canvas!.width = Math.round(cssW * dpr);
  canvas!.height = Math.round(cssH * dpr);
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') fogOn = !fogOn;
  if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
  }
});

// Fixed 30 Hz simulation, drawn as fast as the display allows.
let last = performance.now();
let accumulator = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (!paused) {
    accumulator += dt;
    let guard = 0;
    while (accumulator >= TICK && guard++ < 5) {
      step(world);
      accumulator -= TICK;
    }
  }

  render(ctx!, world, computeView(world.map, cssW, cssH), cssW, cssH, fogOn);
}
requestAnimationFrame(frame);
