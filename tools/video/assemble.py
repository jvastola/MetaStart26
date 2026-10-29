"""Assemble the walkthrough: trimmed capture + captions + title/end cards + soundtrack."""
import json
import os
import subprocess
import sys

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.join(SCRIPTS, 'out')
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
TITLE_S = 3.5
END_S = 4.0


def run(args):
    print('+', ' '.join(args[:6]), '...')
    result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        sys.exit(f'ffmpeg failed ({result.returncode}):\n' + '\n'.join(result.stderr.splitlines()[-12:]))


def text_file(name, text):
    path = os.path.join(HERE, name)
    with open(path, 'w') as f:
        f.write(text)
    return path


def card(out, lines, seconds):
    filters = []
    y = 300 - 40 * (len(lines) - 1)
    for i, (text, size, font, color) in enumerate(lines):
        tf = text_file(f'card_{os.path.basename(out)}_{i}.txt', text)
        filters.append(f"drawtext=fontfile={font}:textfile={tf}:fontsize={size}:fontcolor={color}:x=(w-text_w)/2:y={y}")
        y += size + 34
    run(['ffmpeg', '-y', '-f', 'lavfi', '-i', f'color=c=0x14161b:s=1280x720:d={seconds}:r=30',
         '-vf', ','.join(filters + ['fade=t=in:st=0:d=0.5', f'fade=t=out:st={seconds - 0.5}:d=0.5', 'format=yuv420p']),
         '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out])


# Headless screen capture runs behind the app under software rendering; this
# was measured from the footage (a recolour lands ~5.5-6 s after its event).
CAPTURE_LAG = float(os.environ.get('CAPTURE_LAG', '5.5'))
MIN_SEG = 3.2
MAX_SEG = 8.5


def video_seconds():
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
                            os.path.join(HERE, 'raw.webm')], capture_output=True, text=True)
    return float(probe.stdout.strip() or 1e9)


def segments(timeline):
    """Captioned spans of the capture, each retimed to a readable length."""
    trim = timeline['trimStart'] / 1000
    limit = video_seconds() - trim - 0.1
    out = []
    for cap in timeline['captions']:
        a = min(limit, cap['start'] / 1000 - trim + CAPTURE_LAG)
        b = min(limit, (cap['end'] or timeline['end']) / 1000 - trim + CAPTURE_LAG)
        if b - a < 0.2:
            continue
        real = max(b - a, 0.05)
        target = min(MAX_SEG, max(MIN_SEG, real / 4.0))
        out.append({'text': cap['text'], 'a': a, 'b': b, 'k': target / real, 'dur': target})
    t = 0.0
    for seg in out:
        seg['new'] = t
        t += seg['dur']
    return out, t


def retime(segs, t):
    """Map a capture time (seconds after trim) to the edited timeline."""
    for seg in segs:
        if seg['a'] <= t < seg['b']:
            return seg['new'] + (t - seg['a']) * seg['k']
    return None


def main():
    timeline = json.load(open(os.path.join(HERE, 'timeline.json')))
    trim = timeline['trimStart'] / 1000
    segs, length = segments(timeline)
    label = text_file('label.txt', 'Prototype footage - IWSDK emulator, Quest 3 profile, emulated hands')

    # One ffmpeg run per captioned segment (input seeking keeps memory low),
    # then a lossless concat of the pieces.
    pieces = []
    for i, seg in enumerate(segs):
        tf = text_file(f'cap_{i}.txt', seg['text'])
        vf = (
            f"setpts=(PTS-STARTPTS)*{seg['k']:.5f},fps=30,"
            f"drawtext=fontfile={BOLD}:textfile={tf}:fontsize=32:fontcolor=white:box=1:boxcolor=0x14161bd9:boxborderw=18:x=(w-text_w)/2:y=h-text_h-56,"
            f"drawtext=fontfile={FONT}:textfile={label}:fontsize=16:fontcolor=white@0.75:box=1:boxcolor=0x000000@0.35:boxborderw=8:x=20:y=20,format=yuv420p"
        )
        piece = os.path.join(HERE, f'seg_{i:02d}.mp4')
        run(['ffmpeg', '-y', '-ss', f"{trim + seg['a']:.3f}", '-t', f"{seg['b'] - seg['a']:.3f}", '-i', os.path.join(HERE, 'raw.webm'),
             '-vf', vf, '-t', f"{seg['dur']:.3f}", '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', piece])
        pieces.append(piece)
    listing = os.path.join(HERE, 'segments.txt')
    with open(listing, 'w') as f:
        f.writelines(f"file '{p}'\n" for p in pieces)
    main_mp4 = os.path.join(HERE, 'main.mp4')
    run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', main_mp4])

    # Retime the logged sound events to match the edit.
    edited = dict(timeline)
    edited['trimStart'] = 0
    edited['sfx'] = []
    for event in timeline['sfx']:
        t = retime(segs, event['t'] / 1000 - trim + CAPTURE_LAG)
        if t is not None:
            edited['sfx'].append({**event, 't': t * 1000})
    edited_path = os.path.join(HERE, 'timeline.edited.json')
    json.dump(edited, open(edited_path, 'w'))

    title = os.path.join(HERE, 'title.mp4')
    card(title, [
        ('Hands Lab', 84, BOLD, 'white'),
        ('Hands-first mixed reality for your real desk', 34, FONT, '0x9fc7ff'),
        ('Meta VR Start Developer Competition 2026 - prototype walkthrough', 22, FONT, '0xaeb3bd'),
    ], TITLE_S)
    end_card = os.path.join(HERE, 'end.mp4')
    card(end_card, [
        ('No controllers. Just your hands and your room.', 40, BOLD, 'white'),
        ("Built with Meta's Immersive Web SDK - runs in the Quest browser", 26, FONT, '0x9fc7ff'),
        ('Desk Focus - Conjure - Shot Board - Sketch - Clay - Desk Links', 22, FONT, '0xaeb3bd'),
    ], END_S)

    total = TITLE_S + length + END_S
    wav = os.path.join(HERE, 'soundtrack.wav')
    subprocess.run([sys.executable, os.path.join(SCRIPTS, 'soundtrack.py'), edited_path, wav, f'{total:.2f}', f'{TITLE_S}'], check=True)

    out = os.path.join(HERE, 'hands-lab-walkthrough.mp4')
    run(['ffmpeg', '-y', '-i', title, '-i', main_mp4, '-i', end_card, '-i', wav,
         '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
         '-c:v', 'libx264', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest',
         '-movflags', '+faststart', out])
    print('wrote', out, f'{total:.1f}s')


if __name__ == '__main__':
    main()
