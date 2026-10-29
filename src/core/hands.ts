/**
 * Hand tracking read straight from WebXR joint poses, plus a mouse stand-in.
 *
 * IWSDK already renders the hands and drives its own pointer rays. This
 * module adds what the prototypes need on top:
 *   - all five fingertips, wrist, palm centre and palm normal in world space;
 *   - a pinch with hysteresis, so it does not flicker at the threshold;
 *   - a separate grab: thumb to MIDDLE finger. Thumb + index draws, presses
 *     and twists; thumb + middle picks things up. Only one can be on per hand;
 *   - smoothed fingertip and pinch velocities, for flicks and throws;
 *   - Quest hand microgestures (thumb swipes and thumb tap), which the Quest
 *     browser reports as gamepad buttons 5-9 on a hand input source.
 *
 * The mouse is presented as one more HandState, so every prototype can be
 * driven in a desktop browser without a headset.
 */

import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

/** Thumb-to-index distance that starts a pinch. */
const PINCH_ON = 0.018;
/** Distance that ends it. The gap between the two stops flicker. */
const PINCH_OFF = 0.032;
/** Thumb-to-middle distances for the grab. */
const GRAB_ON = 0.02;
const GRAB_OFF = 0.034;
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

/** All 25 WebXR hand joints, in spec order (used by the optional skeleton view). */
export const ALL_JOINTS: XRHandJoint[] = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];

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
  /** True when this side is a held controller rather than a tracked hand. */
  isController = false;
  /** Controllers have no palm: X/A toggles the menu instead. */
  menuLatch = false;
  tracked = false;
  pinching = false;
  pinchStarted = false;
  pinchEnded = false;
  /** Thumb + middle finger: the pick-up gesture. */
  grabbing = false;
  grabStarted = false;
  grabEnded = false;
  /** Microgesture fired this frame, if any. */
  gesture: Microgesture | null = null;
  readonly tips: Vector3[] = TIP_JOINTS.map(() => new Vector3());
  readonly indexTip: Vector3 = this.tips[1];
  readonly thumbTip: Vector3 = this.tips[0];
  readonly wrist = new Vector3();
  readonly palm = new Vector3();
  /** Unit vector out of the palm. */
  readonly palmNormal = new Vector3(0, -1, 0);
  /**
   * Hand orientation: -Z points along the fingers (wrist to middle knuckle),
   * +Y out of the back of the hand. Controllers use their grip rotation.
   */
  readonly orientation = new Quaternion();
  readonly pinchPoint = new Vector3();
  /** Midpoint of thumb and middle fingertips. */
  readonly grabPoint = new Vector3();
  readonly indexVelocity = new Vector3();
  readonly pinchVelocity = new Vector3();
  /** Mouse only: the pointer ray. */
  readonly rayOrigin = new Vector3();
  readonly rayDir = new Vector3(0, 0, -1);
  /** All joints in world space; filled only when `Hands.readAllJoints` is on. */
  readonly joints: Vector3[] = ALL_JOINTS.map(() => new Vector3());

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
    this.grabPoint.copy(this.tips[2]).add(this.thumbTip).multiplyScalar(0.5);
    this.palm.copy(this.wrist).add(middleMeta).multiplyScalar(0.5);
    const forward = handScratch.fwd.copy(middleMeta).sub(this.wrist);
    // Palm normal from the wrist->index and wrist->pinky metacarpal vectors.
    const a = indexMeta.sub(this.wrist);
    const b = pinkyMeta.sub(this.wrist);
    if (this.side === 'right') this.palmNormal.crossVectors(a, b);
    else this.palmNormal.crossVectors(b, a);
    if (this.palmNormal.lengthSq() > 1e-10) this.palmNormal.normalize();
    setOrientation(this.orientation, forward, this.palmNormal);

    if (this.hasLast && dt > 0) {
      const k = 1 - Math.exp(-dt / VELOCITY_TAU);
      smoothVelocity(this.indexVelocity, this.indexTip, this.lastIndex, dt, k);
      smoothVelocity(this.pinchVelocity, this.pinchPoint, this.lastPinch, dt, k);
    }
    this.lastIndex.copy(this.indexTip);
    this.lastPinch.copy(this.pinchPoint);
    this.hasLast = true;

    const gap = this.indexTip.distanceTo(this.thumbTip);
    const midGap = this.tips[2].distanceTo(this.thumbTip);
    // Whichever finger is closer to the thumb wins, and the other cannot
    // start while it is held, so one hand never pinches and grabs at once.
    const pinch = this.pinching ? gap < PINCH_OFF : !this.grabbing && gap < PINCH_ON && gap <= midGap;
    const grab = this.grabbing ? midGap < GRAB_OFF : !this.pinching && !pinch && midGap < GRAB_ON && midGap < gap;
    this.setPinch(pinch);
    this.setGrab(grab);
  }

  setGrab(on: boolean): void {
    const was = this.grabbing;
    this.grabbing = on;
    this.grabStarted = !was && on;
    this.grabEnded = was && !on;
  }

  /**
   * Where a held object is anchored: the grab point while grabbing (and on
   * the frame it ends, so drops land where the hand was), else the pinch point.
   */
  get holdPoint(): Vector3 {
    return (this.grabbing || this.grabEnded) && !this.isMouse ? this.grabPoint : this.pinchPoint;
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

  /**
   * Feed a controller as if it were a hand: the "fingertip" sits 5 cm ahead of
   * the grip along the pointing ray, and the trigger is the pinch.
   */
  feedController(grip: Vector3, forward: Vector3, rotation: Quaternion, gamepad: Gamepad | null | undefined, dt: number): void {
    this.isController = true;
    this.orientation.copy(rotation);
    this.tracked = true;
    const tip = this.indexTip;
    tip.copy(grip).addScaledVector(forward, 0.05);
    for (const t of this.tips) if (t !== tip) t.copy(tip);
    this.wrist.copy(grip);
    this.palm.copy(grip);
    this.palmNormal.set(0, 1, 0);
    if (this.hasLast && dt > 0) {
      const k = 1 - Math.exp(-dt / VELOCITY_TAU);
      smoothVelocity(this.indexVelocity, tip, this.lastIndex, dt, k);
      smoothVelocity(this.pinchVelocity, tip, this.lastPinch, dt, k);
    }
    this.lastIndex.copy(tip);
    this.lastPinch.copy(tip);
    this.hasLast = true;
    this.pinchPoint.copy(tip);
    this.grabPoint.copy(tip);
    // Grip button picks things up, like the middle-finger grab.
    const squeeze = gamepad?.buttons[1]?.value ?? 0;
    this.setGrab(this.grabbing ? squeeze > 0.3 : squeeze > 0.6);
    const trigger = gamepad?.buttons[0]?.value ?? 0;
    this.setPinch(this.pinching ? trigger > 0.3 : trigger > 0.6);
    // X (left) / A (right) toggles the menu.
    this.gesture = null;
    const face = gamepad?.buttons[4]?.pressed ?? false;
    if (face && !this.buttonsDown[4]) this.menuLatch = !this.menuLatch;
    this.buttonsDown[4] = face;
  }

  /** No tracking data this frame: release any pinch cleanly. */
  lose(): void {
    this.pinchEnded = this.pinching;
    this.pinchStarted = false;
    this.pinching = false;
    this.grabEnded = this.grabbing;
    this.grabStarted = false;
    this.grabbing = false;
    this.tracked = false;
    this.hasLast = false;
    this.gesture = null;
    this.indexVelocity.set(0, 0, 0);
    this.pinchVelocity.set(0, 0, 0);
  }

  clearEdges(): void {
    this.pinchStarted = false;
    this.pinchEnded = false;
    this.grabStarted = false;
    this.grabEnded = false;
    this.gesture = null;
  }

  /** True when the palm faces the given point (e.g. the head). */
  palmFaces(point: Vector3, threshold = 0.6): boolean {
    if (this.isController) return this.tracked && this.menuLatch;
    if (!this.tracked || this.isMouse) return false;
    const dx = point.x - this.palm.x;
    const dy = point.y - this.palm.y;
    const dz = point.z - this.palm.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return (this.palmNormal.x * dx + this.palmNormal.y * dy + this.palmNormal.z * dz) / len > threshold;
  }
}

const handScratch = { fwd: new Vector3(), x: new Vector3(), y: new Vector3(), z: new Vector3(), m: new Matrix4() };

/** Orientation from a finger direction and a palm normal (back of hand is +Y). */
function setOrientation(out: Quaternion, forward: Vector3, palmNormal: Vector3): void {
  const { x, y, z, m } = handScratch;
  if (forward.lengthSq() < 1e-10) return;
  z.copy(forward).normalize().negate();
  y.copy(palmNormal).negate();
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-10) return;
  y.normalize();
  x.crossVectors(y, z);
  m.makeBasis(x, y, z);
  out.setFromRotationMatrix(m);
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
  /** Also read every joint (for the skeleton view). Off by default to save work. */
  readAllJoints = false;
  private readonly seen = { left: false, right: false };
  private readonly meta = [new Vector3(), new Vector3(), new Vector3()];
  private readonly quat = new Quaternion();
  private readonly playerQuat = new Quaternion();

  /**
   * Read joints for this XR frame. `playerMatrix` converts the reference
   * space (the player rig) into world space.
   */
  update(frame: XRFrame | null, refSpace: XRReferenceSpace | null, playerMatrix: Matrix4, dt: number): void {
    this.seen.left = false;
    this.seen.right = false;
    if (frame != null && refSpace != null) {
      for (const source of frame.session.inputSources) {
        const side = source.handedness;
        if (side !== 'left' && side !== 'right') continue;
        const state = this[side];
        const hand = source.hand;
        if (hand != null && frame.getJointPose) {
          if (!this.readHand(frame, refSpace, hand, state, playerMatrix)) continue;
          state.isController = false;
          state.finishFrame(this.meta[0], this.meta[1], this.meta[2], dt);
          state.readGestures(source.gamepad);
          this.seen[side] = true;
        } else if (hand == null && source.gripSpace) {
          // Controllers are welcome too: they act as a pinching fingertip.
          const grip = frame.getPose(source.gripSpace, refSpace);
          const ray = frame.getPose(source.targetRaySpace, refSpace);
          if (grip == null || ray == null) continue;
          const g = grip.transform.position;
          const o = ray.transform.orientation;
          this.meta[0].set(g.x, g.y, g.z).applyMatrix4(playerMatrix);
          // The ray points down its local -Z.
          this.meta[1].set(0, 0, -1).applyQuaternion(this.quat.set(o.x, o.y, o.z, o.w)).transformDirection(playerMatrix);
          this.quat.set(o.x, o.y, o.z, o.w).premultiply(this.playerQuat.setFromRotationMatrix(playerMatrix));
          state.feedController(this.meta[0], this.meta[1], this.quat, source.gamepad, dt);
          this.seen[side] = true;
        }
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
    if (this.readAllJoints) {
      for (let i = 0; i < ALL_JOINTS.length; i += 1) read(ALL_JOINTS[i], state.joints[i]);
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

/** Like `pointerDistance`, measured from the grab point (thumb + middle). */
export function grabDistance(pointer: HandState, point: Vector3): number {
  if (pointer.isMouse) return pointerDistance(pointer, point);
  return pointer.grabPoint.distanceTo(point);
}
