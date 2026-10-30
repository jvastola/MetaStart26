/**
 * Multi-select: loop around things, then act on all of them at once.
 *
 *   Loop     - grab (thumb + middle) in empty air and keep holding: your
 *              hand draws a loop. (With the Select tool on, a pinch does the
 *              same.) Everything whose centre falls inside the loop as you
 *              see it is selected, near or far. A grab ON something still
 *              picks that thing up straight away.
 *   Move     - grab (thumb + middle) any selected thing: the whole selection
 *              follows your hand and turns with your wrist.
 *   Scale    - grab the selection with both hands and pull apart / twist.
 *   Delete   - drop it on the desk bin, or press the bin button.
 *   Menu     - round buttons float above the selection: duplicate, paint
 *              with the brush colour, delete, deselect.
 *   Clear    - a quick grab or pinch on empty space deselects.
 *
 * Tools take part by registering a SelectionSource.
 */

import {
  BufferGeometry,
  Color,
  Group,
  CylinderGeometry,
  InstancedMesh,
  Line,
  LineDashedMaterial,
  MeshStandardMaterial,
  SphereGeometry,
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
}

const MAX_LASSO_POINTS = 400;
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
  private lasso: { hand: HandState; via: 'pinch' | 'grab'; points: Vector3[] } | null = null;
  /** The loop as a glowing tube: beads at each point, segments between. */
  private readonly beads: InstancedMesh;
  private readonly links: InstancedMesh;
  /** Dashed line that shows where the loop will close. */
  private readonly closer: Line;
  /** Grabs that began on empty air: a loop once held or moved, a deselect if just tapped. */
  private readonly air = new Map<HandState, { time: number; at: Vector3 }>();
  private hold: GroupHold | null = null;
  private readonly halos = new Map<Selectable, Mesh>();
  private readonly menu = new Group();
  private readonly buttons: IconButton[] = [];
  private readonly pinchStart = new Map<HandState, { time: number; at: Vector3 }>();
  private time = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly eye = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly lassoMat: MeshStandardMaterial;
  private readonly im = new Matrix4();
  private readonly iq = new Quaternion();
  private readonly is = new Vector3();
  private readonly idir = new Vector3();
  private readonly haloMat: MeshBasicMaterial;

  constructor(
    private readonly ctx: LabContext,
    accent = '#9fc7ff',
  ) {
    this.group.name = 'Selection';
    this.group.userData.hideInShots = true;
    this.lassoMat = new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.9, roughness: 0.3 });
    this.beads = new InstancedMesh(new SphereGeometry(0.0042, 10, 8), this.lassoMat, MAX_LASSO_POINTS);
    this.links = new InstancedMesh(new CylinderGeometry(0.0028, 0.0028, 1, 8, 1, true), this.lassoMat, MAX_LASSO_POINTS);
    this.beads.count = this.links.count = 0;
    this.beads.frustumCulled = this.links.frustumCulled = false;
    this.closer = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]), new LineDashedMaterial({ color: accent, dashSize: 0.01, gapSize: 0.008, transparent: true, opacity: 0.8 }));
    this.closer.frustumCulled = false;
    this.beads.visible = this.links.visible = this.closer.visible = false;
    this.haloMat = new MeshBasicMaterial({ color: new Color(accent), transparent: true, opacity: 0.55, depthWrite: false });
    const menu: [string, string, string, () => void][] = [
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
    this.group.add(this.menu, this.beads, this.links, this.closer);
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

  private beginLasso(hand: HandState, via: 'pinch' | 'grab', from: Vector3): void {
    this.lasso = { hand, via, points: [] };
    this.beads.count = this.links.count = 0;
    this.addLassoPoint(from);
    this.beads.visible = this.links.visible = this.closer.visible = true;
    Sfx.blip(880, hand.isMouse ? undefined : from);
  }

  /** Grow the tube by one bead and the link to the previous one. */
  private addLassoPoint(p: Vector3): void {
    const pts = this.lasso!.points;
    const i = pts.length;
    pts.push(p.clone());
    this.im.makeTranslation(p.x, p.y, p.z);
    this.beads.setMatrixAt(i, this.im);
    this.beads.count = i + 1;
    this.beads.instanceMatrix.needsUpdate = true;
    if (i > 0) {
      const prev = pts[i - 1];
      this.idir.subVectors(p, prev);
      const len = this.idir.length();
      this.iq.setFromUnitVectors(UP, this.idir.multiplyScalar(1 / Math.max(len, 1e-6)));
      this.im.compose(this.tmp.addVectors(p, prev).multiplyScalar(0.5), this.iq, this.is.set(1, len, 1));
      this.links.setMatrixAt(i - 1, this.im);
      this.links.count = i;
      this.links.instanceMatrix.needsUpdate = true;
    }
    // The dashed closing line from here back to the start.
    const pos = this.closer.geometry.attributes.position;
    pos.setXYZ(0, p.x, p.y, p.z);
    pos.setXYZ(1, pts[0].x, pts[0].y, pts[0].z);
    pos.needsUpdate = true;
    this.closer.computeLineDistances();
  }

  /** What the loop encloses, as seen from the eye. */
  private enclosed(points: Vector3[]): Selectable[] {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld(true);
    const project = (w: Vector3): Vector2 | null => {
      const l = cam.worldToLocal(this.tmp.copy(w));
      if (l.z > -0.01) return null;
      return new Vector2(l.x / -l.z, l.y / -l.z);
    };
    const poly = points.map(project).filter((v): v is Vector2 => v != null);
    const caught: Selectable[] = [];
    if (poly.length < 3) return caught;
    for (const item of this.sources.flatMap((s) => s.items())) {
      item.bounds(this.tmp2);
      const c = project(this.tmp2);
      if (c && inside(c, poly)) caught.push(item);
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
    const { hand, via, points } = this.lasso;
    const held = via === 'pinch' ? hand.pinching : hand.grabbing;
    if (held && hand.tracked) {
      const p = via === 'pinch' ? hand.pinchPoint : hand.grabPoint;
      if (points.length < MAX_LASSO_POINTS && points[points.length - 1].distanceTo(p) > 0.005) {
        this.addLassoPoint(p);
        // Live preview: what the loop would catch if you let go now lights up.
        if (points.length >= 6 && points.length % 2 === 0) {
          const before = this.items.length;
          this.setItems(this.enclosed(points));
          if (this.items.length > before) Sfx.blip(1100, hand.isMouse ? undefined : p);
        }
      }
      return;
    }
    // Released: select what the loop encloses, as seen from the eye.
    this.beads.visible = this.links.visible = this.closer.visible = false;
    this.lasso = null;
    if (points.length < 6) {
      this.setItems([]);
      return;
    }
    const caught = this.enclosed(points);
    this.lastCaught = caught.length;
    this.setItems(caught);
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
    for (const [item, halo] of this.halos) {
      if (items.includes(item)) continue;
      item.setLit?.(false);
      halo.removeFromParent();
      halo.geometry.dispose();
      this.halos.delete(item);
    }
    this.items = items;
    for (const item of items) {
      item.setLit?.(true);
      if (this.halos.has(item)) continue;
      const halo = new Mesh(new RingGeometry(0.96, 1, 48), this.haloMat);
      halo.renderOrder = 35;
      this.group.add(halo);
      this.halos.set(item, halo);
    }
    if (items.length === 0) {
      this.hold = null;
      this.menu.visible = false;
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

  private paint(): void {
    const hex = this.paintColor();
    for (const source of this.sources) {
      const mine = this.items.filter((i) => i.source === source);
      if (mine.length) source.recolor?.(mine, hex);
    }
    Sfx.blip(820);
  }

  /** Halos around each selected thing, menu above the whole selection, all facing you. */
  private layoutMenu(): void {
    // The eye: the camera, which is right in both XR and the desktop view.
    const head = this.ctx.camera.getWorldPosition(this.eye);
    let top = -Infinity;
    const center = new Vector3();
    for (const [item, halo] of this.halos) {
      const r = item.bounds(this.tmp);
      halo.position.copy(this.tmp);
      halo.scale.setScalar(r + 0.012);
      halo.lookAt(head);
      center.add(this.tmp);
      top = Math.max(top, this.tmp.y + r);
    }
    this.menu.visible = this.active && !this.hold && !this.lasso;
    if (!this.menu.visible) return;
    center.multiplyScalar(1 / this.halos.size);
    this.menu.position.set(center.x, top + 0.05, center.z);
    // Face the buttons (their +Y) toward the viewer.
    const toHead = this.tmp.copy(head).sub(this.menu.position).normalize();
    this.menu.quaternion.setFromUnitVectors(UP, toHead);
    // Keep the row level: twist about the facing axis so local X stays horizontal.
    const x = new Vector3(1, 0, 0).applyQuaternion(this.menu.quaternion);
    const wantX = new Vector3(-toHead.z, 0, toHead.x).normalize();
    if (wantX.lengthSq() > 0.5) {
      const angle = Math.atan2(new Vector3().crossVectors(x, wantX).dot(toHead), x.dot(wantX));
      this.menu.quaternion.premultiply(this.q.setFromAxisAngle(toHead, angle));
    }
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
