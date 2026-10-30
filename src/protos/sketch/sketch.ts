/**
 * Sketch: pinch to draw in the air above your desk.
 *
 * Pinch and move to draw a tube stroke; let go to finish it. Both hands can
 * draw at once. Pick a colour and brush size with the round buttons, or swipe your
 * thumb to change colour and tap it to undo. Strokes live in desk space and
 * autosave, so a sketch is still there next session.
 *
 * Grab a stroke with thumb + middle finger to pick it up and move it; it
 * follows your hand, rotation included. Thumb + index keeps drawing.
 *
 * Each stroke is two InstancedMeshes (joints and segments) that grow as you
 * draw, so nothing is rebuilt per frame.
 */

import {
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { ACCENTS } from '../../core/art.js';
import { type LabContext, type Prototype, store } from '../../core/context.js';
import { HeldPose } from '../../core/grab.js';
import type { HandState } from '../../core/hands.js';
import { ColorWheel } from '../../core/color-wheel.js';
import { IconButton } from '../../core/icon-button.js';
import { type Selectable, Selection, type SelectionSource } from '../../core/selection.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';

const SIZES = [
  { name: 'Fine', r: 0.0025 },
  { name: 'Medium', r: 0.005 },
  { name: 'Bold', r: 0.009 },
];
const MAX_POINTS = 1200;
const MIN_STEP = 0.004;
const SMOOTH = 0.55;
const SAVE_KEY = 'sketch-strokes-v1';
const MAX_SAVED_POINTS = 12000;

const sphere = new SphereGeometry(1, 12, 8);
const cylinder = new CylinderGeometry(1, 1, 1, 10, 1, true);
const materials = new Map<string, MeshStandardMaterial>();
function material(hex: string, lit = false): MeshStandardMaterial {
  const key = lit ? `${hex}*` : hex;
  let m = materials.get(key);
  if (!m) {
    m = new MeshStandardMaterial({ color: new Color(hex), roughness: 0.45, emissive: new Color(hex), emissiveIntensity: lit ? 0.7 : 0.15 });
    materials.set(key, m);
  }
  return m;
}

interface SavedStroke {
  c: string;
  r: number;
  p: number[];
  /** Where the stroke was moved to: position xyz + quaternion xyzw (+ scale). */
  t?: number[];
}

/** How close (metres, beyond the brush radius) a grab must be to take a stroke. */
const GRAB_REACH = 0.025;
/** Eraser reach beyond the brush radius. */
const ERASE_REACH = 0.015;
const MAX_HISTORY = 40;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

type HistoryEntry = { kind: 'add'; stroke: Stroke } | { kind: 'remove'; strokes: Stroke[] };

class Stroke {
  readonly group = new Group();
  readonly points: Vector3[] = [];
  private readonly joints: InstancedMesh;
  private readonly segments: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly mid = new Vector3();
  private readonly dir = new Vector3();

  constructor(
    public color: string,
    readonly radius: number,
  ) {
    this.joints = new InstancedMesh(sphere, material(color), MAX_POINTS);
    this.segments = new InstancedMesh(cylinder, material(color), MAX_POINTS);
    this.joints.count = 0;
    this.segments.count = 0;
    this.joints.frustumCulled = false;
    this.segments.frustumCulled = false;
    this.group.add(this.joints, this.segments);
  }

  get full(): boolean {
    return this.points.length >= MAX_POINTS;
  }

  add(p: Vector3): void {
    if (this.full) return;
    const i = this.points.length;
    const point = p.clone();
    this.points.push(point);
    this.m.makeScale(this.radius, this.radius, this.radius).setPosition(point);
    this.joints.setMatrixAt(i, this.m);
    this.joints.count = i + 1;
    this.joints.instanceMatrix.needsUpdate = true;
    if (i > 0) {
      const prev = this.points[i - 1];
      this.dir.subVectors(point, prev);
      const len = this.dir.length();
      this.mid.addVectors(point, prev).multiplyScalar(0.5);
      this.q.setFromUnitVectors(UP, this.dir.multiplyScalar(1 / Math.max(len, 1e-6)));
      this.s.set(this.radius, len, this.radius);
      this.m.compose(this.mid, this.q, this.s);
      this.segments.setMatrixAt(i - 1, this.m);
      this.segments.count = i;
      this.segments.instanceMatrix.needsUpdate = true;
    }
  }

  /** Glow while held so it is clear what you picked up. */
  setLit(on: boolean): void {
    this.joints.material = this.segments.material = material(this.color, on);
  }

  /** Distance (metres) from a world point to the nearest point on the stroke. */
  distanceTo(world: Vector3): number {
    this.group.updateMatrixWorld(true);
    const q = this.group.worldToLocal(world.clone());
    let best = Infinity;
    for (const p of this.points) best = Math.min(best, p.distanceToSquared(q));
    return Math.sqrt(best) * this.group.scale.x;
  }

  /** Repaint the whole stroke. */
  setColor(hex: string, lit: boolean): void {
    this.color = hex;
    this.setLit(lit);
  }

  /** World centre (the group origin, once recentred) and reach in metres. */
  bounds(center: Vector3): number {
    this.group.updateMatrixWorld(true);
    let c = new Vector3();
    for (const p of this.points) c.add(p);
    c = c.multiplyScalar(1 / Math.max(1, this.points.length));
    let r = 0;
    for (const p of this.points) r = Math.max(r, p.distanceTo(c));
    this.group.localToWorld(center.copy(c));
    return (r + this.radius) * this.group.scale.x;
  }

  /** Brush radius in metres, after scaling. */
  get worldRadius(): number {
    return this.radius * this.group.scale.x;
  }

  /**
   * Move the group origin to the middle of the stroke without moving the
   * stroke, so it scales and turns about its own centre.
   */
  recenter(): void {
    if (this.points.length === 0) return;
    const c = new Vector3();
    for (const p of this.points) c.add(p);
    c.multiplyScalar(1 / this.points.length);
    if (c.lengthSq() < 1e-12) return;
    const old = this.points.splice(0);
    this.joints.count = 0;
    this.segments.count = 0;
    for (const p of old) this.add(p.sub(c));
    this.group.position.add(c.multiply(this.group.scale).applyQuaternion(this.group.quaternion));
  }

  dispose(): void {
    this.joints.dispose();
    this.segments.dispose();
  }

  save(): SavedStroke {
    const out: SavedStroke = { c: this.color, r: this.radius, p: this.points.flatMap((v) => [round(v.x), round(v.y), round(v.z)]) };
    const { position: o, quaternion: q, scale } = this.group;
    if (o.lengthSq() > 1e-10 || Math.abs(q.w) < 1 - 1e-9 || scale.x !== 1) out.t = [o.x, o.y, o.z, q.x, q.y, q.z, q.w, scale.x].map(round6);
    return out;
  }
}

const UP = new Vector3(0, 1, 0);
const round = (v: number) => Math.round(v * 10000) / 10000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

type Triple = [number, number, number];

/** Lets another app (Studio) embed Sketch with its own layout and buttons. */
export interface SketchOptions {
  saveKey?: string;
  /** Where the round tool buttons sit (desk-local; Studio moves them as a window). */
  tools?: { position: Triple; rotation: Triple };
  wheel?: { position: Triple; rotation: Triple; visible?: boolean };
  /** A selection shared with other tools (Studio). Sketch makes its own otherwise. */
  selection?: () => Selection;
  /** Thumb microgestures (swipe colour, tap undo). Off when the host owns them. */
  gestures?: boolean;

}

export class SketchPrototype implements Prototype {
  readonly id = 'sketch';
  readonly title = 'Sketch';
  readonly tagline = 'Pinch to draw in the air';
  readonly accent = ACCENTS.sketch;
  readonly howTo = [
    'Pinch (thumb + index) and move to draw; let go to finish.',
    'Grab a stroke (thumb + MIDDLE) to move it; grab with both hands to scale.',
    'Drop it in the bin to delete, or use Erase. Undo brings it back.',
  ];
  readonly trash = true;
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private readonly buttons = new Map<string, IconButton>();
  private selection!: Selection;
  private ownSelection = false;
  private readonly selectables = new Map<Stroke, Selectable>();
  /** Lets a Selection find, move, copy, paint and delete strokes. */
  readonly selectionSource: SelectionSource = {
    items: () => this.strokes.filter((st) => !this.isBusy(st)).map((st) => this.selectableFor(st)),
    remove: (items) => this.removeStrokes(items.map((i) => this.strokeOf(i)).filter((st): st is Stroke => st != null)),
    duplicate: (items) => {
      const copies: Selectable[] = [];
      for (const item of items) {
        const st = this.strokeOf(item);
        if (!st) continue;
        const copy = new Stroke(st.color, st.radius);
        for (const pt of st.points) copy.add(pt);
        copy.group.position.copy(st.group.position).add(new Vector3(0.04, 0.02, 0));
        copy.group.quaternion.copy(st.group.quaternion);
        copy.group.scale.copy(st.group.scale);
        this.deskRoot.add(copy.group);
        this.strokes.push(copy);
        this.record({ kind: 'add', stroke: copy });
        copies.push(this.selectableFor(copy));
      }
      this.saveTimer = 0.8;
      return copies;
    },
    recolor: (items, hex) => {
      for (const item of items) this.strokeOf(item)?.setColor(hex, true);
      this.saveTimer = 0.8;
    },
    moved: () => {
      this.moves += 1;
      this.saveTimer = 0.8;
    },
  };
  private strokes: Stroke[] = [];
  private live = new Map<HandState, { stroke: Stroke; smooth: Vector3 }>();
  private held = new Map<HandState, { stroke: Stroke; pose: HeldPose }>();
  private twoHand: {
    stroke: Stroke;
    a: HandState;
    b: HandState;
    startDist: number;
    startAngle: number;
    startScale: number;
    startQuat: Quaternion;
    startPos: Vector3;
    startMid: Vector3;
  } | null = null;
  private history: HistoryEntry[] = [];
  private erasing = false;
  /** Select tool on: a pinch stretches a selection box instead of drawing. */
  selecting = false;
  private erased = 0;
  private moves = 0;
  /** Off when a host (Studio) closes the drawing tools: strokes stay, pinches do not draw. */
  drawEnabled = true;
  private wheel!: ColorWheel;
  private colorHex = '#7fe0b5';
  private size = 1;
  private dirty = false;
  private saveTimer = 0;
  private readonly tmp = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly saveKey: string;
  /** Holds the toolbar and colour wheel, so a host can move them as a window. */
  readonly toolsRoot = new Group();

  constructor(private readonly options: SketchOptions = {}) {
    this.saveKey = options.saveKey ?? SAVE_KEY;
  }

  init(ctx: LabContext): void {
    this.ctx = ctx;
    if (this.options.selection) this.selection = this.options.selection();
    else {
      this.selection = new Selection(ctx, this.accent);
      this.ownSelection = true;
      this.selection.armed = () => this.selecting;
      this.selection.paintColor = () => this.colorHex;
      this.deskRoot.add(this.selection.group);
    }
    this.selection.addSource(this.selectionSource);
    // Round tool buttons in a 3 x 2 grid.
    const tools: [string, string, string][] = [
      ['color', 'colour', 'Colour'],
      ['size', 'size', 'Brush size'],
      ['erase', 'erase', 'Erase'],
      ['select', 'select', 'Select (pinch and stretch a box)'],
      ['undo', 'undo', 'Undo'],
      ['clear', 'trash', 'Clear all'],
    ];
    tools.forEach(([id, icon, label], i) => {
      const b = new IconButton({ id: `sketch:${id}`, icon, label, accent: this.accent, radius: 0.016 });
      b.group.position.set(((i % 3) - 1) * 0.045, 0.001, (Math.floor(i / 3) - 0.5) * 0.045);
      b.onPress = () => this.onButton(id);
      this.buttons.set(id, b);
      this.toolsRoot.add(b.group);
    });
    // Left of centre, clear of the Home and How-to buttons on the corner.
    const pose = this.options.tools ?? { position: [-0.19, 0, 0.13], rotation: [0, 0.2, 0] };
    this.toolsRoot.position.set(...pose.position);
    this.toolsRoot.rotation.set(...pose.rotation, 'YXZ');
    this.deskRoot.add(this.toolsRoot);

    // Colour wheel on the left of the desk, angled toward you.
    this.wheel = new ColorWheel(0.15, this.colorHex);
    // Wheel position is relative to the tool buttons.
    const wheel = this.options.wheel ?? { position: [-0.14, 0.13, -0.15], rotation: [-0.2, 0.3, 0], visible: true };
    this.wheel.mesh.position.set(...wheel.position);
    this.wheel.mesh.rotation.set(...wheel.rotation, 'YXZ');
    this.wheel.mesh.visible = wheel.visible ?? true;
    this.wheel.onChange = (hex) => {
      this.colorHex = hex;
      this.erasing = false;
    };
    this.toolsRoot.add(this.wheel.mesh);
    this.load();
  }

  enter(): void {
    this.refresh();
  }

  exit(): void {
    this.endAll();
    this.dropAll();
    this.save();
  }

  update(dt: number): void {
    for (const hand of this.options.gestures === false ? [] : this.ctx.hands.both) {
      if (hand.gesture === 'right') this.wheel.cycleRecent(1);
      if (hand.gesture === 'left') this.wheel.cycleRecent(-1);
      if (hand.gesture === 'tap') this.undo();
    }
    if (this.wheel.mesh.visible && this.toolsRoot.visible) this.wheel.update(this.ctx.pointers);
    if (this.ownSelection) this.selection.update(dt);
    for (const hand of this.ctx.pointers) this.updateHold(hand);
    this.updateTwoHand();
    // Both hands pinched together to frame a shot: drop the strokes they began.
    if (this.ctx.frameArmed) {
      for (const [, live] of this.live) this.disposeStroke(live.stroke);
      this.live.clear();
      this.refresh();
      return;
    }
    for (const hand of this.ctx.pointers) {
      if (this.erasing) this.updateEraser(hand);
      else if (!this.selecting && !this.selection.owns(hand)) this.updateHand(hand);
    }
    if (this.saveTimer > 0) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) this.save();
    }
    this.refresh();
  }

  /**
   * Thumb + middle on a stroke picks it up. A second hand grabbing the same
   * stroke scales and turns it. A mouse left click is both a pinch and a grab
   * and keeps drawing; right-click or Shift-drag moves.
   */
  private updateHold(hand: HandState): void {
    const hold = this.held.get(hand);
    if (!hold) {
      if (!hand.tracked || !hand.grabStarted || hand.pinchStarted || this.live.has(hand)) return;
      const stroke = this.strokeNear(hand);
      if (!stroke) return;
      const other = [...this.held].find(([h, x]) => h !== hand && x.stroke === stroke)?.[0];
      const pose = new HeldPose();
      pose.begin(hand, stroke.group);
      this.held.set(hand, { stroke, pose });
      if (other) this.beginTwoHand(stroke, other, hand);
      stroke.setLit(true);
      Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
      return;
    }
    if (!hand.grabbing || !hand.tracked || !this.strokes.includes(hold.stroke)) {
      this.release(hand);
      return;
    }
    if (this.twoHand?.stroke === hold.stroke) return;
    hold.pose.apply(hand, hold.stroke.group);
    this.ctx.trash.near(hand.holdPoint);
  }

  private beginTwoHand(stroke: Stroke, a: HandState, b: HandState): void {
    const g = stroke.group;
    const pa = this.deskRoot.worldToLocal(a.holdPoint.clone());
    const pb = this.deskRoot.worldToLocal(b.holdPoint.clone());
    this.twoHand = {
      stroke,
      a,
      b,
      startDist: Math.max(pa.distanceTo(pb), 0.02),
      startAngle: Math.atan2(pb.x - pa.x, pb.z - pa.z),
      startScale: g.scale.x,
      startQuat: g.quaternion.clone(),
      startPos: g.position.clone(),
      startMid: pa.add(pb).multiplyScalar(0.5),
    };
  }

  /** Both hands on one stroke: pull apart to scale, turn around each other to rotate. */
  private updateTwoHand(): void {
    const t = this.twoHand;
    if (!t) return;
    const pa = this.deskRoot.worldToLocal(this.tmp.copy(t.a.holdPoint)).clone();
    const pb = this.deskRoot.worldToLocal(this.tmp.copy(t.b.holdPoint));
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (t.startScale * pa.distanceTo(pb)) / t.startDist));
    const turn = Math.atan2(pb.x - pa.x, pb.z - pa.z) - t.startAngle;
    const mid = pa.add(pb).multiplyScalar(0.5);
    const yaw = this.tmpQ.setFromAxisAngle(UP, turn);
    const g = t.stroke.group;
    g.scale.setScalar(scale);
    g.quaternion.copy(yaw).multiply(t.startQuat);
    // Scale and turn about the point between the hands, which also carries it.
    g.position.copy(t.startPos).sub(t.startMid).multiplyScalar(scale / t.startScale).applyQuaternion(yaw).add(mid);
  }

  private release(hand: HandState): void {
    const hold = this.held.get(hand);
    if (!hold) return;
    this.held.delete(hand);
    const stroke = hold.stroke;
    if (this.twoHand?.stroke === stroke) {
      // One hand let go: the other keeps holding from where things are now.
      const other = this.twoHand.a === hand ? this.twoHand.b : this.twoHand.a;
      this.twoHand = null;
      const rest = this.held.get(other);
      if (rest) rest.pose.begin(other, stroke.group);
      this.saveTimer = 0.8;
      return;
    }
    stroke.setLit(false);
    if (!this.strokes.includes(stroke)) return;
    if (this.ctx.trash.take(hand.holdPoint)) {
      this.removeStrokes([stroke]);
      return;
    }
    this.moves += 1;
    this.saveTimer = 0.8;
    Sfx.place(stroke.group.getWorldPosition(this.tmp));
  }

  private dropAll(): void {
    this.twoHand = null;
    for (const hand of [...this.held.keys()]) this.release(hand);
  }

  /** Erase mode: a pinch sweeps away every stroke it touches. */
  private updateEraser(hand: HandState): void {
    if (!hand.tracked || !hand.pinching || this.held.has(hand)) return;
    if (hand.pinchStarted && (CanvasPanel.anyContains(hand.pinchPoint, 0.05) || this.onWheel(hand))) return;
    const hit = this.strokes.filter((s) => !this.isBusy(s) && s.distanceTo(hand.pinchPoint) - s.worldRadius < ERASE_REACH);
    if (hit.length === 0) return;
    this.removeStrokes(hit);
    this.erased += hit.length;
    Sfx.erase(hand.isMouse ? undefined : hand.pinchPoint);
  }

  private selectableFor(stroke: Stroke): Selectable {
    let s = this.selectables.get(stroke);
    if (!s) {
      s = {
        object: stroke.group,
        source: this.selectionSource,
        bounds: (c) => stroke.bounds(c),
        distance: (w) => stroke.distanceTo(w) - stroke.worldRadius,
        setLit: (on) => stroke.setLit(on),
      };
      this.selectables.set(stroke, s);
    }
    return s;
  }

  private strokeOf(item: Selectable): Stroke | undefined {
    for (const [st, sel] of this.selectables) if (sel === item) return st;
    return undefined;
  }

  private isBusy(stroke: Stroke): boolean {
    return [...this.live.values()].some((l) => l.stroke === stroke) || [...this.held.values()].some((h) => h.stroke === stroke);
  }

  private strokeNear(hand: HandState): Stroke | null {
    let best: Stroke | null = null;
    let bestDist = Infinity;
    for (const stroke of this.strokes) {
      if ([...this.live.values()].some((l) => l.stroke === stroke)) continue;
      const d = stroke.distanceTo(hand.holdPoint) - stroke.worldRadius;
      if (d < GRAB_REACH && d < bestDist) {
        best = stroke;
        bestDist = d;
      }
    }
    return best;
  }

  private updateHand(hand: HandState): void {
    const live = this.live.get(hand);
    if (!live) {
      if (this.held.has(hand) || !this.drawEnabled) return;
      if (!hand.tracked || !hand.pinchStarted) return;
      // Pinches on any other showing panel (Conjure in Studio, say) press it instead.
      if (CanvasPanel.anyContains(hand.pinchPoint, 0.05)) return;
      if (this.wheel.active || this.onWheel(hand)) return;
      const stroke = new Stroke(this.colorHex, SIZES[this.size].r);
      this.deskRoot.add(stroke.group);
      this.strokes.push(stroke);
      const start = this.deskRoot.worldToLocal(this.tmp.copy(hand.pinchPoint));
      stroke.add(start);
      this.live.set(hand, { stroke, smooth: start.clone() });
      Sfx.pinch(hand.pinchPoint);
      return;
    }
    if (!hand.pinching || !hand.tracked || live.stroke.full) {
      this.live.delete(hand);
      if (live.stroke.points.length < 2) this.disposeStroke(live.stroke);
      else {
        live.stroke.recenter();
        this.record({ kind: 'add', stroke: live.stroke });
        this.dirty = true;
        this.saveTimer = 1.5;
      }
      return;
    }
    // Smooth the hand jitter, then add a point every few millimetres.
    const target = this.deskRoot.worldToLocal(this.tmp.copy(hand.pinchPoint));
    live.smooth.lerp(target, SMOOTH);
    const last = live.stroke.points[live.stroke.points.length - 1];
    if (last.distanceTo(live.smooth) >= MIN_STEP) live.stroke.add(live.smooth);
  }

  private endAll(): void {
    for (const [, live] of this.live) {
      if (live.stroke.points.length < 2) this.disposeStroke(live.stroke);
      else {
        live.stroke.recenter();
        this.record({ kind: 'add', stroke: live.stroke });
      }
    }
    this.live.clear();
  }

  /** Gone for good (never drawn properly, or dropped out of the undo history). */
  private disposeStroke(stroke: Stroke): void {
    this.strokes = this.strokes.filter((s) => s !== stroke);
    this.deskRoot.remove(stroke.group);
    stroke.dispose();
  }

  /** Remove strokes but keep them for Undo. */
  private removeStrokes(strokes: Stroke[]): void {
    for (const s of strokes) {
      this.strokes = this.strokes.filter((x) => x !== s);
      this.deskRoot.remove(s.group);
      s.setLit(false);
    }
    this.record({ kind: 'remove', strokes });
    this.saveTimer = 0.5;
  }

  private record(entry: HistoryEntry): void {
    this.history.push(entry);
    while (this.history.length > MAX_HISTORY) {
      const old = this.history.shift()!;
      // Strokes removed that long ago can no longer come back.
      if (old.kind === 'remove') for (const s of old.strokes) if (!this.strokes.includes(s)) s.dispose();
    }
  }

  /** Undo the last add, erase, bin drop or clear. */
  private undo(): void {
    const entry = this.history.pop();
    if (!entry) return;
    if (entry.kind === 'add') {
      if (this.isBusy(entry.stroke)) this.dropAll();
      if (this.strokes.includes(entry.stroke)) this.disposeStroke(entry.stroke);
    } else {
      for (const s of entry.strokes) {
        if (this.strokes.includes(s)) continue;
        this.deskRoot.add(s.group);
        this.strokes.push(s);
      }
    }
    this.saveTimer = 0.5;
    Sfx.blip(520);
  }

  private clear(): void {
    this.endAll();
    this.dropAll();
    if (this.strokes.length) this.removeStrokes([...this.strokes]);
    this.saveTimer = 0.5;
    Sfx.whoosh();
  }

  /** Pinches that land on the colour wheel pick colours instead of drawing. */
  private onWheel(hand: HandState): boolean {
    if (hand.isMouse) return false; // the wheel claims mouse drags itself
    const q = this.wheel.mesh.worldToLocal(this.tmp.copy(hand.pinchPoint));
    return Math.abs(q.z) < 0.05 && Math.abs(q.x) < 0.09 && Math.abs(q.y) < 0.11;
  }

  private onButton(id: string): void {
    if (id === 'size') this.size = (this.size + 1) % SIZES.length;
    if (id === 'color') this.wheel.mesh.visible = !this.wheel.mesh.visible;
    if (id === 'undo') this.undo();
    if (id === 'clear') this.clear();
    if (id === 'erase') {
      this.erasing = !this.erasing;
      if (this.erasing) this.selecting = false;
    }
    if (id === 'select') {
      this.selecting = !this.selecting;
      if (this.selecting) this.erasing = false;
    }
  }

  /** The current brush colour (for painting a selection). */
  get brushColor(): string {
    return this.colorHex;
  }

  /** Something is in hand (a stroke being moved). Drawing does not count, so snapshots still work. */
  holding(): boolean {
    return this.held.size > 0 || (this.erasing && this.ctx.pointers.some((p) => p.pinching));
  }

  /** True if this hand is drawing or moving a stroke. */
  busyWith(hand: HandState): boolean {
    return this.held.has(hand) || this.live.has(hand);
  }

  /** Buttons light up when their mode is on and dim when there is nothing to act on. */
  private refresh(): void {
    const set = (id: string, active: boolean, disabled = false): void => {
      const b = this.buttons.get(id)!;
      b.active = active;
      b.disabled = disabled;
    };
    set('color', this.wheel.mesh.visible);
    set('erase', this.erasing);
    set('select', this.selecting);
    set('undo', false, this.history.length === 0);
    set('clear', false, this.strokes.length === 0);
    this.buttons.get('size')!.label = `Brush: ${SIZES[this.size].name}`;
  }

  // ------------------------------------------------------------ persistence

  private save(): void {
    let budget = MAX_SAVED_POINTS;
    const saved: SavedStroke[] = [];
    for (const s of [...this.strokes].reverse()) {
      if (s.points.length > budget) break;
      budget -= s.points.length;
      saved.unshift(s.save());
    }
    store.set(this.saveKey, saved);
    this.dirty = false;
  }

  private load(): void {
    for (const s of store.get<SavedStroke[]>(this.saveKey, [])) {
      const stroke = new Stroke(s.c, s.r);
      for (let i = 0; i + 2 < s.p.length; i += 3) stroke.add(this.tmp.set(s.p[i], s.p[i + 1], s.p[i + 2]));
      if (s.t && s.t.length >= 7) {
        stroke.group.position.set(s.t[0], s.t[1], s.t[2]);
        stroke.group.quaternion.set(s.t[3], s.t[4], s.t[5], s.t[6]).normalize();
        if (s.t[7]) stroke.group.scale.setScalar(s.t[7]);
      }
      // Older saves kept points in desk space: pivot them about their centre.
      stroke.recenter();
      this.deskRoot.add(stroke.group);
      this.strokes.push(stroke);
    }
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      strokes: this.strokes.map((s) => ({ color: s.color, points: s.points.length })),
      drawing: this.live.size,
      holding: this.held.size,
      twoHand: this.twoHand != null,
      scales: this.strokes.map((s) => +s.group.scale.x.toFixed(3)),
      erasing: this.erasing,
      selecting: this.selecting,
      selection: this.ownSelection ? this.selection.debug() : null,
      erased: this.erased,
      history: this.history.length,
      moves: this.moves,
      offsets: this.strokes.map((s) => s.group.position.toArray().map(round)),
      color: this.colorHex,
      wheel: this.wheel.debug(),
      wheelVisible: this.wheel.mesh.visible,
      size: SIZES[this.size].name,
    };
  }

  debugActions = {
    press: (id: string) => this.onButton(id),
    clear: () => this.clear(),
    /** World position of a stroke's point, for aiming a test grab. */
    strokePoint: (stroke: number, point: number) => {
      const s = this.strokes[stroke];
      if (!s) return null;
      s.group.updateMatrixWorld(true);
      const p = s.group.localToWorld(s.points[Math.min(point, s.points.length - 1)].clone());
      return { x: p.x, y: p.y, z: p.z };
    },
    wheelWorld: (x: number, y: number) => {
      const p = this.wheel.worldAt(x, y);
      this.wheel.mesh.updateMatrixWorld(true);
      const n = new Vector3(0, 0, 1).transformDirection(this.wheel.mesh.matrixWorld);
      return { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z };
    },
  };
}
