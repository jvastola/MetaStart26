"""Assemble the Deskcraft walkthrough from scenes recorded by record-pro.cjs.

Title card, each scene upscaled to 1080p with lower-third captions, short
crossfades, an end card, and a soundtrack: the app's own sound events (from
each scene's timeline) over a soft music bed.

    python3 tools/video/assemble-pro.py open focus conjure ...   (in order)
Writes tools/video/pro/deskcraft-walkthrough.mp4.
"""
import json
import os
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PRO = os.path.join(HERE, 'pro')
sys.path.insert(0, HERE)
import soundtrack as st  # noqa: E402  (the app's sound recipes)

FPS = 24
W, H = 1920, 1080
XF = 0.45  # crossfade seconds
INTER = '/usr/share/fonts/opentype/inter'
F_BOLD = f'{INTER}/InterDisplay-Bold.otf'
F_SEMI = f'{INTER}/Inter-SemiBold.otf'
F_REG = f'{INTER}/Inter-Regular.otf'
ACCENT = '0x7fe0b5'
BG = '0x101318'
SR = st.SR
URL = 'jvastola.github.io/MetaStart26'


def run(args):
    print('+', ' '.join(a if len(a) < 60 else a[:57] + '...' for a in args[:8]))
    r = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if r.returncode:
        print(r.stderr[-3000:])
        raise SystemExit(1)


def text_file(name, text):
    os.makedirs(os.path.join(PRO, 'txt'), exist_ok=True)
    p = os.path.join(PRO, 'txt', name)
    with open(p, 'w') as f:
        f.write(text)
    return p


def fade_alpha(start, end, ramp=0.35):
    # Fade in over `ramp` seconds from start, out over `ramp` before end.
    return f"if(lt(t,{start}),0,if(lt(t,{start + ramp}),(t-{start})/{ramp},if(lt(t,{end - ramp}),1,if(lt(t,{end}),({end}-t)/{ramp},0))))"


def card(out, lines, seconds, sub_accent=True):
    """A dark card with centred lines: [(text, font, size, color, y)]."""
    filters = []
    for i, (text, font, size, color, y) in enumerate(lines):
        tf = text_file(f'{os.path.basename(out)}_{i}.txt', text)
        a = fade_alpha(0.25 + i * 0.25, seconds - 0.2, 0.5)
        filters.append(f"drawtext=fontfile={font}:textfile={tf}:fontsize={size}:fontcolor={color}:x=(w-text_w)/2:y={y}:alpha='{a}'")
    # A thin accent rule under the title.
    filters.append(f"drawbox=x=(iw-160)/2:y=600:w=160:h=4:color={ACCENT}@0.9:t=fill:enable='between(t,0.5,{seconds - 0.3})'")
    run(['ffmpeg', '-y', '-f', 'lavfi', '-i', f'gradients=s={W}x{H}:c0={BG}:c1=0x1c2333:x0=0:y0=0:x1={W}:y1={H}:d={seconds}:r={FPS}',
         '-vf', ','.join(filters + ['format=yuv420p']), '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', out])


def scene_video(name):
    d = os.path.join(PRO, name)
    tl = json.load(open(os.path.join(d, 'timeline.json')))
    frames = tl['frames']
    seconds = frames / FPS
    filters = [f'scale={W}:{H}:flags=lanczos', 'eq=saturation=1.06:contrast=1.03']
    for i, cap in enumerate(tl['captions']):
        s = cap['start'] / FPS
        e = (cap['end'] if cap['end'] is not None else frames) / FPS
        if e - s < 0.6:
            continue
        a = fade_alpha(s, e)
        title = text_file(f'{name}_{i}_t.txt', cap['title'])
        filters.append(f"drawbox=x=72:y={H - 214}:w=8:h=118:color={ACCENT}:t=fill:enable='between(t,{s},{e})'")
        filters.append(f"drawtext=fontfile={F_BOLD}:textfile={title}:fontsize=54:fontcolor=white:x=104:y={H - 222}:alpha='{a}':shadowcolor=black@0.55:shadowx=0:shadowy=2")
        if cap.get('sub'):
            sub = text_file(f'{name}_{i}_s.txt', cap['sub'])
            filters.append(f"drawtext=fontfile={F_REG}:textfile={sub}:fontsize=32:fontcolor=white@0.92:x=106:y={H - 150}:alpha='{a}':shadowcolor=black@0.6:shadowx=0:shadowy=2")
    # A dark band behind the captions, faint, so text reads over any room.
    filters.insert(2, f"drawbox=x=0:y={H - 260}:w={W}:h=260:color=black@0.28:t=fill")
    label = text_file('label.txt', 'Captured in the IWSDK emulator with simulated hands')
    filters.append(f"drawtext=fontfile={F_REG}:textfile={label}:fontsize=20:fontcolor=white@0.6:x=w-text_w-36:y=30")
    out = os.path.join(PRO, f'{name}.mp4')
    run(['ffmpeg', '-y', '-framerate', str(FPS), '-i', os.path.join(d, 'frames', '%05d.jpg'),
         '-vf', ','.join(filters + ['format=yuv420p']), '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', out])
    return out, seconds, tl


def music_bed(seconds):
    """A calm, warm bed: slow chord changes (Cmaj7 - Am7 - Fmaj7 - G6), soft plucks on the beat."""
    n = int(SR * seconds)
    t = np.arange(n) / SR
    chords = [(130.81, 164.81, 196.0, 246.94), (110.0, 130.81, 164.81, 196.0), (87.31, 130.81, 174.61, 220.0), (98.0, 123.47, 146.83, 164.81)]
    bar = 4.0  # seconds per chord
    out = np.zeros(n)
    for k in range(int(seconds / bar) + 1):
        f = chords[k % len(chords)]
        a, b = int(k * bar * SR), min(n, int((k + 1) * bar * SR + SR))
        if a >= n:
            break
        tt = t[a:b] - k * bar
        env = np.minimum(1, tt / 0.8) * np.minimum(1, np.maximum(0, (bar + 1 - tt) / 1.0))
        pad = sum(np.sin(2 * np.pi * fr * tt) + 0.3 * np.sin(2 * np.pi * fr * 2 * tt) for fr in f) / len(f)
        out[a:b] += pad * env * 0.05
        # Plucks: chord tones an octave up, on each beat.
        for beat in range(4):
            p0 = a + int((beat * 1.0) * SR)
            if p0 >= n:
                break
            fr = f[(beat + k) % 4] * 2
            m = min(n - p0, int(SR * 0.9))
            pt = np.arange(m) / SR
            out[p0:p0 + m] += np.sin(2 * np.pi * fr * pt) * np.exp(-pt * 5) * 0.035
    fade = np.minimum(1, t / 2.0) * np.minimum(1, (seconds - t) / 3.0)
    return out * fade


def main(names):
    title = os.path.join(PRO, 'title.mp4')
    T_TITLE, T_END = 4.0, 5.5
    card(title, [
        ('Deskcraft', F_BOLD, 150, 'white', 400),
        ('A desk that remembers what you make.', F_SEMI, 46, ACCENT, 640),
        ('Hands-first mixed reality  |  Meta Quest  |  Productivity', F_REG, 28, '0xaeb3bd', 720),
    ], T_TITLE)
    end = os.path.join(PRO, 'end.mp4')
    card(end, [
        ('Deskcraft', F_BOLD, 120, 'white', 400),
        ('Plan. Sketch. Sculpt. Build. Storyboard.', F_SEMI, 44, ACCENT, 640),
        ("Built with Meta's Immersive Web SDK. Runs in the Quest browser, no install.", F_REG, 30, '0xd6d9de', 720),
        (URL, F_SEMI, 32, 'white', 790),
    ], T_END)

    clips = [(title, T_TITLE, None)]
    for name in names:
        path, secs, tl = scene_video(name)
        clips.append((path, secs, tl))
    clips.append((end, T_END, None))

    # Video: chain crossfades.
    inputs = []
    for path, _, _ in clips:
        inputs += ['-i', path]
    parts = []
    offset = 0.0
    starts = []
    prev = '[0:v]'
    acc = clips[0][1]
    starts.append(0.0)
    for i in range(1, len(clips)):
        offset = acc - XF
        starts.append(offset)
        label = f'[v{i}]'
        parts.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XF}:offset={offset:.3f}{label}")
        prev = label
        acc = offset + clips[i][1]
    total = acc
    video = os.path.join(PRO, 'video.mp4')
    run(['ffmpeg', '-y', *inputs, '-filter_complex', ';'.join(parts), '-map', prev, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', video])

    # Audio: music bed + each scene's sound events at their place in the cut.
    mix = music_bed(total) * 0.9
    sfx = np.zeros_like(mix)
    for (path, secs, tl), start in zip(clips, starts):
        if not tl:
            continue
        ambient_on = None
        for e in tl['sfx']:
            at = start + e['frame'] / FPS
            if e['name'] == 'ambientOn':
                ambient_on = at
                continue
            if e['name'] == 'ambientOff':
                ambient_on = None
                continue
            sound = st.render(e['name'], e.get('arg'))
            if sound is None:
                continue
            i = int(at * SR)
            sfx[i:i + len(sound)] += sound[: max(0, len(sfx) - i)]
    for at, sound in ((0.5, st.layered((0, st.bell(523.25, 0.08)), (0.18, st.bell(783.99, 0.08)))), (total - T_END + 0.6, st.layered((0, st.bell(659.25, 0.08)), (0.18, st.bell(987.77, 0.08))))):
        i = int(at * SR)
        sfx[i:i + len(sound)] += sound[: max(0, len(sfx) - i)]
    mix = mix + st.reverb(sfx) * 1.0
    peak = np.abs(mix).max()
    mix *= 0.89 / max(peak, 1e-6)
    wav = os.path.join(PRO, 'soundtrack.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())

    out = os.path.join(PRO, 'deskcraft-walkthrough.mp4')
    run(['ffmpeg', '-y', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out])
    print(f'wrote {out}  {total:.1f}s')


if __name__ == '__main__':
    main(sys.argv[1:])
