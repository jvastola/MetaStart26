/**
 * Desk Focus: a daily planner that lives in your real room.
 *
 * The Today board is pinned to your actual wall; the focus pad, timer dial,
 * Done tray and a streak plant sit on your actual desk. Everything is placed
 * from plane detection and kept in the anchored room, so tomorrow it is where
 * you left it.
 *
 * Hands:
 *   - grab a card (thumb + middle finger) to pick it up; drop it on a board column, the focus pad,
 *     or the Done tray. A fast flick while holding completes it.
 *   - pinch the dial rim and twist to set minutes; let go to start.
 *   - microgestures: thumb tap = start/pause, swipe left/right = next card,
 *     swipe up = done, swipe down = back to Today.
 *   - voice (when available) to add a card; otherwise a sample card.
 */

import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { Burst } from '../../core/burst.js';
import { HeldPose } from '../../core/grab.js';
import type { LabContext, Prototype } from '../../core/context.js';
import { ACCENTS, blobShadow } from '../../core/art.js';
import type { HandState } from '../../core/hands.js';
import { CanvasPanel, roundRect, THEME, wrap } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import { Voice } from '../../core/voice.js';
import { BOARD_ZONES, type Card, FocusStore, type Zone } from './focus-store.js';

// Everything you touch sits within arm's reach on the desk: the planner
// stands at the back like a lectern, the pad, dial and tray at the front.
const CARD_W = 0.072;
const CARD_H = 0.044;
const BOARD_W = 0.44;
const BOARD_H = 0.25;
const COLUMN_X: Record<string, number> = { inbox: -0.145, today: 0, done: 0.145 };
const SLOT_TOP = 0.045;
const SLOT_STEP = 0.05;
const MAX_SLOTS = 3;
/** Planner pose in desk space: centre and backward tilt. */
const PLANNER_POS = new Vector3(0, 0.1, -0.12);
const PLANNER_TILT = -0.75;
const GRAB_RADIUS = 0.05;
const FLICK_SPEED = 1.1;

const PAD = new Vector3(0, 0, 0.075);
const DIAL = new Vector3(0.2, 0, 0.065);
const TRAY = new Vector3(-0.2, 0, 0.065);
const PLANT = new Vector3(-0.33, 0, -0.1);

const SAMPLE_TASKS = ['Water the plants', 'Read ten pages', 'Tidy the desk', 'Write a thank-you note', 'Plan the weekend'];

const cardGeometry = new PlaneGeometry(CARD_W, CARD_H);

class CardView {
  readonly mesh: Mesh;
  readonly targetPos = new Vector3();
  readonly targetQuat = new Quaternion();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private drawn = '';
  placed = false;

  constructor(public card: Card) {
    this.canvas.width = 360;
    this.canvas.height = 220;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(cardGeometry, new MeshBasicMaterial({ map: this.texture, side: DoubleSide, transparent: true }));
    this.mesh.name = `Card:${card.text}`;
    this.mesh.renderOrder = 11;
    this.draw();
  }

  draw(): void {
    const key = `${this.card.text}|${this.card.zone}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const ctx = this.canvas.getContext('2d')!;
    const { width: w, height: h } = this.canvas;
    const done = this.card.zone === 'done';
    ctx.clearRect(0, 0, w, h);
    roundRect(ctx, 2, 2, w - 4, h - 4, 22);
    ctx.fillStyle = done ? '#d9dde3' : '#fbfaf6';
    ctx.fill();
    ctx.fillStyle = `hsl(${this.card.hue} 65% 55%)`;
    ctx.fillRect(2, 18, 14, h - 36);
    ctx.fillStyle = done ? '#6a707a' : '#1d2027';
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const lines = wrap(ctx, this.card.text, w - 60).slice(0, 4);
    lines.forEach((line, i) => ctx.fillText(line, 34, 26 + i * 42));
    if (done) {
      ctx.strokeStyle = '#2f7d5d';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(w - 90, h - 60);
      ctx.lineTo(w - 66, h - 36);
      ctx.lineTo(w - 26, h - 86);
      ctx.stroke();
    }
    this.texture.needsUpdate = true;
  }
}

interface Hold {
  view: CardView;
  hand: HandState;
  pose: HeldPose;
  from: Zone;
  /** Hand speed while held, from the frame before release (letting go moves the fingers). */
  speed: number;
}

export class FocusPrototype implements Prototype {
  readonly id = 'focus';
  readonly title = 'Desk Focus';
  readonly tagline = 'Planner pinned to your real room';
  readonly accent = ACCENTS.focus;
  readonly howTo = [
    'Grab a card with thumb + middle finger and carry it to the blue FOCUS pad.',
    'Pinch the dial rim and twist to set minutes; let go to start.',
    'Done? Drop the card in the green tray, or flick it away.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private store!: FocusStore;
  private views = new Map<string, CardView>();
  private cards = new Group();
  private board!: CanvasPanel;
  private panel!: CanvasPanel;
  private glance!: CanvasPanel;
  private glanceKey = '';
  private readonly planner = new Group();
  private dial!: Group;
  private dialFace!: { canvas: HTMLCanvasElement; texture: CanvasTexture };
  private dialKnob!: Mesh;
  private plant = new Group();
  private burst!: Burst;
  private holds: Hold[] = [];
  private twist: { hand: HandState; last: number; accum: number; start: number } | null = null;
  private running = false;
  private remaining = 0;
  private total = 0;
  private dialDrawn = '';
  private voice = new Voice();
  private listening = '';
  private sampleIndex = 0;
  private plantKey = '';
  private ambientOn = false;

  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly parentQuatInv = new Quaternion();
  private readonly tilt = new Quaternion();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.store = new FocusStore();
    this.store.rollover();
    this.tilt.setFromAxisAngle(new Vector3(1, 0, 0), -1.05);

    // Wall: the Today board.
    this.board = new CanvasPanel({ width: BOARD_W, height: BOARD_H, columns: 1, ppm: 2200 });
    this.board.mesh.name = 'FocusPlanner';
    this.board.drawExtra = (c, area) => this.drawColumns(c, area);
    this.planner.position.copy(PLANNER_POS);
    this.planner.rotation.x = PLANNER_TILT;
    this.planner.add(this.board.mesh);
    const stand = new Mesh(new BoxGeometry(BOARD_W, 0.008, 0.02), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.6 }));
    stand.position.set(0, -BOARD_H / 2 - 0.004, -0.005);
    this.planner.add(stand);
    this.deskRoot.add(this.planner);

    // Wall: a read-only glance display (big timer, progress, streak).
    this.glance = new CanvasPanel({ width: 0.5, height: 0.28, columns: 1, accent: this.accent });
    this.glance.mesh.name = 'FocusGlance';
    this.glance.drawExtra = (c, area) => this.drawGlance(c, area);
    this.wallRoot.add(this.glance.mesh);

    // Desk: pad, dial, tray, plant, control panel.
    this.buildDesk();
    this.deskRoot.add(this.cards);
    this.burst = new Burst(this.deskRoot);

    this.panel = new CanvasPanel({ width: 0.36, height: 0.13, columns: 4, buttonHeight: 0.034 });
    this.panel.mesh.name = 'FocusPanel';
    // Beside the planner, angled toward the user.
    this.panel.mesh.position.set(0.37, 0.1, -0.02);
    this.panel.mesh.rotation.set(-0.25, -0.5, 0, 'YXZ');
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    for (const card of this.store.cards) this.viewFor(card);
  }

  enter(): void {
    this.store.rollover();
    this.syncViews();
    this.refresh();
  }

  exit(): void {
    for (const h of this.holds) this.returnCard(h);
    this.holds = [];
    this.twist = null;
    this.voice.stop();
    this.listening = '';
    this.ambientOn = false;
    Sfx.ambient(false);
  }

  // ------------------------------------------------------------ build

  private buildDesk(): void {
    const dark = new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.6 });
    const pad = new Mesh(new BoxGeometry(0.13, 0.004, 0.09), new MeshStandardMaterial({ color: '#3d4a63', roughness: 0.8 }));
    pad.position.copy(PAD).setY(0.002);
    this.deskRoot.add(pad);
    const padLabel = labelPlane('FOCUS', 0.06, '#9fb3d9');
    padLabel.position.set(PAD.x, 0.0045, PAD.z + 0.035);
    this.deskRoot.add(padLabel);

    // Done tray: a shallow open box.
    const tray = new Group();
    const trayMat = new MeshStandardMaterial({ color: '#2f7d5d', roughness: 0.7 });
    tray.add(new Mesh(new BoxGeometry(0.12, 0.004, 0.085), trayMat));
    for (const [w, d, x, z] of [
      [0.12, 0.006, 0, -0.0425],
      [0.12, 0.006, 0, 0.0425],
      [0.006, 0.085, -0.06, 0],
      [0.006, 0.085, 0.06, 0],
    ]) {
      const wall = new Mesh(new BoxGeometry(w, 0.02, d), trayMat);
      wall.position.set(x, 0.01, z);
      tray.add(wall);
    }
    tray.add(blobShadow(0.2, 0.15));
    tray.position.copy(TRAY);
    const trayLabel = labelPlane('DONE', 0.05, '#bff0d8');
    trayLabel.position.set(0, 0.005, 0);
    tray.add(trayLabel);
    this.deskRoot.add(tray);

    // Timer dial with a canvas face.
    this.dial = new Group();
    const base = new Mesh(new CylinderGeometry(0.042, 0.045, 0.014, 40), dark);
    base.position.y = 0.007;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const face = new Mesh(new PlaneGeometry(0.084, 0.084), new MeshBasicMaterial({ map: texture, transparent: true }));
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.0145;
    this.dialFace = { canvas, texture };
    this.dialKnob = new Mesh(new BoxGeometry(0.006, 0.01, 0.03), new MeshStandardMaterial({ color: '#f4b860' }));
    this.dialKnob.position.y = 0.018;
    this.dial.add(base, face, this.dialKnob);
    this.dial.add(blobShadow(0.13));
    this.dial.position.copy(DIAL);
    this.deskRoot.add(this.dial);

    this.plant.position.copy(PLANT);
    const plantShadow = blobShadow(0.1);
    plantShadow.position.copy(PLANT).setY(0.0012);
    this.deskRoot.add(plantShadow);
    this.deskRoot.add(this.plant);
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    const { pointers } = this.ctx;
    this.panel.update(pointers, dt);
    this.board.update([], dt);
    this.glance.update([], dt);

    this.updateTimer(dt);
    this.updateGestures();
    this.updateTwist();
    this.updateGrabs();
    this.layoutCards(dt);
    this.burst.update(dt);
    // A soft ambient bed plays while a focus session runs.
    if (this.running !== this.ambientOn) {
      this.ambientOn = this.running;
      Sfx.ambient(this.running);
    }
    this.drawDial();
    this.refresh();
  }

  private updateTimer(dt: number): void {
    if (!this.running) return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.running = false;
      this.remaining = 0;
      Sfx.chime();
      this.ctx.toast('Time! Flick the card into Done, or twist for more.');
    }
  }

  private updateGestures(): void {
    for (const hand of this.ctx.hands.both) {
      switch (hand.gesture) {
        case 'tap':
          this.toggleTimer();
          break;
        case 'left':
        case 'right':
          if (this.store.cycleFocus(hand.gesture === 'right' ? 1 : -1)) Sfx.blip(760);
          this.syncViews();
          break;
        case 'up': {
          const f = this.store.focusCard;
          if (f) this.completeCard(f.id);
          break;
        }
        case 'down': {
          const f = this.store.focusCard;
          if (f) {
            this.store.move(f.id, 'today');
            this.syncViews();
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private toggleTimer(): void {
    if (!this.store.focusCard) {
      this.ctx.toast('Put a card on the focus pad first.');
      return;
    }
    if (this.remaining <= 0) {
      this.total = this.remaining = this.store.data.focusMinutes * 60;
    }
    this.running = !this.running;
    Sfx.blip(this.running ? 880 : 520);
  }

  /** Pinch the dial rim and turn it like a kitchen timer. */
  private updateTwist(): void {
    if (this.twist == null) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.pinchStarted || this.isHolding(hand)) continue;
        const local = this.deskLocal(hand.pinchPoint, this.tmp);
        const dx = local.x - DIAL.x;
        const dz = local.z - DIAL.z;
        if (Math.hypot(dx, dz) < 0.055 && local.y < 0.08 && local.y > -0.03) {
          const angle = Math.atan2(dx, dz);
          this.twist = { hand, last: angle, accum: 0, start: this.store.data.focusMinutes };
          this.running = false;
          Sfx.pinch(hand.pinchPoint);
        }
      }
      return;
    }
    const t = this.twist;
    const local = this.deskLocal(t.hand.pinchPoint, this.tmp);
    const angle = Math.atan2(local.x - DIAL.x, local.z - DIAL.z);
    let d = angle - t.last;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    t.accum += d;
    t.last = angle;
    // Clockwise (seen from above) adds time: 60 minutes per full turn, 5-minute steps.
    const minutes = Math.round((t.start - (t.accum * 60) / (Math.PI * 2)) / 5) * 5;
    if (Math.min(60, Math.max(5, minutes)) !== this.store.data.focusMinutes) {
      this.store.setFocusMinutes(minutes);
      Sfx.blip(600 + this.store.data.focusMinutes * 6);
    }
    if (!t.hand.pinching) {
      this.twist = null;
      if (this.store.focusCard) {
        this.total = this.remaining = this.store.data.focusMinutes * 60;
        this.running = true;
        Sfx.blip(880);
      }
    }
  }

  private isHolding(hand: HandState): boolean {
    return this.holds.some((h) => h.hand === hand) || this.twist?.hand === hand;
  }

  private updateGrabs(): void {
    // Pick up.
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked || !hand.grabStarted || this.isHolding(hand)) continue;
      if (this.panel.contains(hand.holdPoint)) continue;
      const view = this.nearestCard(hand);
      if (!view) continue;
      this.cards.updateMatrixWorld(true);
      // The card follows your hand, including its rotation.
      const pose = new HeldPose();
      pose.begin(hand, view.mesh);
      this.holds.push({ view, hand, pose, from: view.card.zone, speed: 0 });
      if (hand.isMouse) {
        // Drag the card on a plane facing the camera through its position.
        this.ctx.camera.getWorldDirection(this.tmp2).negate();
        this.ctx.setMousePlane(view.mesh.getWorldPosition(this.tmp), this.tmp2);
      }
      Sfx.pinch(hand.holdPoint);
    }
    // Carry and drop.
    for (let i = this.holds.length - 1; i >= 0; i -= 1) {
      const hold = this.holds[i];
      if (hold.hand.grabbing && hold.hand.tracked) {
        hold.speed = hold.hand.pinchVelocity.length();
        continue;
      }
      this.holds.splice(i, 1);
      this.drop(hold);
      if (hold.hand.isMouse) {
        this.ctx.desk.getWorldPosition(this.tmp);
        this.ctx.setMousePlane(this.tmp, this.tmp2.set(0, 1, 0));
      }
    }
  }

  private nearestCard(hand: HandState): CardView | null {
    let best: CardView | null = null;
    let bestDist = hand.isMouse ? 0.045 : GRAB_RADIUS;
    for (const view of this.views.values()) {
      if (this.holds.some((h) => h.view === view)) continue;
      const p = view.mesh.getWorldPosition(this.tmp);
      let d: number;
      if (hand.isMouse) {
        // Distance from the mouse ray to the card centre.
        const along = this.tmp2.copy(p).sub(hand.rayOrigin).dot(hand.rayDir);
        d = this.tmp2.copy(hand.rayOrigin).addScaledVector(hand.rayDir, along).distanceTo(p);
      } else {
        d = p.distanceTo(hand.grabPoint);
      }
      if (d < bestDist) {
        bestDist = d;
        best = view;
      }
    }
    return best;
  }

  private drop(hold: Hold): void {
    const { view, hand } = hold;
    const id = view.card.id;
    if (hand.isMouse && this.dropByRay(hold)) return;
    const world = view.mesh.getWorldPosition(new Vector3());
    const speed = hold.speed;
    const local = this.deskLocal(world, this.tmp);
    if (Math.hypot(local.x - TRAY.x, local.z - TRAY.z) < 0.09 && local.y < 0.12) {
      this.completeCard(id);
      return;
    }
    if (!hand.isMouse && speed > FLICK_SPEED && hold.from !== 'done') {
      this.completeCard(id);
      return;
    }
    if (Math.hypot(local.x - PAD.x, local.z - PAD.z) < 0.09 && local.y < 0.12) {
      this.store.move(id, 'focus');
      Sfx.place();
      this.syncViews();
      return;
    }
    // On the board: which column?
    this.planner.updateMatrixWorld(true);
    const w = this.planner.worldToLocal(world.clone());
    if (Math.abs(w.z) < 0.1 && Math.abs(w.x) < BOARD_W / 2 + 0.04 && Math.abs(w.y) < BOARD_H / 2 + 0.06) {
      const zone = BOARD_ZONES.reduce((a, z) => (Math.abs(COLUMN_X[z] - w.x) < Math.abs(COLUMN_X[a] - w.x) ? z : a));
      if (zone === 'done') this.completeCard(id);
      else {
        this.store.move(id, zone);
        Sfx.place();
      }
      this.syncViews();
      return;
    }
    this.returnCard(hold);
  }

  /**
   * Mouse drops: the dragged card slides on a plane, so pick the target the
   * cursor ray points at instead of where the card ended up in 3D.
   */
  private dropByRay(hold: Hold): boolean {
    const { rayOrigin, rayDir } = hold.hand;
    const rayDist = (p: Vector3): number => {
      const along = this.tmp2.copy(p).sub(rayOrigin).dot(rayDir);
      return this.tmp2.copy(rayOrigin).addScaledVector(rayDir, along).distanceTo(p);
    };
    this.deskRoot.updateMatrixWorld(true);
    this.planner.updateMatrixWorld(true);
    // [zone, point, tall]: board columns are tall, so only their x distance counts.
    const targets: [Zone, Vector3, boolean][] = [
      ['focus', this.deskRoot.localToWorld(PAD.clone().setY(0.02)), false],
      ['done', this.deskRoot.localToWorld(TRAY.clone().setY(0.02)), false],
      ...BOARD_ZONES.map((z) => [z, this.planner.localToWorld(new Vector3(COLUMN_X[z], 0, 0.01)), true] as [Zone, Vector3, boolean]),
    ];
    let best: Zone | null = null;
    let bestDist = Infinity;
    for (const [zone, p, tall] of targets) {
      const d = tall ? Math.max(0, rayDist(p) - BOARD_H / 2) : rayDist(p);
      const limit = tall ? 0.1 : 0.08;
      if (d < limit && d < bestDist) {
        bestDist = d;
        best = zone;
      }
    }
    if (best == null) return false;
    if (best === 'done') this.completeCard(hold.view.card.id);
    else {
      this.store.move(hold.view.card.id, best);
      Sfx.place();
      this.syncViews();
    }
    return true;
  }

  private returnCard(hold: Hold): void {
    hold.view.card.zone = hold.from;
    Sfx.error(hold.hand.pinchPoint);
  }

  private completeCard(id: string): void {
    const before = this.store.currentStreak();
    const streak = this.store.complete(id);
    if (this.store.focusCard == null) {
      this.running = false;
      this.remaining = 0;
    }
    Sfx.success(this.worldOf(TRAY));
    this.burst.fire(this.tmp.copy(TRAY).setY(0.04));
    if (streak > before) this.ctx.toast(streak > 1 ? `${streak}-day streak! Your plant grew.` : 'First one today. Your plant grew.');
    this.syncViews();
  }

  // ------------------------------------------------------------ layout

  private syncViews(): void {
    for (const card of this.store.cards) this.viewFor(card).card = card;
    for (const [id, view] of this.views) {
      if (!this.store.find(id)) {
        this.cards.remove(view.mesh);
        this.views.delete(id);
      }
    }
    for (const view of this.views.values()) view.draw();
  }

  private viewFor(card: Card): CardView {
    let view = this.views.get(card.id);
    if (!view) {
      view = new CardView(card);
      this.views.set(card.id, view);
      this.cards.add(view.mesh);
    }
    return view;
  }

  /** Ease every card toward its zone slot (or the hand holding it). */
  private layoutCards(dt: number): void {
    this.cards.updateMatrixWorld(true);
    this.planner.updateMatrixWorld(true);
    this.cards.getWorldQuaternion(this.parentQuatInv).invert();
    const counts: Record<string, number> = { inbox: 0, today: 0, done: 0 };
    const k = 1 - Math.exp(-dt * 12);

    for (const card of this.store.cards) {
      const view = this.views.get(card.id);
      if (!view) continue;
      const hold = this.holds.find((h) => h.view === view);
      if (hold) {
        hold.pose.apply(hold.hand, view.mesh);
        view.targetPos.copy(view.mesh.position);
        view.targetQuat.copy(view.mesh.quaternion);
      } else if (card.zone === 'focus') {
        view.targetPos.set(PAD.x, 0.03, PAD.z);
        view.targetQuat.copy(this.tilt);
      } else {
        const slot = counts[card.zone]++;
        const visible = Math.min(slot, MAX_SLOTS - 1);
        const over = Math.max(0, slot - (MAX_SLOTS - 1));
        this.tmp.set(COLUMN_X[card.zone], SLOT_TOP - visible * SLOT_STEP - over * 0.004, 0.006 + over * 0.0015);
        this.planner.localToWorld(this.tmp);
        this.planner.getWorldQuaternion(this.tmpQ);
        this.toCardsSpace(this.tmp, this.tmpQ, view);
        view.mesh.visible = slot < MAX_SLOTS + 3;
      }
      if (!view.placed) {
        view.mesh.position.copy(view.targetPos);
        view.mesh.quaternion.copy(view.targetQuat);
        view.placed = true;
      } else {
        view.mesh.position.lerp(view.targetPos, hold ? 1 : k);
        view.mesh.quaternion.slerp(view.targetQuat, hold ? 1 : k);
      }
    }
  }

  private toCardsSpace(worldPos: Vector3, worldQuat: Quaternion, view: CardView): void {
    view.targetPos.copy(worldPos);
    this.cards.worldToLocal(view.targetPos);
    view.targetQuat.copy(this.parentQuatInv).multiply(worldQuat);
  }


  private deskLocal(world: Vector3, out: Vector3): Vector3 {
    out.copy(world);
    this.deskRoot.updateMatrixWorld(true);
    return this.deskRoot.worldToLocal(out);
  }

  // ------------------------------------------------------------ UI

  private onButton(id: string): void {
    if (id === 'timer') this.toggleTimer();
    if (id === 'add') {
      this.ctx.openKeyboard({
        title: 'New task',
        placeholder: 'Type the task, or press Mic and say it',
        onSubmit: (text) => {
          this.store.add(text);
          this.syncViews();
          Sfx.place();
          this.ctx.toast(`Added "${text}" to Inbox.`);
        },
      });
    }
    if (id === 'next') {
      this.store.cycleFocus(1);
      this.syncViews();
    }
  }

  private addCard(): void {
    if (this.voice.listening) {
      this.voice.stop();
      this.listening = '';
      return;
    }
    const started = this.voice.start({
      onPartial: (t) => (this.listening = t || '...'),
      onFinal: (t) => {
        this.listening = '';
        if (t) {
          this.store.add(t);
          this.syncViews();
          Sfx.place();
          this.ctx.toast(`Added "${t}" to Inbox.`);
        }
      },
      onError: () => {
        this.listening = '';
        this.addSample('Voice unavailable, added a sample card.');
      },
      onEnd: () => (this.listening = ''),
    });
    if (started) this.listening = '...';
    else this.addSample('No voice input here, added a sample card.');
  }

  private addSample(message: string): void {
    const text = SAMPLE_TASKS[this.sampleIndex++ % SAMPLE_TASKS.length];
    this.store.add(text);
    this.syncViews();
    Sfx.place();
    this.ctx.toast(message);
  }

  holding(): boolean {
    return this.holds.length > 0 || this.twist != null;
  }

  /** The wall display: read from across the room, never touched. */
  private drawGlance(ctx: CanvasRenderingContext2D, area: { x: number; y: number; w: number; h: number }): void {
    const focus = this.store.focusCard;
    const time = this.remaining > 0 ? formatTime(this.remaining) : `${this.store.data.focusMinutes}:00`;
    const done = this.store.doneToday();
    const today = this.store.zone('today').length + (focus ? 1 : 0) + done;
    const streak = this.store.currentStreak();
    ctx.textBaseline = 'top';
    ctx.fillStyle = this.running ? '#ff8a80' : THEME.text;
    ctx.font = `700 ${area.h * 0.42}px system-ui, sans-serif`;
    ctx.fillText(time, area.x, area.y);
    ctx.fillStyle = THEME.dim;
    ctx.font = `500 ${area.h * 0.11}px system-ui, sans-serif`;
    const title = focus ? (this.running ? `Focusing: ${focus.text}` : `Up next: ${focus.text}`) : 'Put a card on the focus pad';
    ctx.fillText(wrap(ctx, title, area.w)[0] ?? '', area.x, area.y + area.h * 0.5);
    // Progress bar and streak.
    const y = area.y + area.h * 0.72;
    const barW = area.w * 0.62;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, area.x, y, barW, area.h * 0.09, area.h * 0.045);
    ctx.fill();
    ctx.fillStyle = this.accent;
    roundRect(ctx, area.x, y, Math.max(area.h * 0.09, (barW * done) / Math.max(1, today)), area.h * 0.09, area.h * 0.045);
    ctx.fill();
    ctx.fillStyle = THEME.text;
    ctx.font = `600 ${area.h * 0.1}px system-ui, sans-serif`;
    ctx.fillText(`${done}/${today} done`, area.x + barW + area.w * 0.03, y - area.h * 0.01);
    ctx.fillStyle = THEME.dim;
    ctx.fillText(`Streak: ${streak} day${streak === 1 ? '' : 's'}`, area.x, y + area.h * 0.14);
  }

  private mode(): { eyebrow: string; hint: string } {
    const hour = new Date().getHours();
    if (hour < 12) return { eyebrow: 'Morning plan', hint: 'Move up to 3 cards from Inbox to Today, then put one on the focus pad.' };
    if (hour < 18) return { eyebrow: 'Focus', hint: 'Put a card on the pad, pinch the dial and twist to start.' };
    return { eyebrow: 'Wind-down', hint: "Clear what's done, then line up tomorrow's Today column." };
  }

  private refresh(): void {
    const { eyebrow, hint } = this.mode();
    const streak = this.store.currentStreak();
    const doneToday = this.store.doneToday();
    this.board.setText(`${eyebrow} - ${doneToday} done today`, '', '');
    this.glance.setText(`Desk Focus - ${eyebrow}`, '', '');
    const glanceKey = `${Math.ceil(this.remaining)}|${this.running}|${this.store.focusCard?.id}|${doneToday}|${streak}|${this.store.data.focusMinutes}|${this.store.zone('today').length}`;
    if (glanceKey !== this.glanceKey) {
      this.glanceKey = glanceKey;
      this.glance.invalidate();
    }
    const focus = this.store.focusCard;
    let body = hint;
    if (this.listening) body = `Listening: ${this.listening}`;
    else if (focus && (this.running || this.remaining > 0)) body = `${focus.text} - ${formatTime(this.remaining)}${this.running ? '' : ' (paused)'}`;
    else if (focus) body = `On the pad: ${focus.text}. Pinch the dial and twist to start.`;
    this.panel.setText(this.title, '', body);
    this.panel.setButtons([
      { id: 'add', label: 'New card', sub: 'type or say it' },
      { id: 'timer', label: this.running ? 'Pause' : this.remaining > 0 ? 'Resume' : 'Start', tone: 'primary', disabled: !focus },
      { id: 'next', label: 'Next card' },
    ]);
    this.updatePlant();
  }

  private drawColumns(ctx: CanvasRenderingContext2D, area: { x: number; y: number; w: number; h: number }): void {
    const labels: [Zone, string][] = [
      ['inbox', 'Inbox'],
      ['today', 'Today'],
      ['done', 'Done'],
    ];
    const colW = area.w / 3;
    labels.forEach(([zone, label], i) => {
      const x = area.x + i * colW;
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      roundRect(ctx, x + 6, area.y, colW - 12, area.h - 6, 18);
      ctx.fill();
      ctx.fillStyle = zone === 'today' ? THEME.accent : THEME.dim;
      ctx.font = '700 22px system-ui, sans-serif';
      ctx.fillText(`${label}  ${this.store.zone(zone).length}`, x + 22, area.y + 12);
    });
  }

  private drawDial(): void {
    const minutes = this.store.data.focusMinutes;
    const frac = this.total > 0 ? this.remaining / this.total : 0;
    const key = `${minutes}|${Math.ceil(this.remaining)}|${this.running}`;
    if (key === this.dialDrawn) return;
    this.dialDrawn = key;
    const { canvas, texture } = this.dialFace;
    const ctx = canvas.getContext('2d')!;
    const c = canvas.width / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(c, c, c - 6, 0, Math.PI * 2);
    ctx.fillStyle = '#1b1e24';
    ctx.fill();
    // Remaining time (or the set time) as an arc.
    const show = this.remaining > 0 ? frac * (this.total / 3600) : minutes / 60;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, c - 14, -Math.PI / 2, -Math.PI / 2 + show * Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = this.running ? '#e0605b' : '#f4b860';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 64px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.remaining > 0 ? formatTime(this.remaining) : `${minutes}m`, c, c);
    texture.needsUpdate = true;
    // Knob points at the set time.
    this.dialKnob.rotation.y = -(minutes / 60) * Math.PI * 2;
  }

  /** The plant grows a leaf per completed card and flowers on a 3-day streak. */
  private updatePlant(): void {
    const leaves = Math.min(14, this.store.data.totalDone);
    const flower = this.store.currentStreak() >= 3;
    const key = `${leaves}|${flower}`;
    if (key === this.plantKey) return;
    this.plantKey = key;
    this.plant.clear();
    const pot = new Mesh(new CylinderGeometry(0.03, 0.024, 0.04, 20), new MeshStandardMaterial({ color: '#b4683f', roughness: 0.8 }));
    pot.position.y = 0.02;
    const height = 0.03 + leaves * 0.008;
    const stem = new Mesh(new CylinderGeometry(0.003, 0.004, height, 6), new MeshStandardMaterial({ color: '#3f8a4a' }));
    stem.position.y = 0.04 + height / 2;
    this.plant.add(pot, stem);
    const leafMat = new MeshStandardMaterial({ color: '#5fbf6a', roughness: 0.6 });
    for (let i = 0; i < leaves; i += 1) {
      const leaf = new Mesh(new SphereGeometry(0.012, 8, 6), leafMat);
      leaf.scale.set(1.4, 0.35, 0.7);
      const a = i * 2.4;
      leaf.position.set(Math.cos(a) * 0.014, 0.05 + i * 0.008, Math.sin(a) * 0.014);
      leaf.rotation.y = -a;
      this.plant.add(leaf);
    }
    if (flower) {
      const bloom = new Mesh(new SphereGeometry(0.012, 12, 8), new MeshStandardMaterial({ color: '#ff7a8a', emissive: '#4a1018' }));
      bloom.position.y = 0.045 + height;
      this.plant.add(bloom);
    }
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      zones: Object.fromEntries((['inbox', 'today', 'focus', 'done'] as Zone[]).map((z) => [z, this.store.zone(z).map((c) => c.text)])),
      running: this.running,
      remaining: Math.round(this.remaining),
      minutes: this.store.data.focusMinutes,
      streak: this.store.currentStreak(),
      holding: this.holds.length,
    };
  }

  debugActions = {
    cardWorld: (text: string) => {
      const card = this.store.cards.find((c) => c.text === text);
      const view = card && this.views.get(card.id);
      if (!view) return null;
      const p = view.mesh.getWorldPosition(new Vector3());
      return { x: p.x, y: p.y, z: p.z };
    },
    padWorld: () => this.worldOf(PAD),
    trayWorld: () => this.worldOf(TRAY),
    dialWorld: () => this.worldOf(DIAL),
    columnWorld: (zone: string) => {
      this.planner.updateMatrixWorld(true);
      const p = this.planner.localToWorld(new Vector3(COLUMN_X[zone] ?? 0, SLOT_TOP, 0.01));
      return { x: p.x, y: p.y, z: p.z };
    },
    press: (id: string) => this.panel.press(id),
    reset: () => {
      this.store.data = FocusStore.fresh();
      this.store.save();
      this.syncViews();
    },
  };

  private worldOf(local: Vector3): { x: number; y: number; z: number } {
    this.deskRoot.updateMatrixWorld(true);
    const p = this.deskRoot.localToWorld(local.clone().setY(0.02));
    return { x: p.x, y: p.y, z: p.z };
  }
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function labelPlane(text: string, width: number, color: string): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = '700 40px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(width, width / 4), new MeshBasicMaterial({ map: texture, transparent: true }));
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}
