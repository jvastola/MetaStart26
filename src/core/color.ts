/**
 * Colour maths for the colour wheel. Pure, so it is unit-tested.
 * h in [0, 360), s and v in [0, 1].
 */

export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [r + m, g + m, b + m];
}

export function hsvToHex(hsv: Hsv): string {
  return `#${hsvToRgb(hsv)
    .map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function hexToHsv(hex: string): Hsv {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * Wheel geometry in normalised units (radius 1): the hue ring spans
 * [RING_IN, 1]; the saturation/value square is centred, half-size SQUARE.
 */
export const RING_IN = 0.78;
export const SQUARE = 0.5;

export type WheelHit = { part: 'ring'; h: number } | { part: 'square'; s: number; v: number } | null;

/** What a point on the wheel (x right, y up, radius 1) selects. */
export function wheelHit(x: number, y: number, grabbed?: 'ring' | 'square'): WheelHit {
  const r = Math.hypot(x, y);
  // While dragging, stay on the part you grabbed even past its edge.
  if (grabbed === 'ring' || (!grabbed && r >= RING_IN - 0.04 && r <= 1.05)) {
    return { part: 'ring', h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
  }
  if (grabbed === 'square' || (!grabbed && Math.abs(x) <= SQUARE + 0.03 && Math.abs(y) <= SQUARE + 0.03)) {
    const s = Math.min(1, Math.max(0, (x + SQUARE) / (2 * SQUARE)));
    const v = Math.min(1, Math.max(0, (y + SQUARE) / (2 * SQUARE)));
    return { part: 'square', s, v };
  }
  return null;
}
