/**
 * Procedural sound design: every sound is synthesised, so the app ships no
 * audio files and loads instantly.
 *
 * With no controllers there is no haptic buzz, so sound carries the "you
 * touched it" feedback. Sounds can be placed in the room (pass a world
 * position): the host updates the listener from the head every frame, so a
 * card dropped on your left sounds like it landed on your left.
 *
 * Signal chain: voices -> (optional HRTF panner) -> dry + reverb send ->
 * compressor -> speakers.
 */

export interface Where {
  x: number;
  y: number;
  z: number;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let reverbSend: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = false;

function audio(): AudioContext | null {
  if (ctx == null) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor == null) return null;
    ctx = new Ctor();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(compressor).connect(ctx.destination);
    // A small, warm room: decaying stereo noise as the impulse response.
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx, 1.4, 3.2);
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.28;
    reverbSend.connect(convolver).connect(master);
    noiseBuffer = makeNoise(ctx, 1);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function makeImpulse(ac: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ac.sampleRate * seconds);
  const buffer = ac.createBuffer(2, length, ac.sampleRate);
  for (let c = 0; c < 2; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  return buffer;
}

function makeNoise(ac: AudioContext, seconds: number): AudioBuffer {
  const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Route a voice to the mix, through a 3D panner when it has a position. */
function output(ac: AudioContext, at: Where | undefined, reverb: number): AudioNode {
  const out = ac.createGain();
  let head: AudioNode = out;
  if (at) {
    const panner = ac.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.6;
    panner.rolloffFactor = 0.6;
    panner.positionX.value = at.x;
    panner.positionY.value = at.y;
    panner.positionZ.value = at.z;
    out.connect(panner);
    head = panner;
  }
  head.connect(master!);
  if (reverb > 0) {
    const send = ac.createGain();
    send.gain.value = reverb;
    head.connect(send).connect(reverbSend!);
  }
  return out;
}

interface Tone {
  freq: number;
  to?: number;
  type?: OscillatorType;
  start?: number;
  attack?: number;
  decay: number;
  gain: number;
  lowpass?: number;
  reverb?: number;
  at?: Where;
}

function tone(t: Tone): void {
  const ac = audio();
  if (ac == null || muted) return;
  const when = ac.currentTime + (t.start ?? 0);
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = t.type ?? 'sine';
  osc.frequency.setValueAtTime(t.freq, when);
  if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, when + t.decay * 0.6);
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(t.gain, when + (t.attack ?? 0.006));
  amp.gain.exponentialRampToValueAtTime(0.0001, when + t.decay);
  let node: AudioNode = osc.connect(amp);
  if (t.lowpass) {
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = t.lowpass;
    node = node.connect(f);
  }
  node.connect(output(ac, t.at, t.reverb ?? 0.2));
  osc.start(when);
  osc.stop(when + t.decay + 0.05);
}

interface Noise {
  band: number;
  to?: number;
  q?: number;
  decay: number;
  gain: number;
  start?: number;
  attack?: number;
  reverb?: number;
  at?: Where;
}

function noise(n: Noise): void {
  const ac = audio();
  if (ac == null || muted || !noiseBuffer) return;
  const when = ac.currentTime + (n.start ?? 0);
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = n.q ?? 1.2;
  filter.frequency.setValueAtTime(n.band, when);
  if (n.to) filter.frequency.exponentialRampToValueAtTime(n.to, when + n.decay);
  const amp = ac.createGain();
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(n.gain, when + (n.attack ?? 0.004));
  amp.gain.exponentialRampToValueAtTime(0.0001, when + n.decay);
  src.connect(filter).connect(amp).connect(output(ac, n.at, n.reverb ?? 0.1));
  src.start(when, Math.random() * 0.5);
  src.stop(when + n.decay + 0.05);
}

/** A bell: a sine with two inharmonic partials, long tail into the reverb. */
function bell(freq: number, start: number, gain: number, at?: Where): void {
  tone({ freq, start, decay: 1.1, gain, reverb: 0.5, at });
  tone({ freq: freq * 2.76, start, decay: 0.45, gain: gain * 0.25, reverb: 0.5, at });
  tone({ freq: freq * 5.4, start, decay: 0.2, gain: gain * 0.1, reverb: 0.5, at });
}

// Ambient focus bed: two slow detuned pads under a breathing low-pass.
let ambient: { stop: () => void } | null = null;

function startAmbient(): void {
  const ac = audio();
  if (ac == null || ambient) return;
  const out = ac.createGain();
  out.gain.value = 0.0001;
  out.gain.exponentialRampToValueAtTime(0.05, ac.currentTime + 3);
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500;
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  lfo.frequency.value = 0.07;
  lfoGain.gain.value = 220;
  lfo.connect(lfoGain).connect(filter.frequency);
  const oscs = [130.81, 196.0, 261.63, 196.6].map((f, i) => {
    const o = ac.createOscillator();
    o.type = i % 2 ? 'triangle' : 'sine';
    o.frequency.value = f;
    o.connect(filter);
    o.start();
    return o;
  });
  filter.connect(out).connect(master!);
  const send = ac.createGain();
  send.gain.value = 0.6;
  out.connect(send).connect(reverbSend!);
  lfo.start();
  ambient = {
    stop: () => {
      const t = ac.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      for (const o of [...oscs, lfo]) o.stop(t + 1.6);
    },
  };
}

/**
 * Optional event log for offline tools (the walkthrough video renders a
 * matching soundtrack from it). Off unless a page sets `window.__sfxLog = []`.
 */
function log(name: string, arg?: number): void {
  const sink = (globalThis as { __sfxLog?: { name: string; t: number; arg?: number }[] }).__sfxLog;
  if (sink && !muted) sink.push({ name, t: Date.now(), arg });
}

export const Sfx = {
  /** Call from a user gesture so later sounds are allowed to play. */
  unlock(): void {
    audio();
  },

  /** Keep the listener on the user's head (called by the host every frame). */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void {
    if (ctx == null) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = px;
      l.positionY.value = py;
      l.positionZ.value = pz;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  },

  setMuted(value: boolean): void {
    muted = value;
    if (value) Sfx.ambient(false);
  },

  get muted(): boolean {
    return muted;
  },

  /** UI press: a soft wooden tick. */
  click(at?: Where): void {
    log('click');
    noise({ band: 3200, q: 2, decay: 0.03, gain: 0.25, at });
    tone({ freq: 1760, decay: 0.05, gain: 0.05, at, reverb: 0.05 });
  },
  /** Finger arrives over something pressable. */
  hover(at?: Where): void {
    log('hover');
    tone({ freq: 1480, decay: 0.03, gain: 0.018, at, reverb: 0 });
  },
  /** Picked something up: a short rising pluck. */
  pinch(at?: Where): void {
    log('pinch');
    tone({ freq: 620, to: 930, type: 'triangle', decay: 0.09, gain: 0.12, lowpass: 3000, at });
  },
  /** Put something down: a soft thud with a wooden knock. */
  place(at?: Where): void {
    log('place');
    tone({ freq: 190, to: 110, decay: 0.16, gain: 0.35, at, reverb: 0.15 });
    noise({ band: 900, q: 0.8, decay: 0.06, gain: 0.12, at });
    tone({ freq: 660, decay: 0.12, gain: 0.04, start: 0.01, at });
  },
  /** Something went back / was not accepted. */
  error(at?: Where): void {
    log('error');
    tone({ freq: 330, decay: 0.12, gain: 0.08, type: 'triangle', at });
    tone({ freq: 247, start: 0.09, decay: 0.18, gain: 0.08, type: 'triangle', at });
  },
  /** Task done, model ready, shot taken: a small bell chord. */
  success(at?: Where): void {
    log('success');
    bell(523.25, 0, 0.11, at);
    bell(659.25, 0.07, 0.1, at);
    bell(783.99, 0.14, 0.1, at);
    bell(1046.5, 0.24, 0.08, at);
  },
  /** Camera shutter: a sharp click and a short mechanical rattle. */
  shutter(at?: Where): void {
    log('shutter');
    noise({ band: 4200, q: 1.5, decay: 0.035, gain: 0.35, at, reverb: 0.05 });
    noise({ band: 1800, q: 2, decay: 0.07, gain: 0.18, start: 0.05, at, reverb: 0.05 });
  },
  /** Tutorial step complete: two rising notes. */
  step(at?: Where): void {
    log('step');
    bell(659.25, 0, 0.1, at);
    bell(987.77, 0.1, 0.1, at);
  },
  /** Timer finished: a gentle three-strike chime. */
  chime(): void {
    log('chime');
    for (let i = 0; i < 3; i += 1) bell(880, i * 0.45, 0.12);
  },
  /** Something appears: an airy filtered-noise sweep. */
  whoosh(at?: Where): void {
    log('whoosh');
    noise({ band: 280, to: 3200, q: 1.6, decay: 0.45, gain: 0.22, attack: 0.15, reverb: 0.4, at });
  },
  /** Thrown away: a papery crumple falling into the bin. */
  trash(at?: Where): void {
    log('trash');
    noise({ band: 2600, to: 700, q: 1.2, decay: 0.18, gain: 0.25, at, reverb: 0.1 });
    tone({ freq: 240, to: 120, decay: 0.14, gain: 0.18, start: 0.08, at, reverb: 0.15 });
  },
  /** Eraser rubbing a stroke away. */
  erase(at?: Where): void {
    log('erase');
    noise({ band: 1500, to: 3500, q: 1.4, decay: 0.12, gain: 0.16, at, reverb: 0.05 });
  },
  /** Small neutral feedback, pitch carries meaning (up = more, down = less). */
  blip(freq = 700, at?: Where): void {
    log('blip', freq);
    tone({ freq, decay: 0.07, gain: 0.07, at, reverb: 0.15 });
  },

  // Desk Links
  putt(power: number, at?: Where): void {
    log('putt', power);
    noise({ band: 2400, q: 3, decay: 0.03, gain: 0.2 + power * 0.2, at });
    tone({ freq: 900 + power * 300, decay: 0.07, gain: 0.12 + power * 0.1, at });
  },
  wall(impact: number, at?: Where): void {
    log('wall', impact);
    tone({ freq: 420 + impact * 160, decay: 0.05, gain: Math.min(0.25, 0.04 + impact * 0.25), type: 'triangle', at, reverb: 0.05 });
  },
  sink(at?: Where): void {
    log('sink');
    tone({ freq: 300, to: 140, decay: 0.2, gain: 0.25, at });
    bell(784, 0.18, 0.1, at);
    bell(1175, 0.3, 0.09, at);
  },

  /** Soft ambient bed for focus sessions. */
  ambient(on: boolean): void {
    log(on ? 'ambientOn' : 'ambientOff');
    if (on && !muted) startAmbient();
    else if (!on && ambient) {
      ambient.stop();
      ambient = null;
    }
  },
};
