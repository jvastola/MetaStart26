/**
 * Desk Focus data: task cards, the zone each one lives in, completions and the
 * daily streak. Pure logic plus guarded localStorage, so it is unit-tested.
 */

import { dayNumber, store } from '../../core/context.js';

export type Zone = 'inbox' | 'today' | 'focus' | 'done';
export const BOARD_ZONES: Zone[] = ['inbox', 'today', 'done'];

export interface Card {
  id: string;
  text: string;
  zone: Zone;
  hue: number;
  /** Day number the card was completed, for done cards. */
  doneDay?: number;
}

export interface FocusData {
  version: 1;
  cards: Card[];
  nextId: number;
  streak: number;
  lastDoneDay: number;
  totalDone: number;
  focusMinutes: number;
}

const KEY = 'desk-focus-v1';

const STARTER: [string, Zone][] = [
  ["Plan tomorrow's top 3", 'inbox'],
  ['Inbox zero sprint', 'inbox'],
  ['Draft the project update', 'inbox'],
  ['Stretch for two minutes', 'inbox'],
  ['Review notes from today', 'today'],
  ['Sketch the hand menu', 'today'],
];

export function hueFor(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

export class FocusStore {
  data: FocusData;

  constructor(private readonly persist = true) {
    const loaded = persist ? store.get<FocusData | null>(KEY, null) : null;
    this.data = loaded?.version === 1 ? loaded : FocusStore.fresh();
  }

  static fresh(): FocusData {
    const data: FocusData = {
      version: 1,
      cards: [],
      nextId: 1,
      streak: 0,
      lastDoneDay: 0,
      totalDone: 0,
      focusMinutes: 25,
    };
    for (const [text, zone] of STARTER) {
      data.cards.push({ id: `c${data.nextId++}`, text, zone, hue: hueFor(text) });
    }
    return data;
  }

  save(): void {
    if (this.persist) store.set(KEY, this.data);
  }

  get cards(): readonly Card[] {
    return this.data.cards;
  }

  zone(zone: Zone): Card[] {
    return this.data.cards.filter((c) => c.zone === zone);
  }

  get focusCard(): Card | undefined {
    return this.data.cards.find((c) => c.zone === 'focus');
  }

  find(id: string): Card | undefined {
    return this.data.cards.find((c) => c.id === id);
  }

  add(text: string, zone: Zone = 'inbox'): Card {
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New task';
    const card: Card = { id: `c${this.data.nextId++}`, text: capitalise(clean), zone, hue: hueFor(clean) };
    // New cards go to the top of their column.
    this.data.cards.unshift(card);
    this.save();
    return card;
  }

  /** Move a card. Only one card can be in focus: the previous one returns to Today. */
  move(id: string, zone: Zone, now = new Date()): void {
    const card = this.find(id);
    if (!card) return;
    if (zone === 'done') {
      this.complete(id, now);
      return;
    }
    if (zone === 'focus') {
      const current = this.focusCard;
      if (current && current.id !== id) current.zone = 'today';
    }
    card.zone = zone;
    delete card.doneDay;
    // Move to the front of its new column.
    this.data.cards = [card, ...this.data.cards.filter((c) => c !== card)];
    this.save();
  }

  /** Complete a card and update the streak. Returns the new streak. */
  complete(id: string, now = new Date()): number {
    const card = this.find(id);
    if (!card || card.zone === 'done') return this.data.streak;
    const today = dayNumber(now);
    card.zone = 'done';
    card.doneDay = today;
    this.data.totalDone += 1;
    if (this.data.lastDoneDay !== today) {
      this.data.streak = this.data.lastDoneDay === today - 1 ? this.data.streak + 1 : 1;
      this.data.lastDoneDay = today;
    }
    this.data.cards = [card, ...this.data.cards.filter((c) => c !== card)];
    this.save();
    return this.data.streak;
  }

  /** Streak as shown today: it survives until the end of the next day. */
  currentStreak(now = new Date()): number {
    return this.data.lastDoneDay >= dayNumber(now) - 1 ? this.data.streak : 0;
  }

  doneToday(now = new Date()): number {
    const today = dayNumber(now);
    return this.data.cards.filter((c) => c.zone === 'done' && c.doneDay === today).length;
  }

  /** On a new day, clear yesterday's done cards off the board (they stay counted). */
  rollover(now = new Date()): number {
    const today = dayNumber(now);
    const before = this.data.cards.length;
    this.data.cards = this.data.cards.filter((c) => c.zone !== 'done' || c.doneDay === today);
    const removed = before - this.data.cards.length;
    if (removed > 0) this.save();
    return removed;
  }

  /** Focus card cycling for microgestures: next card from Today into focus. */
  cycleFocus(direction: 1 | -1, now = new Date()): Card | undefined {
    const today = this.zone('today');
    if (today.length === 0) return this.focusCard;
    // Forward takes the top of Today, backward takes the bottom.
    const next = direction > 0 ? today[0] : today[today.length - 1];
    this.move(next.id, 'focus', now);
    return next;
  }

  setFocusMinutes(minutes: number): void {
    this.data.focusMinutes = Math.round(Math.min(60, Math.max(5, minutes)));
    this.save();
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
