/**
 * A round button that sits on the desk (or on a tilted strip): an icon on
 * top, a label that appears only while a hand or cursor is near it.
 *
 * Press it by poking down on it, pinching on it, clicking it, or pointing at
 * it from afar with a hand ray and pinching. The host updates every visible
 * button before the active app runs, and a pinch that presses a button is
 * consumed, so the app does not also react to it.
 *
 * The button's face points along its group's local +Y.
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
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import type { HandState } from './hands.js';
import { drawIcon } from './icons.js';
import { RayTargets } from './rays.js';
import { Sfx } from './sfx.js';

const HEIGHT = 0.008;
const COOLDOWN = 0.3;

export interface IconButtonOptions {
  id: string;
  icon: string;
  label: string;
  accent?: string;
  /** Radius in metres (default 1.6 cm). */
  radius?: number;
}

function isShown(o: { visible: boolean; parent: unknown }): boolean {
  let n = o as { visible: boolean; parent: unknown } | null;
  while (n) {
    if (!n.visible) return false;
    n = n.parent as typeof n;
  }
  return true;
}

export class IconButton {
  static readonly all: IconButton[] = [];
  readonly group = new Group();
  readonly id: string;
  onPress: () => void = () => {};
  /** Hovered this frame by a hand, the mouse or a ray. */
  hovered = false;
  private _active = false;
  private _disabled = false;
  private _icon: string;
  private _label: string;
  private readonly accent: string;
  private readonly radius: number;
  private readonly cap: Mesh;
  private readonly face: Mesh;
  private readonly faceCanvas = document.createElement('canvas');
  private readonly faceTexture: CanvasTexture;
  private readonly ring: Mesh;
  private readonly ringMat: MeshBasicMaterial;
  private readonly tip: Mesh;
  private readonly tipCanvas = document.createElement('canvas');
  private readonly tipTexture: CanvasTexture;
  private readonly lastY = new Map<HandState, number>();
  private cooldown = 0;
  private rayHover = 0;
  private hoverAmount = 0;
  private push = 0;
  private readonly local = new Vector3();
  private readonly q = new Quaternion();

  constructor(opts: IconButtonOptions) {
    this.id = opts.id;
    this._icon = opts.icon;
    this._label = opts.label;
    this.accent = opts.accent ?? '#9fc7ff';
    this.radius = opts.radius ?? 0.016;
    const r = this.radius;
    this.group.name = `Icon:${opts.id}`;

    this.cap = new Mesh(new CylinderGeometry(r, r * 1.05, HEIGHT, 32), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.45 }));
    this.cap.position.y = HEIGHT / 2;
    this.faceCanvas.width = this.faceCanvas.height = 128;
    this.faceTexture = new CanvasTexture(this.faceCanvas);
    this.faceTexture.colorSpace = SRGBColorSpace;
    this.face = new Mesh(new CircleGeometry(r * 0.98, 32), new MeshBasicMaterial({ map: this.faceTexture, transparent: true }));
    this.face.rotation.x = -Math.PI / 2;
    this.face.position.y = HEIGHT + 0.0004;
    this.ringMat = new MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0 });
    this.ring = new Mesh(new RingGeometry(r * 1.08, r * 1.28, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.0012;

    this.tipCanvas.width = 320;
    this.tipCanvas.height = 72;
    this.tipTexture = new CanvasTexture(this.tipCanvas);
    this.tipTexture.colorSpace = SRGBColorSpace;
    this.tip = new Mesh(new PlaneGeometry(0.08, 0.018), new MeshBasicMaterial({ map: this.tipTexture, transparent: true, depthTest: false }));
    this.tip.renderOrder = 25;
    this.tip.visible = false;
    this.tip.position.y = r + 0.03;

    this.group.add(this.cap, this.face, this.ring, this.tip);
    this.group.userData.hideInShots = true;
    this.drawFace();
    this.drawTip();
    IconButton.all.push(this);

    RayTargets.add({
      hit: (origin, dir) => (isShown(this.group) && !this._disabled ? this.rayHit(origin, dir) : null),
      hover: () => (this.rayHover = 0.12),
      press: () => this.press(),
    });
  }

  get active(): boolean {
    return this._active;
  }
  set active(v: boolean) {
    if (v === this._active) return;
    this._active = v;
    this.drawFace();
  }
  get disabled(): boolean {
    return this._disabled;
  }
  set disabled(v: boolean) {
    if (v === this._disabled) return;
    this._disabled = v;
    this.drawFace();
  }
  set icon(name: string) {
    if (name === this._icon) return;
    this._icon = name;
    this.drawFace();
  }
  set label(text: string) {
    if (text === this._label) return;
    this._label = text;
    this.drawTip();
  }
  get label(): string {
    return this._label;
  }

  private drawFace(): void {
    const c = this.faceCanvas.getContext('2d')!;
    const s = 128;
    c.clearRect(0, 0, s, s);
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
    c.fillStyle = this._active ? this.accent : '#1d2027';
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = this._active ? '#ffffff' : this.accent;
    c.globalAlpha = this._disabled ? 0.35 : 1;
    c.stroke();
    c.translate(s * 0.18, s * 0.18);
    drawIcon(c, this._icon, s * 0.64, this._active ? '#14161b' : '#f4f5f7');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    this.faceTexture.needsUpdate = true;
  }

  private drawTip(): void {
    const c = this.tipCanvas.getContext('2d')!;
    const { width: w, height: h } = this.tipCanvas;
    c.clearRect(0, 0, w, h);
    c.font = '700 40px system-ui, sans-serif';
    const tw = Math.min(w - 8, c.measureText(this._label).width + 40);
    c.fillStyle = 'rgba(20,22,27,0.9)';
    c.beginPath();
    c.roundRect?.((w - tw) / 2, 4, tw, h - 8, 28);
    c.fill();
    c.fillStyle = '#f4f5f7';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(this._label, w / 2, h / 2 + 2, w - 24);
    this.tipTexture.needsUpdate = true;
  }

  /** Press it (also used by tests and shortcuts; `force` skips the repeat guard). */
  /** Times pressed (for tests). */
  presses = 0;

  press(force = false): void {
    if (this._disabled || (this.cooldown > 0 && !force)) return;
    this.presses += 1;
    this.cooldown = COOLDOWN;
    this.push = 1;
    Sfx.click(this.group.getWorldPosition(this.local));
    this.onPress();
  }

  /** World centre of the face, for tests. */
  worldCenter(): Vector3 {
    this.group.updateMatrixWorld(true);
    return this.group.localToWorld(new Vector3(0, HEIGHT, 0));
  }

  /** World normal of the face. */
  worldNormal(): Vector3 {
    return new Vector3(0, 1, 0).applyQuaternion(this.group.getWorldQuaternion(this.q));
  }

  private rayHit(origin: Vector3, dir: Vector3): number | null {
    this.group.updateMatrixWorld(true);
    const o = this.group.worldToLocal(this.local.copy(origin)).clone();
    const d = this.group.worldToLocal(this.local.copy(origin).add(dir)).sub(o);
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (HEIGHT - o.y) / d.y;
    if (t <= 0) return null;
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    if (Math.hypot(x, z) > this.radius * 1.3) return null;
    // The local ray is the world ray mapped through the group, so t is world distance.
    return t;
  }

  update(pointers: readonly HandState[], head: Vector3, dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.rayHover = Math.max(0, this.rayHover - dt);
    let hover = this.rayHover > 0;
    if (!this._disabled) {
      this.group.updateMatrixWorld(true);
      for (const p of pointers) {
        if (!p.tracked) continue;
        if (p.isMouse) {
          const t = this.rayHit(p.rayOrigin, p.rayDir);
          if (t != null) {
            hover = true;
            if (p.pinchStarted || p.grabStarted) {
              this.press();
              p.clearEdges();
            }
          }
          continue;
        }
        // Poke: the fingertip comes down onto the face.
        const tip = this.group.worldToLocal(this.local.copy(p.indexTip));
        const inside = Math.hypot(tip.x, tip.z) < this.radius * 1.2;
        if (inside && tip.y < 0.05 && tip.y > -0.02) hover = true;
        // Arm while the fingertip is above the face (or off it); press as it comes down.
        // The tip joint sits inside the finger pad, so a touch registers a few mm above the face.
        // A finger sliding in sideways at desk height never arms it.
        const armed = this.lastY.get(p) ?? 0;
        if (!inside) this.lastY.set(p, 0);
        else if (tip.y > HEIGHT + 0.012) this.lastY.set(p, 1);
        else if (armed > 0 && tip.y <= HEIGHT + 0.006 && tip.y > -0.02) {
          this.lastY.set(p, 0);
          this.press();
        }
        // Or pinch on it.
        if (p.pinchStarted) {
          const q = this.group.worldToLocal(this.local.copy(p.pinchPoint));
          if (Math.hypot(q.x, q.z) < this.radius * 1.5 && Math.abs(q.y - HEIGHT) < 0.03) {
            this.press();
            p.clearEdges();
          }
        }
      }
    }
    if (hover && !this.hovered && pointers.some((p) => !p.isMouse && p.tracked)) Sfx.hover(this.group.getWorldPosition(this.local));
    this.hovered = hover;
    this.hoverAmount += ((hover ? 1 : 0) - this.hoverAmount) * Math.min(1, dt * 14);
    this.push = Math.max(0, this.push - dt * 6);
    this.cap.scale.y = 1 - this.push * 0.5;
    this.cap.position.y = (HEIGHT * this.cap.scale.y) / 2;
    this.face.position.y = HEIGHT * this.cap.scale.y + 0.0004;
    this.ringMat.opacity = Math.max(this._active ? 0.9 : 0, this.hoverAmount * 0.8);
    this.tip.visible = this.hoverAmount > 0.3;
    if (this.tip.visible) {
      // Face the viewer.
      this.tip.lookAt(head.x, head.y, head.z);
    }
  }

  /** Update every visible button (the host calls this once per frame). */
  static updateAll(pointers: readonly HandState[], head: Vector3, dt: number): void {
    for (const b of IconButton.all) if (isShown(b.group)) b.update(pointers, head, dt);
  }

  static find(id: string): IconButton | undefined {
    return IconButton.all.find((b) => b.id === id && isShown(b.group));
  }
}
