/**
 * Far pointing. Each hand has a ray from an estimated shoulder through the
 * palm (controllers use their own pointing ray). The palm, unlike the pinch
 * point, stays put when you pinch, so the ray does not jump as you click. The ray only shows
 * when it lands on something usable that is out of reach (further than
 * NEAR from the hand); up close, poking and pinching stay in charge.
 *
 * Things that can be used from afar register a RayTarget. A pinch while the
 * ray is on a target presses it (or starts a drag, for targets that move),
 * and the pinch is consumed so the app underneath does not also draw.
 */

import {
  BufferGeometry,
  type Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { HandState } from './hands.js';

/** Targets closer than this to the hand are left to direct touch. */
export const NEAR = 0.22;

export interface RayTarget {
  /** Distance along the ray to the hit, or null. */
  hit(origin: Vector3, dir: Vector3): number | null;
  /** Shown this frame under a ray (for highlight). */
  hover?(hand: HandState): void;
  press?(hand: HandState): void;
  drag?: {
    begin(hand: HandState, origin: Vector3, dir: Vector3, distance: number): void;
    update(hand: HandState, origin: Vector3, dir: Vector3): void;
    end(hand: HandState): void;
  };
}

export const RayTargets = {
  list: new Set<RayTarget>(),
  add(t: RayTarget): RayTarget {
    this.list.add(t);
    return t;
  },
  remove(t: RayTarget): void {
    this.list.delete(t);
  },
};

const SHOULDER_DROP = 0.2;
const SHOULDER_SIDE = 0.17;

interface RayState {
  line: Line;
  dot: Mesh;
  target: RayTarget | null;
  dragging: RayTarget | null;
  /** Ray-hit distance, for tests. */
  distance: number;
}

/** The host owns one: it updates rays before the active app runs. */
export class HandRays {
  private readonly states = new Map<HandState, RayState>();
  private readonly tmp = new Vector3();
  private readonly right = new Vector3();
  private readonly shoulder = new Vector3();
  private readonly end = new Vector3();
  private readonly shoulders = new Map<HandState, Vector3>();

  constructor(
    private readonly parent: Group,
    private readonly accent = '#9fc7ff',
  ) {}

  private state(hand: HandState): RayState {
    let s = this.states.get(hand);
    if (s) return s;
    const geometry = new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0, -1)]);
    const line = new Line(geometry, new LineBasicMaterial({ color: this.accent, transparent: true, opacity: 0.75, depthWrite: false }));
    line.renderOrder = 30;
    line.frustumCulled = false;
    const dot = new Mesh(new SphereGeometry(0.006, 12, 8), new MeshBasicMaterial({ color: '#ffffff', depthTest: false }));
    dot.renderOrder = 31;
    line.visible = dot.visible = false;
    line.userData.hideInShots = dot.userData.hideInShots = true;
    this.parent.add(line, dot);
    s = { line, dot, target: null, dragging: null, distance: 0 };
    this.states.set(hand, s);
    return s;
  }

  /** Point the hand's ray: from the shoulder through the palm (controllers already have one). */
  aim(hand: HandState, head: Vector3, forward: Vector3): void {
    if (hand.isMouse || hand.isController) return;
    this.right.set(-forward.z, 0, forward.x).normalize();
    this.shoulder.copy(head).addScaledVector(this.right, hand.side === 'right' ? SHOULDER_SIDE : -SHOULDER_SIDE);
    this.shoulder.y -= SHOULDER_DROP;
    this.shoulders.set(hand, this.shoulder.clone());
    hand.rayOrigin.copy(hand.palm);
    hand.rayDir.copy(hand.palm).sub(this.shoulder).normalize();
  }

  /**
   * Find and use far targets for each hand. `busy(hand)` is true while the
   * hand is already doing something up close (drawing, holding).
   */
  update(hands: readonly HandState[], enabled: boolean, busy: (hand: HandState) => boolean): void {
    for (const hand of hands) {
      const s = this.state(hand);
      if (s.dragging) {
        if (!enabled || !hand.tracked || !(hand.pinching || hand.grabbing)) {
          s.dragging.drag?.end(hand);
          s.dragging = null;
        } else {
          s.dragging.drag?.update(hand, hand.rayOrigin, hand.rayDir);
          this.show(s, hand, s.distance);
          continue;
        }
      }
      s.target = null;
      if (!enabled || !hand.tracked || hand.isMouse || (busy(hand) && !hand.pinchStarted && !hand.grabStarted)) {
        s.line.visible = s.dot.visible = false;
        continue;
      }
      let best = Infinity;
      for (const t of RayTargets.list) {
        const d = t.hit(hand.rayOrigin, hand.rayDir);
        if (d == null || d < NEAR || d >= best) continue;
        best = d;
        s.target = t;
      }
      if (!s.target) {
        s.line.visible = s.dot.visible = false;
        continue;
      }
      s.distance = best;
      s.target.hover?.(hand);
      this.show(s, hand, best);
      if (hand.pinchStarted || hand.grabStarted) {
        if (s.target.drag) {
          s.target.drag.begin(hand, hand.rayOrigin, hand.rayDir, best);
          s.dragging = s.target;
        } else {
          s.target.press?.(hand);
        }
        hand.clearEdges();
      }
    }
  }

  private show(s: RayState, hand: HandState, distance: number): void {
    this.end.copy(hand.rayOrigin).addScaledVector(hand.rayDir, distance);
    const pos = s.line.geometry.attributes.position;
    pos.setXYZ(0, hand.rayOrigin.x, hand.rayOrigin.y, hand.rayOrigin.z);
    pos.setXYZ(1, this.end.x, this.end.y, this.end.z);
    pos.needsUpdate = true;
    s.dot.position.copy(this.end);
    s.line.visible = s.dot.visible = true;
    const mat = s.line.material as LineBasicMaterial;
    mat.opacity = s.dragging ? 1 : 0.7;
  }

  /** For tests: which hands show a ray, and how far it reaches. */
  debug(): { side: string; visible: boolean; distance: number; dragging: boolean; shoulder: number[] | null; origin: number[]; dir: number[] }[] {
    return [...this.states].map(([hand, s]) => ({
      side: hand.side,
      visible: s.line.visible,
      distance: +s.distance.toFixed(3),
      dragging: s.dragging != null,
      shoulder: this.shoulders.get(hand)?.toArray() ?? null,
      origin: hand.rayOrigin.toArray(),
      dir: hand.rayDir.toArray(),
    }));
  }

  /** Hide everything (e.g. when XR ends). */
  hide(): void {
    for (const s of this.states.values()) s.line.visible = s.dot.visible = false;
  }
}

/** Ray-to-point distance helper for targets. Returns distance along the ray, or null if behind. */
export function rayToPoint(origin: Vector3, dir: Vector3, point: Vector3, radius: number, scratch = new Vector3()): number | null {
  const along = scratch.copy(point).sub(origin).dot(dir);
  if (along <= 0) return null;
  const miss = scratch.copy(origin).addScaledVector(dir, along).distanceTo(point);
  return miss <= radius ? along : null;
}
