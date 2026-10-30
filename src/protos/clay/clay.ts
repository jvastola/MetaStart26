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
 *
 * Print makes a solid copy of the sculpture that "prints" up from a pad
 * beside the turntable. Grab a print with thumb + middle finger to pick it
 * up; let go low over the desk and it settles onto the desk. The small pin
 * in front of a print keeps it where it is: pinned prints cannot be knocked
 * about, survive Clear prints, and are still there next session.
 *
 * Grab the turntable base (thumb + middle) and raise or lower your hand to
 * scale the sculpture; the size slider follows.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Mesh,
  MeshStandardMaterial,
  Plane,
  Raycaster,
  RingGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { type LabContext, type Prototype, store } from '../../core/context.js';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { HeldPose } from '../../core/grab.js';
import { grabDistance, type HandState } from '../../core/hands.js';
import { ColorWheel } from '../../core/color-wheel.js';
import { DeskSlider } from '../../core/slider.js';
import { IconButton } from '../../core/icon-button.js';
import type { Selectable, SelectionSource } from '../../core/selection.js';
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
const SCALE_KEY = 'clay-scale-v2';
const BRUSH_KEY = 'clay-brush-v1';
/** Where prints appear, desk-local. */
const PRINT_PAD = new Vector3(-0.19, 0, 0.07);
const MAX_PRINTS = 6;
const PRINT_TIME = 1.6;

interface Print {
  holder: Group;
  mesh: Mesh;
  material: MeshStandardMaterial;
  height: number;
  /** 0..1 while printing, then 1. */
  progress: number;
  /** Clip plane in world space that rises as the print builds. */
  clip: Plane;
  settleTo: number | null;
  pinned: boolean;
  pinButton: IconButton;
}

/** A pinned print as saved: vertex positions (base64 float32), colour, transform. */
interface SavedPrint {
  v: string;
  c: string;
  /** Mesh scale, rotation and lift inside its holder. */
  m: [number, number, number];
  /** Holder position xyz, quaternion xyzw, scale. */
  t: number[];
  h: number;
}

const PINS_KEY = 'clay-pinned-v1';
const MAX_PINNED = 4;

function toBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromBase64(text: string): Float32Array {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Lets Studio embed Clay as a compact window with its own saved sculpt. */
export interface ClayOptions {
  /** Prefix for saved keys, so an embedded copy keeps its own sculpt. */
  keyPrefix?: string;
  /** 'compact' puts the panel behind the turntable, so the whole tool is narrow. */
  layout?: 'full' | 'compact';
  /** Thumb microgestures (spin, tool, undo). Off when the host owns them. */
  gestures?: boolean;
  /** Where finished prints live, so they stay put when the tool moves. */
  printsParent?: Group;
}

/** Slider 0..1 to sculpture scale 0.5x..5x (logarithmic; 1x at about 30%). */
const sliderToScale = (v: number): number => 0.5 * 10 ** v;
const ONE_X = Math.log10(2);
/** Slider 0..1 to brush size 0.5x..2.5x (1x at 25%). */
const sliderToBrush = (v: number): number => 0.5 + v * 2;

/** The round buttons around the turntable, left to right. */
const BUTTONS: [id: string, icon: string, label: string][] = [
  ['sculpt', 'sculpt', 'Sculpt: press in, pinch to pull'],
  ['smooth', 'smooth', 'Smooth'],
  ['inflate', 'inflate', 'Inflate'],
  ['mirror', 'mirror', 'Mirror'],
  ['spin', 'spin', 'Auto spin'],
  ['color', 'colour', 'Colour'],
  ['undo', 'undo', 'Undo'],
  ['reset', 'reset', 'Reset'],
  ['print', 'print', 'Print a copy'],
  ['clearPrints', 'trash', 'Clear prints'],
  ['export', 'export', 'Export .obj'],
];

export class ClayPrototype implements Prototype {
  readonly id = 'clay';
  readonly title = 'Clay';
  readonly tagline = 'Sculpt with your fingertips';
  readonly accent = ACCENTS.clay;
  readonly howTo = [
    'Press fingertips in to dent; pinch the surface and pull clay out.',
    'Round buttons pick tools; hover one to see its name.',
    'Grab the base (thumb + middle) and raise your hand to make it bigger.',
    'Print a copy, then grab it with thumb + middle finger.',
  ];
  readonly trash = true;
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private readonly buttons = new Map<string, IconButton>();
  private brushSlider!: DeskSlider;
  private brush = 1;
  private autoSpin = false;
  private layoutMode: 'full' | 'compact' = 'full';
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
  private prints: Print[] = [];
  private printHolds: { print: Print; hand: HandState; pose: HeldPose }[] = [];
  private printPad!: Mesh;
  private readonly printSelectables = new Map<Print, Selectable>();
  /** Lets a Selection find, move, copy, paint and delete prints. */
  readonly selectionSource: SelectionSource = {
    items: () => this.prints.filter((p) => p.progress >= 1 && !p.pinned && !this.printHolds.some((h) => h.print === p)).map((p) => this.selectableFor(p)),
    // The turntable base and prints take a grab themselves: not an air grab.
    grabbable: (w) => this.onBase(w) || this.prints.some((p) => p.holder.getWorldPosition(this.tmp2).distanceTo(w) < Math.max(0.05, p.height * 0.7)),
    remove: (items) => {
      for (const sel of items) {
        const p = this.printOf(sel);
        if (p) this.removePrint(p);
      }
    },
    duplicate: (items) => {
      const out: Selectable[] = [];
      for (const sel of items) {
        const p = this.printOf(sel);
        if (!p) continue;
        const mesh = p.mesh.clone();
        mesh.geometry = p.mesh.geometry.clone();
        const material = p.material.clone();
        material.clippingPlanes = null;
        mesh.material = material;
        const holder = new Group();
        holder.add(mesh);
        holder.position.copy(p.holder.position).add(new Vector3(0.06, 0, 0.03));
        holder.quaternion.copy(p.holder.quaternion);
        holder.scale.copy(p.holder.scale);
        (p.holder.parent ?? this.deskRoot).add(holder);
        const pinButton = new IconButton({ id: `clay:pin:${(this.printed += 1)}`, icon: 'pin', label: 'Pin it here', accent: this.accent, radius: 0.01 });
        pinButton.group.position.copy(p.pinButton.group.position);
        holder.add(pinButton.group);
        const copy: Print = { holder, mesh, material, height: p.height, progress: 1, clip: p.clip.clone(), settleTo: null, pinned: false, pinButton };
        pinButton.onPress = () => this.togglePin(copy);
        this.prints.push(copy);
        out.push(this.selectableFor(copy));
      }
      return out;
    },
    recolor: (items, hex) => {
      for (const sel of items) this.printOf(sel)?.material.color.set(hex);
    },
  };

  private selectableFor(p: Print): Selectable {
    let sel = this.printSelectables.get(p);
    if (!sel) {
      sel = {
        object: p.holder,
        source: this.selectionSource,
        bounds: (c) => {
          p.holder.updateMatrixWorld(true);
          p.holder.localToWorld(c.set(0, p.height / 2, 0));
          return Math.max(0.04, p.height * 0.6) * p.holder.scale.x;
        },
      };
      this.printSelectables.set(p, sel);
    }
    return sel;
  }

  private printOf(sel: Selectable): Print | undefined {
    for (const [p, s] of this.printSelectables) if (s === sel) return p;
    return undefined;
  }
  private printed = 0;
  private readonly tips = new Float32Array(20 * 3);
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly raycaster = new Raycaster();
  private readonly euler = new Euler();
  private readonly keys: { sculpt: string; color: string; scale: string; brush: string; pins: string };
  private readonly printPadAt: Vector3;

  constructor(private readonly options: ClayOptions = {}) {
    const prefix = options.keyPrefix ?? '';
    this.keys = { sculpt: prefix + SAVE_KEY, color: prefix + COLOR_KEY, scale: prefix + SCALE_KEY, brush: prefix + BRUSH_KEY, pins: prefix + PINS_KEY };
    this.layoutMode = options.layout ?? 'full';
    this.printPadAt = new Vector3();
  }
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
    const saved = store.get<number[] | null>(this.keys.sculpt, null);
    this.positions = saved && saved.length === sphere.positions.length ? Float32Array.from(saved) : sphere.positions;
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setIndex(new BufferAttribute(sphere.indices, 1));
    this.geometry.computeVertexNormals();
    this.neighbors = buildNeighbors(sphere.indices, this.positions.length / 3);
    this.mirrorMap = buildMirror(this.rest);
    const savedColor = store.get<string>(this.keys.color, CLAY_COLOR);
    this.material = new MeshStandardMaterial({ color: new Color(savedColor), roughness: 0.85 });
    this.clay = new Mesh(this.geometry, this.material);
    this.clay.name = 'Clay';
    this.clay.position.y = CLAY_Y;
    this.clay.frustumCulled = false;
    this.turntable.add(this.clay);

    // Round buttons in an arc in front of the turntable: icons, no text.
    for (const [id, icon, label] of BUTTONS) {
      const b = new IconButton({ id: `clay:${id}`, icon, label, accent: this.accent, radius: 0.015 });
      b.onPress = () => this.onButton(id);
      this.buttons.set(id, b);
      this.deskRoot.add(b.group);
    }

    // Colour wheel on the left: pinch to tint the clay.
    this.wheel = new ColorWheel(0.14, savedColor);
    this.wheel.onChange = (hex) => this.setColor(hex);
    this.wheel.mesh.visible = false;
    this.deskRoot.add(this.wheel.mesh);

    // Size slider in front of the turntable: 0.5x to 2x, logarithmic.
    this.sizeSlider = new DeskSlider(0.16, store.get<number>(this.keys.scale, ONE_X), this.accent);
    this.sizeSlider.format = (v) => `Size ${sliderToScale(v).toFixed(1)}x`;
    this.sizeSlider.onChange = (v) => this.setScale(sliderToScale(v));
    this.deskRoot.add(this.sizeSlider.group);
    this.setScale(sliderToScale(this.sizeSlider.value));
    // Brush size: how wide a press, pull or rub reaches.
    this.brushSlider = new DeskSlider(0.16, store.get<number>(this.keys.brush, 0.25), '#f4b860');
    this.brushSlider.format = (v) => `Brush ${sliderToBrush(v).toFixed(1)}x`;
    this.brushSlider.onChange = (v) => {
      this.brush = sliderToBrush(v);
      store.set(this.keys.brush, v);
    };
    this.brush = sliderToBrush(this.brushSlider.value);
    this.deskRoot.add(this.brushSlider.group);

    // Print pad: a glowing ring where copies build up.
    this.printPad = new Mesh(new RingGeometry(0.045, 0.052, 48), new MeshStandardMaterial({ color: '#f4b860', emissive: '#f4b860', emissiveIntensity: 0.4, transparent: true, opacity: 0.7 }));
    this.printPad.rotation.x = -Math.PI / 2;
    this.printPad.userData.hideInShots = true;
    this.deskRoot.add(this.printPad);
    this.setLayout(this.layoutMode);
    this.loadPins();
    // Prints build up behind a clipping plane.
    ctx.renderer.localClippingEnabled = true;
  }

  enter(): void {
    this.refresh();
  }

  exit(): void {
    this.pulls = [];
    this.spin = null;
    this.printHolds = [];
    this.save();
  }

  /** Scale the sculpture about its base so it keeps resting on the post. */
  private setScale(scale: number): void {
    this.clay.scale.setScalar(scale);
    this.clay.position.y = CLAY_Y - RADIUS + RADIUS * scale;
    store.set(this.keys.scale, this.sizeSlider.value);
  }

  /** Fold the controls away (Studio, when no hand is near) or bring them back. */
  setControlsVisible(on: boolean): void {
    for (const b of this.buttons.values()) b.group.visible = on;
    this.sizeSlider.group.visible = on;
    this.brushSlider.group.visible = on;
    this.printPad.visible = on;
    if (!on) {
      this.wheelWanted = this.wheel.mesh.visible;
      this.wheel.mesh.visible = false;
    } else if (this.wheelWanted) this.wheel.mesh.visible = true;
  }

  private wheelWanted = false;
  /** Grab on the turntable base: raise or lower the hand to scale the sculpture. */
  private baseGrab: { hand: HandState; y0: number; v0: number; step: number } | null = null;

  /** True if a world point is on the turntable base (where a grab scales). */
  private onBase(world: Vector3): boolean {
    const l = this.deskRoot.worldToLocal(this.tmp2.copy(world));
    return Math.hypot(l.x, l.z) < TABLE_R + 0.025 && l.y < 0.045 && l.y > -0.02;
  }

  private updateBaseGrab(): void {
    if (!this.baseGrab) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.grabStarted || this.owns(hand) || !this.onBase(hand.holdPoint)) continue;
        const l = this.deskRoot.worldToLocal(this.tmp.copy(hand.holdPoint));
        this.baseGrab = { hand, y0: l.y, v0: this.sizeSlider.value, step: Math.round(this.sizeSlider.value * 20) };
        if (hand.isMouse) {
          // Slide on a plane facing the camera, so moving the mouse up raises the hand.
          this.ctx.camera.getWorldDirection(this.tmp2).negate();
          this.ctx.setMousePlane(hand.holdPoint, this.tmp2);
        }
        hand.clearEdges();
        Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
        return;
      }
      return;
    }
    const g = this.baseGrab;
    if (!g.hand.grabbing || !g.hand.tracked) {
      this.baseGrab = null;
      if (g.hand.isMouse) {
        this.ctx.desk.getWorldPosition(this.tmp);
        this.ctx.setMousePlane(this.tmp, this.tmp2.set(0, 1, 0));
      }
      Sfx.place();
      return;
    }
    // 20 cm of height covers the whole range (0.5x to 5x).
    const l = this.deskRoot.worldToLocal(this.tmp.copy(g.hand.holdPoint));
    const v = Math.min(1, Math.max(0, g.v0 + (l.y - g.y0) / 0.2));
    this.sizeSlider.set(v);
    this.setScale(sliderToScale(v));
    const step = Math.round(v * 20);
    if (step !== g.step) {
      g.step = step;
      Sfx.blip(400 + step * 30);
    }
  }

  /**
   * 'full': buttons in a wide arc in front, sliders on the right, prints on
   * the left. 'compact' (a Studio window): a tighter arc, sliders behind the
   * turntable, prints back right.
   */
  setLayout(mode: 'full' | 'compact'): void {
    this.layoutMode = mode;
    const full = mode === 'full';
    const r = full ? 0.17 : 0.15;
    const span = (75 * Math.PI) / 180;
    BUTTONS.forEach(([id], i) => {
      const a = -span + (2 * span * i) / (BUTTONS.length - 1);
      this.buttons.get(id)!.group.position.set(Math.sin(a) * r, 0.001, Math.cos(a) * r);
    });
    if (full) {
      this.sizeSlider.group.position.set(0.3, 0.006, 0.02);
      this.brushSlider.group.position.set(0.3, 0.006, 0.1);
      this.printPadAt.set(-0.29, 0, 0.0);
      this.wheel.mesh.position.set(-0.3, 0.14, -0.04);
      this.wheel.mesh.rotation.set(-0.2, 0.5, 0, 'YXZ');
    } else {
      this.sizeSlider.group.position.set(0, 0.006, -0.165);
      this.brushSlider.group.position.set(0, 0.006, -0.215);
      this.printPadAt.set(0.155, 0, -0.13);
      this.wheel.mesh.position.set(0.27, 0.13, 0);
      this.wheel.mesh.rotation.set(-0.2, -0.5, 0, 'YXZ');
    }
    this.printPad.position.copy(this.printPadAt).setY(0.002);
  }

  private setColor(hex: string): void {
    this.material.color.set(hex);
    store.set(this.keys.color, hex);
  }

  /** True if this hand is pulling clay, spinning the turntable or carrying a print. */
  owns(hand: HandState): boolean {
    return this.pulls.some((p) => p.hand === hand) || this.spin?.hand === hand || this.printHolds.some((p) => p.hand === hand) || this.baseGrab?.hand === hand;
  }

  holding(): boolean {
    return this.pulls.length > 0 || this.printHolds.length > 0 || this.spin != null || this.baseGrab != null || this.touching || this.wheel.active || this.sizeSlider.active || this.brushSlider.active;
  }

  update(dt: number): void {
    if (this.wheel.mesh.visible) this.wheel.update(this.ctx.pointers);
    this.sizeSlider.update(this.ctx.pointers);
    if (!this.sizeSlider.active) this.brushSlider.update(this.ctx.pointers);
    if (this.autoSpin && this.spin == null) this.turntable.rotation.y += dt * 0.6;
    if (this.sizeSlider.active || this.brushSlider.active) {
      this.refresh();
      return;
    }
    this.updatePrints(dt);
    this.updateBaseGrab();
    if (this.options.gestures !== false) this.updateGestures();
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
      const pulling = this.pulls.some((p) => p.hand === hand) || this.spin?.hand === hand || this.printHolds.some((p) => p.hand === hand);
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
      if (nearestDistance(this.positions, this.tips[t * 3], this.tips[t * 3 + 1], this.tips[t * 3 + 2]) < (TIP_RADIUS * this.brush) / this.clay.scale.x) {
        contact = true;
        break;
      }
    }
    if (contact && !this.touching) this.snapshot();
    this.touching = contact;

    if (count > 0) {
      let moved = 0;
      const k = 1 / this.clay.scale.x;
      if (this.tool === 'sculpt') moved = pushTips(this.positions, this.tips, count, TIP_RADIUS * this.brush * k);
      else {
        const normals = this.geometry.attributes.normal.array as Float32Array;
        for (let t = 0; t < count; t += 1) {
          const [x, y, z] = [this.tips[t * 3], this.tips[t * 3 + 1], this.tips[t * 3 + 2]];
          if (this.tool === 'smooth') moved += smoothAt(this.positions, this.neighbors, x, y, z, 0.016 * this.brush * k, 0.35);
          else moved += inflateAt(this.positions, normals, x, y, z, 0.016 * this.brush * k, 0.0006 * k);
        }
      }
      if (moved > 0) this.dirty = true;
    }

    // Pinch pulls.
    for (const hand of this.ctx.hands.both) {
      if (!hand.tracked || !hand.pinchStarted) continue;
      const l = this.local(hand.pinchPoint, this.tmp);
      if (nearestDistance(this.positions, l.x, l.y, l.z) > 0.02 / this.clay.scale.x) continue;
      this.snapshot();
      this.pulls.push({ hand, grab: grabAt(this.positions, l.x, l.y, l.z, (PULL_RADIUS * this.brush) / this.clay.scale.x, this.mirror ? this.mirrorMap : undefined), start: l.clone() });
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
          this.pulls.push({ hand: m, grab: grabAt(this.positions, l.x, l.y, l.z, (PULL_RADIUS * this.brush) / this.clay.scale.x, this.mirror ? this.mirrorMap : undefined), start: l.clone() });
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
        if (this.tool === 'smooth') smoothAt(this.positions, this.neighbors, x, l.y, l.z, 0.018 * this.brush * k, 0.4);
        else inflateAt(this.positions, normals, x, l.y, l.z, 0.018 * this.brush * k, 0.0008 * k);
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
    if (id === 'spin') this.autoSpin = !this.autoSpin;
    if (id === 'export') this.exportObj();
    if (id === 'print') this.print();
    if (id === 'clearPrints') this.clearPrints();
  }

  // ------------------------------------------------------------ prints

  /** Make a solid copy of the sculpture on the print pad. */
  /**
   * A print's holder, mesh and pin button. `lift` rests the lowest point on
   * the holder origin; pass null to compute it from the vertices.
   */
  private buildPrint(positions: Float32Array, color: string, scale: number, rotY: number, lift: number | null, building: boolean): Print {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(this.geometry.index);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const clip = new Plane(new Vector3(0, -1, 0), 0);
    const material = new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, clippingPlanes: building ? [clip] : null });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'ClayPrint';
    mesh.scale.setScalar(scale);
    mesh.position.y = lift ?? -box.min.y * scale;
    mesh.rotation.y = rotY;
    mesh.frustumCulled = false;
    const holder = new Group();
    holder.add(mesh);
    // A small pin in front of the print.
    const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * scale;
    const pinButton = new IconButton({ id: `clay:pin:${(this.printed += 1)}`, icon: 'pin', label: 'Pin it here', accent: this.accent, radius: 0.01 });
    pinButton.group.position.set(0, 0.001, reach + 0.018);
    holder.add(pinButton.group);
    const print: Print = { holder, mesh, material, height: (box.max.y - box.min.y) * scale, progress: building ? 0 : 1, clip, settleTo: null, pinned: false, pinButton };
    pinButton.onPress = () => this.togglePin(print);
    return print;
  }

  private togglePin(print: Print): void {
    if (!print.pinned && this.prints.filter((p) => p.pinned).length >= MAX_PINNED) {
      this.ctx.toast(`Up to ${MAX_PINNED} prints can be pinned.`);
      return;
    }
    print.pinned = !print.pinned;
    print.pinButton.active = print.pinned;
    print.pinButton.label = print.pinned ? 'Pinned: stays here (press to unpin)' : 'Pin it here';
    this.printHolds = this.printHolds.filter((h) => h.print !== print);
    this.savePins();
  }

  private savePins(): void {
    const out: SavedPrint[] = this.prints
      .filter((p) => p.pinned)
      .map((p) => {
        const h = p.holder;
        return {
          v: toBase64(p.mesh.geometry.attributes.position.array as Float32Array),
          c: `#${p.material.color.getHexString()}`,
          m: [p.mesh.scale.x, p.mesh.rotation.y, p.mesh.position.y],
          t: [...h.position.toArray(), ...h.quaternion.toArray(), h.scale.x],
          h: p.height,
        };
      });
    store.set(this.keys.pins, out);
  }

  private loadPins(): void {
    for (const saved of store.get<SavedPrint[]>(this.keys.pins, [])) {
      try {
        const print = this.buildPrint(fromBase64(saved.v), saved.c, saved.m[0], saved.m[1], saved.m[2], false);
        const [x, y, z, qx, qy, qz, qw, sc] = saved.t;
        (this.options.printsParent ?? this.deskRoot).add(print.holder);
        print.holder.position.set(x, y, z);
        print.holder.quaternion.set(qx, qy, qz, qw);
        print.holder.scale.setScalar(sc ?? 1);
        print.pinned = true;
        print.pinButton.active = true;
        print.pinButton.label = 'Pinned: stays here (press to unpin)';
        this.prints.push(print);
      } catch {
        // A damaged save: skip it.
      }
    }
  }

  private print(): void {
    const scale = this.clay.scale.x;
    const p = this.buildPrint(Float32Array.from(this.positions), `#${this.material.color.getHexString()}`, scale, this.turntable.rotation.y, null, true);
    const { holder } = p;
    // Side by side on the pad: newest in the middle, older ones nudge back.
    holder.position.copy(this.printPadAt).setY(0.004);
    // Older prints still on the pad nudge back to make room.
    this.deskRoot.updateMatrixWorld(true);
    const padWorld = this.deskRoot.localToWorld(this.printPadAt.clone());
    for (const q of this.prints) {
      if (!q.pinned && q.holder.getWorldPosition(this.tmp).distanceTo(padWorld) < 0.03) q.holder.translateZ(-0.09 * Math.max(0.6, scale));
    }
    this.deskRoot.add(holder);
    // Hand prints to the host's space so moving this tool leaves them where they are.
    this.options.printsParent?.attach(holder);
    this.prints.push(p);
    // Too many: the oldest unpinned print goes.
    while (this.prints.filter((q) => !q.pinned).length > MAX_PRINTS) this.removePrint(this.prints.find((q) => !q.pinned)!);
    Sfx.whoosh(padWorld);
    this.ctx.toast('Printing a copy. Grab it with thumb + middle finger.');
  }

  private removePrint(print: Print): void {
    this.prints = this.prints.filter((p) => p !== print);
    this.printHolds = this.printHolds.filter((h) => h.print !== print);
    print.holder.removeFromParent();
    this.printSelectables.delete(print);
    print.mesh.geometry.dispose();
    print.material.dispose();
  }

  /** Clear the unpinned prints; pinned ones stay. */
  private clearPrints(): void {
    for (const p of this.prints.filter((q) => !q.pinned)) this.removePrint(p);
    Sfx.whoosh();
  }

  private updatePrints(dt: number): void {
    // Build: the clip plane rises from the base to the top.
    for (const p of this.prints) {
      if (p.progress < 1) {
        p.progress = Math.min(1, p.progress + dt / PRINT_TIME);
        p.holder.updateMatrixWorld(true);
        const base = p.holder.getWorldPosition(this.tmp);
        const up = this.tmp2.set(0, 1, 0).transformDirection(p.holder.matrixWorld);
        // Keep what is below base + h*progress: normal points down the holder's up.
        p.clip.normal.copy(up).negate();
        p.clip.constant = up.dot(base) + p.height * p.progress + 0.001;
        if (p.progress >= 1) {
          p.material.clippingPlanes = null;
          p.material.needsUpdate = true;
          Sfx.blip(980, base);
        }
      }
      if (p.settleTo != null) {
        p.holder.position.y += (p.settleTo - p.holder.position.y) * Math.min(1, dt * 12);
        if (Math.abs(p.holder.position.y - p.settleTo) < 1e-4) {
          p.holder.position.y = p.settleTo;
          p.settleTo = null;
        }
      }
    }
    const busy = this.pulls.length > 0 || this.spin != null;
    // Pick up finished prints.
    for (const hand of this.ctx.pointers) {
      if (busy || !hand.tracked || !hand.grabStarted || this.printHolds.some((h) => h.hand === hand)) continue;
      const print = this.printNear(hand);
      if (!print) continue;
      // Taking a print from the other hand is fine.
      this.printHolds = this.printHolds.filter((h) => h.print !== print);
      const pose = new HeldPose();
      pose.begin(hand, print.holder);
      print.settleTo = null;
      this.printHolds.push({ print, hand, pose });
      if (hand.isMouse) {
        this.ctx.camera.getWorldDirection(this.tmp2).negate();
        this.ctx.setMousePlane(print.holder.getWorldPosition(this.tmp), this.tmp2);
      }
      hand.clearEdges();
      Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
    }
    for (let i = this.printHolds.length - 1; i >= 0; i -= 1) {
      const hold = this.printHolds[i];
      if (hold.hand.grabbing && hold.hand.tracked) {
        hold.pose.apply(hold.hand, hold.print.holder);
        this.ctx.trash.near(hold.hand.holdPoint);
        continue;
      }
      this.printHolds.splice(i, 1);
      const binned = this.ctx.trash.take(hold.hand.holdPoint);
      if (hold.hand.isMouse) {
        this.ctx.desk.getWorldPosition(this.tmp);
        this.ctx.setMousePlane(this.tmp, this.tmp2.set(0, 1, 0));
      }
      if (binned) {
        this.removePrint(hold.print);
        continue;
      }
      // Let go low over the desk: stand it upright on the desk.
      const h = hold.print.holder;
      if (h.position.y < 0.1 && Math.abs(h.position.x) < 0.45 && Math.abs(h.position.z) < 0.28) {
        const yaw = this.euler.setFromQuaternion(h.quaternion, 'YXZ').y;
        h.quaternion.setFromAxisAngle(this.tmp2.set(0, 1, 0), yaw);
        hold.print.settleTo = 0.004;
      }
      Sfx.place(h.getWorldPosition(this.tmp));
    }
  }

  private printNear(hand: HandState): Print | null {
    let best: Print | null = null;
    let bestDist = Infinity;
    for (const p of this.prints) {
      if (p.progress < 1 || p.pinned) continue;
      p.holder.updateMatrixWorld(true);
      // Aim at the middle of the print.
      const centre = p.holder.localToWorld(this.tmp.set(0, p.height / 2, 0));
      const d = grabDistance(hand, centre);
      const reach = Math.max(0.045, p.height * 0.6);
      if (d < reach && d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
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
    store.set(this.keys.sculpt, Array.from(this.positions, (v) => Math.round(v * 1e5) / 1e5));
  }

  /** Button states follow the tool state: lit when on, dimmed when unavailable. */
  private refresh(): void {
    const set = (id: string, active: boolean, disabled = false): void => {
      const b = this.buttons.get(id)!;
      b.active = active;
      b.disabled = disabled;
    };
    set('sculpt', this.tool === 'sculpt');
    set('smooth', this.tool === 'smooth');
    set('inflate', this.tool === 'inflate');
    set('mirror', this.mirror);
    set('spin', this.autoSpin);
    set('color', this.wheel.mesh.visible);
    set('undo', false, this.undo.length === 0);
    set('clearPrints', false, this.prints.length === 0);
    this.buttons.get('clearPrints')!.label = this.prints.length ? `Clear prints (${this.prints.length})` : 'Clear prints';
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
    return { pinned: this.prints.filter((p) => p.pinned).length, baseGrab: this.baseGrab != null, brush: +this.brush.toFixed(2), autoSpin: this.autoSpin, layout: this.layoutMode, scale: +this.clay.scale.x.toFixed(2), wheelVisible: this.wheel.mesh.visible, tool: this.tool, mirror: this.mirror, maxR: +maxR.toFixed(4), minR: +minR.toFixed(4), undo: this.undo.length, spin: +this.turntable.rotation.y.toFixed(3), prints: this.prints.map((p) => ({ progress: +p.progress.toFixed(2), pos: p.holder.position.toArray().map((v) => +v.toFixed(3)), height: +p.height.toFixed(3) })), printing: this.printHolds.length, printed: this.printed };
  }

  debugActions = {
    press: (id: string) => this.buttons.get(id)?.press(true),
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
    pinPrint: (i: number) => this.prints[i] && this.togglePin(this.prints[i]),
    baseWorld: () => {
      this.deskRoot.updateMatrixWorld(true);
      const p = this.deskRoot.localToWorld(new Vector3(TABLE_R * 0.7, 0.012, 0.03));
      return { x: p.x, y: p.y, z: p.z };
    },
    /** World centre of a print, for aiming a test grab. */
    printWorld: (i: number) => {
      const p = this.prints[i];
      if (!p) return null;
      p.holder.updateMatrixWorld(true);
      const w = p.holder.localToWorld(new Vector3(0, p.height / 2, 0));
      return { x: w.x, y: w.y, z: w.z };
    },
    brushWorld: (v: number) => {
      const p = this.brushSlider.worldAt(v);
      return { x: p.x, y: p.y, z: p.z };
    },
    sliderValue: () => this.sizeSlider.value,
    sliderWorld: (v: number) => {
      const p = this.sizeSlider.worldAt(v);
      return { x: p.x, y: p.y, z: p.z };
    },
  };
}
