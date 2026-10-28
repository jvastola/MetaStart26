/**
 * Desk Links: fingertip mini golf on your real table.
 *
 * One system owns the game loop:
 *   Placing  - a ghost course follows your hand; pinch to set it on the table.
 *   Aiming   - pinch near the ball, pull back like a slingshot, release to putt.
 *              A quick fingertip flick into the ball also putts.
 *   Rolling  - the ball simulates (src/game/ball-sim.ts) until it stops or drops.
 *   Sunk     - short celebration, then the next hole.
 *   Finished - round summary, best score and daily streak.
 *
 * Outside XR (desktop browser or the emulator's 2D view) the mouse stands in
 * for a pinching hand, so the whole loop is testable without a headset.
 */

import {
  createSystem,
  type Entity,
  type UIKit,
  type UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { BallSim, MAX_SHOT_SPEED } from './game/ball-sim.js';
import { BoardView, PREVIEW_DOTS } from './game/board-view.js';
import {
  BALL_RADIUS,
  BOARD_DEPTH,
  dailySeed,
  generateRound,
  type HoleLayout,
  HOLES_PER_ROUND,
} from './game/course.js';
import { Hands, HandState } from './game/hands.js';
import { bestFor, recordRound } from './game/progress.js';
import { Sfx } from './game/sfx.js';

export enum Phase {
  Placing = 'placing',
  Aiming = 'aiming',
  Rolling = 'rolling',
  Sunk = 'sunk',
  Finished = 'finished',
}

/** Pinch within this horizontal distance of the ball to pick up the shot. */
const GRAB_RADIUS = 0.055;
/** Pull-back distance that gives full power. */
const FULL_PULL = 0.14;
/** Fingertip speed (m/s) that counts as a flick. */
const FLICK_SPEED = 0.28;
const FLICK_SCALE = 0.9;
/** Give up on a hole after par + this many strokes. */
const MAX_OVER_PAR = 4;
/** Where the course sits when there is no headset (browser preview). */
const DESKTOP_BOARD = new Vector3(0, 0.75, -0.5);

const SCORE_NAMES: Record<number, string> = {
  [-3]: 'Albatross!',
  [-2]: 'Eagle!',
  [-1]: 'Birdie!',
  0: 'Par.',
  1: 'Bogey.',
  2: 'Double bogey.',
};

function relativeToPar(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

export class GolfSystem extends createSystem({}) {
  phase: Phase = Phase.Aiming;
  holes: HoleLayout[] = [];
  holeIndex = 0;
  strokes = 0;
  /** Strokes per finished hole. */
  card: number[] = [];
  seed = dailySeed();

  private hands!: Hands;
  private mouse!: HandState;
  private view!: BoardView;
  private boardEntity!: Entity;
  private sim!: BallSim;
  private previewSim!: BallSim;
  private previewPoints!: Float32Array;
  private dragHand: HandState | null = null;
  private phaseTime = 0;
  private flickCooldown = 0;
  private sinkDepth = 0;
  private boardYaw = 0;
  private immersive = false;
  private pullX = 0;
  private pullZ = 0;

  // Scratch vectors, allocated once.
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly head = new Vector3();

  // Mouse stand-in for a hand (non-immersive only).
  private mouseDown = false;
  private mouseDownPending = false;
  private mouseUpPending = false;
  private readonly mouseNdc = new Vector3();

  // HUD
  private hud: UIKitMLAsset | undefined;
  private readonly hudText = new Map<string, string>();

  init(): void {
    this.hands = new Hands();
    this.mouse = new HandState('right');
    this.view = new BoardView();
    this.sim = new BallSim();
    this.previewSim = new BallSim();
    this.previewPoints = new Float32Array(PREVIEW_DOTS * 2);
    this.boardEntity = this.world.createTransformEntity(this.view.root);

    this.setupHud();
    this.setupMouse();

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const nowImmersive = state !== VisibilityState.NonImmersive;
        if (nowImmersive && !this.immersive) {
          this.immersive = true;
          Sfx.unlock();
          this.enterPlacing();
        } else if (!nowImmersive && this.immersive) {
          this.immersive = false;
          this.placeForDesktop();
        }
        this.hudButtonVisibility();
      }),
    );

    this.startRound();
    this.placeForDesktop();
    this.exposeDebugHooks();
  }

  // ---------------------------------------------------------------- round flow

  startRound(): void {
    this.seed = dailySeed();
    this.holes = generateRound(this.seed);
    this.card = [];
    this.startHole(0);
  }

  startHole(index: number): void {
    this.holeIndex = index;
    this.strokes = 0;
    const hole = this.holes[index];
    this.view.buildHole(hole);
    this.sim.setHole(hole);
    this.previewSim.setHole(hole);
    this.sinkDepth = 0;
    this.dragHand = null;
    this.view.hideAim();
    if (this.phase !== Phase.Placing) this.setPhase(Phase.Aiming);
    this.refreshHud();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
    this.view.setPlacing(phase === Phase.Placing);
    this.refreshHud();
  }

  private enterPlacing(): void {
    this.dragHand = null;
    this.view.hideAim();
    this.setPhase(Phase.Placing);
  }

  private placeForDesktop(): void {
    this.setBoardPose(DESKTOP_BOARD, 0);
    if (this.phase === Phase.Placing) this.setPhase(Phase.Aiming);
  }

  private setBoardPose(position: Vector3, yaw: number): void {
    this.boardYaw = yaw;
    this.view.root.position.copy(position);
    this.view.root.rotation.set(0, yaw, 0);
    this.view.root.updateMatrixWorld(true);
    const panel = this.hud;
    if (panel) {
      // Float the score panel just behind the far rail, facing the player.
      this.tmp.set(0, 0.11, -BOARD_DEPTH / 2 - 0.07);
      this.view.root.localToWorld(this.tmp);
      panel.position.copy(this.tmp);
      panel.rotation.set(0, yaw, 0);
    }
  }

  private shoot(localVx: number, localVz: number, power: number): void {
    this.sim.shoot(localVx, localVz);
    this.strokes += 1;
    this.dragHand = null;
    this.view.hideAim();
    Sfx.putt(power);
    this.setPhase(Phase.Rolling);
  }

  private holeDone(): void {
    this.card.push(this.strokes);
    if (this.holeIndex + 1 < this.holes.length) {
      this.startHole(this.holeIndex + 1);
    } else {
      const total = this.card.reduce((a, b) => a + b, 0);
      const result = recordRound(this.seed, total);
      this.roundSummary = result;
      this.setPhase(Phase.Finished);
    }
  }

  private roundSummary: { best: number; isNewBest: boolean; streak: number } | null =
    null;

  // ---------------------------------------------------------------- per frame

  update(delta: number): void {
    const dt = Math.min(delta, 0.05);
    if (this.world.visibilityState.peek() === VisibilityState.VisibleBlurred) {
      return; // System menu is open: pause.
    }
    this.phaseTime += dt;
    this.flickCooldown = Math.max(0, this.flickCooldown - dt);

    if (this.immersive) {
      this.player.updateMatrixWorld(true);
      this.hands.update(
        this.world.xrFrame,
        this.world.xrReferenceSpace,
        this.player.matrixWorld,
        dt,
      );
    }
    this.updateMouseHand();

    switch (this.phase) {
      case Phase.Placing:
        this.updatePlacing();
        break;
      case Phase.Aiming:
        this.updateAiming();
        break;
      case Phase.Rolling:
        this.updateRolling(dt);
        break;
      case Phase.Sunk:
        this.sinkDepth = Math.min(BALL_RADIUS * 2.2, this.sinkDepth + dt * 0.09);
        if (this.phaseTime > 1.6) this.holeDone();
        break;
      case Phase.Finished:
        break;
    }

    const cup = this.holes[this.holeIndex].cup;
    const near = Math.hypot(cup.x - this.sim.x, cup.z - this.sim.z);
    this.view.setFlagLift(this.phase === Phase.Sunk ? 1 : near < 0.12 ? 1 - near / 0.12 : 0);
    this.view.setBall(this.sim.x, this.sim.z, this.sinkDepth);
  }

  private inputHands(): readonly HandState[] {
    return this.immersive ? this.hands.both : this.mouseHands;
  }
  private mouseHands: HandState[] = [];

  private updatePlacing(): void {
    // Follow the hand that is pinching; otherwise prefer the right hand.
    const { left, right } = this.hands;
    let hand: HandState | null = null;
    if (left.tracked && (left.pinchStarted || (left.pinching && !right.pinching))) hand = left;
    else if (right.tracked) hand = right;
    else if (left.tracked) hand = left;
    if (hand == null) return;
    this.player.head.getWorldPosition(this.head);
    // Course centre under the pinch, a few cm below the fingers, turned to face you.
    this.tmp.copy(hand.pinchPoint);
    this.tmp.y -= 0.03;
    const yaw = Math.atan2(this.head.x - this.tmp.x, this.head.z - this.tmp.z);
    // Push the centre away from you so the near rail sits at your hand.
    this.tmp.x -= Math.sin(yaw) * (BOARD_DEPTH / 2 - 0.04);
    this.tmp.z -= Math.cos(yaw) * (BOARD_DEPTH / 2 - 0.04);
    this.setBoardPose(this.tmp, yaw);
    if (hand.pinchStarted && this.phaseTime > 0.4) {
      Sfx.place();
      this.setPhase(Phase.Aiming);
    }
  }

  /** Hand pinch point in board-local space (written to `out`). */
  private toBoard(world: Vector3, out: Vector3): Vector3 {
    out.copy(world);
    return this.view.toLocal(out);
  }

  private updateAiming(): void {
    const bx = this.sim.x;
    const bz = this.sim.z;
    let reach = 0;
    const hands = this.inputHands();

    if (this.dragHand == null) {
      for (const hand of hands) {
        if (!hand.tracked) continue;
        const p = this.toBoard(hand.pinchPoint, this.tmp);
        const d = Math.hypot(p.x - bx, p.z - bz);
        const vertical = Math.abs(p.y) < 0.09;
        if (vertical) reach = Math.max(reach, 1 - Math.min(1, Math.max(0, (d - GRAB_RADIUS) / 0.08)));
        if (hand.pinchStarted && vertical && d < GRAB_RADIUS) {
          this.dragHand = hand;
          Sfx.pinch();
          break;
        }
        if (this.immersive && this.tryFlick(hand)) return;
      }
    }

    const drag = this.dragHand;
    if (drag != null) {
      const p = this.toBoard(drag.pinchPoint, this.tmp);
      this.pullX = bx - p.x;
      this.pullZ = bz - p.z;
      const len = Math.hypot(this.pullX, this.pullZ);
      const power = Math.min(1, Math.max(0, (len - 0.012) / FULL_PULL));
      if (!drag.pinching) {
        // Released (or tracking lost): putt if there was a real pull.
        if (power > 0.03 && len > 1e-4) {
          const speed = power * MAX_SHOT_SPEED;
          this.shoot((this.pullX / len) * speed, (this.pullZ / len) * speed, power);
        } else {
          this.dragHand = null;
          this.view.hideAim();
        }
        return;
      }
      if (len > 1e-4) {
        const dx = this.pullX / len;
        const dz = this.pullZ / len;
        this.view.showAim(dx, dz, power);
        this.updatePreview(dx * power * MAX_SHOT_SPEED, dz * power * MAX_SHOT_SPEED);
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
    // World velocity into board-local (the board only has yaw).
    const c = Math.cos(this.boardYaw);
    const s = Math.sin(this.boardYaw);
    const v = hand.indexVelocity;
    const vx = v.x * c - v.z * s;
    const vz = v.x * s + v.z * c;
    const speed = Math.hypot(vx, vz);
    if (speed < FLICK_SPEED || vx * dx + vz * dz <= 0) return false;
    this.flickCooldown = 0.6;
    this.shoot(vx * FLICK_SCALE, vz * FLICK_SCALE, Math.min(1, speed / MAX_SHOT_SPEED));
    return true;
  }

  /** Dotted line showing where the putt will roll (first ~0.7 s). */
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
    if (result.impact > 0.06) Sfx.wall(result.impact);
    if (result.sunk) {
      Sfx.sink();
      this.setPhase(Phase.Sunk);
      return;
    }
    if (!this.sim.moving) {
      const hole = this.holes[this.holeIndex];
      if (this.strokes >= hole.par + MAX_OVER_PAR) {
        // Pick up: score the max and move on so nobody gets stuck.
        this.setPhase(Phase.Sunk);
        this.phaseTime = 0.8;
        return;
      }
      this.setPhase(Phase.Aiming);
    }
  }

  // ---------------------------------------------------------------- mouse

  private setupMouse(): void {
    const canvas = this.renderer.domElement;
    this.mouseHands = [this.mouse];
    const toPoint = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      this.mouseNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
        0.5,
      );
    };
    const down = (e: PointerEvent): void => {
      if (this.immersive) return;
      toPoint(e);
      this.mouseDown = true;
      this.mouseDownPending = true;
      Sfx.unlock();
    };
    const move = (e: PointerEvent): void => toPoint(e);
    const up = (): void => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      this.mouseUpPending = true;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', down),
      () => canvas.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
    );
  }

  /** Project the mouse onto the green and present it as a pinching hand. */
  private updateMouseHand(): void {
    const m = this.mouse;
    m.pinchStarted = this.mouseDownPending;
    m.pinchEnded = this.mouseUpPending;
    m.pinching = this.mouseDown || this.mouseDownPending;
    this.mouseDownPending = false;
    this.mouseUpPending = false;
    if (this.immersive) {
      m.tracked = false;
      return;
    }
    const cam = this.camera;
    cam.updateMatrixWorld(true);
    const origin = cam.getWorldPosition(this.tmp2);
    const dir = this.tmp.copy(this.mouseNdc).unproject(cam).sub(origin).normalize();
    const planeY = this.view.root.position.y;
    if (Math.abs(dir.y) < 1e-4) return;
    const t = (planeY - origin.y) / dir.y;
    if (t <= 0) return;
    m.tracked = true;
    m.pinchPoint.copy(origin).addScaledVector(dir, t);
    m.indexTip.copy(m.pinchPoint);
  }

  // ---------------------------------------------------------------- HUD

  private setupHud(): void {
    this.hud = this.world.getSceneObject<UIKitMLAsset>('hud-panel');
    const panel = this.hud;
    if (!panel) return;
    const on = (id: string, fn: () => void): void => {
      const el = panel.getElementById(id);
      if (!el) return;
      el.name = id;
      el.addEventListener('click', fn);
      this.cleanupFuncs.push(() => el.removeEventListener('click', fn));
    };
    on('btn-restart', () => {
      if (this.phase === Phase.Finished) this.startRound();
      else this.startHole(this.holeIndex);
    });
    on('btn-move', () => {
      if (this.immersive) this.enterPlacing();
    });
    this.hudButtonVisibility();
  }

  private hudButtonVisibility(): void {
    const panel = this.hud;
    if (!panel) return;
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    panel.getElementById('btn-move')?.setProperties({ display: immersive ? 'flex' : 'none' });
  }

  private setText(id: string, text: string): void {
    if (this.hudText.get(id) === text) return;
    this.hudText.set(id, text);
    this.hud?.getElementById<UIKit.Text>(id)?.setProperties({ text });
  }

  private refreshHud(): void {
    if (this.holes.length === 0) return;
    const hole = this.holes[this.holeIndex];
    const parSoFar = this.holes.slice(0, this.card.length).reduce((a, h) => a + h.par, 0);
    const strokesSoFar = this.card.reduce((a, b) => a + b, 0);
    const best = bestFor(this.seed);
    this.setText('eyebrow-text', `DESK LINKS - DAILY ${this.seed}${best != null ? ` - BEST ${best}` : ''}`);
    this.setText('hole-text', `Hole ${hole.index + 1} of ${HOLES_PER_ROUND}`);
    this.setText('par-text', `Par ${hole.par}`);
    this.setText('strokes-text', `Strokes ${this.strokes}`);
    this.setText('total-text', `Total ${relativeToPar(strokesSoFar - parSoFar)}`);
    this.setText('restart-label', this.phase === Phase.Finished ? 'Play again' : 'Retry hole');
    this.setText('message-text', this.message(hole));
  }

  private message(hole: HoleLayout): string {
    switch (this.phase) {
      case Phase.Placing:
        return 'Hold your hand over your table and pinch to set the course down.';
      case Phase.Aiming:
        if (this.strokes > 0) return 'Pinch near the ball, pull back, let go.';
        return this.immersive
          ? 'Pinch near the ball, pull back and let go. Or flick it with a fingertip.'
          : 'Drag back from the ball and release to putt.';
      case Phase.Rolling:
        return '...';
      case Phase.Sunk: {
        if (!this.sim.sunk) return `Picked up after ${this.strokes}. Next hole!`;
        if (this.strokes === 1) return 'HOLE IN ONE!';
        return SCORE_NAMES[this.strokes - hole.par] ?? `${this.strokes} strokes.`;
      }
      case Phase.Finished: {
        const total = this.card.reduce((a, b) => a + b, 0);
        const par = this.holes.reduce((a, h) => a + h.par, 0);
        const s = this.roundSummary;
        const best = s ? (s.isNewBest ? 'New best today!' : `Best today ${s.best}.`) : '';
        const streak = s && s.streak > 1 ? ` ${s.streak}-day streak.` : '';
        return `Round done: ${total} (${relativeToPar(total - par)}). ${best}${streak} New course tomorrow.`;
      }
    }
  }

  // ---------------------------------------------------------------- testing

  /** Small hook for automated browser tests and the emulator console. */
  private exposeDebugHooks(): void {
    const api = {
      state: () => ({
        phase: this.phase,
        hole: this.holeIndex,
        strokes: this.strokes,
        card: [...this.card],
        ball: { x: this.sim.x, z: this.sim.z, moving: this.sim.moving, sunk: this.sim.sunk },
        cup: this.holes[this.holeIndex].cup,
        par: this.holes[this.holeIndex].par,
        seed: this.seed,
        hands: this.hands.both.map((h) => ({
          side: h.side,
          tracked: h.tracked,
          pinching: h.pinching,
          gap: h.indexTip.distanceTo(h.thumbTip),
        })),
      }),
      /** Putt in board-local space; direction is normalised, power 0..1. */
      putt: (dx: number, dz: number, power: number) => {
        if (this.phase !== Phase.Aiming) return false;
        const len = Math.hypot(dx, dz) || 1;
        const speed = Math.min(1, Math.max(0, power)) * MAX_SHOT_SPEED;
        this.shoot((dx / len) * speed, (dz / len) * speed, power);
        return true;
      },
      /** Drop the ball in (testing aid). */
      sink: () => {
        const cup = this.holes[this.holeIndex].cup;
        this.sim.place(cup.x, cup.z + 0.03);
        this.sim.shoot(0, -0.2);
        this.strokes += 1;
        this.setPhase(Phase.Rolling);
      },
      boardToWorld: (x: number, z: number) => {
        this.tmp.set(x, 0, z);
        this.view.root.localToWorld(this.tmp);
        return { x: this.tmp.x, y: this.tmp.y, z: this.tmp.z };
      },
      boardToScreen: (x: number, z: number) => {
        this.tmp.set(x, 0, z);
        this.view.root.localToWorld(this.tmp);
        this.tmp.project(this.camera);
        const rect = this.renderer.domElement.getBoundingClientRect();
        return {
          x: rect.left + ((this.tmp.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - this.tmp.y) / 2) * rect.height,
        };
      },
    };
    (window as unknown as { deskLinks: typeof api }).deskLinks = api;
  }
}
