/**
 * Shared visual language for every prototype.
 *
 * In passthrough the real desk is the backdrop, so virtual objects need help
 * to feel like they sit on it: a soft desk mat that frames the workspace,
 * blob shadows under objects, and a pinch cursor that shows how close your
 * thumb and index are to "clicking". Everything is drawn into small canvas
 * textures at startup; nothing here allocates per frame.
 */

import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3 as V3,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  type Vector3,
} from '@iwsdk/core';
import { ALL_JOINTS } from './hands.js';
import type { HandState } from './hands.js';

export const ACCENTS = {
  hub: '#9fc7ff',
  focus: '#7fe0b5',
  conjure: '#c7a6ff',
  shotboard: '#ffcf70',
  clay: '#ff9a76',
  golf: '#8fd1ff',
  sketch: '#ff9ad5',
  intro: '#9fc7ff',
} as const;

let shadowTexture: CanvasTexture | null = null;

function radialTexture(): CanvasTexture {
  if (shadowTexture) return shadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  shadowTexture = new CanvasTexture(canvas);
  return shadowTexture;
}

/** A soft contact shadow lying on y = 0 of its parent. */
export function blobShadow(width: number, depth = width, opacity = 1): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(width, depth),
    new MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, opacity }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.0012;
  mesh.renderOrder = 1;
  mesh.name = 'BlobShadow';
  return mesh;
}

/**
 * The desk mat: a rounded, softly shadowed pad that marks the workspace on
 * the real table. Its rim takes the active prototype's accent colour.
 */
export class DeskMat {
  readonly mesh: Mesh;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private accent = '';

  constructor(width = 0.8, depth = 0.5) {
    this.canvas.width = 1024;
    this.canvas.height = Math.round((1024 * depth) / width);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(width, depth),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false }),
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.0008;
    this.mesh.renderOrder = 0;
    this.mesh.name = 'DeskMat';
    this.setAccent(ACCENTS.hub);
  }

  setAccent(accent: string): void {
    if (accent === this.accent) return;
    this.accent = accent;
    const ctx = this.canvas.getContext('2d')!;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    // Soft drop shadow, then the pad, then a thin accent rim.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 40;
    rounded(ctx, 40, 40, w - 80, h - 80, 56);
    ctx.fillStyle = 'rgba(28, 31, 38, 0.78)';
    ctx.fill();
    ctx.restore();
    const grad = ctx.createLinearGradient(0, 40, 0, h - 40);
    grad.addColorStop(0, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    rounded(ctx, 40, 40, w - 80, h - 80, 56);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = withAlpha(accent, 0.75);
    rounded(ctx, 46, 46, w - 92, h - 92, 52);
    ctx.stroke();
    // A faint dotted grid helps judge depth on the pad.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let x = 120; x < w - 100; x += 64) {
      for (let y = 110; y < h - 90; y += 64) ctx.fillRect(x, y, 4, 4);
    }
    this.texture.needsUpdate = true;
  }
}

/**
 * Pinch cursor: a ring between thumb and index that closes as they come
 * together and fills with the accent colour when the pinch registers, plus
 * a small dot on the index tip for poking.
 */
export class HandCursor {
  readonly group = new Group();
  private readonly ring: Mesh;
  private readonly dot: Mesh;
  private readonly ringMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false });
  private readonly dotMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false });
  private readonly accent = new Color(ACCENTS.hub);
  private readonly white = new Color('#ffffff');

  constructor() {
    this.ring = new Mesh(new RingGeometry(0.8, 1, 32), this.ringMat);
    this.dot = new Mesh(new SphereGeometry(0.0035, 10, 8), this.dotMat);
    this.ring.renderOrder = 20;
    this.dot.renderOrder = 20;
    this.group.add(this.ring, this.dot);
    this.group.visible = false;
  }

  setAccent(hex: string): void {
    this.accent.set(hex);
  }

  update(hand: HandState, head: Vector3, visible: boolean): void {
    this.group.visible = visible && hand.tracked && !hand.isMouse;
    if (!this.group.visible) return;
    const gap = hand.indexTip.distanceTo(hand.thumbTip);
    // Ring radius follows the pinch gap; hide it when the hand is wide open.
    const r = Math.max(0.006, Math.min(0.03, gap * 0.55));
    this.ring.visible = gap < 0.07;
    this.ring.position.copy(hand.pinchPoint);
    this.ring.scale.setScalar(r);
    this.ring.lookAt(head);
    const closeness = Math.min(1, Math.max(0, (0.07 - gap) / 0.05));
    this.ringMat.color.copy(this.white).lerp(this.accent, hand.pinching ? 1 : closeness * 0.5);
    this.ringMat.opacity = hand.pinching ? 1 : 0.25 + closeness * 0.5;
    this.dot.position.copy(hand.indexTip);
    this.dotMat.color.copy(hand.pinching ? this.accent : this.white);
  }
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** '#rrggbb' to an rgba() string (canvas colours are sRGB, so no conversion). */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Bones as joint index pairs: wrist to each metacarpal, then down each finger. */
const BONES: [number, number][] = [];
for (const start of [1, 5, 10, 15, 20]) {
  BONES.push([0, start]);
  const end = start === 1 ? 4 : start + 4;
  for (let j = start; j < end; j += 1) BONES.push([j, j + 1]);
}

/**
 * A light procedural hand: joint spheres and bones drawn from tracked joints.
 * Used for recordings and as a fallback when the stock hand models cannot
 * load. Two instanced meshes per hand, no allocation per frame.
 */
export class HandSkeleton {
  readonly group = new Group();
  private readonly joints: InstancedMesh;
  private readonly bones: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new V3();
  private readonly mid = new V3();
  private readonly dir = new V3();
  private readonly up = new V3(0, 1, 0);

  constructor(color = '#dfe8ff') {
    const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false });
    this.joints = new InstancedMesh(new SphereGeometry(1, 10, 8), mat, ALL_JOINTS.length);
    this.bones = new InstancedMesh(new CylinderGeometry(1, 1, 1, 8), mat, BONES.length);
    this.joints.frustumCulled = false;
    this.bones.frustumCulled = false;
    this.joints.renderOrder = 19;
    this.bones.renderOrder = 19;
    this.group.add(this.joints, this.bones);
    this.group.visible = false;
  }

  update(hand: HandState, visible: boolean): void {
    this.group.visible = visible && hand.tracked && !hand.isMouse && !hand.isController;
    if (!this.group.visible) return;
    hand.joints.forEach((p, i) => {
      const r = i === 0 ? 0.012 : (i + 1) % 5 === 0 ? 0.006 : 0.0075;
      this.m.makeScale(r, r, r).setPosition(p);
      this.joints.setMatrixAt(i, this.m);
    });
    BONES.forEach(([a, b], i) => {
      const pa = hand.joints[a];
      const pb = hand.joints[b];
      this.dir.subVectors(pb, pa);
      const len = this.dir.length();
      this.mid.addVectors(pa, pb).multiplyScalar(0.5);
      this.q.setFromUnitVectors(this.up, len > 1e-6 ? this.dir.multiplyScalar(1 / len) : this.up);
      this.s.set(0.0045, len, 0.0045);
      this.m.compose(this.mid, this.q, this.s);
      this.bones.setMatrixAt(i, this.m);
    });
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
  }
}
