/**
 * Sketch: pinch to draw in the air above your desk.
 *
 * Pinch and move to draw a tube stroke; let go to finish it. Both hands can
 * draw at once. Pick a colour and brush size on the panel, or swipe your
 * thumb to change colour and tap it to undo. Strokes live in desk space and
 * autosave, so a sketch is still there next session.
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
import type { HandState } from '../../core/hands.js';
import { ColorWheel } from '../../core/color-wheel.js';
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
function material(hex: string): MeshStandardMaterial {
  let m = materials.get(hex);
  if (!m) {
    m = new MeshStandardMaterial({ color: new Color(hex), roughness: 0.45, emissive: new Color(hex), emissiveIntensity: 0.15 });
    materials.set(hex, m);
  }
  return m;
}

interface SavedStroke {
  c: string;
  r: number;
  p: number[];
}

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
    readonly color: string,
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

  dispose(): void {
    this.joints.dispose();
    this.segments.dispose();
  }

  save(): SavedStroke {
    return { c: this.color, r: this.radius, p: this.points.flatMap((v) => [round(v.x), round(v.y), round(v.z)]) };
  }
}

const UP = new Vector3(0, 1, 0);
const round = (v: number) => Math.round(v * 10000) / 10000;

export class SketchPrototype implements Prototype {
  readonly id = 'sketch';
  readonly title = 'Sketch';
  readonly tagline = 'Pinch to draw in the air';
  readonly accent = ACCENTS.sketch;
  readonly howTo = [
    'Pinch and move to draw; let go to finish the stroke.',
    'Pinch BOTH hands together and pull apart for a snapshot.',
    'Pinch the colour wheel to pick a colour; tap your thumb to undo.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private strokes: Stroke[] = [];
  private live = new Map<HandState, { stroke: Stroke; smooth: Vector3 }>();
  private wheel!: ColorWheel;
  private colorHex = '#7fe0b5';
  private size = 1;
  private dirty = false;
  private saveTimer = 0;
  private readonly tmp = new Vector3();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.panel = new CanvasPanel({ width: 0.36, height: 0.12, columns: 4, buttonHeight: 0.034, accent: this.accent });
    this.panel.mesh.name = 'SketchPanel';
    this.panel.mesh.position.set(0.33, 0.09, -0.04);
    this.panel.mesh.rotation.set(-0.25, -0.5, 0, 'YXZ');
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    // Colour wheel on the left of the desk, angled toward you.
    this.wheel = new ColorWheel(0.15, this.colorHex);
    this.wheel.mesh.position.set(-0.33, 0.13, -0.02);
    this.wheel.mesh.rotation.set(-0.2, 0.5, 0, 'YXZ');
    this.wheel.onChange = (hex) => (this.colorHex = hex);
    this.deskRoot.add(this.wheel.mesh);
    this.load();
  }

  enter(): void {
    this.refresh();
  }

  exit(): void {
    this.endAll();
    this.save();
  }

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
    for (const hand of this.ctx.hands.both) {
      if (hand.gesture === 'right') this.wheel.cycleRecent(1);
      if (hand.gesture === 'left') this.wheel.cycleRecent(-1);
      if (hand.gesture === 'tap') this.undo();
    }
    if (this.wheel.mesh.visible) this.wheel.update(this.ctx.pointers);
    // Both hands pinched together to frame a shot: drop the strokes they began.
    if (this.ctx.frameArmed) {
      for (const [, live] of this.live) this.removeStroke(live.stroke);
      this.live.clear();
      this.refresh();
      return;
    }
    for (const hand of this.ctx.pointers) this.updateHand(hand);
    if (this.saveTimer > 0) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) this.save();
    }
    this.refresh();
  }

  private updateHand(hand: HandState): void {
    const live = this.live.get(hand);
    if (!live) {
      if (!hand.tracked || !hand.pinchStarted || this.panel.contains(hand.pinchPoint, 0.06)) return;
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
      if (live.stroke.points.length < 2) this.removeStroke(live.stroke);
      else {
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
    for (const [, live] of this.live) if (live.stroke.points.length < 2) this.removeStroke(live.stroke);
    this.live.clear();
  }

  private removeStroke(stroke: Stroke): void {
    this.strokes = this.strokes.filter((s) => s !== stroke);
    this.deskRoot.remove(stroke.group);
    stroke.dispose();
  }

  private undo(): void {
    const last = [...this.strokes].reverse().find((s) => ![...this.live.values()].some((l) => l.stroke === s));
    if (!last) return;
    this.removeStroke(last);
    this.saveTimer = 0.5;
    Sfx.blip(520);
  }

  private clear(): void {
    this.endAll();
    for (const s of [...this.strokes]) this.removeStroke(s);
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
  }

  private refresh(): void {
    const points = this.strokes.reduce((a, s) => a + s.points.length, 0);
    this.panel.setText(
      `Sketch - ${SIZES[this.size].name} brush`,
      '',
      this.ctx.immersive
        ? `Pinch and move to draw. ${this.strokes.length} stroke${this.strokes.length === 1 ? '' : 's'}.`
        : `Drag on the desk to draw. ${this.strokes.length} strokes, ${points} points.`,
    );
    this.panel.setButtons([
      { id: 'color', label: 'Colour', tone: this.wheel.mesh.visible ? 'active' : 'default' },
      { id: 'size', label: SIZES[this.size].name },
      { id: 'undo', label: 'Undo', disabled: this.strokes.length === 0 },
      { id: 'clear', label: 'Clear', disabled: this.strokes.length === 0 },
    ]);
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
    store.set(SAVE_KEY, saved);
    this.dirty = false;
  }

  private load(): void {
    for (const s of store.get<SavedStroke[]>(SAVE_KEY, [])) {
      const stroke = new Stroke(s.c, s.r);
      for (let i = 0; i + 2 < s.p.length; i += 3) stroke.add(this.tmp.set(s.p[i], s.p[i + 1], s.p[i + 2]));
      this.deskRoot.add(stroke.group);
      this.strokes.push(stroke);
    }
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      strokes: this.strokes.map((s) => ({ color: s.color, points: s.points.length })),
      drawing: this.live.size,
      color: this.colorHex,
      wheel: this.wheel.debug(),
      wheelVisible: this.wheel.mesh.visible,
      size: SIZES[this.size].name,
    };
  }

  debugActions = {
    press: (id: string) => this.panel.press(id),
    clear: () => this.clear(),
    wheelWorld: (x: number, y: number) => {
      const p = this.wheel.worldAt(x, y);
      this.wheel.mesh.updateMatrixWorld(true);
      const n = new Vector3(0, 0, 1).transformDirection(this.wheel.mesh.matrixWorld);
      return { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z };
    },
  };
}
