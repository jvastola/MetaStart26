/**
 * Hand tracking read straight from WebXR joint poses, plus a mouse stand-in.
 *
 * IWSDK already renders the hands and drives its own pointer rays. This
 * module adds what the prototypes need on top:
 *   - all five fingertips, wrist, palm centre and palm normal in world space;
 *   - a pinch with hysteresis, so it does not flicker at the threshold;
 *   - smoothed fingertip and pinch velocities, for flicks and throws;
 *   - Quest hand microgestures (thumb swipes and thumb tap), which the Quest
 *     browser reports as gamepad buttons 5-9 on a hand input source.
 *
 * The mouse is presented as one more HandState, so every prototype can be
 * driven in a desktop browser without a headset.
 */

import { type Matrix4, Vector3 } from '@iwsdk/core';

/** Thumb-to-index distance that starts a pinch. */
const PINCH_ON = 0.018;
/** Distance that ends it. The gap between the two stops flicker. */
const PINCH_OFF = 0.032;
/** Velocity smoothing time constant, seconds. */
const VELOCITY_TAU = 0.04;

export type Side = 'left' | 'right';
export type Microgesture = 'left' | 'right' | 'up' | 'down' | 'tap';

/** Fingertip order used by `tips`. */
export const TIP_JOINTS = [
  'thumb-tip',
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;
const EXTRA_JOINTS = [
  'wrist',
  'index-finger-metacarpal',
  'middle-finger-metacarpal',
  'pinky-finger-metacarpal',
] as const;

/** Gamepad button index for each microgesture on a Quest hand. */
const MICRO_BUTTONS: [number, Microgesture][] = [
  [5, 'left'],
  [6, 'right'],
  [7, 'up'],
  [8, 'down'],
  [9, 'tap'],
];

export class HandState {
  readonly side: Side;
  readonly isMouse: boolean;
  tracked = false;
  pinching = false;
  pinchStarted = false;
  pinchEnded = false;
  /** Microgesture fired this frame, if any. */
  gesture: Microgesture | null = null;
  readonly tips: Vector3[] = TIP_JOINTS.map(() => new Vector3());
  readonly indexTip: Vector3 = this.tips[1];
  readonly thumbTip: Vector3 = this.tips[0];
  readonly wrist = new Vector3();
  readonly palm = new Vector3();
  /** Unit vector out of the palm. */
  readonly palmNormal = new Vector3(0, -1, 0);
  readonly pinchPoint = new Vector3();
  readonly indexVelocity = new Vector3();
  readonly pinchVelocity = new Vector3();
  /** Mouse only: the pointer ray. */
  readonly rayOrigin = new Vector3();
  readonly rayDir = new Vector3(0, 0, -1);

  private readonly lastIndex = new Vector3();
  private readonly lastPinch = new Vector3();
  private hasLast = false;
  private readonly buttonsDown = new Array<boolean>(10).fill(false);

  constructor(side: Side, isMouse = false) {
    this.side = side;
    this.isMouse = isMouse;
  }

  /** Recompute derived values after `tips`, `wrist` and the metacarpals are set. */
  finishFrame(indexMeta: Vector3, middleMeta: Vector3, pinkyMeta: Vector3, dt: number): void {
    this.tracked = true;
    this.pinchPoint.copy(this.indexTip).add(this.thumbTip).multiplyScalar(0.5);
    this.palm.copy(this.wrist).add(middleMeta).multiplyScalar(0.5);
    // Palm normal from the wrist->index and wrist->pinky metacarpal vectors.
    const a = indexMeta.sub(this.wrist);
    const b = pinkyMeta.sub(this.wrist);
    if (this.side === 'right') this.palmNormal.crossVectors(a, b);
    else this.palmNormal.crossVectors(b, a);
    if (this.palmNormal.lengthSq() > 1e-10) this.palmNormal.normalize();

    if (this.hasLast && dt > 0) {
      const k = 1 - Math.exp(-dt / VELOCITY_TAU);
      smoothVelocity(this.indexVelocity, this.indexTip, this.lastIndex, dt, k);
      smoothVelocity(this.pinchVelocity, this.pinchPoint, this.lastPinch, dt, k);
    }
    this.lastIndex.copy(this.indexTip);
    this.lastPinch.copy(this.pinchPoint);
    this.hasLast = true;

    const gap = this.indexTip.distanceTo(this.thumbTip);
    this.setPinch(this.pinching ? gap < PINCH_OFF : gap < PINCH_ON);
  }

  setPinch(on: boolean): void {
    const was = this.pinching;
    this.pinching = on;
    this.pinchStarted = !was && on;
    this.pinchEnded = was && !on;
  }

  readGestures(gamepad: Gamepad | null | undefined): void {
    this.gesture = null;
    if (gamepad == null) return;
    for (const [index, name] of MICRO_BUTTONS) {
      const pressed = gamepad.buttons[index]?.pressed ?? false;
      if (pressed && !this.buttonsDown[index]) this.gesture = name;
      this.buttonsDown[index] = pressed;
    }
  }

  /** No tracking data this frame: release any pinch cleanly. */
  lose(): void {
    this.pinchEnded = this.pinching;
    this.pinchStarted = false;
    this.pinching = false;
    this.tracked = false;
    this.hasLast = false;
    this.gesture = null;
    this.indexVelocity.set(0, 0, 0);
    this.pinchVelocity.set(0, 0, 0);
  }

  clearEdges(): void {
    this.pinchStarted = false;
    this.pinchEnded = false;
    this.gesture = null;
  }

  /** True when the palm faces the given point (e.g. the head). */
  palmFaces(point: Vector3, threshold = 0.6): boolean {
    if (!this.tracked || this.isMouse) return false;
    const dx = point.x - this.palm.x;
    const dy = point.y - this.palm.y;
    const dz = point.z - this.palm.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return (this.palmNormal.x * dx + this.palmNormal.y * dy + this.palmNormal.z * dz) / len > threshold;
  }
}

function smoothVelocity(out: Vector3, now: Vector3, last: Vector3, dt: number, k: number): void {
  out.x += ((now.x - last.x) / dt - out.x) * k;
  out.y += ((now.y - last.y) / dt - out.y) * k;
  out.z += ((now.z - last.z) / dt - out.z) * k;
}

export class Hands {
  readonly left = new HandState('left');
  readonly right = new HandState('right');
  readonly both: readonly HandState[] = [this.left, this.right];
  private readonly seen = { left: false, right: false };
  private readonly meta = [new Vector3(), new Vector3(), new Vector3()];

  /**
   * Read joints for this XR frame. `playerMatrix` converts the reference
   * space (the player rig) into world space.
   */
  update(frame: XRFrame | null, refSpace: XRReferenceSpace | null, playerMatrix: Matrix4, dt: number): void {
    this.seen.left = false;
    this.seen.right = false;
    if (frame != null && refSpace != null && frame.getJointPose) {
      for (const source of frame.session.inputSources) {
        const hand = source.hand;
        const side = source.handedness;
        if (hand == null || (side !== 'left' && side !== 'right')) continue;
        const state = this[side];
        if (!this.readHand(frame, refSpace, hand, state, playerMatrix)) continue;
        state.finishFrame(this.meta[0], this.meta[1], this.meta[2], dt);
        state.readGestures(source.gamepad);
        this.seen[side] = true;
      }
    }
    for (const side of ['left', 'right'] as const) {
      const state = this[side];
      if (this.seen[side]) continue;
      if (state.tracked) state.lose();
      else state.clearEdges();
    }
  }

  private readHand(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    hand: XRHand,
    state: HandState,
    playerMatrix: Matrix4,
  ): boolean {
    const read = (name: XRHandJoint, out: Vector3): boolean => {
      const space = hand.get(name);
      if (space == null) return false;
      const pose = frame.getJointPose!(space, refSpace);
      if (pose == null) return false;
      const p = pose.transform.position;
      out.set(p.x, p.y, p.z).applyMatrix4(playerMatrix);
      return true;
    };
    for (let i = 0; i < TIP_JOINTS.length; i += 1) {
      if (!read(TIP_JOINTS[i], state.tips[i])) return false;
    }
    return (
      read(EXTRA_JOINTS[0], state.wrist) &&
      read(EXTRA_JOINTS[1], this.meta[0]) &&
      read(EXTRA_JOINTS[2], this.meta[1]) &&
      read(EXTRA_JOINTS[3], this.meta[2])
    );
  }
}

const scratch = new Vector3();

/**
 * How far a pointer is from a world point: the pinch point's distance for a
 * hand, the cursor ray's closest approach for the mouse.
 */
export function pointerDistance(pointer: HandState, point: Vector3): number {
  if (!pointer.isMouse) return pointer.pinchPoint.distanceTo(point);
  const along = scratch.copy(point).sub(pointer.rayOrigin).dot(pointer.rayDir);
  if (along < 0) return Infinity;
  return scratch.copy(pointer.rayOrigin).addScaledVector(pointer.rayDir, along).distanceTo(point);
}
