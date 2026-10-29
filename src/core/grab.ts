/**
 * Hold an object the way a hand holds it: the object's pose is stored in the
 * hand's frame when the grab starts (thumb + middle finger, or a pinch), then re-applied every frame. Turning
 * your wrist turns the object; no separate rotate gizmo is needed.
 */

import { type Object3D, Quaternion, Vector3 } from '@iwsdk/core';
import type { HandState } from './hands.js';

const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpV = new Vector3();
const fwd = new Vector3();

export interface HoldOptions {
  /** Keep the object upright and only take the hand's twist about vertical. */
  upright?: boolean;
}

export class HeldPose {
  private readonly offsetPos = new Vector3();
  private readonly offsetQuat = new Quaternion();

  /** Remember where `object` sits relative to the hand right now. */
  begin(hand: HandState, object: Object3D, options: HoldOptions = {}): void {
    object.updateMatrixWorld(true);
    const handQ = handQuat(hand, options, tmpQ);
    const inv = tmpQ2.copy(handQ).invert();
    object.getWorldPosition(this.offsetPos).sub(hand.holdPoint).applyQuaternion(inv);
    this.offsetQuat.copy(inv).multiply(object.getWorldQuaternion(tmpQ));
  }

  /** Move `object` (in its parent's space) to follow the hand. */
  apply(hand: HandState, object: Object3D, options: HoldOptions = {}): void {
    const handQ = handQuat(hand, options, tmpQ);
    const worldPos = tmpV.copy(this.offsetPos).applyQuaternion(handQ).add(hand.holdPoint);
    const worldQuat = handQ.multiply(this.offsetQuat);
    const parent = object.parent;
    if (parent) {
      parent.updateMatrixWorld(true);
      parent.worldToLocal(worldPos);
      worldQuat.premultiply(parent.getWorldQuaternion(tmpQ2).invert());
    }
    object.position.copy(worldPos);
    object.quaternion.copy(worldQuat);
  }
}

/** The hand's rotation, or only its heading (yaw) for upright holds. */
function handQuat(hand: HandState, options: HoldOptions, out: Quaternion): Quaternion {
  if (!options.upright) return out.copy(hand.orientation);
  fwd.set(0, 0, -1).applyQuaternion(hand.orientation);
  return out.setFromAxisAngle(UP, Math.atan2(-fwd.x, -fwd.z));
}
