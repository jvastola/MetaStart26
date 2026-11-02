// Five 1080p app screenshots for the submission, from the IWER emulator with
// simulated hands and the emulator's own tools hidden.
//   node tools/video/screenshots.cjs      (dev server on :8081) -> pro/shots/*.jpg
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'pro', 'shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const { wristRotationFromDirections } = await import(path.join(__dirname, '../../node_modules/iwer/lib/device/XRHandInput.js'));
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const wrist = (side, fingers, palm) => Array.from(wristRotationFromDirections({ fingers: norm(fingers), palm: norm(palm) }, side));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
  await page.addInitScript(() => localStorage.setItem('lab-intro-done-v1', 'true'));
  await page.goto('https://localhost:8081/?skeleton=1');
  await page.waitForFunction(() => window.lab != null && window.IWER_DEVICE != null, null, { timeout: 120000 });
  const lab = (fn, ...a) => page.evaluate(([fn, a]) => window.lab[fn](...a), [fn, a]);
  const act = (...a) => page.evaluate((a) => window.lab.act(...a), a);
  const remote = (m, p) => page.evaluate(([m, p]) => window.IWER_DEVICE.remote.dispatch(m, p), [m, p]);
  const wait = (ms) => page.waitForTimeout(ms);
  await page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'hand'; });
  await page.getByText('Enter mixed reality').click();
  await remote('set_transform', { device: 'headset', position: { x: -0.95, y: 1.17, z: 0.7 } });
  await remote('look_at', { device: 'headset', target: { x: -0.95, y: 0.8, z: 1.28 } });
  await page.waitForFunction(() => window.lab.setup() === 'ready', null, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => {
    // Hide the emulator's tools (panels, hand gizmos, remote-control badge) and the page buttons.
    window.IWER_DEVICE.devui?.inputLayer?.setProgrammaticMode(true);
    const deep = (root, out = []) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deep(el.shadowRoot, out); } return out; };
    for (const el of deep(document)) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && ['3', '5', '10', '11', '899'].includes(cs.zIndex)) el.style.display = 'none';
    }
  });
  await remote('set_transform', { device: 'headset', position: { x: -0.95, y: 1.12, z: 0.86 } });
  const desk = (x, y, z) => lab('deskToWorld', x, y, z);
  const d0 = await desk(0, 0, 0), dz = await desk(0, 0, -1);
  const fwd = norm([dz.x - d0.x, 0, dz.z - d0.z]);
  const reach = (side) => wrist(side, [fwd[0], -0.35, fwd[2]], [0, -1, 0]);
  const framePose = (side) => wrist(side, [fwd[0] * 0.6, 0.75, fwd[2] * 0.6], [side === 'left' ? fwd[2] : -fwd[2], 0, side === 'left' ? -fwd[0] : fwd[0]]);
  const pin = (side, p, q, anchor = 'index-tip') => page.evaluate(([s, p, q, a]) => window.IWER_DEVICE.hands[s].setPin({ anchor: a, target: [p.x, p.y, p.z], wristRotation: q }), [side, p, q, anchor]);
  const pinchV = (side, v) => page.evaluate(([s, v]) => window.IWER_DEVICE.hands[s].setPinchValueImmediate(v), [side, v]);
  const grabOn = (side, on) => page.evaluate(([s, on]) => { window.IWER_DEVICE.hands[s].poseId = on ? 'pinch-middle' : 'default'; }, [side, on]);
  const look = (p) => remote('look_at', { device: 'headset', target: p });
  const open = async (id) => {
    await lab('go', id);
    await wait(800);
    if (await lab('coach')) await lab('pressCoach');
    await wait(300);
  };
  const shot = async (name) => {
    await wait(2500);
    await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 93, timeout: 180000 });
    console.log('shot', name);
  };
  const carry = async (from, to) => {
    await pin('right', { x: from.x, y: from.y + 0.04, z: from.z }, reach('right'), 'middle-finger-tip'); await wait(500);
    await pin('right', from, reach('right'), 'middle-finger-tip'); await wait(500);
    await grabOn('right', true); await wait(500);
    await pin('right', { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + 0.05, z: (from.z + to.z) / 2 }, reach('right'), 'middle-finger-tip'); await wait(500);
    await pin('right', to, reach('right'), 'middle-finger-tip'); await wait(600);
    await grabOn('right', false); await wait(500);
  };
  const restHands = async () => {
    await pin('right', await desk(0.26, 0.06, 0.2), reach('right'));
    await pin('left', await desk(-0.26, 0.06, 0.2), reach('left'));
    await wait(400);
  };

  // 1. Desk Focus: the board at the back, a card on the way to the pad.
  await open('focus');
  await restHands();
  let s = await lab('state');
  await carry(await act('cardWorld', s.zones.today[0]), await act('padWorld'));
  s = await lab('state');
  const card = await act('cardWorld', s.zones.inbox[0]);
  await pin('right', { x: card.x + 0.01, y: card.y, z: card.z + 0.02 }, reach('right'), 'middle-finger-tip');
  await look(await desk(0, 0.09, -0.05));
  await shot('1-desk-focus');

  // 2. Blocks: the starter cottage and a hand laying blocks.
  await open('blocks');
  await restHands();
  const a = await act('cellWorld', 2, 0, 12), b = await act('cellWorld', 7, 0, 12);
  await pin('right', a, reach('right')); await wait(500);
  await pinchV('right', 1); await wait(400);
  await pin('right', b, reach('right')); await wait(900);
  await look(await desk(0, 0.06, -0.02));
  await shot('2-blocks');
  await pinchV('right', 0); await wait(300);

  // 3. Clay: a pulled sculpt and a printed copy.
  await open('clay');
  await restHands();
  for (const [x, z] of [[0, 0.03], [0.03, 0], [-0.025, -0.01]]) {
    const surf = await act('clayWorld', x, 0.055, z);
    await pin('right', { x: surf.x, y: surf.y + 0.003, z: surf.z }, reach('right')); await wait(400);
    await pinchV('right', 1); await wait(300);
    await pin('right', { x: surf.x, y: surf.y + 0.045, z: surf.z }, reach('right')); await wait(500);
    await pinchV('right', 0); await wait(300);
  }
  await act('press', 'print');
  await page.waitForFunction(() => (window.lab.state().prints ?? []).some((p) => p.progress >= 1), null, { timeout: 60000 }).catch(() => {});
  const surf = await act('clayWorld', 0.04, 0.05, 0.02);
  await pin('right', { x: surf.x + 0.01, y: surf.y, z: surf.z + 0.01 }, reach('right'));
  await look(await desk(-0.06, 0.07, 0));
  await shot('3-clay');

  // 4. Conjure: a creation on the pedestal, held up for a look.
  await open('conjure');
  await restHands();
  await act('say', 'a small red castle');
  await wait(1500);
  await act('say', 'a blue rocket');
  await wait(1500);
  const item = await act('itemWorld', 0);
  await pin('right', { x: item.x + 0.05, y: item.y, z: item.z + 0.05 }, reach('right'));
  await look(await desk(0, 0.09, -0.04));
  await shot('4-conjure');

  // 5. Shot Board: a dressed stage and the two-hand camera frame.
  await open('shotboard');
  await restHands();
  await carry(await act('shelfWorld', 0), await act('stageWorld', -0.06, 0.04));
  await carry(await act('shelfWorld', 1), await act('stageWorld', 0.04, 0.05));
  await carry(await act('shelfWorld', 5), await act('stageWorld', 0.11, -0.06));
  await act('press', 'light');
  const c = await desk(0, 0.2, 0.1);
  const off = (x, y) => ({ x: c.x + fwd[2] * x, y: c.y + y, z: c.z - fwd[0] * x });
  await pin('left', off(0.04, -0.01), framePose('left'));
  await pin('right', off(-0.04, 0.01), framePose('right'));
  await wait(500);
  await pinchV('left', 1); await pinchV('right', 1); await wait(500);
  await pin('left', off(0.12, -0.045), framePose('left'));
  await pin('right', off(-0.12, 0.045), framePose('right'));
  await look(await desk(0, 0.12, -0.04));
  await shot('5-shot-board');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
