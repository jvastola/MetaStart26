# Hands Lab: Meta VR Start 2026 prototypes

Five hands-first mixed-reality prototypes for the
[Meta VR Start Developer Competition 2026](https://start-developer-competition-26.devpost.com/),
built with Meta's Immersive Web SDK (IWSDK, WebXR). Judges open a link in the
Quest browser: no APK or release channel.

They share one host: a launcher, desk and wall detection, hand input, and a
palm-up menu. That makes it cheap to compare concepts before we pick the one
to submit. The goal is to choose a Productivity entry for the **New Experience**
division.

| # | Prototype | Track | One-line pitch |
|---|---|---|---|
| 1 | **Desk Focus** | Productivity | A daily planner pinned to your real wall and desk: pinch cards, twist a timer, flick to done, grow a streak plant. |
| 2 | **Conjure** | Productivity / creative (Agentic) | Say what you want and it appears on your desk. Instant offline sketch, optionally upgraded by Meshy or Tripo. |
| 3 | **Shot Board** | Productivity / creative | Storyboard a scene on your desk by framing shots with both hands like a director. |
| 4 | **Clay** | Productivity / creative | Sculpt with your bare fingertips on a turntable; export to OBJ. |
| 5 | **Desk Links** | Gaming (reference) | Fingertip mini golf on your desk, kept for comparing hand mechanics. |

## Run it

```bash
npm install
npm run dev          # IWSDK-managed dev server + browser with the XR emulator (IWER)
npm test             # unit tests (vitest)
npm run typecheck
npm run build
```

- **Desktop:** the mouse stands in for a pinching hand. Use the buttons at the
  bottom of the page or keys `0`-`5` to switch prototypes, or open `?p=focus`
  (also `conjure`, `shotboard`, `clay`, `golf`, `hub`).
- **`?skeleton=1`** draws procedural hands. Use it for recordings, or when the
  stock hand models cannot load (they come from a CDN).
- **Quest on the same Wi-Fi:** run `npx @iwsdk/cli dev status` and open the
  `runtimeUrls.network` address in the Quest browser. Accept the local
  certificate, then press Enter XR.

## Live build

**https://jvastola.github.io/MetaStart26/** (open it in the Quest browser and
press Enter XR).

`.github/workflows/pages.yml` typechecks, tests, builds and publishes on every
push. One-time setup: in the repository, go to **Settings > Pages > Build and
deployment**, set **Source** to **GitHub Actions**, then re-run the workflow.

GitHub Pages serves static files only, so Conjure runs in offline-sketch mode
there. AI generation needs the `api/gen3d.ts` proxy on Vercel.

## First use

1. Put on the headset and open the link. Press **Enter XR**.
2. The lab looks for your desk in your Space Setup and puts a soft desk mat on
   it ("Found your table"). If it can't find one, hold your hand (or a
   controller) over the desk and pinch (or pull the trigger). The setup panel
   shows how many room surfaces the headset reported. If you do nothing, the
   desk appears in front of you after a few seconds; move it later with
   **Move desk** in the menu.
   - If the browser's own enter prompt doesn't appear (Quest sometimes skips
     it after a reload), use the **Enter mixed reality** button on the page.
3. A **40-second tutorial** teaches the four moves by doing them. A ghost
   fingertip demonstrates each one:
   1. poke a glowing button;
   2. pinch an orb and carry it into a ring;
   3. pinch a dial's rim and twist it;
   4. turn your left palm toward you to open the menu.
4. The hub opens. The first time you enter each prototype, a **How to** card
   explains it in three lines. Bring it back any time with palm up, then
   **How to**.

Replay the tutorial from the hub's **Tutorial** button. To reset first-use
state, clear the site's storage.

## How the hands work

Everything is reachable within arm's length while seated, so the default
interaction is **direct touch**, not rays:

| Gesture | Does |
|---|---|
| Poke a button with your index fingertip, or pinch on it | Press it |
| Pinch near an object | Pick it up. It follows your pinch; release to drop. |
| Pinch with both hands on one object | Scale and turn it (Conjure) |
| Pinch with both hands and pull apart | Frame a camera shot (Shot Board) |
| Pinch a dial or rim and move around it | Twist it (timer, turntable) |
| Turn your left palm toward your face | Wrist menu: Home, Move desk, How to, Sound |
| Thumb microgestures (thumb tap, swipe on the index finger) | Shortcuts: start/pause, next card, undo, bigger/smaller, rotate |

**Controllers work too**, though hands are the design target:
- the controller acts as a fingertip 5 cm ahead of the grip, so you can poke
  with it;
- the trigger is the pinch;
- X or A opens and closes the menu.

There is no locomotion: the experience is designed to be used seated.

**Feedback without haptics.** A pinch cursor between thumb and index closes
as they come together and fills with the prototype's colour when the pinch
registers. Every interaction also has a sound, synthesised at runtime (no
audio files) and positioned in the room where it happened:
- a soft tick on press;
- a pluck on grab;
- a wooden thud on drop;
- a bell chord on success.

A quiet ambient bed plays during Desk Focus sessions. **Sound** in the wrist
menu mutes everything.

**Look.** Each prototype has an accent colour, used for its desk mat rim,
pinch cursor and hub stripe. Blob shadows make the virtual objects sit on the
real desk under passthrough.

**First launch.** The host looks for a table plane in front of you from the
headset's Space Setup and puts the workspace on it. It finds the wall behind it
the same way. If neither is detected, it asks you to hold your hand over the
desk and pinch. Placement is stored relative to an IWSDK persistent anchor, so
it comes back in the same physical spot next session.

## Mapping to the judging criteria (each 25%)

- **Innovation & Creativity:** every prototype depends on your real room. The
  planner lives on your actual wall and desk, Conjure fills your desk, and Shot
  Board frames shots from your own eye point.
- **Experience Design:**
  - Passthrough is purposeful: content is anchored to detected surfaces.
  - The central UI stays in a narrow cone in front of you (FoV-aware, with
    Meta VR Glasses in mind).
  - Each prototype gives a complete moment in under 10 minutes.
  - The system menu pauses everything.
- **Technical Implementation:** hand tracking, plane detection, persistent
  anchors and microgestures, in light procedural scenes (no physics engine,
  no heavy assets) aimed at Quest's 60 fps minimum.
- **Polish & Presentation:** still to do: art pass, sound pass, video.

Special awards each concept targets:
- **Reason to Come Back:** Desk Focus streaks and plant, Desk Links daily course.
- **Agentic Interaction:** Conjure's voice loop with follow-ups.
- **First Five Minutes:** desk auto-detect, then the hub.
- **Accessibility:** voice and microgestures as alternatives to arm movement.
- **Boldest Concept:** Shot Board's hand-framed camera.

## Conjure AI generation (optional)

The offline sketch generator always works. That covers the rules' "take it
away" test: with the AI service removed, there is still a project. For real
models:

1. Deploy to **Vercel**. `api/gen3d.ts` is a serverless proxy that keeps API
   keys off the client.
2. Set `MESHY_API_KEY` and/or `TRIPO_API_KEY` in the Vercel project.
   - Optional: `GEN3D_ALLOWED_ORIGIN`, and `GEN3D_ALLOWED_HOSTS` (the hosts the
     proxy may download GLBs from).
3. In the app, press **AI: off** to cycle through the providers. The endpoint
   is same-origin `/api/gen3d` on `*.vercel.app`. Elsewhere, set
   `VITE_GEN3D_ENDPOINT` at build time, or the `gen3d-endpoint` localStorage key.

The proxy has **not been run against the live Meshy or Tripo APIs yet**. Check
the response shapes in `api/gen3d.ts` against their current docs before relying
on it. Tripo's model download host in particular may need adding to
`GEN3D_ALLOWED_HOSTS`.

## Video

`docs/VIDEO_SCRIPT.md` has the shot list for the real Quest capture (under 3
minutes, honest device footage).

`tools/video/` produces an emulator rough cut, with every frame labelled as
emulator footage. It drives the app with emulated hands, records it, rebuilds
the app's sound from a logged event track, then burns in captions:

```bash
npm run dev                      # keep the dev server running
node tools/video/record.cjs      # PLAYWRIGHT_MODULE / CHROMIUM_PATH pick an existing install
python3 tools/video/assemble.py  # writes tools/video/out/hands-lab-walkthrough.mp4
```

## Layout

```
src/lab-system.ts        host: input, desk/wall setup, anchored room, wrist menu, navigation
src/core/                hands + microgestures, canvas panels, surfaces, voice, sfx
src/protos/hub.ts        launcher
src/protos/intro.ts      first-use tutorial (poke, carry, twist, palm menu)
src/core/art.ts          desk mat, blob shadows, pinch cursor, accent colours
src/protos/focus/        Desk Focus (focus-store.ts is the pure data model)
src/protos/conjure/      Conjure (intent.ts parser, kit.ts offline generator, remote.ts client)
src/protos/shotboard/    Shot Board
src/protos/clay/         Clay (sculpt.ts is the pure sculpting maths)
src/protos/golf/         Desk Links
api/gen3d.ts             Meshy/Tripo proxy (Vercel function)
tests/                   unit tests for the pure modules
```

For the automated browser tests, `window.lab` exposes `go(id)`, `state()`,
`act(name, ...args)` and coordinate helpers.

## Verified so far, and what is not

**Verified** in desktop Chromium and in the IWER emulator with emulated hands:
- every prototype's main interaction;
- the **whole tutorial**: fingertip poke, pinch-carry, twist, and the palm-up
  wrist menu;
- auto-placing the desk on the emulated room's labelled table;
- pinch-to-place fallback;
- carrying a card to the focus pad;
- the timer dial twist;
- fingertip dents in the clay;
- two-hand shot framing;
- first-visit how-to cards.

The 39 unit tests, typecheck and production build pass.

**Not yet verified on a real Quest:**
- plane detection in a real room;
- persistent anchor restore across sessions;
- microgesture button mapping;
- Web Speech API availability in the Quest browser (every voice path has a
  pinch fallback);
- the feel of the palm threshold;
- frame rate;
- how the positional (HRTF) audio sounds on the Quest speakers.

## Competition checklist

- [ ] Pick the entry and cut the other prototypes from the submitted build (or keep the hub).
- [ ] Device test on Quest 3 / 3S. Profile to 72 fps+ with the Meta VR CLI performance tools.
- [x] Deploy to GitHub Pages (workflow in place; Vercel only needed for the AI proxy).
- [ ] Record a real-footage video under 3 minutes following `docs/VIDEO_SCRIPT.md`.
- [ ] Devpost form: Productivity track, New Experience division, description, how hands are used.
