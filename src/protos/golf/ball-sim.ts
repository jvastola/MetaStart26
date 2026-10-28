/**
 * Tabletop putting physics on the board plane.
 *
 * A putt on a flat table is a 2D problem, so this is a small hand-written
 * simulation rather than a full rigid-body engine: rolling friction, bounces
 * off rotated wall blocks and round posts, and a cup that captures slow
 * balls. It is deterministic and allocation-free per step, which keeps it
 * cheap on Quest and lets the aim preview run the exact same maths.
 */

import {
  BALL_RADIUS,
  BOARD_DEPTH,
  BOARD_WIDTH,
  CUP_RADIUS,
  type HoleLayout,
} from './course.js';

/** Constant rolling deceleration from the felt, m/s². */
export const ROLL_DECEL = 0.32;
/** Speed-proportional drag, 1/s. */
export const LINEAR_DRAG = 0.35;
export const WALL_RESTITUTION = 0.72;
export const STOP_SPEED = 0.01;
export const MAX_SHOT_SPEED = 1.6;
/** A ball slower than this over the cup drops in; faster ones lip out. */
export const SINK_SPEED = 0.55;

const HALF_W = BOARD_WIDTH / 2;
const HALF_D = BOARD_DEPTH / 2;

export interface StepResult {
  /** Strongest wall impact speed this step (0 when there was none). */
  impact: number;
  sunk: boolean;
}

export class BallSim {
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  sunk = false;
  private hole: HoleLayout | null = null;
  private readonly result: StepResult = { impact: 0, sunk: false };

  setHole(hole: HoleLayout): void {
    this.hole = hole;
    this.place(hole.tee.x, hole.tee.z);
  }

  place(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.vx = 0;
    this.vz = 0;
    this.sunk = false;
  }

  copyFrom(other: BallSim): void {
    this.hole = other.hole;
    this.x = other.x;
    this.z = other.z;
    this.vx = other.vx;
    this.vz = other.vz;
    this.sunk = other.sunk;
  }

  shoot(vx: number, vz: number): void {
    const speed = Math.hypot(vx, vz);
    const scale = speed > MAX_SHOT_SPEED ? MAX_SHOT_SPEED / speed : 1;
    this.vx = vx * scale;
    this.vz = vz * scale;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  get moving(): boolean {
    return !this.sunk && this.speed > STOP_SPEED;
  }

  step(dt: number): StepResult {
    const result = this.result;
    result.impact = 0;
    result.sunk = false;
    if (this.sunk || this.hole == null) return result;

    // Substep so the ball never moves more than half its radius at once.
    const travel = this.speed * dt;
    const substeps = Math.min(48, Math.max(1, Math.ceil(travel / (BALL_RADIUS * 0.5))));
    const h = dt / substeps;
    for (let i = 0; i < substeps; i += 1) {
      this.integrate(h);
      this.collide(result);
      if (this.checkCup(h)) {
        result.sunk = true;
        return result;
      }
    }
    if (this.speed <= STOP_SPEED) {
      this.vx = 0;
      this.vz = 0;
    }
    return result;
  }

  private integrate(h: number): void {
    const speed = this.speed;
    if (speed <= 1e-6) return;
    const decel = ROLL_DECEL * h + LINEAR_DRAG * speed * h;
    const next = Math.max(0, speed - decel);
    const k = next / speed;
    this.vx *= k;
    this.vz *= k;
    this.x += this.vx * h;
    this.z += this.vz * h;
  }

  private bounce(nx: number, nz: number, penetration: number, result: StepResult): void {
    this.x += nx * penetration;
    this.z += nz * penetration;
    const vn = this.vx * nx + this.vz * nz;
    if (vn < 0) {
      this.vx -= (1 + WALL_RESTITUTION) * vn * nx;
      this.vz -= (1 + WALL_RESTITUTION) * vn * nz;
      if (-vn > result.impact) result.impact = -vn;
    }
  }

  private collide(result: StepResult): void {
    const r = BALL_RADIUS;
    // Outer rails.
    if (this.x < -HALF_W + r) this.bounce(1, 0, -HALF_W + r - this.x, result);
    if (this.x > HALF_W - r) this.bounce(-1, 0, this.x - (HALF_W - r), result);
    if (this.z < -HALF_D + r) this.bounce(0, 1, -HALF_D + r - this.z, result);
    if (this.z > HALF_D - r) this.bounce(0, -1, this.z - (HALF_D - r), result);

    const hole = this.hole!;
    for (const b of hole.blocks) {
      // Into the block's local frame.
      const c = Math.cos(b.angle);
      const s = Math.sin(b.angle);
      const dx = this.x - b.cx;
      const dz = this.z - b.cz;
      const lx = dx * c + dz * s;
      const lz = -dx * s + dz * c;
      const qx = Math.min(b.hx, Math.max(-b.hx, lx));
      const qz = Math.min(b.hz, Math.max(-b.hz, lz));
      let ox = lx - qx;
      let oz = lz - qz;
      let dist = Math.hypot(ox, oz);
      let pen: number;
      if (dist > 1e-9) {
        if (dist >= r) continue;
        ox /= dist;
        oz /= dist;
        pen = r - dist;
      } else {
        // Centre is inside the block: push out along the shallowest axis.
        const px = b.hx - Math.abs(lx);
        const pz = b.hz - Math.abs(lz);
        if (px < pz) {
          ox = Math.sign(lx) || 1;
          oz = 0;
          pen = px + r;
        } else {
          ox = 0;
          oz = Math.sign(lz) || 1;
          pen = pz + r;
        }
        dist = 0;
      }
      // Back to board space.
      const nx = ox * c - oz * s;
      const nz = ox * s + oz * c;
      this.bounce(nx, nz, pen, result);
    }
    for (const p of hole.posts) {
      const dx = this.x - p.x;
      const dz = this.z - p.z;
      const dist = Math.hypot(dx, dz);
      const min = p.r + r;
      if (dist >= min || dist < 1e-9) continue;
      this.bounce(dx / dist, dz / dist, min - dist, result);
    }
  }

  private checkCup(h: number): boolean {
    const hole = this.hole!;
    const dx = hole.cup.x - this.x;
    const dz = hole.cup.z - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist > CUP_RADIUS) return false;
    if (this.speed < SINK_SPEED) {
      this.sunk = true;
      this.x = hole.cup.x;
      this.z = hole.cup.z;
      this.vx = 0;
      this.vz = 0;
      return true;
    }
    // Too fast: the lip tugs the ball toward the centre and bleeds speed.
    if (dist > 1e-6) {
      const pull = 2.5 * h;
      this.vx += (dx / dist) * pull;
      this.vz += (dz / dist) * pull;
    }
    this.vx *= 1 - 1.5 * h;
    this.vz *= 1 - 1.5 * h;
    return false;
  }
}
