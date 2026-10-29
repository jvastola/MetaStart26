# Demo video script

Judges watch at most 3 minutes and score Polish & Presentation partly on the
video. The rules ask for footage that honestly represents the experience,
captured on a Meta Quest (or an emulator), leading with the story and what
makes the project distinct. No AI-generated video.

There is a rough cut recorded automatically in the emulator
(`hands-lab-walkthrough.mp4`, made by the recorder described below). Use it to
check pacing. The submission should be re-shot on a Quest with real passthrough
and real hands.

## Capture setup (Quest 3 / 3S)

- **Capture:** Quest's built-in recording (Camera app, Record video) at 1080p,
  with the **mixed reality** capture option so passthrough is recorded.
  Microphone off; voice lines are added as captions.
- **Seating:** a real desk against a wall, good light, an uncluttered desktop.
  Sit centred, close enough that the desk mat fills the lower third of the view.
- **Before recording:** run Space Setup so the desk and wall are labelled
  (that is what makes "it found my desk" work). Clear site data for the app so
  the tutorial and how-to cards appear fresh.
- **Hand pace:** move about half your natural speed. Pause one beat after each
  success so the sound and particles land.
- **Audio:** the app's sounds are the soundtrack. Keep system volume around 70%.

## Structure (target 2:30, hard limit 2:59)

| Time | Shot | On-screen caption | Why it is here |
|---|---|---|---|
| 0:00-0:06 | Title card over a slow push-in on the desk | **Hands Lab**: your desk, no controllers | Hook |
| 0:06-0:16 | Put on headset, press Enter XR; the mat snaps onto the real desk; toast "Found your table" | It finds your real desk | Scene understanding in the first 10 seconds (Technical, Experience) |
| 0:16-0:40 | Tutorial: poke, pinch-carry, twist, palm up (one take, fast) | Four moves, learned by doing | First Five Minutes award: no wall of text |
| 0:40-1:25 | **Hero: Desk Focus.** Pinch a card off the real wall, drop it on the focus pad, twist the dial (ambient bed starts), cut to the timer chime, flick the card into Done, plant grows, streak toast | Your day, pinned to your room | Productivity track fit; purposeful passthrough; reason to come back |
| 1:25-1:50 | Conjure: say "a red mushroom", then "make it blue", "bigger"; pinch it onto the shelf | Say it, place it | Agentic interaction; voice as an accessibility option |
| 1:50-2:10 | Shot Board: two-hand frame, capture, Play | Frame shots with your hands | Boldest concept; shows hand range |
| 2:10-2:25 | Clay: fingertip dents, pinch-pull with mirror | Sculpt with your fingertips | Craft, hand precision |
| 2:25-2:35 | Next day: put the headset back on and everything is where you left it (anchors); streak 2 | Tomorrow, it is still there | Persistence, repeat use |
| 2:35-2:45 | End card | Built with IWSDK, runs in the Quest browser | Call to action |

If the final entry is a single prototype, give that one 60 to 75 seconds, keep
the setup and tutorial beats, and cut the others to a 10-second "also in the
lab" montage, or drop them.

## Lines for the captions / description

- Your desk is the interface. Hands Lab finds it, frames it, and remembers it.
- Everything is reachable from your chair: poke, pinch, twist, palm up.
- No controllers, no wall of text. A 40-second tutorial teaches by doing.

## Regenerating the emulator rough cut

The emulator cut is produced by scripts (kept outside the repo, in the session
scratchpad) that:

1. drive the app in IWER with Playwright (emulated hands, seated head facing
   the emulated room's table), recording video plus a log of caption timings
   and app sound events (`window.__sfxLog`);
2. re-synthesise the app's sounds from that log with numpy;
3. use ffmpeg to burn in captions, add title and end cards, and mux the audio.

Every frame is labelled "Prototype footage - IWSDK emulator", so it is never
mistaken for device footage.
