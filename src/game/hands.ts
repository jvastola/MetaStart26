/**
 * Hand tracking read straight from WebXR joint poses.
 *
 * IWSDK already renders the hands and drives its own pointer rays; this module
 * only adds what the game needs on top: fingertip positions in world space, a
 * pinch with hysteresis (so it does not flicker at the threshold), and a
 * smoothed fingertip velocity for flick putts.
 */

import { type Matrix4, Vector3 } from '@iwsdk/core';

/** Thumb-to-index distance that starts a pinch. */
const PINCH_ON = 0.018;
/** Distance that ends it. The gap between the two stops flicker. */
const PINCH_OFF = 0.032;
/** Velocity smoothing time constant, seconds. */
const VELOCITY_TAU = 0.04;

export type Side = 'left' | 'right';

export class HandState {
  readonly side: Side;
  tracked = false;
  pinching = false;
  pinchStarted = false;
  pinchEnded = false;
  readonly indexTip = new Vector3();
  readonly thumbTip = new Vector3();
  readonly pinchPoint = new Vector3();
  readonly indexVelocity = new Vector3();
  private readonly lastIndex = new Vector3();
  private hasLast = false;

  constructor(side: Side) {
    this.side = side;
  }

  /** Feed one frame of tip positions (world space). */
  feed(index: Vector3, thumb: Vector3, dt: number): void {
    this.tracked = true;
    this.indexTip.copy(index);
    this.thumbTip.copy(thumb);
    this.pinchPoint.copy(index).add(thumb).multiplyScalar(0.5);

    if (this.hasLast && dt > 0) {
      const a = 1 - Math.exp(-dt / VELOCITY_TAU);
      const vx = (index.x - this.lastIndex.x) / dt;
      const vy = (index.y - this.lastIndex.y) / dt;
      const vz = (index.z - this.lastIndex.z) / dt;
      this.indexVelocity.x += (vx - this.indexVelocity.x) * a;
      this.indexVelocity.y += (vy - this.indexVelocity.y) * a;
      this.indexVelocity.z += (vz - this.indexVelocity.z) * a;
    }
    this.lastIndex.copy(index);
    this.hasLast = true;

    const gap = index.distanceTo(thumb);
    const was = this.pinching;
    if (!was && gap < PINCH_ON) this.pinching = true;
    else if (was && gap > PINCH_OFF) this.pinching = false;
    this.pinchStarted = !was && this.pinching;
    this.pinchEnded = was && !this.pinching;
  }

  /** No tracking data this frame: release any pinch cleanly. */
  lose(): void {
    this.pinchEnded = this.pinching;
    this.pinchStarted = false;
    this.pinching = false;
    this.tracked = false;
    this.hasLast = false;
    this.indexVelocity.set(0, 0, 0);
  }
}

export class Hands {
  readonly left = new HandState('left');
  readonly right = new HandState('right');
  readonly both: readonly HandState[] = [this.left, this.right];
  private readonly index = new Vector3();
  private readonly thumb = new Vector3();
  private readonly seen = { left: false, right: false };

  /**
   * Read joints for this XR frame. `playerMatrix` converts the reference space
   * (the player rig) into world space.
   */
  update(
    frame: XRFrame | null,
    refSpace: XRReferenceSpace | null,
    playerMatrix: Matrix4,
    dt: number,
  ): void {
    this.seen.left = false;
    this.seen.right = false;
    if (frame != null && refSpace != null && frame.getJointPose) {
      for (const source of frame.session.inputSources) {
        const hand = source.hand;
        if (hand == null) continue;
        const side = source.handedness;
        if (side !== 'left' && side !== 'right') continue;
        const indexSpace = hand.get('index-finger-tip');
        const thumbSpace = hand.get('thumb-tip');
        if (indexSpace == null || thumbSpace == null) continue;
        const ip = frame.getJointPose(indexSpace, refSpace);
        const tp = frame.getJointPose(thumbSpace, refSpace);
        if (ip == null || tp == null) continue;
        const i = ip.transform.position;
        const t = tp.transform.position;
        this.index.set(i.x, i.y, i.z).applyMatrix4(playerMatrix);
        this.thumb.set(t.x, t.y, t.z).applyMatrix4(playerMatrix);
        this[side].feed(this.index, this.thumb, dt);
        this.seen[side] = true;
      }
    }
    if (!this.seen.left && this.left.tracked) this.left.lose();
    else if (!this.seen.left) this.left.pinchEnded = this.left.pinchStarted = false;
    if (!this.seen.right && this.right.tracked) this.right.lose();
    else if (!this.seen.right) this.right.pinchEnded = this.right.pinchStarted = false;
  }

  get anyTracked(): boolean {
    return this.left.tracked || this.right.tracked;
  }
}
