/**
 * A window on the desk, for Studio's mini OS: a group holding one tool, an
 * optional tray under it, and a handle bar along its front edge with the
 * title and three round buttons: pin, focus and hide.
 *
 *   Move    - pinch or grab the bar (or point at it from afar and pinch); the
 *             window follows your hand and turns with your wrist.
 *   Pin     - pinned windows keep their controls showing. Unpinned windows
 *             fold their controls away when no hand is near, and unfold as
 *             soon as you reach toward them.
 *   Focus   - the host gives this tool the desk (see Studio).
 *   Hide    - tuck it away; the dock brings it back.
 */

import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { withAlpha } from './art.js';
import { HeldPose } from './grab.js';
import { grabDistance, type HandState, pointerDistance } from './hands.js';
import { IconButton } from './icon-button.js';
import { roundRect } from './panel.js';
import { RayTargets } from './rays.js';
import { Sfx } from './sfx.js';

export interface WindowOptions {
  id: string;
  title: string;
  accent: string;
  /** Tray under the tool: size and centre (window-local, on y = 0). */
  tray?: { width: number; depth: number; z?: number };
  /** Handle bar centre (window-local) and length. */
  handle: { position: [number, number, number]; length: number };
  /** Where the tool is, for "is a hand near": centre (window-local) and radius. */
  reach: { center: [number, number, number]; radius: number };
}

const BAR_RADIUS = 0.006;
const GRAB_REACH = 0.03;
/** Seconds without a hand near before an unpinned window folds its controls. */
const FOLD_AFTER = 3;

function shown(o: { visible: boolean; parent: unknown }): boolean {
  let n = o as { visible: boolean; parent: unknown } | null;
  while (n) {
    if (!n.visible) return false;
    n = n.parent as typeof n;
  }
  return true;
}

export class DeskWindow {
  readonly root = new Group();
  /** Put the tool's objects in here. */
  readonly content = new Group();
  readonly id: string;
  readonly title: string;
  readonly pinButton: IconButton;
  readonly focusButton: IconButton;
  readonly hideButton: IconButton;
  private readonly chrome = new Group();
  private readonly tray: Mesh | null = null;
  private readonly barMat: MeshStandardMaterial;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly tmp = new Vector3();
  private drag: { hand: HandState; pose: HeldPose } | null = null;
  private rayDrag: { hand: HandState; distance: number; offset: Vector3 } | null = null;
  private _pinned = false;
  private _expanded = true;
  private idle = 0;
  /** Called after the window was moved and let go. */
  onMoved: () => void = () => {};
  onHide: () => void = () => {};
  onFocus: () => void = () => {};
  onPin: (pinned: boolean) => void = () => {};
  /** Show or fold the tool's controls. */
  onExpand: (expanded: boolean) => void = () => {};

  constructor(private readonly opts: WindowOptions) {
    this.id = opts.id;
    this.title = opts.title;
    this.root.name = `Window:${opts.id}`;
    this.root.add(this.content, this.chrome);
    this.chrome.userData.hideInShots = true;

    if (opts.tray) {
      const { width, depth, z = 0 } = opts.tray;
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = Math.round((512 * depth) / width);
      const c = canvas.getContext('2d')!;
      roundRect(c, 6, 6, canvas.width - 12, canvas.height - 12, 36);
      c.fillStyle = 'rgba(28,31,38,0.55)';
      c.fill();
      c.lineWidth = 5;
      c.strokeStyle = withAlpha(opts.accent, 0.75);
      c.stroke();
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      this.tray = new Mesh(new PlaneGeometry(width, depth), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
      this.tray.rotation.x = -Math.PI / 2;
      this.tray.position.set(0, 0.0015, z);
      this.tray.renderOrder = 1;
      this.chrome.add(this.tray);
    }

    const [hx, hy, hz] = opts.handle.position;
    const len = opts.handle.length;
    this.barMat = new MeshStandardMaterial({ color: '#d7dbe2', emissive: opts.accent, emissiveIntensity: 0.15, roughness: 0.35 });
    const bar = new Mesh(new CylinderGeometry(BAR_RADIUS, BAR_RADIUS, len, 14), this.barMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(hx, hy, hz);
    this.chrome.add(bar);

    // Title just behind the bar, tilted toward the user.
    const label = document.createElement('canvas');
    label.width = 512;
    label.height = 64;
    const lc = label.getContext('2d')!;
    lc.font = '700 40px system-ui, sans-serif';
    lc.textBaseline = 'middle';
    lc.fillStyle = opts.accent;
    lc.beginPath();
    lc.arc(18, 32, 9, 0, Math.PI * 2);
    lc.fill();
    lc.fillStyle = '#f4f5f7';
    lc.fillText(opts.title, 38, 34);
    const lt = new CanvasTexture(label);
    lt.colorSpace = SRGBColorSpace;
    const labelMesh = new Mesh(new PlaneGeometry(0.16, 0.02), new MeshBasicMaterial({ map: lt, transparent: true, depthWrite: false }));
    labelMesh.position.set(hx - len / 2 + 0.08, hy + 0.016, hz - 0.004);
    labelMesh.rotation.x = -0.5;
    this.chrome.add(labelMesh);

    // Pin, focus and hide: small round buttons past the right end of the bar.
    const mk = (id: string, icon: string, text: string, i: number): IconButton => {
      const btn = new IconButton({ id: `win:${opts.id}:${id}`, icon, label: text, accent: opts.accent, radius: 0.011 });
      btn.group.position.set(hx + len / 2 + 0.02 + i * 0.027, hy - 0.004, hz);
      this.chrome.add(btn.group);
      return btn;
    };
    this.pinButton = mk('pin', 'pin', 'Pin (keep controls showing)', 0);
    this.focusButton = mk('focus', 'focus', 'Focus on this tool', 1);
    this.hideButton = mk('hide', 'hide', 'Hide (bring back from the dock)', 2);
    this.pinButton.onPress = () => {
      this.pinned = !this._pinned;
      this.onPin(this._pinned);
    };
    this.focusButton.onPress = () => this.onFocus();
    this.hideButton.onPress = () => {
      this.open = false;
      this.onHide();
    };

    // Drag the bar from afar with a hand ray.
    RayTargets.add({
      hit: (origin, dir) => (shown(this.root) && !this.drag ? this.rayToBar(origin, dir) : null),
      hover: () => {
        this.barMat.emissiveIntensity = 0.8;
        this.idle = 0;
        this.setExpanded(true);
      },
      drag: {
        begin: (hand, origin, dir, distance) => {
          const at = origin.clone().addScaledVector(dir, distance);
          this.rayDrag = { hand, distance, offset: this.root.getWorldPosition(new Vector3()).sub(at) };
          Sfx.pinch();
        },
        update: (_hand, origin, dir) => {
          if (!this.rayDrag) return;
          const world = origin.clone().addScaledVector(dir, this.rayDrag.distance).add(this.rayDrag.offset);
          this.root.parent?.worldToLocal(world);
          this.root.position.copy(world);
        },
        end: () => {
          this.rayDrag = null;
          Sfx.place();
          this.onMoved();
        },
      },
    });
  }

  get open(): boolean {
    return this.root.visible;
  }

  set open(value: boolean) {
    this.root.visible = value;
    if (!value) this.drag = null;
  }

  get pinned(): boolean {
    return this._pinned;
  }

  set pinned(v: boolean) {
    this._pinned = v;
    this.pinButton.active = v;
    if (v) this.setExpanded(true);
  }

  get expanded(): boolean {
    return this._expanded;
  }

  /** Focus button lit while this window has focus. */
  set focused(v: boolean) {
    this.focusButton.active = v;
  }

  set trayVisible(v: boolean) {
    if (this.tray) this.tray.visible = v;
  }

  setExpanded(v: boolean): void {
    if (v === this._expanded) return;
    this._expanded = v;
    this.onExpand(v);
  }

  get moving(): boolean {
    return this.drag != null || this.rayDrag != null;
  }

  /** True if this hand is moving the window. */
  owns(hand: HandState): boolean {
    return this.drag?.hand === hand || this.rayDrag?.hand === hand;
  }

  /**
   * Handle bar and folding. Pinches and grabs used on the bar are consumed
   * (`clearEdges`) so the tools underneath do not also react.
   */
  update(pointers: readonly HandState[], dt: number): void {
    if (!this.open) return;
    this.updateFold(pointers, dt);
    if (this.drag) {
      const { hand, pose } = this.drag;
      if (!(hand.pinching || hand.grabbing) || !hand.tracked) {
        this.drag = null;
        Sfx.place(this.root.getWorldPosition(this.tmp));
        this.onMoved();
        return;
      }
      pose.apply(hand, this.root, { upright: true });
      this.barMat.emissiveIntensity = 1;
      return;
    }
    if (this.rayDrag) {
      this.barMat.emissiveIntensity = 1;
      return;
    }
    let near = Infinity;
    for (const p of pointers) {
      if (!p.tracked) continue;
      const d = this.barDistance(p);
      near = Math.min(near, d);
      if ((p.pinchStarted || p.grabStarted) && d < GRAB_REACH) {
        const pose = new HeldPose();
        pose.begin(p, this.root, { upright: true });
        this.drag = { hand: p, pose };
        p.clearEdges();
        Sfx.pinch(p.isMouse ? undefined : p.holdPoint);
        return;
      }
    }
    this.barMat.emissiveIntensity = near < 0.08 ? 0.3 + (1 - near / 0.08) * 0.5 : 0.15;
  }

  /** Unpinned windows show their controls only while a hand (or the cursor) is near. */
  private updateFold(pointers: readonly HandState[], dt: number): void {
    if (this._pinned || this.moving) {
      this.idle = 0;
      this.setExpanded(true);
      return;
    }
    const [cx, cy, cz] = this.opts.reach.center;
    this.root.updateMatrixWorld(true);
    const center = this.root.localToWorld(this.tmp.set(cx, cy, cz));
    const reach = this.opts.reach.radius * this.root.scale.x + 0.1;
    const near = pointers.some((p) => p.tracked && (p.isMouse ? pointerDistance(p, center) < reach : Math.min(p.indexTip.distanceTo(center), p.palm.distanceTo(center)) < reach));
    if (near) {
      this.idle = 0;
      this.setExpanded(true);
      return;
    }
    this.idle += dt;
    if (this.idle > FOLD_AFTER) this.setExpanded(false);
  }

  /** Distance from a pointer to the handle bar. */
  private barDistance(p: HandState): number {
    const [a, b] = this.barEnds();
    const ab = b.clone().sub(a);
    const nearest = (point: Vector3, dist: (p: HandState, v: Vector3) => number): number => {
      const t = Math.min(1, Math.max(0, this.tmp.copy(point).sub(a).dot(ab) / ab.lengthSq()));
      return dist(p, this.tmp.copy(a).addScaledVector(ab, t));
    };
    return Math.min(nearest(p.pinchPoint, pointerDistance), nearest(p.grabPoint, grabDistance));
  }

  private barEnds(): [Vector3, Vector3] {
    const [hx, hy, hz] = this.opts.handle.position;
    const len = this.opts.handle.length;
    this.root.updateMatrixWorld(true);
    return [this.root.localToWorld(this.a.set(hx - len / 2, hy, hz)), this.root.localToWorld(this.b.set(hx + len / 2, hy, hz))];
  }

  /** Ray distance to the bar if the ray passes within 2.5 cm of it. */
  private rayToBar(origin: Vector3, dir: Vector3): number | null {
    const [a, b] = this.barEnds();
    // Closest points between the ray and the bar segment.
    const u = b.clone().sub(a);
    const w = origin.clone().sub(a);
    const uu = u.dot(u);
    const ud = u.dot(dir);
    const uw = u.dot(w);
    const dw = dir.dot(w);
    const denom = uu - ud * ud;
    let s = denom > 1e-9 ? (uw - ud * dw) / denom : 0;
    s = Math.min(1, Math.max(0, s));
    const onBar = a.clone().addScaledVector(u, s);
    const t = onBar.clone().sub(origin).dot(dir);
    if (t <= 0) return null;
    const miss = origin.clone().addScaledVector(dir, t).distanceTo(onBar);
    return miss < 0.025 ? t : null;
  }

  /** World centre of the handle bar and its buttons, for tests. */
  debug(): { handle: Vector3; pin: Vector3; focus: Vector3; hide: Vector3 } {
    this.root.updateMatrixWorld(true);
    return {
      handle: this.root.localToWorld(new Vector3(...this.opts.handle.position)),
      pin: this.pinButton.worldCenter(),
      focus: this.focusButton.worldCenter(),
      hide: this.hideButton.worldCenter(),
    };
  }
}
