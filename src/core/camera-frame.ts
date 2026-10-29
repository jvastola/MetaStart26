/**
 * The director's frame, available everywhere in the lab.
 *
 * Pinch with both hands close together and pull them apart: the rectangle
 * between the pinches (seen from your eyes) becomes a camera frame. Let go
 * and the view is rendered into the shared album, which Shot Board shows as
 * a storyboard. The host only runs this while the active prototype is not
 * already using both pinches (holding, drawing, sculpting).
 */

import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
  type Object3D,
  PerspectiveCamera,
  type Scene,
  type Texture,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from '@iwsdk/core';
import type { HandState } from './hands.js';
import { CanvasPanel } from './panel.js';

export const SHOT_W = 480;
export const SHOT_H = 270;
const MAX_SHOTS = 12;
/** Both pinches must start this close together for a frame to begin... */
const START_GAP = 0.3;
/** ...and within this many seconds of each other (a deliberate two-hand gesture). */
const START_WINDOW = 0.4;
const MIN_FRAME = 0.08;
const UP = new Vector3(0, 1, 0);

export interface Shot {
  texture: Texture;
  target?: WebGLRenderTarget;
  caption: string;
  dispose(): void;
}

/** Shots taken anywhere in the lab, newest last. */
export class Album {
  readonly shots: Shot[] = [];
  private readonly listeners = new Set<() => void>();

  add(shot: Shot): void {
    this.shots.push(shot);
    if (this.shots.length > MAX_SHOTS) this.shots.shift()?.dispose();
    this.changed();
  }

  removeLast(): void {
    this.shots.pop()?.dispose();
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

export class FrameCamera {
  readonly line: LineLoop;
  private readonly camera = new PerspectiveCamera(50, SHOT_W / SHOT_H, 0.01, 20);
  private readonly center = new Vector3();
  private readonly size = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly tmp = new Vector3();
  private armed = false;
  private framing = 0;
  private clock = 0;
  private readonly started = { left: -10, right: -10 };

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly album: Album,
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(12), 3));
    this.line = new LineLoop(geometry, new LineBasicMaterial({ color: '#ffcf70' }));
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.line.userData.hideInShots = true;
  }

  get active(): boolean {
    return this.line.visible;
  }

  /** True once both pinches have started together: apps should drop what those pinches began. */
  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * Track the gesture. Returns a caption when a shot was captured this frame.
   * `enabled` is false while the active prototype owns the pinches.
   */
  update(left: HandState, right: HandState, head: Vector3, enabled: boolean, dt: number): string | null {
    this.clock += dt;
    if (left.pinchStarted) this.started.left = this.clock;
    if (right.pinchStarted) this.started.right = this.clock;
    const both = enabled && left.tracked && right.tracked && !left.isController && !right.isController && left.pinching && right.pinching;
    if (both) {
      // Arm only when both pinches start together, close to each other.
      if (!this.armed && (left.pinchStarted || right.pinchStarted)) {
        const together = Math.abs(this.started.left - this.started.right) < START_WINDOW;
        this.armed = together && left.pinchPoint.distanceTo(right.pinchPoint) < START_GAP;
      }
      if (this.armed) {
        this.computeFrame(left.pinchPoint, right.pinchPoint, head);
        this.line.visible = Math.max(this.size.x, this.size.y) > MIN_FRAME;
        if (this.line.visible) this.framing += dt;
      }
      return null;
    }
    const shoot = this.armed && this.line.visible && this.framing > 0.25;
    this.armed = false;
    this.framing = 0;
    this.line.visible = false;
    if (!shoot) return null;
    const [w, h, dist] = [this.size.x, this.size.y, this.size.z];
    const aspect = Math.min(2.4, Math.max(1, w / Math.max(h, 1e-3)));
    const fov = (2 * Math.atan(w / aspect / 2 / Math.max(dist, 0.05)) * 180) / Math.PI;
    return this.capture(head, this.center, Math.min(90, Math.max(12, fov)));
  }

  /** Rectangle facing the head with the pinches on opposite corners. */
  private computeFrame(p: Vector3, q: Vector3, head: Vector3): void {
    this.center.copy(p).add(q).multiplyScalar(0.5);
    this.fwd.copy(this.center).sub(head).normalize();
    this.right.crossVectors(this.fwd, UP).normalize();
    this.up.crossVectors(this.right, this.fwd).normalize();
    this.tmp.copy(q).sub(p);
    const w = Math.abs(this.tmp.dot(this.right));
    const h = Math.abs(this.tmp.dot(this.up));
    const pos = this.line.geometry.getAttribute('position') as Float32BufferAttribute;
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < 4; i += 1) {
      this.tmp
        .copy(this.center)
        .addScaledVector(this.right, (corners[i * 2] * w) / 2)
        .addScaledVector(this.up, (corners[i * 2 + 1] * h) / 2);
      pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    pos.needsUpdate = true;
    this.size.set(w, h, this.center.distanceTo(head));
  }

  /** Render the scene from `eye` toward `target` into a new album shot. */
  capture(eye: Vector3, target: Vector3, fov: number): string {
    const { renderer, scene, camera } = this;
    const rt = new WebGLRenderTarget(SHOT_W, SHOT_H);
    camera.fov = fov;
    camera.aspect = SHOT_W / SHOT_H;
    camera.position.copy(eye);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // Hide UI and helpers, and paint a neutral previs backdrop.
    const hidden: Object3D[] = CanvasPanel.all.map((p) => p.mesh);
    scene.traverse((o) => {
      if (o.userData.hideInShots) hidden.push(o);
    });
    const was = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const background = scene.background;
    scene.background = new Color('#cdd7e3');
    const xrEnabled = renderer.xr.enabled;
    const previous = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xrEnabled;
    scene.background = background;
    hidden.forEach((o, i) => (o.visible = was[i]));

    const caption = fov < 25 ? 'close-up' : fov < 45 ? 'medium' : 'wide';
    this.album.add({ texture: rt.texture, target: rt, caption, dispose: () => rt.dispose() });
    return caption;
  }
}
