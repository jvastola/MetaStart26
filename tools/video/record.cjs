// Records a walkthrough of Hands Lab in the IWER emulator with emulated hands.
// Writes out/raw.webm (video) and out/timeline.json (captions, sound events, trim point).
// Needs the dev server running (npm run dev) and Playwright with Chromium.
// PLAYWRIGHT_MODULE picks a specific Playwright install (e.g. a global one whose
// browsers are already downloaded); otherwise the project's copy is used.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  // IWER's own helper turns "fingers point here, palm faces there" into a wrist rotation,
  // so the emulated hands look like real hands reaching toward the desk.
  const { wristRotationFromDirections } = await import(path.join(__dirname, '../../node_modules/iwer/lib/device/XRHandInput.js'));
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const wrist = (side, fingers, palm) => Array.from(wristRotationFromDirections({ fingers: norm(fingers), palm: norm(palm) }, side));

  // CHROMIUM_PATH lets you use an already-installed Chromium instead of Playwright's download.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
  await context.addInitScript(() => { window.__sfxLog = []; });
  const t0 = Date.now();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // ?skeleton=1 draws procedural hands so they show up even without the stock hand models.
  await page.goto('https://localhost:8081/?skeleton=1');
  await page.waitForFunction(() => window.lab != null && window.IWER_DEVICE != null, null, { timeout: 90000 });

  const lab = (fn, ...a) => page.evaluate(([fn, a]) => window.lab[fn](...a), [fn, a]);
  const act = (...a) => page.evaluate((a) => window.lab.act(...a), a);
  const remote = (m, p) => page.evaluate(([m, p]) => window.IWER_DEVICE.remote.dispatch(m, p), [m, p]);
  const wait = (ms) => page.waitForTimeout(ms);
  const captions = [];
  const caption = (text) => {
    const t = Date.now() - t0;
    if (captions.length) captions[captions.length - 1].end = t;
    if (text) captions.push({ text, start: t, end: null });
  };
  const hideChrome = () => page.evaluate(() => {
    const overlay = document.body.lastElementChild;
    for (const el of overlay.children) { const z = getComputedStyle(el).zIndex; if (z === '5' || z === '3') el.style.display = 'none'; }
    for (const el of document.body.children) if (['10', '11'].includes(getComputedStyle(el).zIndex)) el.style.display = 'none';
  });

  // ---------------------------------------------------------------- hand helpers
  let fwd = [0, 0, 1];
  const rest = { left: null, right: null };
  const pose = (side, kind) => {
    const [fx, , fz] = fwd;
    if (kind === 'poke') return wrist(side, [fx * 0.55, -0.85, fz * 0.55], [fx * 0.2, -0.3, fz * 0.2 - 0.0001]);
    if (kind === 'frame') return wrist(side, [fx * 0.6, 0.75, fz * 0.6], [side === 'left' ? fz : -fz, 0, side === 'left' ? -fx : fx]);
    return wrist(side, [fx, -0.35, fz], [0, -1, 0]); // reach: fingers toward the desk, palm down
  };
  const pos = { left: null, right: null };
  const quat = { left: null, right: null };
  const pin = (side, p, q) => {
    pos[side] = p;
    if (q) quat[side] = q;
    return page.evaluate(([side, p, q]) => window.IWER_DEVICE.hands[side].setPin({ anchor: 'index-tip', target: [p.x, p.y, p.z], ...(q ? { wristRotation: q } : {}) }), [side, p, quat[side]]);
  };
  const glide = async (side, to, ms = 700, q) => {
    const from = pos[side] ?? to;
    const steps = Math.max(2, Math.round(ms / 45));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await pin(side, { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e }, q);
      await wait(30);
    }
  };
  const pinch = async (side, on) => {
    await page.evaluate(([side, v]) => window.IWER_DEVICE.hands[side].setPinchValueImmediate(v), [side, on ? 1 : 0]);
    await page.waitForFunction(([i, on]) => window.lab.hands()[i].pinching === on, [side === 'left' ? 0 : 1, on], { timeout: 10000 }).catch(() => {});
    await wait(120);
  };
  const desk = (x, y, z) => lab('deskToWorld', x, y, z);
  const add = (p, n, d) => ({ x: p.x + n.x * d, y: p.y + n.y * d, z: p.z + n.z * d });
  const toRest = async () => {
    await Promise.all([glide('right', rest.right, 550, pose('right', 'reach')), glide('left', rest.left, 550, pose('left', 'reach'))]);
  };
  const pokeAt = async (b, side = 'right') => {
    const n = { x: b.nx, y: b.ny, z: b.nz };
    const q = pose(side, 'poke');
    await glide(side, add(b, n, 0.06), 600, q);
    await glide(side, add(b, n, -0.012), 350, q);
    await wait(250);
    await glide(side, add(b, n, 0.07), 350, q);
  };
  const poke = async (id, side = 'right') => {
    const b = await lab('button', id);
    if (b) await pokeAt(b, side);
    else console.log('no button', id);
  };
  const carry = async (side, from, to, lift = 0.05) => {
    const q = pose(side, 'reach');
    await glide(side, { x: from.x, y: from.y + 0.05, z: from.z }, 600, q);
    await glide(side, from, 300, q);
    await pinch(side, true);
    const mid = { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + lift, z: (from.z + to.z) / 2 };
    await glide(side, mid, 450);
    await glide(side, to, 450);
    await wait(150);
    await pinch(side, false);
    await glide(side, { x: to.x, y: to.y + 0.06, z: to.z }, 300);
  };
  const twist = async (side, centerLocal, radius, turns = 0.28) => {
    const rim = (a) => desk(centerLocal[0] + Math.sin(a) * radius, centerLocal[1], centerLocal[2] + Math.cos(a) * radius);
    await glide(side, await rim(Math.PI), 600, pose(side, 'reach'));
    await pinch(side, true);
    for (let i = 1; i <= 16; i++) { await pin(side, await rim(Math.PI - (i / 16) * Math.PI * 2 * turns)); await wait(70); }
    await pinch(side, false);
  };
  const openPalm = async () => {
    const view = await lab('view');
    const h = { x: view.head[0], y: view.head[1], z: view.head[2] };
    const f = { x: view.forward[0], z: view.forward[2] };
    const fl = Math.hypot(f.x, f.z); f.x /= fl; f.z /= fl;
    const at = { x: h.x + f.x * 0.3 + f.z * 0.08, y: h.y - 0.16, z: h.z + f.z * 0.3 - f.x * 0.08 };
    // Fingers up, palm toward the face.
    const tries = [wrist('left', [0, 1, 0], [-f.x, 0, -f.z]), wrist('left', [f.x * 0.3, 0.9, f.z * 0.3], [-f.x, 0.2, -f.z]), [1, 0, 0, 0], [0, 0, 1, 0]];
    for (const q of tries) {
      await glide('left', at, 500, q);
      await wait(400);
      if (await lab('wrist')) return true;
    }
    return false;
  };
  const closePalm = () => glide('left', rest.left, 500, pose('left', 'reach'));
  const lookAt = (target) => remote('look_at', { device: 'headset', target });
  const dismissCoach = async () => { if (await lab('coach')) { await poke('ok'); } };

  // ---------------------------------------------------------------- 1. Setup
  await page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'hand'; });
  await page.getByText('Enter mixed reality').click();
  await page.waitForFunction(() => ['auto', 'manual'].includes(window.lab.setup()), null, { timeout: 20000 });
  await remote('set_transform', { device: 'headset', position: { x: -0.95, y: 1.15, z: 0.72 } });
  await lookAt({ x: -0.95, y: 0.8, z: 1.28 });
  await hideChrome();
  const trimStart = Date.now() - t0;
  await page.waitForFunction(() => window.lab.setup() === 'ready', null, { timeout: 30000 });
  const d0 = await desk(0, 0, 0);
  const dz = await desk(0, 0, -1);
  fwd = norm([dz.x - d0.x, 0, dz.z - d0.z]);
  rest.right = await desk(0.22, 0.05, 0.15);
  rest.left = await desk(-0.22, 0.05, 0.15);
  caption('Hands Lab finds your real table and sets up on it');
  await pin('right', await desk(0.3, 0.1, 0.32), pose('right', 'reach'));
  await pin('left', await desk(-0.3, 0.1, 0.32), pose('left', 'reach'));
  await hideChrome();
  await toRest();
  await wait(1500);
  if (process.env.PREVIEW) {
    // Quick pose check: one frame with the hands at rest and one mid-poke.
    await page.screenshot({ path: path.join(OUT, 'preview-rest.png') });
    const b = await act('world', 'button');
    const q = pose('right', 'poke');
    await glide('right', { x: b.x, y: b.y + 0.05, z: b.z }, 500, q);
    await page.screenshot({ path: path.join(OUT, 'preview-poke.png') });
    await browser.close();
    return;
  }

  // ---------------------------------------------------------------- 2. Tutorial
  caption('Tutorial 1/4: poke the button with a fingertip');
  const btn = await act('world', 'button');
  await pokeAt({ ...btn, y: btn.y + 0.006, nx: 0, ny: 1, nz: 0 });
  await wait(600);
  caption('2/4: pinch the orb, carry it into the ring');
  await carry('right', await act('world', 'orb'), await act('world', 'ring'));
  await wait(600);
  caption('3/4: pinch the rim and twist');
  await twist('right', [0, 0.03, 0.03], 0.05);
  await wait(600);
  caption('4/4: turn your left palm toward you for the menu');
  await toRest();
  const palm = await openPalm();
  await wait(1000);
  await closePalm();
  caption("Ready. These moves work everywhere");
  await poke('finish');
  await toRest();
  await wait(500);

  // ---------------------------------------------------------------- 3. Home -> Desk Focus
  caption('Home: poke an app to open it');
  await lookAt(await desk(0, 0.14, -0.1));
  await wait(1200);
  const tile = await act('tileWorld', 'focus');
  await pokeAt(tile);
  await wait(600);
  caption('Desk Focus: your day, on your desk');
  await lookAt(await desk(0.02, 0.12, -0.02));
  await wait(900);
  await dismissCoach();
  await toRest();
  const s = await lab('state');
  caption('Pinch a card off the planner, carry it to the focus pad');
  await carry('right', await act('cardWorld', s.zones.today[0]), await act('padWorld'), 0.06);
  await wait(400);
  caption('Twist the dial to start a focus session');
  await twist('right', [0.2, 0.025, 0.065], 0.042, 0.22);
  await toRest();
  caption('The wall shows your timer and progress at a glance');
  await lookAt(await lab('deskToWorld', 0, 0.4, -0.36));
  await wait(2600);
  await lookAt(await desk(0.02, 0.12, -0.02));
  caption('Done? Drop it in the tray. Your streak plant grows');
  const fs2 = await lab('state');
  await carry('right', await act('cardWorld', fs2.zones.focus[0]), await act('trayWorld'), 0.06);
  await wait(1500);

  // ---------------------------------------------------------------- 4. Conjure
  caption('Palm up, Home');
  await toRest();
  if (await openPalm()) { await wait(400); await poke('home'); } else await lab('go', 'hub');
  await closePalm();
  await lookAt(await desk(0, 0.14, -0.1));
  await wait(500);
  await pokeAt(await act('tileWorld', 'conjure'));
  await lookAt(await desk(0, 0.1, -0.02));
  await wait(500);
  await dismissCoach();
  await toRest();
  caption('Conjure: say what you want (voice simulated here)');
  await act('say', 'a red mushroom');
  await wait(6000);
  caption('"make it blue"');
  await act('say', 'make it blue');
  await wait(4000);
  caption('Pick it up and turn your wrist to turn it');
  const item = await act('itemWorld', 0);
  await glide('right', item, 650, pose('right', 'reach'));
  await pinch('right', true);
  for (let i = 1; i <= 14; i++) {
    const a = (i / 14) * Math.PI * 0.9;
    const f = [Math.cos(a) * fwd[0] - Math.sin(a) * fwd[2], -0.35, Math.sin(a) * fwd[0] + Math.cos(a) * fwd[2]];
    await pin('right', { x: item.x, y: item.y + 0.04 * Math.sin((i / 14) * Math.PI), z: item.z }, wrist('right', f, [0, -1, 0]));
    await wait(110);
  }
  await pinch('right', false);
  await toRest();
  await wait(800);

  // ---------------------------------------------------------------- 5. Frame anywhere
  caption('Frame a shot with both hands, anywhere in the lab');
  const c = await desk(0, 0.2, 0.12);
  const off = (x, y) => ({ x: c.x + fwd[2] * x, y: c.y + y, z: c.z - fwd[0] * x });
  await Promise.all([glide('left', off(0.04, -0.01), 600, pose('left', 'frame')), glide('right', off(-0.04, 0.01), 600, pose('right', 'frame'))]);
  await pinch('left', true); await pinch('right', true);
  await Promise.all([glide('left', off(0.13, -0.05), 900), glide('right', off(-0.13, 0.05), 900)]);
  await wait(600);
  await pinch('right', false); await pinch('left', false);
  await wait(1800);
  await toRest();

  // ---------------------------------------------------------------- 6. Sketch
  await lab('go', 'sketch');
  await wait(400);
  await dismissCoach();
  await act('clear');
  caption('Sketch: pinch and draw in the air');
  const loop = async (side, cx, cy, r, turns) => {
    const start = await desk(cx + r, cy, 0.04);
    await glide(side, start, 500, pose(side, 'reach'));
    await pinch(side, true);
    for (let i = 1; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2 * turns;
      await pin(side, await desk(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8, 0.04 - i * 0.001));
      await wait(45);
    }
    await pinch(side, false);
  };
  await loop('right', 0.06, 0.16, 0.06, 1.1);
  caption('Draw with both hands at once');
  await act('press', 'c1');
  await Promise.all([loop('left', -0.12, 0.13, 0.04, 1), loop('right', 0.16, 0.12, 0.035, 1)]);
  await toRest();
  await wait(1500);

  // ---------------------------------------------------------------- 7. Shot Board
  await lab('go', 'shotboard');
  await lookAt(await desk(0, 0.2, -0.15));
  await wait(500);
  await dismissCoach();
  caption('Shot Board: your shots, as a storyboard');
  await wait(2200);
  await lookAt(await desk(0, 0.1, -0.02));
  caption('Pose the scene: turn your wrist to turn a figure');
  const hero = await act('propWorld', 'Hero');
  await glide('right', hero, 600, pose('right', 'reach'));
  await pinch('right', true);
  for (let i = 1; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 0.7;
    const f = [Math.cos(a) * fwd[0] - Math.sin(a) * fwd[2], -0.35, Math.sin(a) * fwd[0] + Math.cos(a) * fwd[2]];
    await pin('right', await desk(-0.06 + i * 0.006, 0.04, 0.04), wrist('right', f, [0, -1, 0]));
    await wait(100);
  }
  await pinch('right', false);
  await toRest();
  await wait(1200);
  caption('');
  const end = Date.now() - t0;

  const sfx = await page.evaluate(() => window.__sfxLog);
  await context.close();
  const video = await page.video().path();
  fs.renameSync(video, path.join(OUT, 'raw.webm'));
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ t0, trimStart, end, captions, sfx: sfx.map((e) => ({ ...e, t: e.t - t0 })), palm, errors }, null, 1));
  console.log(JSON.stringify({ trimStart, end, captions: captions.length, sfx: sfx.length, palm, errors }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
