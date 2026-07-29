/**
 * The whole DOM vocabulary of the HUD.
 *
 * The interesting decision is `setText`: the HUD runs `update()` on every animation
 * frame, and writing `textContent` invalidates layout even when the string is
 * identical. Every panel therefore writes through this file and never touches
 * `textContent` directly, which turns a per-frame relayout into a string compare.
 *
 * Styling lives entirely in the stylesheet — nothing here sets a colour or a size.
 * The only inline styles in the UI are genuinely dynamic geometry (a progress
 * bar's width).
 */

/** Thin space, used to group digits without inviting a line break. */
const GROUP_SEP = '\u2009';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Writes only when the text actually changed. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (v: number) => void;
  /** Renders the readout beside the label. Defaults to the bare number. */
  format?: (v: number) => string;
}

export interface SliderHandle {
  readonly root: HTMLElement;
  /** Moves the thumb from outside — ignored while the user holds the input. */
  set(v: number): void;
}

export function slider(opts: SliderOptions): SliderHandle {
  const root = el('label', 'df-slider');
  const label = el('span', 'df-slider__label');
  const input = el('input', 'df-slider__input');
  input.type = 'range';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);

  const format = opts.format ?? ((v: number): string => String(v));
  const paint = (v: number): void => setText(label, `${opts.label} · ${format(v)}`);
  paint(Number(input.value));

  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    opts.onInput(v);
  });
  root.append(label, input);

  return {
    root,
    set(v: number): void {
      // A value echoing back through the simulation must never yank a live drag.
      if (document.activeElement === input) return;
      if (Number(input.value) !== v) input.value = String(v);
      paint(Number(input.value));
    },
  };
}

/** `12 480`, grouped with thin spaces. Rounds; keeps the sign. */
export function fmtInt(n: number): string {
  const rounded = Math.round(n);
  const digits = Math.abs(rounded).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += GROUP_SEP;
    out += digits[i]!;
  }
  return rounded < 0 ? `-${out}` : out;
}

/** `+12.5` / `-3.0`. Always signed, because a rate's sign is the point. */
export function fmtRate(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded < 0 ? '-' : '+'}${Math.abs(rounded).toFixed(1)}`;
}

/** `m:ss`. Minutes are not wrapped into hours — matches never run that long. */
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
