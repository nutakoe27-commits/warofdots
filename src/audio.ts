/**
 * Sound, made from scratch with Web Audio.
 *
 * Every noise here is synthesised at run time — filtered noise and a few
 * oscillators. Nothing is sampled from anywhere, there are no files to load, and
 * the whole thing is a couple of kilobytes of arithmetic.
 *
 * The bed is the important part. Battle is a continuous crackle whose loudness
 * and brightness track how many units are actually in contact, so you can hear a
 * fight start on the far side of the map without looking at it, and hear it die
 * down when it is over. The one-shots on top are deliberately quiet and dry: this
 * runs for twenty minutes at a stretch and anything with a tail becomes mud.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

/** Combat bed. */
let bedGain: GainNode | null = null;
let bedFilter: BiquadFilterNode | null = null;
let volume = 0.7;
let muted = false;

function makeNoise(c: AudioContext): AudioBuffer {
  const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = b.getChannelData(0);
  // Brown-ish rather than white: white noise on a loop reads as tape hiss, and a
  // battle two kilometres away is mostly low end.
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + w * 0.16) / 1.02;
    d[i] = last * 3.2;
  }
  return b;
}

/**
 * Must be called from a real click. Browsers will not start an AudioContext any
 * other way, which is why the menu's start button is the thing that does it.
 */
export function initAudio(): void {
  if (ctx) return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(ctx.destination);
  noise = makeNoise(ctx);

  bedFilter = ctx.createBiquadFilter();
  bedFilter.type = 'bandpass';
  bedFilter.frequency.value = 320;
  bedFilter.Q.value = 0.7;
  bedGain = ctx.createGain();
  bedGain.gain.value = 0;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.connect(bedFilter);
  bedFilter.connect(bedGain);
  bedGain.connect(master);
  src.start();
}

export function setVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
  if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
}

export function setMuted(m: boolean): void {
  muted = m;
  setVolume(volume);
}

export function isMuted(): boolean {
  return muted;
}

export function getVolume(): number {
  return volume;
}

export function resume(): void {
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

/**
 * How loud the battle is, from the number of units in contact.
 *
 * Square-rooted, because sixty men fighting is not sixty times one man fighting —
 * past a point it is just "a battle" and the ear stops counting.
 */
export function setCombat(engaged: number): void {
  if (!ctx || !bedGain || !bedFilter) return;
  const k = Math.min(1, Math.sqrt(engaged) / 6);
  bedGain.gain.setTargetAtTime(k * 0.5, ctx.currentTime, 0.25);
  bedFilter.frequency.setTargetAtTime(300 + k * 700, ctx.currentTime, 0.4);
}

function burst(freq: number, q: number, gain: number, decay: number, delay = 0): void {
  if (!ctx || !master || !noise) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + decay + 0.02);
}

function tone(freq: number, gain: number, decay: number, type: OscillatorType = 'triangle', delay = 0, slideTo = 0): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo > 0) o.frequency.exponentialRampToValueAtTime(slideTo, t + decay);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + decay + 0.02);
}

/** A unit dies: a dull thud, no ring. There are hundreds of these in a match. */
export function sfxDeath(): void {
  burst(160, 1.1, 0.28, 0.16);
  tone(90, 0.14, 0.18, 'sine', 0, 46);
}

/** Orders given. Dry click, so holding the mouse down does not become a rattle. */
export function sfxOrder(): void {
  burst(1500, 5, 0.1, 0.05);
  tone(520, 0.05, 0.07, 'square');
}

export function sfxSelect(): void {
  tone(760, 0.05, 0.06, 'triangle');
}

export function sfxCapture(taken: boolean): void {
  const base = taken ? 520 : 392;
  tone(base, 0.11, 0.18);
  tone(base * (taken ? 1.5 : 0.667), 0.09, 0.3, 'triangle', 0.1);
}

/** Somebody of yours has just been cut off. Low, once, easy to miss on purpose. */
export function sfxCutOff(): void {
  tone(196, 0.1, 0.5, 'sawtooth', 0, 140);
}

export function sfxClick(): void {
  burst(2400, 6, 0.06, 0.035);
}

export function sfxEnd(won: boolean): void {
  const notes = won ? [392, 523, 659, 784] : [392, 330, 262, 196];
  notes.forEach((f, i) => tone(f, 0.14, won ? 0.5 : 0.7, 'triangle', i * 0.14));
}
