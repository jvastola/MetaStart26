/**
 * Turns what the user said into an action. Follow-ups ("make it blue",
 * "bigger", "another one") edit the last result instead of starting over,
 * which is what makes the voice loop feel like talking to an assistant.
 * Pure and unit-tested.
 */

export const COLORS: Record<string, string> = {
  red: '#d9483b',
  orange: '#ef8a2c',
  yellow: '#f2c53d',
  gold: '#d4a73a',
  green: '#4caf50',
  teal: '#2aa198',
  blue: '#3f7fd9',
  navy: '#24407a',
  purple: '#8a55c9',
  pink: '#e86fa4',
  white: '#f2f2ee',
  black: '#2a2a2e',
  gray: '#8c9099',
  grey: '#8c9099',
  silver: '#c3c7cf',
  brown: '#8a5a3c',
};

export type Intent =
  | { kind: 'create'; prompt: string }
  | { kind: 'recolor'; color: string; name: string }
  | { kind: 'scale'; factor: number }
  | { kind: 'spin' }
  | { kind: 'again' }
  | { kind: 'delete' }
  | { kind: 'clear' }
  | { kind: 'none' };

const EDIT_WORDS = new Set(['bigger', 'larger', 'huge', 'grow', 'smaller', 'tiny', 'shrink', 'little', 'much', 'a', 'bit', 'even', 'more', 'now', 'it', 'make', 'please', 'go', 'way']);

const REFERS = '(it|that|this|the last one|this one|that one)';

export function parseIntent(raw: string): Intent {
  const text = raw.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'none' };

  if (/\b(clear|delete|remove) (all|everything)\b/.test(text)) return { kind: 'clear' };
  if (new RegExp(`\\b(delete|remove|get rid of|undo) ${REFERS}\\b`).test(text) || /^(delete|remove|undo)$/.test(text)) {
    return { kind: 'delete' };
  }
  if (/\b(another|again|one more|try again|variation|different one)\b/.test(text)) return { kind: 'again' };
  if (/\b(spin|rotate|turn around)\b/.test(text) && !/\bmake\b.*\b(a|an)\b/.test(text)) return { kind: 'spin' };

  const refersToLast = new RegExp(`\\b(make|turn|paint|color|colour) ${REFERS}\\b`).test(text) || /^(make it|now)\b/.test(text);
  // Short follow-ups ("bigger", "blue", "much smaller") are made only of
  // edit words; "tiny castle" or "red mushroom" names a new thing.
  const editOnly = text.split(' ').every((w) => EDIT_WORDS.has(w) || w in COLORS);
  if (refersToLast || (editOnly && text.split(' ').length <= 3)) {
    if (/\b(bigger|larger|huge|grow)\b/.test(text)) return { kind: 'scale', factor: 1.4 };
    if (/\b(smaller|tiny|shrink|little)\b/.test(text)) return { kind: 'scale', factor: 0.7 };
    for (const name of Object.keys(COLORS)) {
      if (new RegExp(`\\b${name}\\b`).test(text)) return { kind: 'recolor', color: COLORS[name], name };
    }
  }

  const prompt = text
    .replace(/^(please )?(can you |could you )?(make|create|generate|build|give|show|conjure|sculpt|draw)( me)?( a| an| some)? /, '')
    .replace(/^(i want|i'd like|i would like)( a| an)? /, '')
    .trim();
  return prompt ? { kind: 'create', prompt } : { kind: 'none' };
}
