/**
 * Local progress: best score per daily course and a play streak.
 * Stored in localStorage; every access is guarded because storage can be
 * unavailable (private windows, blocked site data).
 */

const KEY = 'desk-links-progress-v1';

interface ProgressData {
  best: Record<string, number>;
  lastDay: number;
  streak: number;
}

function load(): ProgressData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as ProgressData;
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return { best: {}, lastDay: 0, streak: 0 };
}

function save(data: ProgressData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Ignore: progress just will not persist.
  }
}

/** Day number since epoch, used to tell whether two days are consecutive. */
function dayNumber(date: Date): number {
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000,
  );
}

export interface RoundResult {
  best: number;
  isNewBest: boolean;
  streak: number;
}

export function recordRound(seed: number, strokes: number, now = new Date()): RoundResult {
  const data = load();
  const key = String(seed);
  const previous = data.best[key];
  const isNewBest = previous == null || strokes < previous;
  if (isNewBest) data.best[key] = strokes;
  const today = dayNumber(now);
  if (data.lastDay !== today) {
    data.streak = data.lastDay === today - 1 ? data.streak + 1 : 1;
    data.lastDay = today;
  }
  save(data);
  return { best: data.best[key], isNewBest, streak: data.streak };
}

export function bestFor(seed: number): number | null {
  return load().best[String(seed)] ?? null;
}
