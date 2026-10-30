/**
 * Multi-select: stretch a box around things, then act on all of them.
 *
 *   Box      - grab (thumb + middle) in empty air and keep holding: a glowing
 *              box stretches from where you started to your hand, lined up
 *              with the desk. Everything whose centre is inside lights up as
 *              you go; let go to select it. (With the Select tool on, a
 *              pinch does the same.) A grab ON something still picks that
 *              thing up straight away. A flat box (dragged along the desk)
 *              still reaches things resting on it.
 *   Move     - grab (thumb + middle) any selected thing: the whole selection
 *              follows your hand and turns with your wrist.
 *   Scale    - grab the selection with both hands and pull apart / twist.
 *   Delete   - drop it on the desk bin, or press the bin button.
 *   Menu     - round buttons float above the selection: pin to the desk,
 *              duplicate, paint with the brush colour, delete, deselect.
 *   Show     - selected things glow, and one thin box outlines the lot.
 *   Clear    - a quick grab or pinch on empty space deselects.
 *
 * Tools take part by registering a SelectionSource.
 */

import {
  BufferGeometry,
  Color,
  Group,
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Quaternion,
  RingGeometry,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import type { LabContext } from './context.js';
import type { HandState } from './hands.js';
import { IconButton } from './icon-button.js';
import { faceViewer } from './item-actions.js';
import { Sfx } from './sfx.js';

export interface Selectable {
  readonly object: Object3D;
  readonly source: SelectionSource;
  /** World centre and radius of the thing. */
  bounds(center: Vector3): number;
  /** Precise distance (m) from a world point to the thing's surface, if cheaper than bounds suggest. */
  distance?(world: Vector3): number;
  setLit?(on: boolean): void;
}

export interface SelectionSource {
  items(): Selectable[];
  /** True if a grab here picks up something of this tool (so it is not an air grab). */
  grabbable?(world: Vector3): boolean;
  remove(items: Selectable[]): void;
  duplicate?(items: Selectable[]): Selectable[];
  recolor?(items: Selectable[], hex: string): void;
  /** Called after a move or scale, e.g. to save. */
  moved?(items: Selectable[]): void;
  /** Hand these over to the desk, where they stay in every app. */
  pin?(items: Selectable[]): void;
}

/** The selection box is never thinner than this on any side (m). */
const MIN_BOX = 0.06;
const TAP_TIME = 0.25;
/** An air grab becomes a loop after this long, or this far. */
const AIR_HOLD = 0.25;
const AIR_MOVE = 0.02;
/** A grab this close to something is a pick-up, not a loop. */
const NEAR_THING = 0.03;
const UP = new Vector3(0, 1, 0);

interface GroupHold {
  hands: HandState[];
  /** Each item's world matrix when the hold (or second hand) began. */
  start: Map<Selectable, Matrix4>;
  /** One hand: its pose at the start. Two hands: midpoint/angle/distance at the start. */
  handStart: Matrix4;
  mid0: Vector3;
  angle0: number;
  dist0: number;
}

export class Selection {
  readonly group = new Group();
  items: Selectable[] = [];
  /** The Select tool is on: every pinch draws a loop. */
  armed: () => boolean = () => false;
  /** Colour for "paint". */
  paintColor: () => string = () => '#ffffff';
  /** Set by tests: how many things the last loop caught. */
  lastCaught = 0;
  private readonly sources: SelectionSource[] = [];
  /** The box being stretched: corners in desk space. */
  private lasso: { hand: HandState; via: 'pinch' | 'grab'; a: Vector3; b: Vector3 } | null = null;
  private readonly box: Mesh;
  private readonly boxEdges: LineSegments;
  private readonly min = new Vector3();
  private readonly max = new Vector3();
  /** Grabs that began on empty air: a loop once held or moved, a deselect if just tapped. */
  private readonly air = new Map<HandState, { time: number; at: Vector3 }>();
  private hold: GroupHold | null = null;
  /** One thin box around the whole selection (desk-aligned). */
  private readonly outline: LineSegments;
  private readonly menu = new Group();
  private readonly buttons: IconButton[] = [];
  private readonly pinchStart = new Map<HandState, { time: number; at: Vector3 }>();
  private time = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly eye = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();



  constructor(
    private readonly ctx: LabContext,
    accent = '#9fc7ff',
  ) {
    this.group.name = 'Selection';
    this.group.userData.hideInShots = true;
    const unit = new BoxGeometry(1, 1, 1);
    this.box = new Mesh(unit, new MeshBasicMaterial({ color: new Color(accent), transparent: true, opacity: 0.12, depthWrite: false }));
    this.boxEdges = new LineSegments(new EdgesGeometry(unit), new LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95 }));
    this.box.renderOrder = this.boxEdges.renderOrder = 34;
    this.box.frustumCulled = this.boxEdges.frustumCulled = false;
    this.box.visible = this.boxEdges.visible = false;

    const menu: [string, string, string, () => void][] = [
      ['sel:pin', 'pin', 'Pin to the desk (stays in every app)', () => this.pinAll()],
      ['sel:duplicate', 'duplicate', 'Duplicate', () => this.duplicate()],
      ['sel:paint', 'colour', 'Paint with brush colour', () => this.paint()],
      ['sel:delete', 'trash', 'Delete', () => this.removeAll()],
      ['sel:clear', 'deselect', 'Deselect', () => this.clear()],
    ];
    menu.forEach(([id, icon, label, fn], i) => {
      const b = new IconButton({ id, icon, label, accent, radius: 0.014 });
      b.group.position.x = (i - (menu.length - 1) / 2) * 0.038;
      b.onPress = fn;
      this.buttons.push(b);
      this.menu.add(b.group);
    });
    this.menu.visible = false;
    this.outline = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), new LineBasicMaterial({ color: accent, transparent: true, opacity: 0.5 }));
    this.outline.frustumCulled = false;
    this.outline.visible = false;
    this.group.add(this.menu, this.box, this.boxEdges, this.outline);
    // Children are placed in world coordinates wherever the group is parented.
    this.group.matrixAutoUpdate = false;
  }

  /** Cancel the parent's transform so children can use world coordinates. */
  private alignToWorld(): void {
    const parent = this.group.parent;
    if (!parent) return;
    parent.updateMatrixWorld(true);
    this.group.matrix.copy(parent.matrixWorld).invert();
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
  }

  addSource(source: SelectionSource): void {
    this.sources.push(source);
  }

  get active(): boolean {
    return this.items.length > 0;
  }

  /** True if this hand is drawing a loop or holding the selection. */
  owns(hand: HandState): boolean {
    return this.lasso?.hand === hand || this.air.has(hand) || (this.hold?.hands.includes(hand) ?? false);
  }

  get busy(): boolean {
    return this.lasso != null || this.hold != null || this.air.size > 0;
  }

  /**
   * Run before the tools: starts loops and selection holds, consuming the
   * pinches and grabs it uses.
   */
  update(dt: number): void {
    this.time += dt;
    this.alignToWorld();
    // Forget things that were deleted by their tool.
    const alive = new Set(this.sources.flatMap((s) => s.items()));
    if (this.items.some((i) => !alive.has(i))) this.setItems(this.items.filter((i) => alive.has(i)));

    for (const hand of this.ctx.pointers) {
      if (!hand.tracked) continue;
      // Taps are measured at the index tip: the pinch point shifts as the fingers open.
      if (hand.pinchStarted) this.pinchStart.set(hand, { time: this.time, at: hand.indexTip.clone() });
      if (hand.pinchEnded) {
        const start = this.pinchStart.get(hand);
        const tap = start != null && this.time - start.time < TAP_TIME && start.at.distanceTo(hand.indexTip) < 0.02;
        // A quick tap on nothing clears the selection.
        if (tap && this.active && !this.lasso && !this.hitAny(hand.pinchPoint)) this.clear();
      }
    }

    this.updateHold();
    this.updateAir();
    this.updateLasso();
    this.layoutMenu();
  }

  // ------------------------------------------------------------ lasso

  /** Desk-space copy of a world point. */
  private toDesk(world: Vector3, out: Vector3): Vector3 {
    this.ctx.desk.updateMatrixWorld(true);
    return this.ctx.desk.worldToLocal(out.copy(world));
  }

  private beginLasso(hand: HandState, via: 'pinch' | 'grab', from: Vector3): void {
    const a = this.toDesk(from, new Vector3());
    this.lasso = { hand, via, a, b: a.clone() };
    this.box.visible = this.boxEdges.visible = true;
    this.layoutBox();
    Sfx.blip(880, hand.isMouse ? undefined : from);
  }

  /**
   * The box in desk space, with a minimum thickness so a flat drag still has
   * depth, and reaching down to the desk when it starts just above it.
   */
  private boxBounds(): void {
    const { a, b } = this.lasso!;
    this.min.copy(a).min(b);
    this.max.copy(a).max(b);
    for (const axis of ['x', 'y', 'z'] as const) {
      const size = this.max[axis] - this.min[axis];
      if (size < MIN_BOX) {
        const grow = (MIN_BOX - size) / 2;
        this.min[axis] -= grow;
        this.max[axis] += grow;
      }
    }
    if (this.min.y > 0 && this.min.y < 0.08) this.min.y = -0.005;
  }

  /** Show the box, lined up with the desk. */
  private layoutBox(): void {
    this.boxBounds();
    const desk = this.ctx.desk;
    desk.updateMatrixWorld(true);
    const center = desk.localToWorld(this.tmp.copy(this.min).add(this.max).multiplyScalar(0.5));
    const q = desk.getWorldQuaternion(this.q);
    const scale = desk.getWorldScale(this.tmp2);
    for (const m of [this.box, this.boxEdges]) {
      m.position.copy(center);
      m.quaternion.copy(q);
      m.scale.set((this.max.x - this.min.x) * scale.x, (this.max.y - this.min.y) * scale.y, (this.max.z - this.min.z) * scale.z);
    }
  }

  /** What the box contains (by centre). */
  private enclosed(): Selectable[] {
    const caught: Selectable[] = [];
    for (const item of this.sources.flatMap((s) => s.items())) {
      item.bounds(this.tmp2);
      const p = this.toDesk(this.tmp2, this.tmp);
      if (p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y && p.z >= this.min.z && p.z <= this.max.z) caught.push(item);
    }
    return caught;
  }

  /** True if a world point is on or next to anything selectable. */
  private nearAnything(world: Vector3): boolean {
    if (this.sources.some((s) => s.grabbable?.(world))) return true;
    for (const item of this.sources.flatMap((s) => s.items())) {
      const r = item.bounds(this.tmp);
      const d = item.distance ? item.distance(world) : this.tmp.distanceTo(world) - r;
      if (d < NEAR_THING) return true;
    }
    return false;
  }

  /** A grab that starts on nothing: hold or move it to draw a loop; tap it to deselect. */
  private updateAir(): void {
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked) continue;
      // A mouse left-click is a pinch and a grab at once: that one draws, it does not loop.
      if (hand.grabStarted && !hand.pinchStarted && !this.owns(hand) && !this.lasso && !this.nearAnything(hand.holdPoint)) {
        this.air.set(hand, { time: this.time, at: hand.grabPoint.clone() });
        hand.clearEdges();
      }
    }
    for (const [hand, a] of this.air) {
      if (!hand.grabbing || !hand.tracked) {
        this.air.delete(hand);
        if (this.active) this.clear();
        continue;
      }
      if (this.time - a.time > AIR_HOLD || hand.grabPoint.distanceTo(a.at) > AIR_MOVE) {
        this.air.delete(hand);
        if (!this.lasso) this.beginLasso(hand, 'grab', a.at);
      }
    }
  }

  private updateLasso(): void {
    if (!this.lasso) {
      if (!this.armed()) return;
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.pinchStarted) continue;
        this.beginLasso(hand, 'pinch', hand.pinchPoint);
        hand.clearEdges();
        return;
      }
      return;
    }
    const { hand, via } = this.lasso;
    const held = via === 'pinch' ? hand.pinching : hand.grabbing;
    if (held && hand.tracked) {
      this.toDesk(via === 'pinch' ? hand.pinchPoint : hand.grabPoint, this.lasso.b);
      this.layoutBox();
      // Live preview: what the box would select if you let go now lights up.
      const before = this.items.length;
      const caught = this.enclosed();
      if (caught.length !== before || caught.some((c) => !this.items.includes(c))) {
        this.setItems(caught);
        if (caught.length > before) Sfx.blip(1100, hand.isMouse ? undefined : hand.grabPoint);
      }
      return;
    }
    // Released: select what the box holds.
    this.box.visible = this.boxEdges.visible = false;
    const { a, b } = this.lasso;
    this.lasso = null;
    if (a.distanceTo(b) < 0.02) {
      this.setItems([]);
      return;
    }
    const caught = this.items;
    this.lastCaught = caught.length;
    if (caught.length) Sfx.success(hand.isMouse ? undefined : hand.pinchPoint);
    else Sfx.error(hand.isMouse ? undefined : hand.pinchPoint);
  }

  // ------------------------------------------------------------ hold

  private hitAny(world: Vector3): Selectable | null {
    let best: Selectable | null = null;
    let bestD = Infinity;
    for (const item of this.items) {
      const r = item.bounds(this.tmp);
      const d = this.tmp.distanceTo(world) - r;
      if (d < 0.03 && d < bestD) {
        best = item;
        bestD = d;
      }
    }
    return best;
  }

  private snapshot(): Map<Selectable, Matrix4> {
    const map = new Map<Selectable, Matrix4>();
    for (const i of this.items) {
      i.object.updateMatrixWorld(true);
      map.set(i, i.object.matrixWorld.clone());
    }
    return map;
  }

  private handMatrix(hand: HandState, out: Matrix4): Matrix4 {
    return out.compose(hand.holdPoint, hand.orientation, this.tmp.set(1, 1, 1));
  }

  private beginHold(hands: HandState[]): void {
    const [a, b] = hands;
    const hold: GroupHold = {
      hands,
      start: this.snapshot(),
      handStart: this.handMatrix(a, new Matrix4()),
      mid0: new Vector3(),
      angle0: 0,
      dist0: 1,
    };
    if (b) {
      hold.mid0.copy(a.holdPoint).add(b.holdPoint).multiplyScalar(0.5);
      hold.angle0 = Math.atan2(b.holdPoint.x - a.holdPoint.x, b.holdPoint.z - a.holdPoint.z);
      hold.dist0 = Math.max(0.02, a.holdPoint.distanceTo(b.holdPoint));
    }
    this.hold = hold;
  }

  private updateHold(): void {
    if (!this.active) return;
    // Start: a grab on any selected thing; a second grab adds the other hand.
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked || !hand.grabStarted || this.hold?.hands.includes(hand)) continue;
      if (!this.hitAny(hand.holdPoint)) continue;
      const hands = this.hold ? [this.hold.hands[0], hand] : [hand];
      this.beginHold(hands);
      hand.clearEdges();
      Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
    }
    const hold = this.hold;
    if (!hold) return;
    const still = hold.hands.filter((h) => h.grabbing && h.tracked);
    if (still.length !== hold.hands.length) {
      const leaving = hold.hands.find((h) => !still.includes(h))!;
      this.notifyMoved();
      if (still.length === 1) {
        this.beginHold(still);
        return;
      }
      this.hold = null;
      if (this.ctx.trash.take(leaving.holdPoint)) {
        this.removeAll();
        return;
      }
      Sfx.place(leaving.isMouse ? undefined : leaving.holdPoint);
      return;
    }
    // The transform that takes the start to now.
    const delta = this.m;
    if (hold.hands.length === 1) {
      const now = this.handMatrix(hold.hands[0], new Matrix4());
      delta.copy(now).multiply(hold.handStart.clone().invert());
      this.ctx.trash.near(hold.hands[0].holdPoint);
    } else {
      const [a, b] = hold.hands;
      const mid = a.holdPoint.clone().add(b.holdPoint).multiplyScalar(0.5);
      const scale = Math.min(6, Math.max(0.15, a.holdPoint.distanceTo(b.holdPoint) / hold.dist0));
      const turn = Math.atan2(b.holdPoint.x - a.holdPoint.x, b.holdPoint.z - a.holdPoint.z) - hold.angle0;
      delta
        .makeTranslation(mid.x, mid.y, mid.z)
        .multiply(new Matrix4().makeRotationAxis(UP, turn))
        .multiply(new Matrix4().makeScale(scale, scale, scale))
        .multiply(new Matrix4().makeTranslation(-hold.mid0.x, -hold.mid0.y, -hold.mid0.z));
    }
    for (const [item, start] of hold.start) {
      const world = this.tmp2;
      const m = delta.clone().multiply(start);
      const parent = item.object.parent;
      if (parent) {
        parent.updateMatrixWorld(true);
        m.premultiply(parent.matrixWorld.clone().invert());
      }
      m.decompose(item.object.position, item.object.quaternion, world);
      // Keep uniform scale (things here scale evenly).
      item.object.scale.setScalar((world.x + world.y + world.z) / 3);
    }
  }

  private notifyMoved(): void {
    for (const source of this.sources) {
      const mine = this.items.filter((i) => i.source === source);
      if (mine.length) source.moved?.(mine);
    }
  }

  // ------------------------------------------------------------ actions

  setItems(items: Selectable[]): void {
    for (const item of this.items) if (!items.includes(item)) item.setLit?.(false);
    this.items = items;
    for (const item of items) item.setLit?.(true);
    if (items.length === 0) {
      this.hold = null;
      this.menu.visible = false;
      this.outline.visible = false;
    }
  }

  clear(): void {
    if (!this.active) return;
    this.setItems([]);
    Sfx.blip(520);
  }

  removeAll(): void {
    const items = this.items;
    this.setItems([]);
    for (const source of this.sources) {
      const mine = items.filter((i) => i.source === source);
      if (mine.length) source.remove(mine);
    }
    Sfx.trash();
  }

  private duplicate(): void {
    const copies: Selectable[] = [];
    for (const source of this.sources) {
      const mine = this.items.filter((i) => i.source === source);
      if (mine.length && source.duplicate) copies.push(...source.duplicate(mine));
    }
    // Select the copies, so they can be moved straight away.
    if (copies.length) this.setItems(copies);
    Sfx.whoosh();
  }

  private pinAll(): void {
    const items = this.items;
    this.setItems([]);
    for (const source of this.sources) {
      const mine = items.filter((i) => i.source === source);
      if (mine.length) source.pin?.(mine);
    }
    Sfx.blip(900);
  }

  private paint(): void {
    const hex = this.paintColor();
    for (const source of this.sources) {
      const mine = this.items.filter((i) => i.source === source);
      if (mine.length) source.recolor?.(mine, hex);
    }
    Sfx.blip(820);
  }

  /** One outline box around the selection, and the menu above it, facing you. */
  private layoutMenu(): void {
    const eye = this.ctx.camera.getWorldPosition(this.eye);
    const showOutline = this.active && !this.lasso;
    this.outline.visible = showOutline;
    this.menu.visible = this.active && !this.hold && !this.lasso;
    if (!showOutline) return;
    // Union of the things' bounds, in desk space.
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const item of this.items) {
      const r = item.bounds(this.tmp);
      const p = this.toDesk(this.tmp, this.tmp2);
      lo.min(this.tmp.set(p.x - r, p.y - r, p.z - r));
      hi.max(this.tmp.set(p.x + r, p.y + r, p.z + r));
    }
    lo.subScalar(0.008);
    hi.addScalar(0.008);
    const desk = this.ctx.desk;
    desk.updateMatrixWorld(true);
    this.outline.position.copy(desk.localToWorld(this.tmp.copy(lo).add(hi).multiplyScalar(0.5)));
    desk.getWorldQuaternion(this.outline.quaternion);
    const scale = desk.getWorldScale(this.tmp2);
    this.outline.scale.set((hi.x - lo.x) * scale.x, (hi.y - lo.y) * scale.y, (hi.z - lo.z) * scale.z);
    if (!this.menu.visible) return;
    // The menu floats above the middle of the box, upright and facing you.
    const top = desk.localToWorld(this.tmp.set((lo.x + hi.x) / 2, hi.y + 0.04, (lo.z + hi.z) / 2));
    this.menu.position.copy(top);
    faceViewer(top, eye, this.menu.quaternion);
  }

  debug(): { count: number; holding: number; lasso: boolean; caught: number; airGrab: number } {
    return { count: this.items.length, holding: this.hold?.hands.length ?? 0, lasso: this.lasso != null, caught: this.lastCaught, airGrab: this.air.size };
  }
}

/** Point-in-polygon (even-odd). */
function inside(p: Vector2, poly: Vector2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
