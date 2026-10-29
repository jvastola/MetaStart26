/**
 * First-use tutorial: teaches the four hand moves every prototype uses by
 * doing them, not by reading about them.
 *
 *   1. Poke   - press a glowing button with your index fingertip.
 *   2. Carry  - pinch an orb, carry it into the ring, let go.
 *   3. Twist  - pinch the dial's rim and turn it a quarter turn.
 *   4. Menu   - turn your left palm toward your face.
 *
 * A translucent "ghost fingertip" demonstrates each motion on a loop, the
 * target pulses, and big step dots show progress. Every step has a mouse
 * equivalent so the same flow works in a desktop browser. It runs once on
 * first launch and can be replayed from the hub.
 */

import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { ACCENTS, blobShadow } from '../core/art.js';
import { Burst } from '../core/burst.js';
import { type LabContext, type Prototype, store } from '../core/context.js';
import { type HandState, pointerDistance } from '../core/hands.js';
import { CanvasPanel, THEME } from '../core/panel.js';
import { Sfx } from '../core/sfx.js';

type Step = 'poke' | 'carry' | 'twist' | 'menu' | 'done';
const STEPS: Step[] = ['poke', 'carry', 'twist', 'menu'];
export const INTRO_DONE_KEY = 'lab-intro-done-v1';

const BUTTON = new Vector3(0, 0, 0.03);
const ORB_HOME = new Vector3(-0.17, 0.035, 0.05);
const RING = new Vector3(0.17, 0, 0.05);
const DIAL = new Vector3(0, 0, 0.03);
const TWIST_GOAL = Math.PI / 2;

export class IntroPrototype implements Prototype {
  readonly id = 'intro';
  readonly title = 'Tutorial';
  readonly tagline = 'Learn the hand moves';
  readonly accent = ACCENTS.intro;
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private step: Step = 'poke';
  private stepTime = 0;
  private burst!: Burst;
  private readonly accentMat = new MeshStandardMaterial({ color: '#9fc7ff', emissive: '#2a4f8a', roughness: 0.35 });

  // Step props.
  private button = new Group();
  private buttonCap!: Mesh;
  private buttonLast = 1;
  private orb!: Mesh;
  private ring!: Mesh;
  private carry: HandState | null = null;
  private dial = new Group();
  private dialTurn = 0;
  private twist: { hand: HandState; last: number } | null = null;
  private ghost!: Mesh;
  private lastDrop: number[] = [];
  private pulse!: Mesh;

  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  constructor(private readonly finish: () => void) {}

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.panel = new CanvasPanel({ width: 0.42, height: 0.2, columns: 2, buttonHeight: 0.034, accent: this.accent });
    this.panel.mesh.name = 'IntroPanel';
    this.panel.mesh.position.set(0, 0.17, -0.15);
    this.panel.mesh.rotation.x = -0.15;
    this.panel.drawExtra = (c, area) => this.drawSteps(c, area);
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);
    this.burst = new Burst(this.deskRoot, this.accent);

    // 1. Big push button.
    const base = new Mesh(new CylinderGeometry(0.045, 0.05, 0.012, 40), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.5 }));
    base.position.y = 0.006;
    this.buttonCap = new Mesh(new CylinderGeometry(0.034, 0.034, 0.014, 40), this.accentMat);
    this.buttonCap.position.y = 0.019;
    this.button.add(base, this.buttonCap, blobShadow(0.14));
    this.button.position.copy(BUTTON);
    this.deskRoot.add(this.button);

    // 2. Orb and target ring.
    this.orb = new Mesh(new SphereGeometry(0.02, 32, 16), this.accentMat);
    this.orb.add(blobShadow(0.06));
    this.ring = new Mesh(new TorusGeometry(0.045, 0.004, 10, 48), new MeshBasicMaterial({ color: THEME.accent }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.copy(RING).setY(0.004);
    this.deskRoot.add(this.orb, this.ring);

    // 3. Dial with a notch to turn toward.
    const dialBase = new Mesh(new CylinderGeometry(0.05, 0.052, 0.018, 48), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.5 }));
    dialBase.position.y = 0.009;
    const knob = new Mesh(new CylinderGeometry(0.004, 0.004, 0.004, 8), this.accentMat);
    knob.scale.set(1, 1, 8);
    knob.position.set(0, 0.02, -0.03);
    const spinner = new Group();
    spinner.add(dialBase, knob);
    spinner.name = 'Spinner';
    const goal = new Mesh(new RingGeometry(0.056, 0.064, 24, 1, -0.15, 0.3), new MeshBasicMaterial({ color: THEME.accent }));
    goal.rotation.x = -Math.PI / 2;
    goal.position.y = 0.002;
    this.dial.add(spinner, goal, blobShadow(0.16));
    this.dial.position.copy(DIAL);
    this.deskRoot.add(this.dial);

    // Hints: a ghost fingertip that acts out the move, and a pulsing ring.
    this.ghost = new Mesh(new SphereGeometry(0.009, 16, 12), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }));
    this.pulse = new Mesh(new RingGeometry(0.8, 1, 40), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false }));
    this.pulse.rotation.x = -Math.PI / 2;
    this.deskRoot.add(this.ghost, this.pulse);
  }

  enter(): void {
    this.setStep('poke');
  }

  exit(): void {
    this.carry = null;
    this.twist = null;
  }

  private setStep(step: Step): void {
    this.step = step;
    this.stepTime = 0;
    this.button.visible = step === 'poke';
    this.orb.visible = this.ring.visible = step === 'carry';
    this.dial.visible = step === 'twist';
    this.orb.position.copy(ORB_HOME);
    this.dialTurn = 0;
    (this.dial.children[0] as Group).rotation.y = 0;
    this.refresh();
  }

  private complete(at: Vector3): void {
    Sfx.step(this.deskRoot.localToWorld(this.tmp2.copy(at)));
    this.burst.fire(this.tmp.copy(at).setY(0.05));
    const next = STEPS[STEPS.indexOf(this.step) + 1] ?? 'done';
    this.setStep(next);
    if (next === 'done') {
      Sfx.success();
      store.set(INTRO_DONE_KEY, true);
    }
  }

  holding(): boolean {
    return this.carry != null || this.twist != null;
  }

  update(dt: number): void {
    this.stepTime += dt;
    this.panel.update(this.ctx.pointers, dt);
    this.burst.update(dt);
    switch (this.step) {
      case 'poke':
        this.updatePoke();
        break;
      case 'carry':
        this.updateCarry(dt);
        break;
      case 'twist':
        this.updateTwist();
        break;
      case 'menu':
        if (this.ctx.wristMenuOpen) this.complete(new Vector3(0, 0.1, 0));
        break;
      case 'done':
        break;
    }
    this.animateHints();
  }

  // ------------------------------------------------------------ steps

  private updatePoke(): void {
    let pressed = false;
    let depth = 1;
    for (const p of this.ctx.pointers) {
      if (!p.tracked) continue;
      if (p.isMouse) {
        if (p.pinchStarted && pointerDistance(p, this.deskRoot.localToWorld(this.tmp.copy(BUTTON).setY(0.02))) < 0.045) pressed = true;
        continue;
      }
      // A pinch (or controller trigger) on the button also counts.
      if (p.pinchStarted && p.pinchPoint.distanceTo(this.deskRoot.localToWorld(this.tmp.copy(BUTTON).setY(0.02))) < 0.06) {
        pressed = true;
        continue;
      }
      const tip = this.deskRoot.worldToLocal(this.tmp.copy(p.indexTip));
      if (Math.hypot(tip.x - BUTTON.x, tip.z - BUTTON.z) > 0.04) continue;
      depth = Math.min(depth, tip.y);
    }
    // The cap follows the fingertip down; it clicks at 8 mm of travel.
    const travel = Math.min(0.012, Math.max(0, 0.026 - depth));
    this.buttonCap.position.y = 0.019 - travel;
    if (travel >= 0.008 && this.buttonLast < 0.008) pressed = true;
    this.buttonLast = travel;
    if (pressed) this.complete(BUTTON);
  }

  private updateCarry(dt: number): void {
    if (this.carry == null) {
      for (const p of this.ctx.pointers) {
        if (!p.tracked || !p.pinchStarted) continue;
        if (pointerDistance(p, this.orb.getWorldPosition(this.tmp)) < 0.05) {
          this.carry = p;
          Sfx.pinch(p.pinchPoint);
          if (p.isMouse) {
            this.ctx.desk.getWorldPosition(this.tmp);
            this.ctx.setMousePlane(this.tmp.setY(this.tmp.y + ORB_HOME.y), this.tmp2.set(0, 1, 0));
          }
          break;
        }
      }
      // Drift home when not held.
      this.orb.position.lerp(ORB_HOME, 1 - Math.exp(-dt * 6));
      return;
    }
    const hand = this.carry;
    const local = this.deskRoot.worldToLocal(this.tmp.copy(hand.pinchPoint));
    this.orb.position.copy(local);
    if (!hand.pinching || !hand.tracked) {
      this.carry = null;
      // Decide the drop before `this.tmp` (which holds `local`) is reused.
      this.lastDrop = [+local.x.toFixed(3), +local.y.toFixed(3), +local.z.toFixed(3)];
      const inRing = Math.hypot(local.x - RING.x, local.z - RING.z) < 0.06 && local.y < 0.12;
      if (hand.isMouse) {
        this.ctx.desk.getWorldPosition(this.tmp);
        this.ctx.setMousePlane(this.tmp, this.tmp2.set(0, 1, 0));
      }
      if (inRing) {
        this.orb.position.copy(RING).setY(0.02);
        this.complete(RING);
      } else {
        Sfx.error(hand.pinchPoint);
      }
    }
  }

  private updateTwist(): void {
    const spinner = this.dial.children[0] as Group;
    if (this.twist == null) {
      for (const p of this.ctx.pointers) {
        if (!p.tracked || !p.pinchStarted) continue;
        const l = this.deskRoot.worldToLocal(this.tmp.copy(p.pinchPoint));
        const r = Math.hypot(l.x - DIAL.x, l.z - DIAL.z);
        if (r < 0.075 && l.y < 0.08) {
          this.twist = { hand: p, last: Math.atan2(l.x - DIAL.x, l.z - DIAL.z) };
          Sfx.pinch(p.pinchPoint);
          break;
        }
      }
      return;
    }
    const t = this.twist;
    const l = this.deskRoot.worldToLocal(this.tmp.copy(t.hand.pinchPoint));
    const a = Math.atan2(l.x - DIAL.x, l.z - DIAL.z);
    let d = a - t.last;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    t.last = a;
    // Clockwise seen from above lowers atan2(x, z); count that as progress.
    const before = Math.floor((this.dialTurn / TWIST_GOAL) * 6);
    this.dialTurn = Math.max(0, this.dialTurn - d);
    spinner.rotation.y = -this.dialTurn;
    if (Math.floor((this.dialTurn / TWIST_GOAL) * 6) > before) Sfx.blip(600 + this.dialTurn * 200);
    if (this.dialTurn >= TWIST_GOAL * 0.9) {
      this.twist = null;
      this.complete(DIAL);
      return;
    }
    if (!t.hand.pinching) this.twist = null;
  }

  // ------------------------------------------------------------ hints

  /** Loop a demonstration of the current move with the ghost fingertip. */
  private animateHints(): void {
    const cycle = (this.stepTime % 2) / 2;
    const ease = 0.5 - Math.cos(cycle * Math.PI * 2) / 2;
    const busy = this.carry != null || this.twist != null;
    this.ghost.visible = !busy && this.step !== 'menu' && this.step !== 'done';
    this.pulse.visible = this.step !== 'menu' && this.step !== 'done';
    const pulseScale = 0.05 + (this.stepTime % 1.2) * 0.04;
    (this.pulse.material as MeshBasicMaterial).opacity = 0.6 * (1 - (this.stepTime % 1.2) / 1.2);
    switch (this.step) {
      case 'poke':
        this.ghost.position.set(BUTTON.x, 0.09 - ease * 0.065, BUTTON.z);
        this.pulse.position.set(BUTTON.x, 0.003, BUTTON.z);
        break;
      case 'carry': {
        // Pinch at the orb, arc over, release in the ring.
        const k = Math.min(1, Math.max(0, (cycle - 0.15) / 0.7));
        this.ghost.position.lerpVectors(ORB_HOME, RING, k);
        this.ghost.position.y = ORB_HOME.y + Math.sin(k * Math.PI) * 0.08 + 0.015;
        this.pulse.position.copy(RING).setY(0.003);
        break;
      }
      case 'twist': {
        const a = Math.PI - ease * TWIST_GOAL;
        this.ghost.position.set(DIAL.x + Math.sin(a) * 0.05, 0.03, DIAL.z + Math.cos(a) * 0.05);
        this.pulse.position.set(DIAL.x, 0.003, DIAL.z);
        break;
      }
      default:
        break;
    }
    this.pulse.scale.setScalar(pulseScale);
  }

  // ------------------------------------------------------------ panel

  private refresh(): void {
    const n = STEPS.indexOf(this.step);
    const mouse = !this.ctx.immersive;
    const copy: Record<Step, [string, string]> = {
      poke: ['Poke the button', mouse ? 'Click the glowing button.' : 'Press it with your index fingertip.'],
      carry: ['Pinch and carry', mouse ? 'Drag the orb into the ring.' : 'Pinch the orb, carry it into the ring, let go.'],
      twist: ['Pinch and twist', mouse ? 'Drag around the dial a quarter turn.' : 'Pinch the dial rim and turn it to the mark.'],
      menu: ['Your menu', mouse ? 'In the headset, turn your left palm toward you. Here, use the bar below.' : 'Turn your left palm toward your face.'],
      done: ["You're ready", 'Those four moves work everywhere in the lab.'],
    };
    const [title, body] = copy[this.step];
    this.panel.setText(this.step === 'done' ? 'Tutorial complete' : `Welcome - step ${n + 1} of ${STEPS.length}`, title, body);
    const buttons = this.step === 'done'
      ? [{ id: 'finish', label: 'Open the lab', tone: 'primary' as const }, { id: 'again', label: 'Replay' }]
      : [{ id: 'skip', label: 'Skip tutorial' }, ...(this.step === 'menu' && mouse ? [{ id: 'next', label: 'Continue', tone: 'primary' as const }] : [])];
    this.panel.setButtons(buttons);
    this.panel.invalidate();
  }

  private drawSteps(ctx: CanvasRenderingContext2D, area: { x: number; y: number; w: number; h: number }): void {
    const n = this.step === 'done' ? STEPS.length : STEPS.indexOf(this.step);
    const r = Math.min(area.h * 0.28, 26);
    const gap = r * 3.2;
    const x0 = area.x + area.w / 2 - (gap * (STEPS.length - 1)) / 2;
    const y = area.y + area.h / 2;
    STEPS.forEach((_, i) => {
      if (i < STEPS.length - 1) {
        ctx.fillStyle = i < n ? this.accent : 'rgba(255,255,255,0.15)';
        ctx.fillRect(x0 + i * gap + r, y - 2, gap - 2 * r, 4);
      }
      ctx.beginPath();
      ctx.arc(x0 + i * gap, y, r, 0, Math.PI * 2);
      ctx.fillStyle = i < n ? this.accent : i === n ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.15)';
      ctx.fill();
      ctx.fillStyle = i < n ? '#10243b' : i === n ? '#14161b' : THEME.dim;
      ctx.font = `700 ${r}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i < n ? '✓' : String(i + 1), x0 + i * gap, y + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    });
  }

  private onButton(id: string): void {
    if (id === 'skip' || id === 'finish') {
      store.set(INTRO_DONE_KEY, true);
      this.finish();
    }
    if (id === 'again') this.setStep('poke');
    if (id === 'next' && this.step === 'menu') this.complete(new Vector3(0, 0.1, 0));
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return { step: this.step, dialTurn: +this.dialTurn.toFixed(2), carrying: this.carry != null, lastDrop: this.lastDrop };
  }

  debugActions = {
    press: (id: string) => this.panel.press(id),
    world: (what: string) => {
      const local = what === 'button' ? BUTTON.clone().setY(0.02) : what === 'orb' ? this.orb.position.clone() : what === 'ring' ? RING.clone().setY(0.02) : DIAL.clone().setY(0.02);
      this.deskRoot.updateMatrixWorld(true);
      const p = this.deskRoot.localToWorld(local);
      return { x: p.x, y: p.y, z: p.z };
    },
  };
}
