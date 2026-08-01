/**
 * Sound, made from scratch with Web Audio.
 *
 * Every noise here is synthesised at run time — filtered noise and a few
 * oscillators. Nothing is sampled from anywhere, there are no files to load, and
 * the whole thing is a couple of kilobytes of arithmetic.
 *
 * Battle is a **crackle of separate reports**, not a wash.
 *
 * The first version held a loop of filtered noise open and rode its gain with the
 * number of units fighting. On paper that is a battle heard from a distance; in
 * practice a continuous band of noise is a hiss, and it sounded like a broken
 * radio for as long as anyone was in contact. What actually reads as gunfire is
 * discrete events: individual cracks at a rate you can almost count at four a
 * second and cannot at forty. So the fighting is scheduled shots — each a short
 * filtered burst with a hard attack — at a rate that follows the fighting, over a
 * very quiet low rumble that only carries the weight.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

/** The low weight under a big fight. Never loud enough to be heard as noise. */
let rumbleGain: GainNode | null = null;
let volume = 0.7;
let muted = false;

/** Shots per second the battle is currently generating. */
let fireRate = 0;
/** Audio-clock time up to which shots have already been scheduled. */
let scheduledTo = 0;

function makeNoise(c: AudioContext): AudioBuffer {
  const b = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/**
 * Must be called from a real click. Browsers will not start an AudioContext any
 * other way, which is why every menu button does it.
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

  // Distant weight: heavily lowpassed, and quiet enough that on its own you would
  // not be able to say whether it was on.
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 110;
  low.Q.value = 0.4;
  rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.connect(low);
  low.connect(rumbleGain);
  rumbleGain.connect(master);
  src.start();

  scheduledTo = ctx.currentTime;
  setInterval(scheduleShots, 90);
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

/** One report: a hard click with a short filtered tail. */
function shot(at: number, far: boolean): void {
  if (!ctx || !master || !noise) return;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.6 + Math.random() * 0.9;

  const band = ctx.createBiquadFilter();
  band.type = far ? 'lowpass' : 'bandpass';
  band.frequency.value = far ? 500 + Math.random() * 400 : 700 + Math.random() * 1800;
  band.Q.value = far ? 0.7 : 1.4;

  const g = ctx.createGain();
  const peak = (far ? 0.05 : 0.12) * (0.6 + Math.random() * 0.7);
  const decay = far ? 0.1 + Math.random() * 0.1 : 0.03 + Math.random() * 0.05;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + decay);

  src.connect(band);
  band.connect(g);
  g.connect(master);
  src.start(at);
  src.stop(at + decay + 0.02);
}

/**
 * Keeps roughly a fifth of a second of shots queued ahead of the audio clock.
 *
 * Scheduled on the audio clock rather than fired from the frame loop, because
 * gaps between frames are uneven enough to be audible as stumbling, and a burst
 * of fire that stumbles sounds broken rather than busy.
 */
function scheduleShots(): void {
  if (!ctx || fireRate <= 0) return;
  const horizon = ctx.currentTime + 0.25;
  if (scheduledTo < ctx.currentTime) scheduledTo = ctx.currentTime;
  let guard = 0;
  while (scheduledTo < horizon && guard++ < 40) {
    // Exponential gaps: real fire is ragged, evenly spaced shots read as a machine.
    scheduledTo += -Math.log(1 - Math.random()) / fireRate;
    if (scheduledTo > horizon) break;
    shot(scheduledTo, Math.random() < 0.45);
  }
}

/**
 * How busy the battle is, from the number of units in contact.
 *
 * Square-rooted, and capped: sixty men fighting is not sixty times one man
 * fighting, and past a couple of dozen reports a second the ear stops counting
 * and just hears "a battle".
 */
export function setCombat(engaged: number): void {
  fireRate = engaged <= 0 ? 0 : Math.min(26, 1.6 * Math.sqrt(engaged) + engaged * 0.16);
  if (!ctx || !rumbleGain) return;
  const k = Math.min(1, Math.sqrt(Math.max(0, engaged)) / 7);
  rumbleGain.gain.setTargetAtTime(k * 0.16, ctx.currentTime, 0.4);
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
  burst(150, 1.1, 0.22, 0.14);
  tone(85, 0.12, 0.16, 'sine', 0, 44);
}

/** Orders given. Dry click, so holding the mouse down does not become a rattle. */
export function sfxOrder(): void {
  burst(1500, 5, 0.09, 0.045);
  tone(520, 0.045, 0.06, 'square');
}

export function sfxSelect(): void {
  tone(760, 0.045, 0.055, 'triangle');
}

export function sfxCapture(taken: boolean): void {
  const base = taken ? 520 : 392;
  tone(base, 0.1, 0.18);
  tone(base * (taken ? 1.5 : 0.667), 0.08, 0.3, 'triangle', 0.1);
}

/** Somebody of yours has just been cut off. Low, once, easy to miss on purpose. */
export function sfxCutOff(): void {
  tone(196, 0.09, 0.5, 'sawtooth', 0, 140);
}

export function sfxClick(): void {
  burst(2400, 6, 0.055, 0.03);
}

export function sfxEnd(won: boolean): void {
  const notes = won ? [392, 523, 659, 784] : [392, 330, 262, 196];
  notes.forEach((f, i) => tone(f, 0.13, won ? 0.5 : 0.7, 'triangle', i * 0.14));
}
