import { describe, expect, it } from 'vitest';
import { BallSim, MAX_SHOT_SPEED, SINK_SPEED } from '../src/game/ball-sim';
import { BALL_RADIUS, BOARD_DEPTH, BOARD_WIDTH, type HoleLayout } from '../src/game/course';

const open = (extra: Partial<HoleLayout> = {}): HoleLayout => ({
  index: 0,
  tee: { x: 0, z: 0.15 },
  cup: { x: 0, z: -0.14 },
  blocks: [],
  posts: [],
  par: 2,
  ...extra,
});

function run(sim: BallSim, seconds: number, dt = 1 / 72): { sunk: boolean; impacts: number } {
  let impacts = 0;
  for (let t = 0; t < seconds; t += dt) {
    const r = sim.step(dt);
    if (r.impact > 0) impacts += 1;
    if (r.sunk) return { sunk: true, impacts };
    if (!sim.moving) break;
  }
  return { sunk: false, impacts };
}

describe('BallSim', () => {
  it('comes to rest under friction', () => {
    const sim = new BallSim();
    sim.setHole(open({ cup: { x: 0.25, z: -0.15 } }));
    sim.shoot(0, -0.3);
    run(sim, 10);
    expect(sim.moving).toBe(false);
    expect(sim.z).toBeLessThan(0.15);
  });

  it('sinks a gentle straight putt', () => {
    const sim = new BallSim();
    sim.setHole(open());
    sim.shoot(0, -0.5);
    expect(run(sim, 5).sunk).toBe(true);
    expect(sim.sunk).toBe(true);
  });

  it('lets a very fast ball skip over the cup', () => {
    const sim = new BallSim();
    sim.setHole(open());
    sim.shoot(0, -MAX_SHOT_SPEED);
    // Check the first moment it crosses the cup: still too fast to drop.
    let crossedFast = false;
    for (let i = 0; i < 40; i += 1) {
      sim.step(1 / 72);
      if (Math.abs(sim.z + 0.14) < 0.02 && sim.speed > SINK_SPEED) crossedFast = true;
    }
    expect(crossedFast).toBe(true);
  });

  it('never leaves the board, even at max speed', () => {
    const sim = new BallSim();
    sim.setHole(open({ cup: { x: 10, z: 10 } }));
    for (let a = 0; a < 16; a += 1) {
      sim.place(0, 0);
      const angle = (a / 16) * Math.PI * 2;
      sim.shoot(Math.cos(angle) * 5, Math.sin(angle) * 5);
      for (let i = 0; i < 400; i += 1) {
        sim.step(1 / 72);
        expect(Math.abs(sim.x)).toBeLessThanOrEqual(BOARD_WIDTH / 2 - BALL_RADIUS + 1e-6);
        expect(Math.abs(sim.z)).toBeLessThanOrEqual(BOARD_DEPTH / 2 - BALL_RADIUS + 1e-6);
      }
    }
  });

  it('bounces off a wall block instead of passing through it', () => {
    const sim = new BallSim();
    sim.setHole(open({ blocks: [{ cx: 0, cz: 0, hx: 0.3, hz: 0.008, angle: 0 }] }));
    sim.shoot(0, -MAX_SHOT_SPEED);
    const { impacts } = run(sim, 6);
    expect(impacts).toBeGreaterThan(0);
    expect(sim.z).toBeGreaterThan(0);
  });

  it('bounces off a rotated block along its normal', () => {
    const sim = new BallSim();
    // A 45-degree bank: a ball rolling toward -z should be deflected sideways.
    sim.setHole(open({ cup: { x: 10, z: 10 }, blocks: [{ cx: 0, cz: 0, hx: 0.08, hz: 0.008, angle: Math.PI / 4 }] }));
    sim.place(0, 0.08);
    sim.shoot(0, -0.6);
    for (let i = 0; i < 30; i += 1) sim.step(1 / 72);
    expect(Math.abs(sim.vx)).toBeGreaterThan(0.1);
  });

  it('bounces off posts', () => {
    const sim = new BallSim();
    sim.setHole(open({ posts: [{ x: 0, z: 0, r: 0.02 }] }));
    sim.shoot(0, -0.8);
    const { impacts } = run(sim, 6);
    expect(impacts).toBeGreaterThan(0);
  });

  it('caps shot speed', () => {
    const sim = new BallSim();
    sim.setHole(open());
    sim.shoot(30, 40);
    expect(sim.speed).toBeCloseTo(MAX_SHOT_SPEED, 5);
  });
});
