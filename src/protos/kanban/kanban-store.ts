/**
 * The Kanban board's data: cards in ordered columns. Pure (no Three.js), so
 * it is unit tested on its own, and saved as plain JSON.
 */

export const COLUMNS = ['todo', 'doing', 'done'] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_TITLES: Record<Column, string> = { todo: 'To do', doing: 'Doing', done: 'Done' };
/** A soft limit on work in progress: the Doing header warns past it. */
export const WIP_LIMIT = 3;
/** Colour tags a tap cycles through (index 0 is no tag). */
export const TAGS = ['none', 'red', 'amber', 'green', 'blue'] as const;
export type Tag = (typeof TAGS)[number];

export interface Card {
  id: number;
  text: string;
  column: Column;
  tag: Tag;
}

export interface BoardData {
  cards: Card[];
  next: number;
}

export function starterBoard(): BoardData {
  const cards: Omit<Card, 'id'>[] = [
    { text: 'Sketch the opening shot', column: 'todo', tag: 'blue' },
    { text: 'Block out the set', column: 'todo', tag: 'none' },
    { text: 'Record a voice note', column: 'todo', tag: 'amber' },
    { text: 'Print the clay prop', column: 'doing', tag: 'green' },
    { text: 'Set up the desk', column: 'done', tag: 'none' },
  ];
  return { cards: cards.map((c, i) => ({ ...c, id: i + 1 })), next: cards.length + 1 };
}

export class KanbanStore {
  constructor(public data: BoardData = starterBoard()) {}

  column(column: Column): Card[] {
    return this.data.cards.filter((c) => c.column === column);
  }

  get(id: number): Card | undefined {
    return this.data.cards.find((c) => c.id === id);
  }

  add(text: string, column: Column = 'todo'): Card {
    const card: Card = { id: this.data.next++, text: text.trim() || 'New card', column, tag: 'none' };
    // New cards go to the top of their column.
    const first = this.data.cards.findIndex((c) => c.column === column);
    if (first < 0) this.data.cards.push(card);
    else this.data.cards.splice(first, 0, card);
    return card;
  }

  remove(id: number): Card | undefined {
    const i = this.data.cards.findIndex((c) => c.id === id);
    if (i < 0) return undefined;
    return this.data.cards.splice(i, 1)[0];
  }

  /** Put a card in a column at a position (0 = top), keeping everything else in order. */
  move(id: number, column: Column, index: number): void {
    const card = this.remove(id);
    if (!card) return;
    card.column = column;
    const others = this.column(column);
    const at = Math.max(0, Math.min(others.length, index));
    if (others.length === 0) {
      this.data.cards.push(card);
      return;
    }
    const anchor = at < others.length ? others[at] : null;
    const pos = anchor ? this.data.cards.indexOf(anchor) : this.data.cards.indexOf(others[others.length - 1]) + 1;
    this.data.cards.splice(pos, 0, card);
  }

  cycleTag(id: number): Tag {
    const card = this.get(id);
    if (!card) return 'none';
    card.tag = TAGS[(TAGS.indexOf(card.tag) + 1) % TAGS.length];
    return card.tag;
  }

  /** Remove every Done card; returns how many went. */
  clearDone(): number {
    const before = this.data.cards.length;
    this.data.cards = this.data.cards.filter((c) => c.column !== 'done');
    return before - this.data.cards.length;
  }

  overLimit(): boolean {
    return this.column('doing').length > WIP_LIMIT;
  }
}
