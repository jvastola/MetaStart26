/**
 * Clay: sculpt with your bare hands on a turntable on your desk.
 *
 *   Sculpt  - press fingertips into the clay to dent it; pinch near the
 *             surface and pull to drag clay out.
 *   Smooth  - rub with your fingertips to relax bumps.
 *   Inflate - hover fingertips to add clay where they touch.
 *   Mirror  - every stroke is mirrored left/right.
 * Pinch the turntable rim and drag around to spin it. Undo, reset, colour,
 * and export to .obj. The sculpt autosaves locally.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  TorusGeometry,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { type LabContext, type Prototype, store } from '../../core/context.js';
import { ACCENTS, blobShadow } from '../../core/art.js';
import type { HandState } from '../../core/hands.js';
import { ColorWheel } from '../../core/color-wheel.js';
import { DeskSlider } from '../../core/slider.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import {
  applyGrab,
  buildMirror,
  buildNeighbors,
  type Grab,
  grabAt,
  inflateAt,
  makeIcosphere,
  type Neighbors,
  nearestDistance,
  pushTips,
  smoothAt,
  toObj,
} from './sculpt.js';

type Tool = 'sculpt' | 'smooth' | 'inflate';

const RADIUS = 0.055;
const DETAIL = 22;
const TIP_RADIUS = 0.0075;
const PULL_RADIUS = 0.028;
const CLAY_Y = 0.08;
const TABLE_R = 0.1;
const SAVE_KEY = 'clay-sculpt-v1';
const CLAY_COLOR = '#c98b62';
const COLOR_KEY = 'clay-color-v1';
const SCALE_KEY = 'clay-scale-v1';
/** Slider 0..1 to sculpture scale 0.5x..2x (1x in the middle). */
const sliderToScale = (v: number): number => 0.5 * 4 ** v;

export class ClayPrototype implements Prototype {
  readonly id = 'clay';
  readonly title = 'Clay';
  readonly tagline = 'Sculpt with your fingertips';
  readonly accent = ACCENTS.clay;
  readonly howTo = [
    'Press your fingertips into the clay to dent it.',
    'Pinch the surface and pull to drag clay out.',
    'Pinch the gold rim and drag to spin the turntable.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private turntable = new Group();
  private clay!: Mesh;
  private geometry!: BufferGeometry;
  private positions!: Float32Array;
  private rest!: Float32Array;
  private neighbors!: Neighbors;
  private mirrorMap!: Int32Array;
  private material!: MeshStandardMaterial;
  private tool: Tool = 'sculpt';
  private mirror = true;
  private wheel!: ColorWheel;
  private sizeSlider!: DeskSlider;
  private dirty = false;
  private saveTimer = 0;
  private undo: Float32Array[] = [];
  private touching = false;
  private pulls: { hand: HandState; grab: Grab; start: Vector3 }[] = [];
  private spin: { hand: HandState; last: number } | null = null;
  private readonly tips = new Float32Array(20 * 3);
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    const base = new Mesh(new CylinderGeometry(TABLE_R, TABLE_R + 0.005, 0.016, 48), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.5 }));
    base.position.y = 0.008;
    const rim = new Mesh(new TorusGeometry(TABLE_R, 0.004, 8, 64), new MeshStandardMaterial({ color: '#f4b860', roughness: 0.4 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.016;
    const post = new Mesh(new CylinderGeometry(0.008, 0.008, CLAY_Y - RADIUS * 0.6, 12), new MeshStandardMaterial({ color: '#444a55' }));
    post.position.y = (CLAY_Y - RADIUS * 0.6) / 2 + 0.016;
    this.deskRoot.add(base, rim, blobShadow(0.3));
    this.turntable.add(post);
    this.deskRoot.add(this.turntable);

    const sphere = makeIcosphere(RADIUS, DETAIL);
    this.rest = Float32Array.from(sphere.positions);
    const saved = store.get<number[] | null>(SAVE_KEY, null);
    this.positions = saved && saved.length === sphere.positions.length ? Float32Array.from(saved) : sphere.positions;
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setIndex(new BufferAttribute(sphere.indices, 1));
    this.geometry.computeVertexNormals();
    this.neighbors = buildNeighbors(sphere.indices, this.positions.length / 3);
    this.mirrorMap = buildMirror(this.rest);
    const savedColor = store.get<string>(COLOR_KEY, CLAY_COLOR);
    this.material = new MeshStandardMaterial({ color: new Color(savedColor), roughness: 0.85 });
    this.clay = new Mesh(this.geometry, this.material);
    this.clay.name = 'Clay';
    this.clay.position.y = CLAY_Y;
    this.clay.frustumCulled = false;
    this.turntable.add(this.clay);

    this.panel = new CanvasPanel({ width: 0.36, height: 0.15, columns: 4, buttonHeight: 0.03, accent: this.accent });
    this.panel.mesh.name = 'ClayPanel';
    // Beside the turntable so the clay stays unobstructed.
    this.panel.mesh.position.set(0.31, 0.09, -0.04);
    this.panel.mesh.rotation.set(-0.25, -0.5, 0, 'YXZ');
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    // Colour wheel on the left: pinch to tint the clay.
    this.wheel = new ColorWheel(0.14, savedColor);
    this.wheel.mesh.position.set(-0.3, 0.13, 0);
    this.wheel.mesh.rotation.set(-0.2, 0.5, 0, 'YXZ');
    this.wheel.onChange = (hex) => this.setColor(hex);
    this.wheel.mesh.visible = false;
    this.deskRoot.add(this.wheel.mesh);

    // Size slider in front of the turntable: 0.5x to 2x, logarithmic.
    this.sizeSlider = new DeskSlider(0.2, store.get<number>(SCALE_KEY, 0.5), this.accent);
    this.sizeSlider.group.position.set(0, 0.006, 0.165);
    this.sizeSlider.format = (v) => `${sliderToScale(v).toFixed(1)}x`;
    this.sizeSlider.onChange = (v) => this.setScale(sliderToScale(v));
    this.deskRoot.add(this.sizeSlider.group);
    this.setScale(sliderToScale(this.sizeSlider.value));
  }

  enter(): void {
    this.refresh();
  }

  exit(): void {
    this.pulls = [];
    this.spin = null;
    this.save();
  }

  /** Scale the sculpture about its base so it keeps resting on the post. */
  private setScale(scale: number): void {
    this.clay.scale.setScalar(scale);
    this.clay.position.y = CLAY_Y + (scale - 1) * RADIUS * 0.6;
    store.set(SCALE_KEY, this.sizeSlider.value);
  }

  private setColor(hex: string): void {
    this.material.color.set(hex);
    store.set(COLOR_KEY, hex);
  }

  holding(): boolean {
    return this.pulls.length > 0 || this.spin != null || this.touching || this.wheel.active || this.sizeSlider.active;
  }

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
    if (this.wheel.mesh.visible) this.wheel.update(this.ctx.pointers);
    this.sizeSlider.update(this.ctx.pointers);
    if (this.sizeSlider.active) {
      this.refresh();
      return;
    }
    this.updateGestures();
    this.updateSpin();
    if (this.ctx.immersive) this.updateHands();
    else this.updateMouse();
    if (this.dirty) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.computeVertexNormals();
      this.geometry.computeBoundingSphere();
      this.dirty = false;
      this.saveTimer = 2;
    }
    if (this.saveTimer > 0) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) this.save();
    }
    this.refresh();
  }

  private updateGestures(): void {
    for (const hand of this.ctx.hands.both) {
      if (hand.gesture === 'left') this.turntable.rotation.y -= Math.PI / 8;
      if (hand.gesture === 'right') this.turntable.rotation.y += Math.PI / 8;
      if (hand.gesture === 'tap') this.cycleTool();
      if (hand.gesture === 'down') this.doUndo();
    }
  }

  /** Clay-local copy of a world point. */
  private local(world: Vector3, out: Vector3): Vector3 {
    out.copy(world);
    this.clay.updateMatrixWorld(true);
    return this.clay.worldToLocal(out);
  }

  private snapshot(): void {
    this.undo.push(Float32Array.from(this.positions));
    if (this.undo.length > 20) this.undo.shift();
  }

  private updateHands(): void {
    // Fingertips not involved in a pull act as the brush.
    let count = 0;
    for (const hand of this.ctx.hands.both) {
      if (!hand.tracked) continue;
      const pulling = this.pulls.some((p) => p.hand === hand) || this.spin?.hand === hand;
      if (pulling) continue;
      for (const tip of hand.tips) {
        const l = this.local(tip, this.tmp);
        if (l.length() > RADIUS * 2.5) continue;
        this.tips[count * 3] = l.x;
        this.tips[count * 3 + 1] = l.y;
        this.tips[count * 3 + 2] = l.z;
        count += 1;
        if (this.mirror) {
          this.tips[count * 3] = -l.x;
          this.tips[count * 3 + 1] = l.y;
          this.tips[count * 3 + 2] = l.z;
          count += 1;
        }
      }
    }

    // Start a stroke on first contact so it can be undone in one step.
    let contact = false;
    for (let t = 0; t < count; t += 1) {
      if (nearestDistance(this.positions, this.tips[t * 3], this.tips[t * 3 + 1], this.tips[t * 3 + 2]) < TIP_RADIUS / this.clay.scale.x) {
        contact = true;
        break;
      }
    }
    if (contact && !this.touching) this.snapshot();
    this.touching = contact;

    if (count > 0) {
      let moved = 0;
      const k = 1 / this.clay.scale.x;
      if (this.tool === 'sculpt') moved = pushTips(this.positions, this.tips, count, TIP_RADIUS * k);
      else {
        const normals = this.geometry.attributes.normal.array as Float32Array;
        for (let t = 0; t < count; t += 1) {
          const [x, y, z] = [this.tips[t * 3], this.tips[t * 3 + 1], this.tips[t * 3 + 2]];
          if (this.tool === 'smooth') moved += smoothAt(this.positions, this.neighbors, x, y, z, 0.016 * k, 0.35);
          else moved += inflateAt(this.positions, normals, x, y, z, 0.016 * k, 0.0006 * k);
        }
      }
      if (moved > 0) this.dirty = true;
    }

    // Pinch pulls.
    for (const hand of this.ctx.hands.both) {
      if (!hand.tracked || !hand.pinchStarted || this.panel.contains(hand.pinchPoint)) continue;
      const l = this.local(hand.pinchPoint, this.tmp);
      if (nearestDistance(this.positions, l.x, l.y, l.z) > 0.02 / this.clay.scale.x) continue;
      this.snapshot();
      this.pulls.push({ hand, grab: grabAt(this.positions, l.x, l.y, l.z, PULL_RADIUS / this.clay.scale.x, this.mirror ? this.mirrorMap : undefined), start: l.clone() });
      Sfx.pinch(hand.pinchPoint);
    }
    this.applyPulls();
  }

  private applyPulls(): void {
    for (let i = this.pulls.length - 1; i >= 0; i -= 1) {
      const pull = this.pulls[i];
      if (!pull.hand.pinching || !pull.hand.tracked) {
        this.pulls.splice(i, 1);
        continue;
      }
      const l = this.local(pull.hand.pinchPoint, this.tmp);
      applyGrab(this.positions, pull.grab, l.x - pull.start.x, l.y - pull.start.y, l.z - pull.start.z);
      this.dirty = true;
    }
  }

  /** Desktop: drag on the clay to pull it; smooth/inflate brush under the cursor. */
  private updateMouse(): void {
    const m = this.ctx.mouse;
    if (!m.tracked) return;
    if (m.pinchStarted && !this.spin) {
      const hit = this.raycastClay(m);
      if (hit) {
        this.snapshot();
        if (this.tool === 'sculpt') {
          const l = this.local(hit, this.tmp);
          this.pulls.push({ hand: m, grab: grabAt(this.positions, l.x, l.y, l.z, PULL_RADIUS / this.clay.scale.x, this.mirror ? this.mirrorMap : undefined), start: l.clone() });
          // Drag on a plane through the hit point, facing the camera.
          this.ctx.camera.getWorldDirection(this.tmp2).negate();
          this.ctx.setMousePlane(hit, this.tmp2);
        }
      }
    }
    if (this.tool === 'sculpt') {
      this.applyPulls();
      if (m.pinchEnded) {
        this.ctx.desk.getWorldPosition(this.tmp);
        this.ctx.setMousePlane(this.tmp, this.tmp2.set(0, 1, 0));
      }
      return;
    }
    if (m.pinching) {
      const hit = this.raycastClay(m);
      if (!hit) return;
      const l = this.local(hit, this.tmp);
      const normals = this.geometry.attributes.normal.array as Float32Array;
      const apply = (x: number) => {
        const k = 1 / this.clay.scale.x;
        if (this.tool === 'smooth') smoothAt(this.positions, this.neighbors, x, l.y, l.z, 0.018 * k, 0.4);
        else inflateAt(this.positions, normals, x, l.y, l.z, 0.018 * k, 0.0008 * k);
      };
      apply(l.x);
      if (this.mirror) apply(-l.x);
      this.dirty = true;
    }
  }

  private raycastClay(m: HandState): Vector3 | null {
    this.raycaster.set(m.rayOrigin, m.rayDir);
    const hits = this.raycaster.intersectObject(this.clay, false);
    return hits[0]?.point.clone() ?? null;
  }

  /** Pinch the turntable rim and drag around it to spin. */
  private updateSpin(): void {
    if (this.spin == null) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.pinchStarted) continue;
        this.tmp.copy(hand.pinchPoint);
        this.deskRoot.worldToLocal(this.tmp);
        const r = Math.hypot(this.tmp.x, this.tmp.z);
        if (r > TABLE_R - 0.025 && r < TABLE_R + 0.03 && this.tmp.y < 0.05 && this.tmp.y > -0.02) {
          this.spin = { hand, last: Math.atan2(this.tmp.x, this.tmp.z) };
          Sfx.pinch(hand.pinchPoint);
          return;
        }
      }
      return;
    }
    if (!this.spin.hand.pinching) {
      this.spin = null;
      return;
    }
    this.tmp.copy(this.spin.hand.pinchPoint);
    this.deskRoot.worldToLocal(this.tmp);
    const a = Math.atan2(this.tmp.x, this.tmp.z);
    let d = a - this.spin.last;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.turntable.rotation.y += d;
    this.spin.last = a;
  }

  // ------------------------------------------------------------ UI

  private cycleTool(): void {
    const order: Tool[] = ['sculpt', 'smooth', 'inflate'];
    this.tool = order[(order.indexOf(this.tool) + 1) % order.length];
    Sfx.blip(700);
  }

  private doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.positions.set(prev);
    this.dirty = true;
    Sfx.blip(500);
  }

  private onButton(id: string): void {
    if (id === 'sculpt' || id === 'smooth' || id === 'inflate') this.tool = id;
    if (id === 'mirror') this.mirror = !this.mirror;
    if (id === 'undo') this.doUndo();
    if (id === 'reset') {
      this.snapshot();
      this.positions.set(this.rest);
      this.dirty = true;
    }
    if (id === 'color') this.wheel.mesh.visible = !this.wheel.mesh.visible;
    if (id === 'export') this.exportObj();
  }

  private exportObj(): void {
    const text = toObj({ positions: this.positions, indices: this.geometry.index!.array as Uint32Array });
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'clay-sculpt.obj';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.ctx.toast('Exported clay-sculpt.obj');
    } catch {
      this.ctx.toast('Export is not available here.');
    }
  }

  private save(): void {
    store.set(SAVE_KEY, Array.from(this.positions, (v) => Math.round(v * 1e5) / 1e5));
  }

  private refresh(): void {
    const tips: Record<Tool, string> = {
      sculpt: this.ctx.immersive ? 'Press fingertips in to dent. Pinch the surface and pull to drag clay out.' : 'Drag on the clay to pull it out.',
      smooth: 'Rub the clay with your fingertips to smooth it.',
      inflate: 'Touch the clay to build it up.',
    };
    this.panel.setText(`Clay - ${this.tool}${this.mirror ? ' - mirrored' : ''} - size ${this.clay.scale.x.toFixed(1)}x`, '', [tips[this.tool], 'Spin: pinch the gold rim. Size: slide the knob in front.']);
    this.panel.setButtons([
      { id: 'sculpt', label: 'Sculpt', tone: this.tool === 'sculpt' ? 'active' : 'default' },
      { id: 'smooth', label: 'Smooth', tone: this.tool === 'smooth' ? 'active' : 'default' },
      { id: 'inflate', label: 'Inflate', tone: this.tool === 'inflate' ? 'active' : 'default' },
      { id: 'mirror', label: this.mirror ? 'Mirror on' : 'Mirror off', tone: this.mirror ? 'active' : 'default' },
      { id: 'color', label: 'Colour', tone: this.wheel.mesh.visible ? 'active' : 'default' },
      { id: 'undo', label: 'Undo', disabled: this.undo.length === 0 },
      { id: 'reset', label: 'Reset' },
      { id: 'export', label: 'Export' },
    ]);
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    let maxR = 0;
    let minR = Infinity;
    for (let v = 0; v < this.positions.length; v += 3) {
      const r = Math.hypot(this.positions[v], this.positions[v + 1], this.positions[v + 2]);
      maxR = Math.max(maxR, r);
      minR = Math.min(minR, r);
    }
    return { scale: +this.clay.scale.x.toFixed(2), wheelVisible: this.wheel.mesh.visible, tool: this.tool, mirror: this.mirror, maxR: +maxR.toFixed(4), minR: +minR.toFixed(4), undo: this.undo.length, spin: +this.turntable.rotation.y.toFixed(3) };
  }

  debugActions = {
    press: (id: string) => this.panel.press(id),
    clayWorld: (lx: number, ly: number, lz: number) => {
      this.clay.updateMatrixWorld(true);
      const p = this.clay.localToWorld(new Vector3(lx, ly, lz));
      return { x: p.x, y: p.y, z: p.z };
    },
    rimWorld: () => {
      this.deskRoot.updateMatrixWorld(true);
      const p = this.deskRoot.localToWorld(new Vector3(TABLE_R, 0.016, 0));
      return { x: p.x, y: p.y, z: p.z };
    },
    reset: () => this.onButton('reset'),
    sliderWorld: (v: number) => {
      const p = this.sizeSlider.worldAt(v);
      return { x: p.x, y: p.y, z: p.z };
    },
  };
}
