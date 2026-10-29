/**
 * Desk Links: fingertip mini golf on your real desk (the Gaming-track
 * reference prototype, kept for comparing hand mechanics).
 *
 *   Aiming   - pinch near the ball, pull back like a slingshot, release.
 *              A quick fingertip flick into the ball also putts.
 *   Rolling  - the ball simulates (ball-sim.ts) until it stops or drops.
 *   Sunk     - short celebration, then the next hole.
 *   Finished - round summary, best score and daily streak.
 */

import { Group, Vector3 } from '@iwsdk/core';
import type { LabContext, Prototype } from '../../core/context.js';
import { ACCENTS } from '../../core/art.js';
import type { HandState } from '../../core/hands.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import { BallSim, MAX_SHOT_SPEED } from './ball-sim.js';
import { BoardView, PREVIEW_DOTS } from './board-view.js';
import { BALL_RADIUS, BOARD_DEPTH, dailySeed, generateRound, type HoleLayout, HOLES_PER_ROUND } from './course.js';
import { bestFor, recordRound, type RoundResult } from './progress.js';

type Phase = 'aiming' | 'rolling' | 'sunk' | 'finished';

const GRAB_RADIUS = 0.055;
const FULL_PULL = 0.14;
const FLICK_SPEED = 0.28;
const FLICK_SCALE = 0.9;
const MAX_OVER_PAR = 4;

const SCORE_NAMES: Record<number, string> = {
  [-3]: 'Albatross!',
  [-2]: 'Eagle!',
  [-1]: 'Birdie!',
  0: 'Par.',
  1: 'Bogey.',
  2: 'Double bogey.',
};

const relativeToPar = (n: number): string => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);

export class GolfPrototype implements Prototype {
  readonly id = 'golf';
  readonly title = 'Desk Links';
  readonly tagline = 'Gaming: fingertip mini golf';
  readonly accent = ACCENTS.golf;
  readonly howTo = [
    'Pinch near the ball, pull back, let go to putt.',
    'Or flick the ball with a fingertip.',
    'Sink it in as few strokes as you can.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private view!: BoardView;
  private panel!: CanvasPanel;
  private sim = new BallSim();
  private previewSim = new BallSim();
  private previewPoints = new Float32Array(PREVIEW_DOTS * 2);
  private phase: Phase = 'aiming';
  private phaseTime = 0;
  private holes: HoleLayout[] = [];
  private holeIndex = 0;
  private strokes = 0;
  private card: number[] = [];
  private seed = dailySeed();
  private summary: RoundResult | null = null;
  private dragHand: HandState | null = null;
  private flickCooldown = 0;
  private sinkDepth = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.view = new BoardView();
    // Sit the board on top of the shared desk mat (its fringe hangs 8 mm below the green).
    this.view.root.position.y = 0.009;
    this.deskRoot.add(this.view.root);
    this.panel = new CanvasPanel({ width: 0.3, height: 0.13, columns: 2, buttonHeight: 0.03 });
    this.panel.mesh.position.set(0, 0.1, -BOARD_DEPTH / 2 - 0.06);
    this.panel.onPress = (id) => {
      if (id === 'retry') {
        if (this.phase === 'finished') this.startRound();
        else this.startHole(this.holeIndex);
      }
      if (id === 'home') this.ctx.goHome();
    };
    this.deskRoot.add(this.panel.mesh);
    this.startRound();
  }

  enter(): void {
    this.refreshPanel();
  }

  exit(): void {
    this.dragHand = null;
    this.view.hideAim();
  }

  private startRound(): void {
    this.seed = dailySeed();
    this.holes = generateRound(this.seed);
    this.card = [];
    this.summary = null;
    this.startHole(0);
  }

  private startHole(index: number): void {
    this.holeIndex = index;
    this.strokes = 0;
    const hole = this.holes[index];
    this.view.buildHole(hole);
    this.sim.setHole(hole);
    this.previewSim.setHole(hole);
    this.sinkDepth = 0;
    this.dragHand = null;
    this.view.hideAim();
    this.setPhase('aiming');
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
    this.refreshPanel();
  }

  private shoot(vx: number, vz: number, power: number): void {
    this.sim.shoot(vx, vz);
    this.strokes += 1;
    this.dragHand = null;
    this.view.hideAim();
    Sfx.putt(power, this.view.ball.getWorldPosition(this.tmp2));
    this.setPhase('rolling');
  }

  private holeDone(): void {
    this.card.push(this.strokes);
    if (this.holeIndex + 1 < this.holes.length) {
      this.startHole(this.holeIndex + 1);
    } else {
      this.summary = recordRound(this.seed, this.card.reduce((a, b) => a + b, 0));
      this.setPhase('finished');
    }
  }

  holding(): boolean {
    return this.dragHand != null;
  }

  update(dt: number): void {
    this.phaseTime += dt;
    this.flickCooldown = Math.max(0, this.flickCooldown - dt);
    this.panel.update(this.ctx.pointers, dt);
    switch (this.phase) {
      case 'aiming':
        this.updateAiming();
        break;
      case 'rolling':
        this.updateRolling(dt);
        break;
      case 'sunk':
        this.sinkDepth = Math.min(BALL_RADIUS * 2.2, this.sinkDepth + dt * 0.09);
        if (this.phaseTime > 1.6) this.holeDone();
        break;
      case 'finished':
        break;
    }
    const cup = this.holes[this.holeIndex].cup;
    const near = Math.hypot(cup.x - this.sim.x, cup.z - this.sim.z);
    this.view.setFlagLift(this.phase === 'sunk' ? 1 : near < 0.12 ? 1 - near / 0.12 : 0);
    this.view.setBall(this.sim.x, this.sim.z, this.sinkDepth);
  }

  private toBoard(world: Vector3, out: Vector3): Vector3 {
    out.copy(world);
    return this.view.toLocal(out);
  }

  private updateAiming(): void {
    const bx = this.sim.x;
    const bz = this.sim.z;
    let reach = 0;
    if (this.dragHand == null) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked) continue;
        const p = this.toBoard(hand.pinchPoint, this.tmp);
        const d = Math.hypot(p.x - bx, p.z - bz);
        const vertical = Math.abs(p.y) < 0.09;
        if (vertical) reach = Math.max(reach, 1 - Math.min(1, Math.max(0, (d - GRAB_RADIUS) / 0.08)));
        if (hand.pinchStarted && vertical && d < GRAB_RADIUS) {
          this.dragHand = hand;
          Sfx.pinch(hand.pinchPoint);
          break;
        }
        if (!hand.isMouse && this.tryFlick(hand)) return;
      }
    }
    const drag = this.dragHand;
    if (drag != null) {
      const p = this.toBoard(drag.pinchPoint, this.tmp);
      const pullX = bx - p.x;
      const pullZ = bz - p.z;
      const len = Math.hypot(pullX, pullZ);
      const power = Math.min(1, Math.max(0, (len - 0.012) / FULL_PULL));
      if (!drag.pinching) {
        if (power > 0.03 && len > 1e-4) {
          const speed = power * MAX_SHOT_SPEED;
          this.shoot((pullX / len) * speed, (pullZ / len) * speed, power);
        } else {
          this.dragHand = null;
          this.view.hideAim();
        }
        return;
      }
      if (len > 1e-4) {
        this.view.showAim(pullX / len, pullZ / len, power);
        this.updatePreview((pullX / len) * power * MAX_SHOT_SPEED, (pullZ / len) * power * MAX_SHOT_SPEED);
      }
    }
    this.view.setReach(reach, drag != null);
  }

  /** A fast fingertip moving into the ball putts it directly. */
  private tryFlick(hand: HandState): boolean {
    if (this.flickCooldown > 0) return false;
    const tip = this.toBoard(hand.indexTip, this.tmp2);
    if (tip.y > 0.035 || tip.y < -0.02) return false;
    const dx = this.sim.x - tip.x;
    const dz = this.sim.z - tip.z;
    if (Math.hypot(dx, dz) > BALL_RADIUS + 0.012) return false;
    // Fingertip velocity in board space.
    const ahead = this.toBoard(this.tmp.copy(hand.indexTip).add(hand.indexVelocity), this.tmp);
    const vx = ahead.x - tip.x;
    const vz = ahead.z - tip.z;
    const speed = Math.hypot(vx, vz);
    if (speed < FLICK_SPEED || vx * dx + vz * dz <= 0) return false;
    this.flickCooldown = 0.6;
    this.shoot(vx * FLICK_SCALE, vz * FLICK_SCALE, Math.min(1, speed / MAX_SHOT_SPEED));
    return true;
  }

  private updatePreview(vx: number, vz: number): void {
    const sim = this.previewSim;
    sim.copyFrom(this.sim);
    sim.shoot(vx, vz);
    let count = 0;
    let travelled = 0;
    let lastX = sim.x;
    let lastZ = sim.z;
    for (let i = 0; i < 90 && count < PREVIEW_DOTS; i += 1) {
      const r = sim.step(1 / 90);
      travelled += Math.hypot(sim.x - lastX, sim.z - lastZ);
      lastX = sim.x;
      lastZ = sim.z;
      if (travelled > 0.025) {
        travelled = 0;
        this.previewPoints[count * 2] = sim.x;
        this.previewPoints[count * 2 + 1] = sim.z;
        count += 1;
      }
      if (r.sunk || !sim.moving) break;
    }
    this.view.setPreview(this.previewPoints, count);
  }

  private updateRolling(dt: number): void {
    const result = this.sim.step(dt);
    if (result.impact > 0.06) Sfx.wall(result.impact, this.view.ball.getWorldPosition(this.tmp2));
    if (result.sunk) {
      Sfx.sink(this.view.ball.getWorldPosition(this.tmp2));
      this.setPhase('sunk');
      return;
    }
    if (!this.sim.moving) {
      if (this.strokes >= this.holes[this.holeIndex].par + MAX_OVER_PAR) {
        this.setPhase('sunk');
        this.phaseTime = 0.8;
        return;
      }
      this.setPhase('aiming');
    }
  }

  private refreshPanel(): void {
    if (!this.panel || this.holes.length === 0) return;
    const hole = this.holes[this.holeIndex];
    const parSoFar = this.holes.slice(0, this.card.length).reduce((a, h) => a + h.par, 0);
    const strokesSoFar = this.card.reduce((a, b) => a + b, 0);
    const best = bestFor(this.seed);
    this.panel.setText(
      `Daily course ${this.seed}${best != null ? ` - best ${best}` : ''}`,
      `Hole ${hole.index + 1} of ${HOLES_PER_ROUND}   Par ${hole.par}   Strokes ${this.strokes}   Total ${relativeToPar(strokesSoFar - parSoFar)}`,
      this.message(hole),
    );
    this.panel.setButtons([
      { id: 'retry', label: this.phase === 'finished' ? 'Play again' : 'Retry hole' },
      { id: 'home', label: 'Lab menu' },
    ]);
  }

  private message(hole: HoleLayout): string {
    switch (this.phase) {
      case 'aiming':
        return this.ctx.immersive
          ? 'Pinch near the ball, pull back and let go. Or flick it with a fingertip.'
          : 'Drag back from the ball and release to putt.';
      case 'rolling':
        return '...';
      case 'sunk':
        if (!this.sim.sunk) return `Picked up after ${this.strokes}. Next hole!`;
        if (this.strokes === 1) return 'HOLE IN ONE!';
        return SCORE_NAMES[this.strokes - hole.par] ?? `${this.strokes} strokes.`;
      case 'finished': {
        const total = this.card.reduce((a, b) => a + b, 0);
        const par = this.holes.reduce((a, h) => a + h.par, 0);
        const s = this.summary;
        const best = s ? (s.isNewBest ? 'New best today!' : `Best today ${s.best}.`) : '';
        const streak = s && s.streak > 1 ? ` ${s.streak}-day streak.` : '';
        return `Round done: ${total} (${relativeToPar(total - par)}). ${best}${streak}`;
      }
    }
  }

  debugState(): unknown {
    return {
      phase: this.phase,
      hole: this.holeIndex,
      strokes: this.strokes,
      card: [...this.card],
      ball: { x: this.sim.x, z: this.sim.z, moving: this.sim.moving, sunk: this.sim.sunk },
      cup: this.holes[this.holeIndex].cup,
    };
  }

  debugActions = {
    putt: (dx: number, dz: number, power: number) => {
      if (this.phase !== 'aiming') return false;
      const len = Math.hypot(dx, dz) || 1;
      const speed = Math.min(1, Math.max(0, power)) * MAX_SHOT_SPEED;
      this.shoot((dx / len) * speed, (dz / len) * speed, power);
      return true;
    },
    sink: () => {
      const cup = this.holes[this.holeIndex].cup;
      this.sim.place(cup.x, cup.z + 0.03);
      this.sim.shoot(0, -0.2);
      this.strokes += 1;
      this.setPhase('rolling');
    },
  };
}
