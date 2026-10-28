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
- **Quest on the same Wi-Fi:** run `npx @iwsdk/cli dev status` and open the
  `runtimeUrls.network` address in the Quest browser. Accept the local
  certificate, then press Enter XR.

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
| Turn your left palm toward your face | Wrist menu: Home, Move desk |
| Thumb microgestures (thumb tap, swipe on the index finger) | Shortcuts: start/pause, next card, undo, bigger/smaller, rotate |

There is no locomotion: the experience is designed to be used seated.

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

## Layout

```
src/lab-system.ts        host: input, desk/wall setup, anchored room, wrist menu, navigation
src/core/                hands + microgestures, canvas panels, surfaces, voice, sfx
src/protos/hub.ts        launcher
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
- pinch-to-place desk setup;
- carrying a card to the focus pad;
- the timer dial twist;
- fingertip dents in the clay;
- two-hand shot framing.

The 39 unit tests, typecheck and production build pass.

**Not yet verified on a real Quest:**
- plane-detected desk and wall placement in a real room;
- persistent anchor restore across sessions;
- microgesture button mapping;
- Web Speech API availability in the Quest browser (every voice path has a
  pinch fallback);
- frame rate;
- the wrist menu's palm-facing threshold.

## Competition checklist

- [ ] Pick the entry and cut the other prototypes from the submitted build (or keep the hub).
- [ ] Device test on Quest 3 / 3S. Profile to 72 fps+ with the Meta VR CLI performance tools.
- [ ] Deploy (Vercel recommended for the AI proxy; GitHub Pages works without it).
- [ ] Record a real-footage video under 3 minutes. Lead with the strongest moment.
- [ ] Devpost form: Productivity track, New Experience division, description, how hands are used.
