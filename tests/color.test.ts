import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, RING_IN, SQUARE, wheelHit } from '../src/core/color';

describe('colour maths', () => {
  it.each([
    ['#ff0000', { h: 0, s: 1, v: 1 }],
    ['#00ff00', { h: 120, s: 1, v: 1 }],
    ['#0000ff', { h: 240, s: 1, v: 1 }],
    ['#ffffff', { h: 0, s: 0, v: 1 }],
    ['#000000', { h: 0, s: 0, v: 0 }],
  ])('%s round-trips', (hex, hsv) => {
    expect(hsvToHex(hsv)).toBe(hex);
    const back = hexToHsv(hex);
    expect(back.h).toBeCloseTo(hsv.h, 5);
    expect(back.s).toBeCloseTo(hsv.s, 5);
    expect(back.v).toBeCloseTo(hsv.v, 5);
  });

  it('round-trips arbitrary colours', () => {
    for (const hex of ['#7fe0b5', '#c7a6ff', '#ff9a76', '#123456']) expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });

  it('maps the ring to hue and the square to saturation/value', () => {
    const top = wheelHit(0, (1 + RING_IN) / 2);
    expect(top).toMatchObject({ part: 'ring' });
    expect((top as { h: number }).h).toBeCloseTo(90, 5);
    expect(wheelHit(SQUARE, SQUARE)).toEqual({ part: 'square', s: 1, v: 1 });
    expect(wheelHit(-SQUARE, -SQUARE)).toEqual({ part: 'square', s: 0, v: 0 });
    expect(wheelHit(0.65, 0)).toBeNull();
  });

  it('keeps a drag on the part it started on', () => {
    expect(wheelHit(0, 0, 'ring')).toMatchObject({ part: 'ring' });
    expect(wheelHit(2, -2, 'square')).toEqual({ part: 'square', s: 1, v: 0 });
  });
});
