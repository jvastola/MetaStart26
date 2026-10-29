"""Render the walkthrough soundtrack from the app's logged sound events.

Mirrors the recipes in src/core/sfx.ts (tones, band-passed noise, bells, the
focus ambient bed and a small reverb) so the video sounds like the app.
Usage: python3 soundtrack.py timeline.json out.wav total_seconds offset_seconds
"""
import json
import sys
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(7)


def envelope(n, attack, decay, gain):
    t = np.arange(n) / SR
    a = max(attack, 1e-3)
    rise = np.clip(t / a, 0, 1)
    fall = np.exp(np.log(1e-4 / max(gain, 1e-4)) * np.clip((t - a) / max(decay - a, 1e-3), 0, 1))
    return gain * rise * np.where(t < a, 1, fall)


def tone(freq, decay, gain, to=None, kind='sine', attack=0.006):
    n = int(SR * (decay + 0.05))
    t = np.arange(n) / SR
    if to:
        glide = min(decay * 0.6, decay)
        k = np.clip(t / glide, 0, 1)
        f = freq * (to / freq) ** k
    else:
        f = np.full(n, freq)
    phase = 2 * np.pi * np.cumsum(f) / SR
    if kind == 'sine':
        w = np.sin(phase)
    elif kind == 'triangle':
        w = 2 / np.pi * np.arcsin(np.sin(phase))
    elif kind == 'square':
        w = np.sign(np.sin(phase)) * 0.6
    else:
        w = ((phase / np.pi) % 2 - 1) * 0.6
    return w * envelope(n, attack, decay, gain)


def noise(band, decay, gain, to=None, q=1.2, attack=0.004):
    n = int(SR * (decay + 0.05))
    out = np.zeros(n)
    chunk = 1024
    for i in range(0, n, chunk):
        k = i / max(n - 1, 1)
        centre = band * ((to / band) ** k if to else 1)
        seg = rng.standard_normal(chunk * 2)
        spec = np.fft.rfft(seg)
        freqs = np.fft.rfftfreq(seg.size, 1 / SR)
        width = centre / max(q, 0.3)
        spec *= np.exp(-0.5 * ((freqs - centre) / width) ** 2)
        filtered = np.fft.irfft(spec)[chunk // 2: chunk // 2 + chunk]
        out[i:i + chunk] = filtered[: len(out[i:i + chunk])]
    out /= max(np.abs(out).max(), 1e-9)
    return out * envelope(n, attack, decay, gain)


def bell(freq, gain):
    a = tone(freq, 1.1, gain)
    b = tone(freq * 2.76, 0.45, gain * 0.25)
    c = tone(freq * 5.4, 0.2, gain * 0.1)
    out = np.zeros(max(len(a), len(b), len(c)))
    out[: len(a)] += a
    out[: len(b)] += b
    out[: len(c)] += c
    return out


def layered(*parts):
    """parts: (delay_seconds, signal)."""
    length = max(int(d * SR) + len(s) for d, s in parts)
    out = np.zeros(length)
    for d, s in parts:
        i = int(d * SR)
        out[i:i + len(s)] += s
    return out


def render(name, arg):
    if name == 'click':
        return layered((0, noise(3200, 0.03, 0.25, q=2)), (0, tone(1760, 0.05, 0.05)))
    if name == 'hover':
        return tone(1480, 0.03, 0.018)
    if name == 'pinch':
        return tone(620, 0.09, 0.12, to=930, kind='triangle')
    if name == 'place':
        return layered((0, tone(190, 0.16, 0.35, to=110)), (0, noise(900, 0.06, 0.12, q=0.8)), (0.01, tone(660, 0.12, 0.04)))
    if name == 'error':
        return layered((0, tone(330, 0.12, 0.08, kind='triangle')), (0.09, tone(247, 0.18, 0.08, kind='triangle')))
    if name == 'success':
        return layered((0, bell(523.25, 0.11)), (0.07, bell(659.25, 0.1)), (0.14, bell(783.99, 0.1)), (0.24, bell(1046.5, 0.08)))
    if name == 'shutter':
        return layered((0, noise(4200, 0.035, 0.35, q=1.5)), (0.05, noise(1800, 0.07, 0.18, q=2)))
    if name == 'step':
        return layered((0, bell(659.25, 0.1)), (0.1, bell(987.77, 0.1)))
    if name == 'chime':
        return layered(*[(i * 0.45, bell(880, 0.12)) for i in range(3)])
    if name == 'whoosh':
        return noise(280, 0.45, 0.22, to=3200, q=1.6, attack=0.15)
    if name == 'blip':
        return tone(arg or 700, 0.07, 0.07)
    if name == 'putt':
        p = arg or 0.5
        return layered((0, noise(2400, 0.03, 0.2 + p * 0.2, q=3)), (0, tone(900 + p * 300, 0.07, 0.12 + p * 0.1)))
    if name == 'wall':
        i = arg or 0.3
        return tone(420 + i * 160, 0.05, min(0.25, 0.04 + i * 0.25), kind='triangle')
    if name == 'sink':
        return layered((0, tone(300, 0.2, 0.25, to=140)), (0.18, bell(784, 0.1)), (0.3, bell(1175, 0.09)))
    return None


def ambient(seconds):
    n = int(SR * seconds)
    t = np.arange(n) / SR
    pad = sum(np.sin(2 * np.pi * f * t) for f in (130.81, 196.0, 261.63, 196.6)) / 4
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * 0.07 * t)
    fade = np.minimum(1, t / 3) * np.minimum(1, (seconds - t) / 1.5)
    return pad * swell * fade * 0.05


def reverb(signal, seconds=1.4, decay=3.2, mix=0.22):
    n = int(SR * seconds)
    ir = rng.standard_normal(n) * (1 - np.arange(n) / n) ** decay
    ir /= np.sqrt((ir ** 2).sum())
    size = 1 << int(np.ceil(np.log2(len(signal) + n)))
    wet = np.fft.irfft(np.fft.rfft(signal, size) * np.fft.rfft(ir, size), size)[: len(signal)]
    return signal + wet * mix


def main():
    timeline = json.load(open(sys.argv[1]))
    total = float(sys.argv[3])
    offset = float(sys.argv[4])
    trim = timeline['trimStart'] / 1000
    mix = np.zeros(int(SR * total))
    ambient_on = None
    for event in timeline['sfx']:
        at = event['t'] / 1000 - trim + offset
        if at < 0 or at >= total:
            continue
        name = event['name']
        if name == 'ambientOn':
            ambient_on = at
            continue
        if name == 'ambientOff':
            if ambient_on is not None:
                pad = ambient(at - ambient_on + 1.5)
                i = int(ambient_on * SR)
                mix[i:i + len(pad)] += pad[: len(mix) - i]
            ambient_on = None
            continue
        sound = render(name, event.get('arg'))
        if sound is None:
            continue
        i = int(at * SR)
        mix[i:i + len(sound)] += sound[: len(mix) - i]
    # Title and end stingers.
    for at, sound in ((0.4, layered((0, bell(523.25, 0.08)), (0.15, bell(783.99, 0.08)))), (total - 3.5, layered((0, bell(659.25, 0.08)), (0.15, bell(987.77, 0.08))))):
        i = int(at * SR)
        mix[i:i + len(sound)] += sound[: len(mix) - i]
    mix = reverb(mix)
    peak = np.abs(mix).max()
    if peak > 0.9:
        mix *= 0.9 / peak
    data = (mix * 32767).astype(np.int16)
    with wave.open(sys.argv[2], 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print(f'rendered {len(timeline["sfx"])} events into {total:.1f}s, peak {peak:.2f}')


if __name__ == '__main__':
    main()
