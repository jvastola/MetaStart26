// Records one scene of the Deskcraft walkthrough, frame by frame.
//
// The page runs on Playwright's fake clock: every frame advances the app by
// exactly 1/FPS of a second and the screencast frame for it is saved, so the
// footage is smooth however slowly the software renderer runs here.
// Writes pro/<scene>/frames/00000.jpg ... and pro/<scene>/timeline.json
// (captions by frame, sound events by frame).
//
//   node tools/video/record-pro.cjs <scene>        (dev server on :8081)
//   scenes: open focus conjure clay sketch blocks shotboard home
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');

const SCENE = process.argv[2];
const FPS = 24;
const STEP = 1000 / FPS;
const W = 1280;
const H = 720;
const OUT = path.join(__dirname, 'pro', SCENE);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

(async () => {
  const { wristRotationFromDirections } = await import(path.join(__dirname, '../../node_modules/iwer/lib/device/XRHandInput.js'));
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const wrist = (side, fingers, palm) => Array.from(wristRotationFromDirections({ fingers: norm(fingers), palm: norm(palm) }, side));

  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('lab-intro-done-v1', 'true');
    window.__sfxLog = [];
  });
  await page.clock.install({ time: new Date('2026-11-03T10:00:00') });
  const app = SCENE === 'open' || SCENE === 'home' ? 'hub' : SCENE;
  await page.goto(`https://localhost:8081/?skeleton=1&p=${app}`);
  for (let i = 0; i < 600; i++) {
    await page.clock.runFor(50);
    if (await page.evaluate(() => window.lab != null && window.IWER_DEVICE != null)) break;
  }
  const lab = (fn, ...a) => page.evaluate(([fn, a]) => window.lab[fn](...a), [fn, a]);
  const act = (...a) => page.evaluate((a) => window.lab.act(...a), a);
  const remote = (m, p) => page.evaluate(([m, p]) => window.IWER_DEVICE.remote.dispatch(m, p), [m, p]);

  // ------------------------------------------------------------ frames
  const cdp = await page.context().newCDPSession(page);
  let latest = null;
  let count = 0;
  cdp.on('Page.screencastFrame', (f) => {
    latest = f;
    count++;
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  let recording = false;
  let frameNo = 0;
  let startTime = 0;
  const frame = async () => {
    const before = count;
    await page.clock.fastForward(STEP);
    if (!recording) return;
    const t0 = Date.now();
    while (count === before && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 10));
    if (latest) fs.writeFileSync(path.join(OUT, 'frames', `${String(frameNo).padStart(5, '0')}.jpg`), Buffer.from(latest.data, 'base64'));
    frameNo++;
    if (frameNo % 48 === 0) console.log(`${SCENE}: ${frameNo} frames`);
  };
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const hold = (seconds) => frames(Math.round(seconds * FPS));
  const settle = async (seconds) => { for (let i = 0; i < Math.round(seconds * FPS); i++) await page.clock.fastForward(STEP); };

  const captions = [];
  const caption = (title, sub = '') => {
    if (captions.length && captions[captions.length - 1].end == null) captions[captions.length - 1].end = frameNo;
    if (title) captions.push({ title, sub, start: frameNo, end: null });
  };

  // ------------------------------------------------------------ setup (not recorded)
  await page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'hand'; });
  await page.getByText('Enter mixed reality').click();
  const HEAD = { x: -0.95, y: 1.17, z: 0.7 };
  await remote('set_transform', { device: 'headset', position: HEAD });
  await remote('look_at', { device: 'headset', target: { x: -0.95, y: 0.8, z: 1.28 } });
  for (let i = 0; i < 240 && (await lab('setup')) !== 'ready'; i++) await page.clock.fastForward(100);
  if ((await lab('setup')) !== 'ready') {
    // No table found: pinch to place.
    await page.evaluate(() => window.IWER_DEVICE.hands.right.setPin({ anchor: 'index-tip', target: [-0.95, 0.78, 1.25] }));
    await settle(1);
    for (let i = 0; i < 3 && (await lab('setup')) !== 'ready'; i++) {
      await page.evaluate(() => window.IWER_DEVICE.hands.right.setPinchValueImmediate(1));
      await settle(0.3);
      await page.evaluate(() => window.IWER_DEVICE.hands.right.setPinchValueImmediate(0));
      await settle(0.6);
    }
  }
  // Hide the emulator's own tools and the page's buttons: only the app and the room show.
  await page.evaluate(() => {
    const ui = window.IWER_DEVICE.devui;
    if (ui) {
      ui.devUIContainer.style.display = 'none';
      ui.devUICanvas.style.display = 'none';
    }
    for (const el of document.body.children) if (['10', '11', '999'].includes(getComputedStyle(el).zIndex)) el.style.display = 'none';
  });
  if (app !== 'hub') await lab('go', app);
  await settle(0.5);
  if (await lab('coach')) await lab('pressCoach');
  await settle(0.3);

  // Desk frame: forward and the hands' resting spots.
  const desk = (x, y, z) => lab('deskToWorld', x, y, z);
  const d0 = await desk(0, 0, 0);
  const dz = await desk(0, 0, -1);
  const fwd = norm([dz.x - d0.x, 0, dz.z - d0.z]);
  const pose = (side, kind) => {
    const [fx, , fz] = fwd;
    if (kind === 'poke') return wrist(side, [fx * 0.55, -0.85, fz * 0.55], [fx * 0.2, -0.3, fz * 0.2 - 0.0001]);
    if (kind === 'frame') return wrist(side, [fx * 0.6, 0.75, fz * 0.6], [side === 'left' ? fz : -fz, 0, side === 'left' ? -fx : fx]);
    return wrist(side, [fx, -0.35, fz], [0, -1, 0]);
  };
  const rest = { right: await desk(0.24, 0.06, 0.2), left: await desk(-0.24, 0.06, 0.2) };
  const offscreen = { right: await desk(0.34, -0.05, 0.42), left: await desk(-0.34, -0.05, 0.42) };

  // ------------------------------------------------------------ hands and camera
  const pos = { left: null, right: null };
  const quat = { left: null, right: null };
  const anchor = { left: 'index-tip', right: 'index-tip' };
  const pin = (side, p, q) => {
    pos[side] = p;
    if (q) quat[side] = q;
    return page.evaluate(([side, p, q, a]) => window.IWER_DEVICE.hands[side].setPin({ anchor: a, target: [p.x, p.y, p.z], ...(q ? { wristRotation: q } : {}) }), [side, p, quat[side], anchor[side]]);
  };
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
  /** Move one or both hands over `seconds`, a frame at a time. */
  const move = async (targets, seconds = 0.6) => {
    const from = Object.fromEntries(Object.keys(targets).map((s) => [s, pos[s] ?? targets[s].p]));
    const n = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      for (const [side, t] of Object.entries(targets)) await pin(side, lerp(from[side], t.p, k), t.q);
      await frame();
    }
  };
  const glide = (side, p, seconds, q) => move({ [side]: { p, q } }, seconds);
  const pinch = async (side, on) => {
    await page.evaluate(([s, v]) => window.IWER_DEVICE.hands[s].setPinchValueImmediate(v), [side, on ? 1 : 0]);
    await frames(2);
  };
  const grab = async (side, on) => {
    await page.evaluate(([s, on]) => { window.IWER_DEVICE.hands[s].poseId = on ? 'pinch-middle' : 'default'; }, [side, on]);
    await frames(2);
  };
  const useMiddle = (side, on) => { anchor[side] = on ? 'middle-finger-tip' : 'index-tip'; };
  const toRest = (seconds = 0.6) => move({ right: { p: rest.right, q: pose('right', 'reach') }, left: { p: rest.left, q: pose('left', 'reach') } }, seconds);
  const away = (seconds = 0.6) => move({ right: { p: offscreen.right, q: pose('right', 'reach') }, left: { p: offscreen.left, q: pose('left', 'reach') } }, seconds);

  let look = null;
  const lookAt = (p) => { look = p; return remote('look_at', { device: 'headset', target: p }); };
  /** Ease the camera's aim to a new point (and the head a little, for depth). */
  const pan = async (target, seconds = 1, headTo = null) => {
    const from = look ?? target;
    const h0 = headNow;
    const n = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      if (headTo) {
        headNow = lerp(h0, headTo, k);
        await remote('set_transform', { device: 'headset', position: headNow });
      }
      await lookAt(lerp(from, target, k));
      await frame();
    }
  };
  let headNow = HEAD;

  /** Drag something: reach it, grab (thumb + middle), carry, let go. */
  const carry = async (side, from, to, lift = 0.05, seconds = 0.9) => {
    useMiddle(side, true);
    await glide(side, { x: from.x, y: from.y + 0.05, z: from.z }, 0.5, pose(side, 'reach'));
    await glide(side, from, 0.3);
    await grab(side, true);
    await frames(3);
    const mid = { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + lift, z: (from.z + to.z) / 2 };
    await glide(side, mid, seconds / 2);
    await glide(side, to, seconds / 2);
    await frames(3);
    await grab(side, false);
    useMiddle(side, false);
    await glide(side, { x: to.x, y: to.y + 0.06, z: to.z }, 0.3);
  };
  const tap = async (side, at) => {
    await glide(side, { x: at.x, y: at.y + 0.04, z: at.z }, 0.45, pose(side, 'reach'));
    await glide(side, at, 0.2);
    await pinch(side, true);
    await frames(2);
    await pinch(side, false);
    await glide(side, { x: at.x, y: at.y + 0.05, z: at.z }, 0.3);
  };
  const press = async (iconId, side = 'right') => {
    const b = await lab('icon', iconId);
    if (!b) return console.log('no icon', iconId);
    const n = { x: b.nx, y: b.ny, z: b.nz };
    const at = (d) => ({ x: b.x + n.x * d, y: b.y + n.y * d, z: b.z + n.z * d });
    await glide(side, at(0.05), 0.45, pose(side, 'poke'));
    await glide(side, at(0.001), 0.25);
    await frames(4);
    await glide(side, at(0.06), 0.3);
  };
  const openPalm = async () => {
    const view = await lab('view');
    const h = { x: view.head[0], y: view.head[1], z: view.head[2] };
    const f = norm([view.forward[0], 0, view.forward[2]]);
    const at = { x: h.x + f[0] * 0.3 + f[2] * 0.08, y: h.y - 0.17, z: h.z + f[2] * 0.3 - f[0] * 0.08 };
    for (const q of [wrist('left', [0, 1, 0], [-f[0], 0, -f[2]]), wrist('left', [f[0] * 0.3, 0.9, f[2] * 0.3], [-f[0], 0.2, -f[2]])]) {
      await glide('left', at, 0.6, q);
      await frames(4);
      if (await lab('wrist')) return true;
    }
    return false;
  };

  // ------------------------------------------------------------ start recording
  await pin('right', offscreen.right, pose('right', 'reach'));
  await pin('left', offscreen.left, pose('left', 'reach'));
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await settle(0.4);
  startTime = await page.evaluate(() => Date.now());
  recording = true;

  const deskCam = async (x, y, z) => desk(x, y, z);

  // ------------------------------------------------------------ scenes
  if (SCENE === 'open') {
    // The desk on a real table, hands come in, fingertip icons, palm menu.
    await lookAt(await deskCam(0, 0.05, 0.02));
    caption('Deskcraft', 'Your real desk, in mixed reality');
    await hold(1.2);
    await toRest(1.0);
    caption('Two gestures do everything', 'Pinch (thumb + index) to use. Grab (thumb + middle) to hold.');
    const center = await desk(0.1, 0.12, 0.12);
    await glide('right', center, 0.8, pose('right', 'reach'));
    await hold(0.6);
    await pinch('right', true); await hold(0.6); await pinch('right', false);
    await grab('right', true); await hold(0.6); await grab('right', false);
    await hold(0.4);
    caption('Palm up for your menu', 'Home, help, undo, clear the desk, sound and passthrough');
    await glide('right', rest.right, 0.5);
    await openPalm();
    await hold(1.8);
    await glide('left', rest.left, 0.6, pose('left', 'reach'));
    await hold(0.6);
  }

  if (SCENE === 'home') {
    await lookAt(await deskCam(0, 0.14, -0.08));
    await toRest(0.01);
    caption('Every tool, one tap away', 'Poke an app on Home to open it');
    await hold(1.0);
    const tile = await act('tileWorld', 'focus');
    const n = { x: tile.nx, y: tile.ny, z: tile.nz };
    const at = (d) => ({ x: tile.x + n.x * d, y: tile.y + n.y * d, z: tile.z + n.z * d });
    await glide('right', at(0.06), 0.6, pose('right', 'poke'));
    await hold(0.8);
    await glide('right', at(0.07), 0.3);
    await toRest(0.6);
    await hold(0.8);
  }

  if (SCENE === 'focus') {
    await act('reset');
    await settle(0.3);
    await lookAt(await deskCam(0, 0.1, -0.06));
    caption('Desk Focus', 'A Kanban planner standing on your desk');
    await toRest(0.8);
    let s = await lab('state');
    caption('Grab a card, drop it where it belongs', 'Any column, any height');
    await carry('right', await act('cardWorld', s.zones.inbox[0]), await act('slotWorld', 'today', 1), 0.05, 1.0);
    caption('A quick pinch tags it', 'Colour-code what matters');
    await tap('right', await act('cardWorld', s.zones.inbox[0]));
    await hold(0.3);
    s = await lab('state');
    caption('Put one on the focus pad', 'Then twist the dial to start the timer');
    await pan(await deskCam(0, 0.05, 0.03), 0.8);
    await carry('right', await act('cardWorld', s.zones.today[0]), await act('padWorld'), 0.06, 0.9);
    // Twist the dial rim a quarter turn.
    const dial = await act('dialWorld');
    const rim = (a) => ({ x: dial.x + Math.sin(a) * 0.04, y: dial.y + 0.005, z: dial.z + Math.cos(a) * 0.04 });
    await glide('right', rim(Math.PI), 0.5, pose('right', 'reach'));
    await pinch('right', true);
    for (let i = 1; i <= 18; i++) { await pin('right', rim(Math.PI - (i / 18) * Math.PI * 0.6)); await frame(); }
    await pinch('right', false);
    await hold(0.8);
    caption('Done? Drop it in the tray', 'Your streak plant grows');
    s = await lab('state');
    await carry('right', await act('cardWorld', s.zones.focus[0]), await act('trayWorld'), 0.06, 0.9);
    await toRest(0.6);
    await hold(1.4);
  }

  if (SCENE === 'conjure') {
    await act('say', 'clear everything');
    await settle(0.3);
    await lookAt(await deskCam(0, 0.09, -0.04));
    await toRest(0.01);
    caption('Conjure', 'Say what you need. It appears on the pedestal.');
    await hold(0.6);
    await act('say', 'a small red castle');
    await hold(2.2);
    caption('"Make it blue"', 'Change it by talking');
    await act('say', 'make it blue');
    await hold(1.6);
    caption('Pick it up and look around it', 'Your wrist turns it');
    const item = await act('itemWorld', 0);
    useMiddle('right', true);
    await glide('right', { x: item.x, y: item.y + 0.04, z: item.z }, 0.5, pose('right', 'reach'));
    await glide('right', item, 0.25);
    await grab('right', true);
    for (let i = 1; i <= 30; i++) {
      const a = (i / 30) * Math.PI * 0.8;
      const f = [Math.cos(a) * fwd[0] - Math.sin(a) * fwd[2], -0.35, Math.sin(a) * fwd[0] + Math.cos(a) * fwd[2]];
      await pin('right', { x: item.x, y: item.y + 0.05 * Math.sin((i / 30) * Math.PI), z: item.z }, wrist('right', f, [0, -1, 0]));
      await frame();
    }
    await grab('right', false);
    useMiddle('right', false);
    await toRest(0.6);
    await hold(1.0);
  }

  if (SCENE === 'clay') {
    await lookAt(await deskCam(0, 0.07, -0.01));
    await toRest(0.01);
    caption('Clay', 'Sculpt with your fingertips on a turntable');
    await hold(0.5);
    for (const [x, z] of [[0, 0.03], [0.03, 0.0]]) {
      const surf = await act('clayWorld', x, 0.055, z);
      await glide('right', { x: surf.x, y: surf.y + 0.02, z: surf.z }, 0.45, pose('right', 'reach'));
      await glide('right', { x: surf.x, y: surf.y + 0.003, z: surf.z }, 0.2);
      await pinch('right', true);
      await glide('right', { x: surf.x, y: surf.y + 0.05, z: surf.z }, 0.6);
      await pinch('right', false);
    }
    await toRest(0.5);
    caption('Print a copy', 'A solid copy builds up you can pick up and keep');
    await press('clay:print');
    await toRest(0.4);
    await hold(2.6);
  }

  if (SCENE === 'sketch') {
    await act('clear');
    await settle(0.2);
    await lookAt(await deskCam(0, 0.13, 0.0));
    await toRest(0.01);
    caption('Sketch', 'Draw in the air with either hand, or both');
    const loop = async (side, cx, cy, r) => {
      const at = async (a) => desk(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8, 0.05);
      await glide(side, await at(0), 0.4, pose(side, 'reach'));
      await pinch(side, true);
      for (let i = 1; i <= 30; i++) { await pin(side, await at((i / 30) * Math.PI * 2.1)); await frame(); }
      await pinch(side, false);
    };
    await loop('right', 0.08, 0.16, 0.06);
    // Both hands at once: a wave each side.
    caption('Both hands at once', 'Grab a stroke to move it; two hands to resize');
    const wave = (side, x0) => async (i) => desk(x0 + i * 0.004, 0.12 + Math.sin(i / 4) * 0.025, 0.05);
    const wl = wave('left', -0.2), wr = wave('right', 0.0);
    await move({ left: { p: await wl(0), q: pose('left', 'reach') }, right: { p: await wr(0), q: pose('right', 'reach') } }, 0.4);
    await page.evaluate(() => { window.IWER_DEVICE.hands.left.setPinchValueImmediate(1); window.IWER_DEVICE.hands.right.setPinchValueImmediate(1); });
    for (let i = 1; i <= 28; i++) { await pin('left', await wl(i)); await pin('right', await wr(i)); await frame(); }
    await page.evaluate(() => { window.IWER_DEVICE.hands.left.setPinchValueImmediate(0); window.IWER_DEVICE.hands.right.setPinchValueImmediate(0); });
    await frames(3);
    // Grab the first loop and move it.
    const sp = await act('strokePoint', 0, 8);
    await carry('right', sp, { x: sp.x - 0.04, y: sp.y + 0.03, z: sp.z + 0.03 }, 0.02, 0.8);
    await toRest(0.5);
    await hold(1.0);
  }

  if (SCENE === 'blocks') {
    await act('reset');
    await settle(0.3);
    await lookAt(await deskCam(0, 0.06, -0.03));
    await toRest(0.01);
    caption('Blocks', 'Pinch where you want a block. Drag to lay a wall.');
    await hold(0.4);
    for (const y of [0, 1, 2]) {
      const a = await act('cellWorld', 4, y, 8);
      const b = await act('cellWorld', 11, y, 8);
      await glide('right', a, y === 0 ? 0.5 : 0.35, pose('right', 'reach'));
      await pinch('right', true);
      await glide('right', b, 0.7);
      await pinch('right', false);
    }
    const roof = await act('cellWorld', 6, 3, 8), roof2 = await act('cellWorld', 9, 3, 8);
    await glide('right', roof, 0.35); await pinch('right', true); await glide('right', roof2, 0.4); await pinch('right', false);
    await toRest(0.5);
    caption('Print it, keep it', 'A copy lands on your desk. Pin it, resize it with both hands.');
    await press('blocks:print');
    await toRest(0.4);
    await pan(await deskCam(0.16, 0.05, -0.05), 0.8);
    await hold(0.6);
    const objs = await lab('deskObjects');
    const pi = objs.length - 1;
    const pw = await lab('deskObjectWorld', pi);
    useMiddle('right', true); useMiddle('left', true);
    await move({ right: { p: { x: pw.x + 0.03, y: pw.y + 0.02, z: pw.z }, q: pose('right', 'reach') }, left: { p: { x: pw.x - 0.03, y: pw.y + 0.02, z: pw.z }, q: pose('left', 'reach') } }, 0.6);
    await grab('right', true);
    await grab('left', true);
    await frames(3);
    const r0 = pos.right, l0 = pos.left;
    const u = norm([r0.x - l0.x, 0, r0.z - l0.z]);
    await move({ right: { p: { x: r0.x + u[0] * 0.05, y: r0.y + 0.02, z: r0.z + u[2] * 0.05 } }, left: { p: { x: l0.x - u[0] * 0.05, y: l0.y + 0.02, z: l0.z - u[2] * 0.05 } } }, 0.9);
    await grab('left', false);
    await grab('right', false);
    useMiddle('right', false); useMiddle('left', false);
    await toRest(0.6);
    await hold(1.0);
  }

  if (SCENE === 'shotboard') {
    await lookAt(await deskCam(-0.06, 0.07, -0.04));
    await toRest(0.01);
    caption('Shot Board', 'Dress a stage from your library');
    await hold(0.4);
    await carry('right', await act('shelfWorld', 0), await act('stageWorld', -0.06, 0.04), 0.06, 0.9);
    await carry('right', await act('shelfWorld', 1), await act('stageWorld', 0.03, 0.05), 0.06, 0.9);
    await carry('right', await act('shelfWorld', 5), await act('stageWorld', 0.1, -0.06), 0.06, 0.9);
    await toRest(0.5);
    caption('Frame the shot with your hands', 'Pinch both hands together, pull apart, let go');
    const c = await desk(0, 0.2, 0.1);
    const off = (x, y) => ({ x: c.x + fwd[2] * x, y: c.y + y, z: c.z - fwd[0] * x });
    await move({ left: { p: off(0.035, -0.01), q: pose('left', 'frame') }, right: { p: off(-0.035, 0.01), q: pose('right', 'frame') } }, 0.6);
    await page.evaluate(() => { window.IWER_DEVICE.hands.left.setPinchValueImmediate(1); window.IWER_DEVICE.hands.right.setPinchValueImmediate(1); });
    await frames(3);
    await move({ left: { p: off(0.13, -0.05) }, right: { p: off(-0.13, 0.05) } }, 0.9);
    await hold(0.5);
    await page.evaluate(() => { window.IWER_DEVICE.hands.left.setPinchValueImmediate(0); window.IWER_DEVICE.hands.right.setPinchValueImmediate(0); });
    await frames(4);
    await away(0.6);
    caption('Every shot lands on your storyboard', 'And pops out as a little photo print');
    await pan(await deskCam(0, 0.32, -0.36), 1.1);
    await hold(1.4);
    await pan(await deskCam(-0.04, 0.07, -0.02), 0.9);
    caption('Set the mood', 'Day, sunset or night');
    await toRest(0.4);
    await press('shot:light');
    await hold(0.6);
    await press('shot:light');
    await toRest(0.4);
    await hold(1.2);
  }

  caption('');
  recording = false;
  const sfx = (await page.evaluate(() => window.__sfxLog)).map((e) => ({ name: e.name, arg: e.arg, frame: Math.round((e.t - startTime) / STEP) })).filter((e) => e.frame >= 0 && e.frame < frameNo);
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ scene: SCENE, fps: FPS, frames: frameNo, captions, sfx, errors }, null, 1));
  console.log(JSON.stringify({ scene: SCENE, frames: frameNo, seconds: +(frameNo / FPS).toFixed(1), captions: captions.length, sfx: sfx.length, errors }));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
