/**
 * A window on the desk, for Studio's mini OS: a group holding one tool, an
 * optional tray under it, and a handle bar along its front edge with the
 * title and a close button.
 *
 * Pinch or grab the handle to move the window; it follows your hand and
 * turns with your wrist (upright). Poke or pinch the round button to close.
 */

import {
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { roundRect } from './panel.js';
import { HeldPose } from './grab.js';
import { grabDistance, type HandState, pointerDistance } from './hands.js';
import { Sfx } from './sfx.js';
import { withAlpha } from './art.js';

export interface WindowOptions {
  id: string;
  title: string;
  accent: string;
  /** Tray under the tool: size and centre (window-local, on y = 0). */
  tray?: { width: number; depth: number; z?: number };
  /** Handle bar centre (window-local) and length. */
  handle: { position: [number, number, number]; length: number };
}

const BAR_RADIUS = 0.006;
const GRAB_REACH = 0.03;
const CLOSE_R = 0.013;

export class DeskWindow {
  readonly root = new Group();
  /** Put the tool's objects in here. */
  readonly content = new Group();
  readonly id: string;
  readonly title: string;
  private readonly chrome = new Group();
  private readonly barMat: MeshStandardMaterial;
  private readonly closeMesh: Mesh;
  private readonly closeMat: MeshBasicMaterial;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly tmp = new Vector3();
  private readonly lastDepth = new Map<HandState, number>();
  private drag: { hand: HandState; pose: HeldPose } | null = null;
  /** Called after the window was moved and let go. */
  onMoved: () => void = () => {};
  onClose: () => void = () => {};

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
      const tray = new Mesh(new PlaneGeometry(width, depth), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
      tray.rotation.x = -Math.PI / 2;
      tray.position.set(0, 0.0015, z);
      tray.renderOrder = 1;
      this.chrome.add(tray);
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
    lc.fillStyle = '#f4f5f7';
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

    // Close button at the right end of the bar.
    const x = document.createElement('canvas');
    x.width = 64;
    x.height = 64;
    const xc = x.getContext('2d')!;
    xc.fillStyle = '#e5484d';
    xc.beginPath();
    xc.arc(32, 32, 30, 0, Math.PI * 2);
    xc.fill();
    xc.strokeStyle = '#ffffff';
    xc.lineWidth = 7;
    xc.lineCap = 'round';
    xc.beginPath();
    xc.moveTo(21, 21);
    xc.lineTo(43, 43);
    xc.moveTo(43, 21);
    xc.lineTo(21, 43);
    xc.stroke();
    const xt = new CanvasTexture(x);
    xt.colorSpace = SRGBColorSpace;
    this.closeMat = new MeshBasicMaterial({ map: xt, transparent: true });
    this.closeMesh = new Mesh(new CircleGeometry(CLOSE_R, 24), this.closeMat);
    this.closeMesh.position.set(hx + len / 2 + 0.024, hy + 0.006, hz);
    this.closeMesh.rotation.x = -0.6;
    this.closeMesh.name = `Close:${opts.id}`;
    this.chrome.add(this.closeMesh);
  }

  get open(): boolean {
    return this.root.visible;
  }

  set open(value: boolean) {
    this.root.visible = value;
    if (!value) this.drag = null;
  }

  get moving(): boolean {
    return this.drag != null;
  }

  /** True if this hand is moving the window. */
  owns(hand: HandState): boolean {
    return this.drag?.hand === hand;
  }

  /**
   * Handle and close button. Pinches and grabs used here are consumed
   * (`clearEdges`) so the tools underneath do not also react.
   */
  update(pointers: readonly HandState[]): void {
    if (!this.open) return;
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
    let near = Infinity;
    const close = this.closeMesh.getWorldPosition(this.tmp).clone();
    for (const p of pointers) {
      if (!p.tracked) continue;
      // Close: a poke, a pinch, or a click.
      const startedHere = (p.pinchStarted || p.grabStarted) && pointerDistance(p, close) < CLOSE_R * 1.8;
      const depth = p.isMouse ? 1 : p.indexTip.distanceTo(close);
      const last = this.lastDepth.get(p) ?? 1;
      this.lastDepth.set(p, depth);
      if (startedHere || (depth < CLOSE_R && last >= CLOSE_R)) {
        p.clearEdges();
        Sfx.click(p.isMouse ? undefined : close);
        this.open = false;
        this.onClose();
        return;
      }
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
    this.closeMesh.scale.setScalar(Math.min(...pointers.map((p) => (p.tracked ? pointerDistance(p, close) : 1))) < 0.04 ? 1.25 : 1);
  }

  /** Distance from a pointer to the handle bar. */
  private barDistance(p: HandState): number {
    const [hx, hy, hz] = this.opts.handle.position;
    const len = this.opts.handle.length;
    this.root.updateMatrixWorld(true);
    const a = this.root.localToWorld(this.a.set(hx - len / 2, hy, hz));
    const b = this.root.localToWorld(this.b.set(hx + len / 2, hy, hz));
    const ab = b.sub(a);
    const nearest = (point: Vector3, dist: (p: HandState, v: Vector3) => number): number => {
      const t = Math.min(1, Math.max(0, this.tmp.copy(point).sub(a).dot(ab) / ab.lengthSq()));
      return dist(p, this.tmp.copy(a).addScaledVector(ab, t));
    };
    return Math.min(nearest(p.pinchPoint, pointerDistance), nearest(p.grabPoint, grabDistance));
  }

  /** World centre of the handle bar and the close button, for tests. */
  debug(): { handle: Vector3; close: Vector3 } {
    this.root.updateMatrixWorld(true);
    return {
      handle: this.root.localToWorld(new Vector3(...this.opts.handle.position)),
      close: this.closeMesh.getWorldPosition(new Vector3()),
    };
  }
}
