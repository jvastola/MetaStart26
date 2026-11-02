/**
 * The library: things you saved to reuse later (a Clay sculpt, a Conjure
 * creation, a Blocks build, a pinned stroke, a photo). Shot Board's shelf
 * shows it, so saved things can be pulled into a scene as props.
 *
 * Items are stored as the same data desk objects save, so the desk can
 * rebuild any of them. Saved in this browser.
 */

import { store } from './context.js';
import type { SavedObject } from './desk-objects.js';

export interface LibraryItem {
  id: string;
  name: string;
  data: SavedObject;
  added: number;
}

const KEY = 'library-v1';
const MAX = 30;

export function nameFor(data: SavedObject): string {
  switch (data.k) {
    case 'model':
      return data.pr ?? 'Creation';
    case 'print':
      return 'Clay sculpt';
    case 'voxels':
      return 'Blocks build';
    case 'stroke':
      return 'Sketch';
    case 'photo':
      return 'Photo';
    default:
      return 'Thing';
  }
}

export class Library {
  items: LibraryItem[] = [];
  /** Bumped on every change, so views know to rebuild. */
  version = 0;
  private next = 1;

  constructor() {
    this.items = store.get<LibraryItem[]>(KEY, []).filter((i) => i && i.data && typeof i.data.k === 'string');
    for (const i of this.items) this.next = Math.max(this.next, Number(i.id.replace(/\D/g, '')) + 1 || 1);
  }

  /** Save a copy (its pose is not kept: a library item is the thing itself). */
  add(data: SavedObject, name = nameFor(data)): LibraryItem {
    const copy = { ...data, t: [0, 0, 0, 0, 0, 0, 1, 1], pinned: false } as SavedObject;
    // The same thing twice is one entry, moved to the front.
    const same = JSON.stringify(copy);
    this.items = this.items.filter((i) => JSON.stringify(i.data) !== same);
    const item: LibraryItem = { id: `lib${this.next++}`, name, data: copy, added: Date.now() };
    this.items.unshift(item);
    if (this.items.length > MAX) this.items.length = MAX;
    this.changed();
    return item;
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.changed();
  }

  private changed(): void {
    this.version++;
    store.set(KEY, this.items);
  }
}
