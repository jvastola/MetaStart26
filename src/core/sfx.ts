/**
 * Tiny synthesized sound effects, so the game ships no audio files.
 * With no controllers there is no haptic buzz, so sound carries the feedback.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx == null) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor == null) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, start: number, length: number, gain: number, type: OscillatorType = 'sine'): void {
  const ac = audio();
  if (ac == null) return;
  const t = ac.currentTime + start;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(amp).connect(ac.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

export const Sfx = {
  /** Call from a user gesture so later sounds are allowed to play. */
  unlock(): void {
    audio();
  },
  putt(power: number): void {
    tone(520 + power * 200, 0, 0.09, 0.25 + power * 0.25, 'triangle');
  },
  wall(impact: number): void {
    tone(260 + impact * 120, 0, 0.05, Math.min(0.3, 0.05 + impact * 0.3), 'square');
  },
  pinch(): void {
    tone(880, 0, 0.04, 0.08);
  },
  sink(): void {
    tone(660, 0, 0.12, 0.25);
    tone(880, 0.1, 0.12, 0.25);
    tone(1320, 0.2, 0.25, 0.25);
  },
  click(): void {
    tone(1200, 0, 0.03, 0.12);
  },
  success(): void {
    tone(523, 0, 0.1, 0.2);
    tone(659, 0.08, 0.1, 0.2);
    tone(784, 0.16, 0.18, 0.22);
  },
  whoosh(): void {
    tone(300, 0, 0.18, 0.15, 'sawtooth');
  },
  blip(freq = 700): void {
    tone(freq, 0, 0.05, 0.1);
  },
  place(): void {
    tone(440, 0, 0.08, 0.2);
    tone(660, 0.07, 0.12, 0.2);
  },
};
