import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS,
  BOARD_DEPTH,
  BOARD_WIDTH,
  blockDistance,
  dailySeed,
  generateHole,
  generateRound,
  HOLE_NAMES,
  HOLES_PER_ROUND,
  shortestPathLength,
} from '../src/protos/golf/course';

describe('course generation', () => {
  it('is deterministic for a seed', () => {
    expect(generateRound(20261028)).toEqual(generateRound(20261028));
  });

  it('differs between days', () => {
    expect(generateRound(20261028)).not.toEqual(generateRound(20261029));
  });

  it('builds a round of the right length with sensible pars', () => {
    const round = generateRound(dailySeed(new Date(2026, 9, 28)));
    expect(round).toHaveLength(HOLES_PER_ROUND);
    for (const hole of round) {
      expect(hole.par).toBeGreaterThanOrEqual(2);
      expect(hole.par).toBeLessThanOrEqual(4);
    }
  });

  it('only generates reachable holes, with tee and cup inside the board', () => {
    // A year of daily courses.
    for (let day = 0; day < 365; day += 1) {
      const seed = dailySeed(new Date(2026, 0, 1 + day));
      for (let i = 0; i < HOLES_PER_ROUND; i += 1) {
        const hole = generateHole(seed, i);
        expect(Number.isFinite(shortestPathLength(hole))).toBe(true);
        for (const v of [hole.tee, hole.cup]) {
          expect(Math.abs(v.x)).toBeLessThan(BOARD_WIDTH / 2 - BALL_RADIUS);
          expect(Math.abs(v.z)).toBeLessThan(BOARD_DEPTH / 2 - BALL_RADIUS);
          for (const b of hole.blocks) expect(blockDistance(b, v.x, v.z)).toBeGreaterThan(BALL_RADIUS);
        }
      }
    }
  }, 30000);

  it('uses every kind of hole over a month, and rarely falls back to an open green', () => {
    const kinds = new Map<string, number>();
    for (let day = 0; day < 30; day += 1) {
      for (const hole of generateRound(dailySeed(new Date(2026, 10, 1 + day)))) kinds.set(hole.name, (kinds.get(hole.name) ?? 0) + 1);
    }
    for (const name of Object.values(HOLE_NAMES)) if (name !== HOLE_NAMES.open) expect(kinds.get(name) ?? 0).toBeGreaterThan(0);
    expect(kinds.get(HOLE_NAMES.open) ?? 0).toBeLessThan(5);
  });

  it('dailySeed encodes the local date', () => {
    expect(dailySeed(new Date(2026, 10, 18))).toBe(20261118);
  });

  it('blockDistance respects rotation', () => {
    const b = { cx: 0, cz: 0, hx: 0.1, hz: 0.01, angle: Math.PI / 2 };
    // Rotated 90 degrees, the long axis runs along z.
    expect(blockDistance(b, 0, 0.09)).toBeLessThan(0);
    expect(blockDistance(b, 0.09, 0)).toBeGreaterThan(0.07);
  });
});
