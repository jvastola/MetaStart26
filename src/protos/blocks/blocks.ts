/**
 * Blocks: build with voxel blocks on a small plate on your desk.
 *
 *   Pinch (thumb + index) where you want a block: it appears in that cell.
 *   Keep pinching and move to lay a line or a wall. Blocks can float.
 *   Erase - pinch through blocks to remove them.
 *   Paint - pinch through blocks to recolour them.
 *   Mirror - everything you do is mirrored left/right.
 * Grab (thumb + middle) anywhere over the plate and move around it to turn
 * the build; grab with both hands and pull apart to make it bigger.
 *
 * On a desktop, click a face to put a block against it; drag to lay a row
 * at that height. Right-drag (or Shift-drag) turns the plate.
 *
 * A ghost cube shows where the next block goes. Everything autosaves.
 */

import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  CanvasTexture,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { ColorWheel } from '../../core/color-wheel.js';
import { type LabContext, type Prototype, store } from '../../core/context.js';
import type { HandState } from '../../core/hands.js';
import { IconButton } from '../../core/icon-button.js';
import { Sfx } from '../../core/sfx.js';
import { type Cell, type Change, cellsBetween, raycast, VoxelGrid } from './voxels.js';

/** Cells across the plate, and how tall a build can get. */
const SIZE = 16;
const HEIGHT = 16;
/** One block, in metres (at 1x). */
const VOX = 0.02;
/** Top of the plate, stage-local. */
const PLATE_Y = 0.012;
const STAGE_Z = -0.03;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const MAX_HISTORY = 60;

const SAVE_KEY = 'blocks-v1';
const COLOR_KEY = 'blocks-color-v1';

type Tool = 'build' | 'erase' | 'paint';

const BUTTONS: [id: string, icon: string, label: string][] = [
  ['build', 'cube', 'Build'],
  ['erase', 'erase', 'Erase'],
  ['paint', 'brush', 'Paint'],
  ['color', 'colour', 'Colour'],
  ['mirror', 'mirror', 'Mirror'],
  ['size', 'size', 'Size (hold to slide)'],
  ['undo', 'undo', 'Undo'],
  ['clear', 'trash', 'Clear'],
];

/** A small cottage for a first visit, so the plate is not empty. */
function starter(grid: VoxelGrid): void {
  const wall = 0xe9dcc4;
  const roof = 0xc0533a;
  const door = 0x6b4a2f;
  const glass = 0x8fd1ff;
  const grass = 0x6dbb5a;
  for (let x = 3; x <= 12; x++) for (let z = 4; z <= 11; z++) grid.set(x, 0, z, grass);
  for (let y = 1; y <= 3; y++)
    for (let x = 5; x <= 10; x++)
      for (let z = 6; z <= 9; z++) if (x === 5 || x === 10 || z === 6 || z === 9) grid.set(x, y, z, wall);
  grid.set(7, 1, 9, door);
  grid.set(7, 2, 9, door);
  grid.set(9, 2, 9, glass);
  grid.set(5, 2, 8, glass);
  grid.set(10, 2, 7, glass);
  for (let step = 0; step < 3; step++)
    for (let x = 5 + step; x <= 10 - step; x++) for (let z = 5; z <= 10; z++) grid.set(x, 4 + step, z, roof);
}

export class BlocksPrototype implements Prototype {
  readonly id = 'blocks';
  readonly title = 'Blocks';
  readonly tagline = 'Build with voxel blocks';
  readonly accent = ACCENTS.blocks;
  readonly howTo = [
    'Pinch (thumb + index) where you want a block; move while pinching for a row.',
    'Round buttons: build, erase, paint, colour, mirror, size, undo.',
    'Grab (thumb + middle) over the plate to turn it; both hands to resize.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private readonly grid = new VoxelGrid(SIZE, HEIGHT);
  private readonly stage = new Group();
  private voxels!: InstancedMesh;
  private readonly ghosts: { mesh: Mesh; mat: MeshBasicMaterial; edges: LineSegments; edgeMat: LineBasicMaterial }[] = [];
  private readonly buttons = new Map<string, IconButton>();
  private wheel!: ColorWheel;
  private tool: Tool = 'build';
  private mirror = false;
  private color = new Color('#5aa9e6');
  private dirty = true;
  private saveTimer = 0;
  private history: Change[][] = [];
  /** `layer` and `plane` (mouse only): the drag stays in that layer, on the height first clicked. */
  private strokes = new Map<HandState, { last: Cell; changes: Change[]; layer: number | null; plane: number }>();
  private turn: { hands: HandState[]; angle0: number; yaw0: number; dist0: number; scale0: number } | null = null;
  private soundCooldown = 0;
  private readonly m = new Matrix4();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmpColor = new Color();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.stage.name = 'BlocksStage';
    this.stage.position.set(0, 0, STAGE_Z);
    this.deskRoot.add(blobShadow(SIZE * VOX * 1.3, SIZE * VOX * 1.3, 0.8));
    this.deskRoot.add(this.stage);

    // The plate: a dark board with a faint cell grid.
    const span = SIZE * VOX;
    const base = new Mesh(new BoxGeometry(span + 0.012, PLATE_Y, span + 0.012), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.6 }));
    base.position.y = PLATE_Y / 2;
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = gridCanvas.height = 512;
    const g = gridCanvas.getContext('2d')!;
    g.fillStyle = '#343a45';
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 2;
    for (let i = 0; i <= SIZE; i++) {
      const p = (i / SIZE) * 512;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, 512);
      g.moveTo(0, p);
      g.lineTo(512, p);
      g.stroke();
    }
    g.strokeStyle = this.accent;
    g.lineWidth = 6;
    g.strokeRect(3, 3, 506, 506);
    const gridTex = new CanvasTexture(gridCanvas);
    gridTex.colorSpace = SRGBColorSpace;
    const top = new Mesh(new PlaneGeometry(span, span), new MeshStandardMaterial({ map: gridTex, roughness: 0.8 }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = PLATE_Y + 0.0004;
    this.stage.add(base, top);

    const box = new BoxGeometry(VOX * 0.97, VOX * 0.97, VOX * 0.97);
    this.voxels = new InstancedMesh(box, new MeshStandardMaterial({ roughness: 0.65, metalness: 0 }), SIZE * SIZE * HEIGHT);
    this.voxels.name = 'Voxels';
    this.voxels.count = 0;
    this.voxels.frustumCulled = false;
    this.stage.add(this.voxels);

    // One ghost cube per hand: where the next block goes.
    const ghostBox = new BoxGeometry(VOX * 1.04, VOX * 1.04, VOX * 1.04);
    const ghostEdges = new EdgesGeometry(ghostBox);
    for (let i = 0; i < 2; i++) {
      const mat = new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
      const mesh = new Mesh(ghostBox, mat);
      const edgeMat = new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
      const edges = new LineSegments(ghostEdges, edgeMat);
      mesh.add(edges);
      mesh.visible = false;
      mesh.userData.hideInShots = true;
      this.stage.add(mesh);
      this.ghosts.push({ mesh, mat, edges, edgeMat });
    }

    const saved = store.get<number[] | null>(SAVE_KEY, null);
    if (saved) this.grid.load(saved);
    else starter(this.grid);
    this.color.set(store.get<string>(COLOR_KEY, '#5aa9e6'));

    // Round buttons in an arc in front of the plate.
    const r = 0.215;
    const arc = (62 * Math.PI) / 180;
    BUTTONS.forEach(([id, icon, label], i) => {
      const b = new IconButton({ id: `blocks:${id}`, icon, label, accent: this.accent, radius: 0.015 });
      const a = -arc + (2 * arc * i) / (BUTTONS.length - 1);
      b.group.position.set(Math.sin(a) * r, 0.001, STAGE_Z + Math.cos(a) * r);
      b.onPress = () => this.onButton(id);
      if (id === 'size') {
        b.hold = {
          get: () => (this.stage.scale.x - MIN_SCALE) / (MAX_SCALE - MIN_SCALE),
          set: (v) => this.setScale(MIN_SCALE + v * (MAX_SCALE - MIN_SCALE)),
          label: () => `Size ${this.stage.scale.x.toFixed(1)}x`,
        };
      }
      this.buttons.set(id, b);
      this.deskRoot.add(b.group);
    });

    this.wheel = new ColorWheel(0.14, `#${this.color.getHexString()}`);
    this.wheel.onChange = (hex) => {
      this.color.set(hex);
      store.set(COLOR_KEY, hex);
      // Picking a colour while erasing means you want to build with it.
      if (this.tool === 'erase') this.tool = 'build';
    };
    this.wheel.mesh.visible = false;
    this.wheel.mesh.position.set(-0.33, 0.14, -0.04);
    this.wheel.mesh.rotation.set(-0.2, 0.5, 0, 'YXZ');
    this.deskRoot.add(this.wheel.mesh);
    this.setScale(store.get<number>('blocks-scale-v1', 1));
    this.stage.rotation.y = store.get<number>('blocks-yaw-v1', 0);
  }

  enter(): void {
    this.refresh();
  }

  exit(): void {
    for (const hand of [...this.strokes.keys()]) this.endStroke(hand);
    this.turn = null;
    for (const g of this.ghosts) g.mesh.visible = false;
    this.save();
  }

  fingerHints(hand: HandState): { index: string; middle: string | null } {
    const icon = this.tool === 'build' ? 'cube' : this.tool === 'erase' ? 'erase' : 'brush';
    return { index: icon, middle: this.inVolume(hand.grabbing ? hand.grabPoint : hand.tips[2], 2) ? 'spin' : null };
  }

  holding(): boolean {
    return this.strokes.size > 0 || this.turn != null || this.wheel.active;
  }

  undo(): boolean {
    const changes = this.history.pop();
    if (!changes) return false;
    this.grid.revert(changes);
    this.dirty = true;
    this.saveTimer = 0.5;
    Sfx.blip(520);
    return true;
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.soundCooldown = Math.max(0, this.soundCooldown - dt);
    if (this.wheel.mesh.visible) this.wheel.update(this.ctx.pointers);
    this.stage.updateWorldMatrix(true, false);
    this.updateGestures();
    this.updateTurn();
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked) {
        this.endStroke(hand);
        continue;
      }
      if (this.turn?.hands.includes(hand)) continue;
      if (hand.isMouse) this.updateMouse(hand);
      else this.updateHand(hand);
    }
    this.updateGhosts();
    if (this.dirty) this.rebuild();
    if (this.saveTimer > 0) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) this.save();
    }
    this.refresh();
  }

  /** Thumb microgestures: swipe to turn, tap for the next tool, swipe down to undo. */
  private updateGestures(): void {
    for (const hand of this.ctx.hands.both) {
      if (hand.gesture === 'left') this.turnBy(-Math.PI / 4);
      if (hand.gesture === 'right') this.turnBy(Math.PI / 4);
      if (hand.gesture === 'tap') this.tool = this.tool === 'build' ? 'erase' : this.tool === 'erase' ? 'paint' : 'build';
      if (hand.gesture === 'down') this.undo();
    }
  }

  // ------------------------------------------------------------ grid maths

  /** A world point in continuous cell units (stage-local). */
  private toCellSpace(world: Vector3, out: Vector3): Vector3 {
    this.stage.worldToLocal(out.copy(world));
    return out.set(out.x / VOX + SIZE / 2, (out.y - PLATE_Y) / VOX, out.z / VOX + SIZE / 2);
  }

  /** The cell a hand is pinching in, or null outside the build space. */
  private cellAt(world: Vector3): Cell | null {
    const p = this.toCellSpace(world, this.tmp);
    // Just above or on the plate counts as the bottom layer.
    if (p.y < 0 && p.y > -0.8) p.y = 0;
    const c: Cell = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
    return this.grid.inBounds(...c) ? c : null;
  }

  /** True if a world point is over the plate, within `margin` cells. */
  private inVolume(world: Vector3, margin: number): boolean {
    const p = this.toCellSpace(world, this.tmp2);
    return p.x > -margin && p.z > -margin && p.x < SIZE + margin && p.z < SIZE + margin && p.y > -1.5 && p.y < HEIGHT + margin;
  }

  cellWorld(c: Cell, out = new Vector3()): Vector3 {
    out.set((c[0] + 0.5 - SIZE / 2) * VOX, PLATE_Y + (c[1] + 0.5) * VOX, (c[2] + 0.5 - SIZE / 2) * VOX);
    this.stage.updateWorldMatrix(true, false);
    return this.stage.localToWorld(out);
  }

  // ------------------------------------------------------------ editing

  /** Apply the current tool to one cell (and its mirror). */
  private apply(c: Cell, changes: Change[]): void {
    const targets: Cell[] = [c];
    if (this.mirror && c[0] !== SIZE - 1 - c[0]) targets.push([SIZE - 1 - c[0], c[1], c[2]]);
    const hex = this.color.getHex();
    for (const [x, y, z] of targets) {
      let change: Change | null = null;
      if (this.tool === 'build') {
        if (!this.grid.has(x, y, z)) change = this.grid.set(x, y, z, hex);
      } else if (this.tool === 'erase') change = this.grid.set(x, y, z, null);
      else if (this.grid.has(x, y, z)) change = this.grid.set(x, y, z, hex);
      if (change) {
        changes.push(change);
        this.dirty = true;
        if (this.soundCooldown <= 0) {
          this.soundCooldown = 0.05;
          const at = this.cellWorld([x, y, z], this.tmp2);
          if (this.tool === 'erase') Sfx.erase(at);
          else Sfx.blip(440 + y * 45, at);
        }
      }
    }
  }

  /** Walk from the last cell to this one, so fast moves leave no gaps. */
  private extend(stroke: { last: Cell; changes: Change[] }, c: Cell): void {
    const l = stroke.last;
    if (l[0] === c[0] && l[1] === c[1] && l[2] === c[2]) return;
    for (const cell of cellsBetween(l, c).slice(1)) this.apply(cell, stroke.changes);
    stroke.last = c;
  }

  private endStroke(hand: HandState): void {
    const stroke = this.strokes.get(hand);
    if (!stroke) return;
    this.strokes.delete(hand);
    if (stroke.changes.length) this.record(stroke.changes);
  }

  private record(changes: Change[]): void {
    this.history.push(changes);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.saveTimer = 0.8;
  }

  private updateHand(hand: HandState): void {
    const stroke = this.strokes.get(hand);
    if (!stroke) {
      if (!hand.pinchStarted) return;
      const c = this.cellAt(hand.pinchPoint);
      if (!c) return;
      hand.clearEdges();
      const s = { last: c, changes: [] as Change[], layer: null, plane: 0 };
      this.strokes.set(hand, s);
      this.apply(c, s.changes);
      return;
    }
    if (!hand.pinching) {
      this.endStroke(hand);
      return;
    }
    const c = this.cellAt(hand.pinchPoint);
    if (c) this.extend(stroke, c);
  }

  /** Mouse: build against the face under the cursor; dragging lays a row at that height. */
  private readonly rayO = new Vector3();
  private readonly rayD = new Vector3();
  /** Height (cell units) where the last mouse ray hit, for a drag to follow. */
  private lastPlane = 0;

  private mouseTarget(hand: HandState, layer: number | null, plane = 0): Cell | null {
    const o = this.toCellSpace(hand.rayOrigin, this.rayO);
    const d = this.toCellSpace(this.tmp2.copy(hand.rayOrigin).add(hand.rayDir), this.rayD).sub(o).normalize();
    if (layer != null) {
      // Stay in the layer the drag began in, following the height first clicked.
      if (Math.abs(d.y) < 1e-6) return null;
      const t = (plane - o.y) / d.y;
      if (t <= 0) return null;
      const c: Cell = [Math.floor(o.x + d.x * t), layer, Math.floor(o.z + d.z * t)];
      return this.grid.inBounds(...c) ? c : null;
    }
    const hit = raycast(this.grid, [o.x, o.y, o.z], [d.x, d.y, d.z]);
    if (!hit) return null;
    this.lastPlane = o.y + d.y * hit.t;
    return this.tool === 'build' ? hit.place : hit.hit;
  }

  private updateMouse(hand: HandState): void {
    const stroke = this.strokes.get(hand);
    if (!stroke) {
      // A left click is a pinch and a grab at once: it builds. Grab alone turns.
      if (!hand.pinchStarted) return;
      const c = this.mouseTarget(hand, null);
      if (!c) return;
      hand.clearEdges();
      const s = { last: c, changes: [] as Change[], layer: c[1] as number | null, plane: this.lastPlane };
      this.strokes.set(hand, s);
      this.apply(c, s.changes);
      return;
    }
    if (!hand.pinching) {
      this.endStroke(hand);
      return;
    }
    const c = this.mouseTarget(hand, stroke.layer, stroke.plane);
    if (c) this.extend(stroke, c);
  }

  // ------------------------------------------------------------ turning and size

  private stageCenter(out: Vector3): Vector3 {
    return this.deskRoot.localToWorld(out.set(0, 0, STAGE_Z));
  }

  /** Angle of a world point around the plate centre, in desk space. */
  private angleOf(world: Vector3): number {
    this.deskRoot.updateWorldMatrix(true, false);
    const p = this.deskRoot.worldToLocal(this.tmp.copy(world));
    return Math.atan2(p.x, p.z - STAGE_Z);
  }

  private updateTurn(): void {
    // Start (or add a second hand): a grab over the plate.
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked || !hand.grabStarted || hand.pinchStarted || this.turn?.hands.includes(hand)) continue;
      if (!this.inVolume(hand.holdPoint, 2)) continue;
      hand.clearEdges();
      if (hand.isMouse) {
        this.deskRoot.updateWorldMatrix(true, false);
        this.ctx.setMousePlane(this.stageCenter(this.tmp2).setY(this.tmp2.y + PLATE_Y), new Vector3(0, 1, 0));
      }
      const hands = this.turn ? [this.turn.hands[0], hand] : [hand];
      this.beginTurn(hands);
      Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
    }
    const t = this.turn;
    if (!t) return;
    const still = t.hands.filter((h) => h.grabbing && h.tracked);
    if (still.length !== t.hands.length) {
      this.turn = null;
      if (still.length) this.beginTurn(still);
      else {
        store.set('blocks-yaw-v1', this.stage.rotation.y);
        store.set('blocks-scale-v1', this.stage.scale.x);
      }
      return;
    }
    if (t.hands.length === 1) {
      let d = this.angleOf(t.hands[0].holdPoint) - t.angle0;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      this.stage.rotation.y = t.yaw0 + d;
    } else {
      const dist = t.hands[0].holdPoint.distanceTo(t.hands[1].holdPoint);
      this.setScale((t.scale0 * dist) / t.dist0);
    }
  }

  private beginTurn(hands: HandState[]): void {
    this.turn = {
      hands,
      angle0: this.angleOf(hands[0].holdPoint),
      yaw0: this.stage.rotation.y,
      dist0: hands[1] ? Math.max(0.02, hands[0].holdPoint.distanceTo(hands[1].holdPoint)) : 1,
      scale0: this.stage.scale.x,
    };
  }

  private turnBy(angle: number): void {
    this.stage.rotation.y += angle;
    store.set('blocks-yaw-v1', this.stage.rotation.y);
  }

  private setScale(s: number): void {
    this.stage.scale.setScalar(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)));
    store.set('blocks-scale-v1', this.stage.scale.x);
  }

  // ------------------------------------------------------------ view

  private updateGhosts(): void {
    let used = 0;
    for (const hand of this.ctx.pointers) {
      if (used >= this.ghosts.length || !hand.tracked || this.turn?.hands.includes(hand)) continue;
      let c: Cell | null = null;
      if (hand.isMouse) {
        const stroke = this.strokes.get(hand);
        c = this.mouseTarget(hand, stroke?.layer ?? null, stroke?.plane ?? 0);
      } else if (this.inVolume(hand.pinchPoint, 0.5)) c = this.cellAt(hand.pinchPoint);
      if (!c) continue;
      const g = this.ghosts[used++];
      g.mesh.position.set((c[0] + 0.5 - SIZE / 2) * VOX, PLATE_Y + (c[1] + 0.5) * VOX, (c[2] + 0.5 - SIZE / 2) * VOX);
      g.mesh.visible = true;
      const erase = this.tool === 'erase';
      g.mat.color.copy(erase ? this.tmpColor.set('#ff5a5a') : this.color);
      g.mat.opacity = erase ? 0.25 : this.tool === 'paint' ? 0.2 : 0.4;
      g.edgeMat.color.copy(erase ? this.tmpColor.set('#ff8a8a') : this.tmpColor.set('#ffffff'));
    }
    for (let i = used; i < this.ghosts.length; i++) this.ghosts[i].mesh.visible = false;
  }

  private rebuild(): void {
    let i = 0;
    for (const [x, y, z, color] of this.grid.entries()) {
      this.m.makeTranslation((x + 0.5 - SIZE / 2) * VOX, PLATE_Y + (y + 0.5) * VOX, (z + 0.5 - SIZE / 2) * VOX);
      this.voxels.setMatrixAt(i, this.m);
      this.voxels.setColorAt(i, this.tmpColor.setHex(color));
      i++;
    }
    this.voxels.count = i;
    this.voxels.instanceMatrix.needsUpdate = true;
    if (this.voxels.instanceColor) this.voxels.instanceColor.needsUpdate = true;
    this.dirty = false;
  }

  private refresh(): void {
    const set = (id: string, active: boolean, disabled = false) => {
      const b = this.buttons.get(id)!;
      b.active = active;
      b.disabled = disabled;
    };
    set('build', this.tool === 'build');
    set('erase', this.tool === 'erase');
    set('paint', this.tool === 'paint');
    set('color', this.wheel.mesh.visible);
    set('mirror', this.mirror);
    set('size', false);
    set('undo', false, this.history.length === 0);
    set('clear', false, this.grid.count === 0);
  }

  private onButton(id: string): void {
    if (id === 'build' || id === 'erase' || id === 'paint') this.tool = id;
    if (id === 'color') this.wheel.mesh.visible = !this.wheel.mesh.visible;
    if (id === 'mirror') this.mirror = !this.mirror;
    if (id === 'size') this.setScale(Math.abs(this.stage.scale.x - 1) < 0.05 ? 1.6 : 1);
    if (id === 'undo') this.undo();
    if (id === 'clear' && this.grid.count) {
      this.record(this.grid.clear());
      this.dirty = true;
      Sfx.whoosh(this.stageCenter(this.tmp));
    }
    this.refresh();
  }

  private save(): void {
    store.set(SAVE_KEY, this.grid.toJSON());
    this.saveTimer = 0;
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      count: this.grid.count,
      tool: this.tool,
      mirror: this.mirror,
      color: `#${this.color.getHexString()}`,
      scale: +this.stage.scale.x.toFixed(2),
      yaw: +this.stage.rotation.y.toFixed(3),
      history: this.history.length,
      drawing: this.strokes.size,
      turning: this.turn?.hands.length ?? 0,
      ghosts: this.ghosts.filter((g) => g.mesh.visible).length,
      rendered: this.voxels.count,
    };
  }

  debugActions = {
    press: (id: string) => this.buttons.get(id)?.press(true),
    /** World centre of a cell. */
    cellWorld: (x: number, y: number, z: number) => {
      const p = this.cellWorld([x, y, z]);
      return { x: p.x, y: p.y, z: p.z };
    },
    has: (x: number, y: number, z: number) => this.grid.has(x, y, z),
    get: (x: number, y: number, z: number) => this.grid.get(x, y, z),
    /** Empty the plate without an undo step (test setup). */
    reset: () => {
      this.grid.clear();
      this.history = [];
      this.dirty = true;
    },
    setColor: (hex: string) => this.color.set(hex),
  };
}
