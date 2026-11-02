import { describe, expect, it } from 'vitest';
import { KanbanStore, starterBoard, WIP_LIMIT } from '../src/protos/kanban/kanban-store.js';

const ids = (s: KanbanStore, col: 'todo' | 'doing' | 'done') => s.column(col).map((c) => c.id);

describe('KanbanStore', () => {
  it('adds new cards to the top of a column', () => {
    const s = new KanbanStore({ cards: [], next: 1 });
    s.add('a');
    s.add('b');
    expect(s.column('todo').map((c) => c.text)).toEqual(['b', 'a']);
  });

  it('moves a card to a column and position, keeping the rest in order', () => {
    const s = new KanbanStore(starterBoard());
    const [first, second, third] = ids(s, 'todo');
    s.move(third, 'todo', 0);
    expect(ids(s, 'todo')).toEqual([third, first, second]);
    s.move(first, 'doing', 1);
    expect(ids(s, 'doing')[1]).toBe(first);
    expect(s.get(first)?.column).toBe('doing');
    s.move(second, 'done', 99);
    expect(ids(s, 'done').at(-1)).toBe(second);
  });

  it('moves into an empty column', () => {
    const s = new KanbanStore({ cards: [], next: 1 });
    const c = s.add('x');
    s.move(c.id, 'done', 3);
    expect(ids(s, 'done')).toEqual([c.id]);
  });

  it('cycles colour tags and wraps', () => {
    const s = new KanbanStore({ cards: [], next: 1 });
    const c = s.add('x');
    const seen = [s.cycleTag(c.id), s.cycleTag(c.id), s.cycleTag(c.id), s.cycleTag(c.id), s.cycleTag(c.id)];
    expect(seen).toEqual(['red', 'amber', 'green', 'blue', 'none']);
  });

  it('clears Done and warns past the work-in-progress limit', () => {
    const s = new KanbanStore(starterBoard());
    expect(s.clearDone()).toBe(1);
    expect(s.column('done')).toHaveLength(0);
    for (let i = 0; i <= WIP_LIMIT; i++) s.add(`w${i}`, 'doing');
    expect(s.overLimit()).toBe(true);
  });
});
