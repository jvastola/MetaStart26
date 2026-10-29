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
  // CHROMIUM_PATH lets you use an already-installed Chromium instead of Playwright's download.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
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
    for (const el of document.body.children) if (getComputedStyle(el).zIndex === '10') el.style.display = 'none';
  });

  // Hands: pinned by the index fingertip, moved with eased glides.
  const pos = { left: null, right: null };
  const pin = (side, p, q) => {
    pos[side] = p;
    return page.evaluate(([side, p, q]) => window.IWER_DEVICE.hands[side].setPin({ anchor: 'index-tip', target: [p.x, p.y, p.z], ...(q ? { wristRotation: q } : {}) }), [side, p, q]);
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
  const rest = async () => {
    await Promise.all([glide('right', await desk(0.26, 0.05, 0.17), 600), glide('left', await desk(-0.26, 0.05, 0.17), 600)]);
  };
  const poke = async (id, side = 'right') => {
    const b = await lab('button', id);
    if (!b) { console.log('no button', id); return; }
    const n = { x: b.nx, y: b.ny, z: b.nz };
    await glide(side, add(b, n, 0.06), 650);
    await glide(side, add(b, n, -0.012), 350);
    await wait(250);
    await glide(side, add(b, n, 0.07), 350);
  };
  const lookAt = (target) => remote('look_at', { device: 'headset', target });
  const carry = async (side, from, to, lift = 0.05) => {
    await glide(side, { x: from.x, y: from.y + 0.05, z: from.z }, 650);
    await glide(side, from, 300);
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
    await glide(side, await rim(Math.PI), 600);
    await pinch(side, true);
    for (let i = 1; i <= 16; i++) { await pin(side, await rim(Math.PI - (i / 16) * Math.PI * 2 * turns)); await wait(70); }
    await pinch(side, false);
  };
  const openPalm = async () => {
    const view = await lab('view');
    const h = { x: view.head[0], y: view.head[1], z: view.head[2] };
    const f = { x: view.forward[0], y: 0, z: view.forward[2] };
    const fl = Math.hypot(f.x, f.z); f.x /= fl; f.z /= fl;
    const at = { x: h.x + f.x * 0.32 - f.z * 0.07, y: h.y - 0.14, z: h.z + f.z * 0.32 + f.x * 0.07 };
    const tries = [[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1]];
    for (const q of tries) {
      await glide('left', at, 500, q);
      await wait(400);
      if (await lab('wrist')) return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- 1. Setup
  await page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'hand'; });
  await page.getByText('Enter XR').first().click();
  await page.waitForFunction(() => window.lab.setup() === 'auto', null, { timeout: 20000 });
  await remote('set_transform', { device: 'headset', position: { x: -0.95, y: 1.15, z: 0.72 } });
  await lookAt({ x: -0.95, y: 0.8, z: 1.28 });
  await hideChrome();
  const trimStart = Date.now() - t0;
  await page.waitForFunction(() => window.lab.setup() === 'ready', null, { timeout: 20000 });
  caption('Hands Lab finds your real table and sets up on it');
  await pin('right', await desk(0.3, 0.08, 0.3));
  await pin('left', await desk(-0.3, 0.08, 0.3));
  await hideChrome();
  await rest();
  await wait(1800);

  // ---------------------------------------------------------------- 2. Tutorial
  caption('Tutorial 1/4: poke the button with a fingertip');
  const btn = await act('world', 'button');
  await glide('right', { x: btn.x, y: btn.y + 0.07, z: btn.z }, 700);
  await glide('right', { x: btn.x, y: btn.y - 0.012, z: btn.z }, 450);
  await wait(500);
  await glide('right', { x: btn.x, y: btn.y + 0.08, z: btn.z }, 400);
  await wait(700);
  caption('2/4: pinch the orb, carry it into the ring');
  await carry('right', await act('world', 'orb'), await act('world', 'ring'));
  await wait(700);
  caption('3/4: pinch the rim and twist');
  await twist('right', [0, 0.03, 0.03], 0.05);
  await wait(700);
  caption('4/4: turn your left palm toward you for the menu');
  await rest();
  const palm = await openPalm();
  await wait(1200);
  await glide('left', await desk(-0.26, 0.05, 0.17), 600);
  await wait(400);
  caption("Ready. These four moves work everywhere");
  await poke('finish');
  await rest();
  await wait(600);

  // ---------------------------------------------------------------- 3. Hub -> Desk Focus
  caption('Five prototypes in one lab');
  await wait(1500);
  await poke('focus');
  await wait(600);
  caption('Desk Focus: your day, pinned to your desk');
  await lookAt(await desk(0, 0.14, -0.12));
  await wait(1200);
  await poke('ok');
  const s = await lab('state');
  caption('Pinch a card and carry it to the focus pad');
  await carry('right', await act('cardWorld', s.zones.today[0]), await act('padWorld'), 0.08);
  await wait(500);
  caption('Pinch the dial and twist to start a focus session');
  await twist('right', [0.19, 0.025, 0.03], 0.042, 0.22);
  await wait(1600);
  caption('Finished? Drop it in the tray. Your streak plant grows');
  const fs2 = await lab('state');
  await carry('right', await act('cardWorld', fs2.zones.focus[0]), await act('trayWorld'), 0.06);
  await wait(1800);

  // ---------------------------------------------------------------- 4. Palm menu -> Conjure
  caption('Palm up, Home');
  await rest();
  if (await openPalm()) {
    await wait(500);
    await poke('home');
  } else {
    await lab('go', 'hub');
  }
  await glide('left', await desk(-0.26, 0.05, 0.17), 500);
  await lookAt({ x: -0.95, y: 0.8, z: 1.28 });
  await wait(500);
  await poke('conjure');
  await wait(500);
  await poke('ok');
  caption('Conjure: say what you want (voice simulated here)');
  // The emulator renders slowly, so give each result time to grow in on camera.
  await act('say', 'a red mushroom');
  await wait(6000);
  caption('"make it blue"');
  await act('say', 'make it blue');
  await wait(4000);
  caption('"bigger"');
  await act('say', 'bigger');
  await wait(4000);
  caption('"a tiny castle"');
  await act('say', 'a tiny castle');
  await wait(6000);
  caption('Pinch a creation and place it anywhere');
  await carry('right', await act('itemWorld', 1), await desk(0.12, 0.05, 0.12), 0.06);
  await wait(1200);

  // ---------------------------------------------------------------- 5. Shot Board
  await lab('go', 'shotboard');
  await lookAt(await desk(0, 0.12, -0.08));
  await wait(600);
  await poke('ok');
  caption('Shot Board: pose the scene with a pinch');
  const hero = await act('propWorld', 'Hero');
  await carry('right', hero, await desk(-0.02, 0.04, 0.02), 0.04);
  await wait(500);
  caption('Pinch with both hands and pull apart to frame a shot');
  const c = await desk(0, 0.2, 0.16);
  await Promise.all([glide('left', { x: c.x - 0.03, y: c.y - 0.01, z: c.z }, 600), glide('right', { x: c.x + 0.03, y: c.y + 0.01, z: c.z }, 600)]);
  await pinch('left', true); await pinch('right', true);
  const lv = await desk(-0.11, 0.16, 0.16); const rv = await desk(0.11, 0.25, 0.16);
  await Promise.all([glide('left', lv, 800), glide('right', rv, 800)]);
  await wait(500);
  await pinch('right', false); await pinch('left', false);
  await wait(900);
  caption('Each shot lands on your storyboard');
  await rest();
  await wait(800);
  await poke('play');
  await wait(2500);

  // ---------------------------------------------------------------- 6. Clay
  await lab('go', 'clay');
  await lookAt(await desk(0, 0.09, -0.02));
  await wait(600);
  await poke('ok');
  caption('Clay: press your fingertips in to sculpt');
  for (const [x, y, z] of [[0.0, 0.035, 0.045], [0.02, 0.0, 0.05], [-0.02, 0.0, 0.05]]) {
    const out = await act('clayWorld', x * 1.6, y * 1.6, z * 1.6);
    const inn = await act('clayWorld', x * 0.7, y * 0.7, z * 0.7);
    await glide('right', out, 450);
    await glide('right', inn, 450);
    await glide('right', out, 300);
  }
  caption('Pinch and pull. Mirror mode keeps it symmetric');
  const surf = await act('clayWorld', 0.03, 0.044, 0.0);
  const pulled = await act('clayWorld', 0.055, 0.085, 0.0);
  await glide('right', { x: surf.x, y: surf.y + 0.03, z: surf.z }, 500);
  await glide('right', surf, 300);
  await pinch('right', true);
  await glide('right', pulled, 900);
  await pinch('right', false);
  await rest();
  await wait(2000);
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
