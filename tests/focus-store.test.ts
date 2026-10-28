import { describe, expect, it } from 'vitest';
import { FocusStore } from '../src/protos/focus/focus-store';

const day = (d: number) => new Date(2026, 10, d, 10);

describe('FocusStore', () => {
  it('keeps only one card in focus', () => {
    const s = new FocusStore(false);
    const [a, b] = s.zone('inbox');
    s.move(a.id, 'focus');
    s.move(b.id, 'focus');
    expect(s.zone('focus').map((c) => c.id)).toEqual([b.id]);
    expect(s.find(a.id)?.zone).toBe('today');
  });

  it('counts a streak across consecutive days and resets after a gap', () => {
    const s = new FocusStore(false);
    const ids = s.cards.map((c) => c.id);
    expect(s.complete(ids[0], day(1))).toBe(1);
    expect(s.complete(ids[1], day(1))).toBe(1);
    expect(s.complete(ids[2], day(2))).toBe(2);
    expect(s.currentStreak(day(3))).toBe(2);
    expect(s.currentStreak(day(4))).toBe(0);
    expect(s.complete(ids[3], day(5))).toBe(1);
    expect(s.data.totalDone).toBe(4);
  });

  it('clears yesterday done cards on rollover but keeps the total', () => {
    const s = new FocusStore(false);
    const [a] = s.zone('inbox');
    s.complete(a.id, day(1));
    expect(s.doneToday(day(1))).toBe(1);
    expect(s.rollover(day(2))).toBe(1);
    expect(s.zone('done')).toHaveLength(0);
    expect(s.data.totalDone).toBe(1);
  });

  it('adds cleaned-up cards to the top of the inbox', () => {
    const s = new FocusStore(false);
    const c = s.add('   buy   oat milk  ');
    expect(c.text).toBe('Buy oat milk');
    expect(s.zone('inbox')[0].id).toBe(c.id);
  });

  it('clamps focus minutes', () => {
    const s = new FocusStore(false);
    s.setFocusMinutes(500);
    expect(s.data.focusMinutes).toBe(60);
    s.setFocusMinutes(-3);
    expect(s.data.focusMinutes).toBe(5);
  });
});
