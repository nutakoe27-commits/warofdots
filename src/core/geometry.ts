/** Pure 2D helpers shared by input handling, pathing and the bots. */

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Perpendicular distance from `(px, py)` to the segment `a → b`. */
export function pointSegmentDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return dist(px, py, ax + dx * t, ay + dy * t);
}

/**
 * Ramer–Douglas–Peucker on a flat `[x0, y0, x1, y1, ...]` list.
 * Iterative so a 4000-point mouse drag cannot blow the stack.
 */
export function rdpSimplify(pts: number[], eps: number): number[] {
  const n = pts.length >> 1;
  if (n <= 2) return pts.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    if (hi - lo < 2) continue;

    const ax = pts[lo * 2]!;
    const ay = pts[lo * 2 + 1]!;
    const bx = pts[hi * 2]!;
    const by = pts[hi * 2 + 1]!;

    let best = -1;
    let bestD = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointSegmentDist(pts[i * 2]!, pts[i * 2 + 1]!, ax, ay, bx, by);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push(lo, best, best, hi);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2]!, pts[i * 2 + 1]!);
  }
  return out;
}

/**
 * Even–odd point-in-polygon over a flat vertex list. Used by lasso selection,
 * which draws an arbitrary closed loop rather than a rectangle.
 */
export function pointInPolygon(poly: number[], px: number, py: number): boolean {
  const n = poly.length >> 1;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!;
    const yi = poly[i * 2 + 1]!;
    const xj = poly[j * 2]!;
    const yj = poly[j * 2 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonBounds(poly: number[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i]!;
    const y = poly[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Drops points closer than `minStep` to the previous kept point. */
export function decimate(pts: number[], minStep: number): number[] {
  if (pts.length < 4) return pts.slice();
  const out: number[] = [pts[0]!, pts[1]!];
  const min2 = minStep * minStep;
  for (let i = 2; i < pts.length; i += 2) {
    const lx = out[out.length - 2]!;
    const ly = out[out.length - 1]!;
    if (dist2(pts[i]!, pts[i + 1]!, lx, ly) >= min2) out.push(pts[i]!, pts[i + 1]!);
  }
  const n = pts.length;
  const lx = out[out.length - 2]!;
  const ly = out[out.length - 1]!;
  if (lx !== pts[n - 2]! || ly !== pts[n - 1]!) out.push(pts[n - 2]!, pts[n - 1]!);
  return out;
}

export function polylineLength(pts: ArrayLike<number>): number {
  let total = 0;
  for (let i = 2; i < pts.length; i += 2) {
    total += dist(pts[i]!, pts[i + 1]!, pts[i - 2]!, pts[i - 1]!);
  }
  return total;
}
