import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/protos/conjure/intent';

describe('parseIntent', () => {
  it.each([
    ['make me a red mushroom', { kind: 'create', prompt: 'red mushroom' }],
    ['Create a tiny castle!', { kind: 'create', prompt: 'tiny castle' }],
    ['I want a low poly fox', { kind: 'create', prompt: 'low poly fox' }],
    ['make it blue', { kind: 'recolor', name: 'blue' }],
    ['now pink', { kind: 'recolor', name: 'pink' }],
    ['bigger', { kind: 'scale', factor: 1.4 }],
    ['make it smaller', { kind: 'scale', factor: 0.7 }],
    ['another one', { kind: 'again' }],
    ['try again', { kind: 'again' }],
    ['delete it', { kind: 'delete' }],
    ['clear everything', { kind: 'clear' }],
    ['spin it', { kind: 'spin' }],
    ['', { kind: 'none' }],
    ['tiny castle', { kind: 'create', prompt: 'tiny castle' }],
    ['red mushroom', { kind: 'create', prompt: 'red mushroom' }],
    ['little robot', { kind: 'create', prompt: 'little robot' }],
    ['blue', { kind: 'recolor', name: 'blue' }],
    ['much bigger', { kind: 'scale', factor: 1.4 }],
    ['a bit smaller', { kind: 'scale', factor: 0.7 }],
  ])('%s', (text, expected) => {
    expect(parseIntent(text)).toMatchObject(expected);
  });

  it('treats a colour inside a new request as part of the prompt', () => {
    expect(parseIntent('make a blue rocket')).toEqual({ kind: 'create', prompt: 'blue rocket' });
  });
});
