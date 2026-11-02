/**
 * Two small round buttons, pin and delete, that float just above one thing
 * when you tap it (a quick pinch on it), facing you and upright. Tap the
 * thing again, or tap elsewhere, and they go away. Desk objects, Clay prints
 * and Conjure creations use them, so their buttons only show when wanted.
 */

import { Group, Matrix4, type Object3D, Quaternion, Vector3 } from '@iwsdk/core';
import { type HoldSlider, IconButton } from './icon-button.js';

const UP = new Vector3(0, 1, 0);

/**
 * Orientation for round buttons floating at `pos` so they face `eye` and
 * their icons read upright (button faces are their local +Y; an icon's top
 * is its local -Z).
 */
export function faceViewer(pos: Vector3, eye: Vector3, out: Quaternion): Quaternion {
  const y = eye.clone().sub(pos).normalize();
  const z = UP.clone().addScaledVector(y, -UP.dot(y));
  if (z.lengthSq() < 1e-6) z.set(0, 0, -1);
  z.normalize().negate();
  const x = new Vector3().crossVectors(y, z).normalize();
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

export class ItemActions {
  readonly group = new Group();
  readonly pin: IconButton;
  readonly remove: IconButton;
  /** Optional middle button: press to step the size, hold and slide to set it. */
  size: IconButton | null = null;
  /** Optional: save the thing to the library. */
  library: IconButton | null = null;
  target: Object3D | null = null;
  /** World point the buttons float above (top of the thing). */
  private top: () => Vector3 = () => new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3(1, 1, 1);

  constructor(id: string, accent: string, onPin: () => void, onDelete: () => void, pinLabel = 'Pin to the desk') {
    this.pin = new IconButton({ id: `${id}:pin`, icon: 'pin', label: pinLabel, accent, radius: 0.012 });
    this.remove = new IconButton({ id: `${id}:delete`, icon: 'trash', label: 'Delete', accent, radius: 0.012 });
    this.pin.group.position.x = -0.017;
    this.remove.group.position.x = 0.017;
    this.pin.onPress = onPin;
    this.remove.onPress = onDelete;
    this.group.add(this.pin.group, this.remove.group);
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.userData.hideInShots = true;
  }

  /** Add a size button between pin and delete. */
  addSize(id: string, accent: string, hold: HoldSlider, onPress: () => void): IconButton {
    const b = new IconButton({ id: `${id}:size`, icon: 'size', label: 'Size (hold and slide)', accent, radius: 0.012 });
    b.hold = hold;
    b.onPress = onPress;
    this.group.add(b.group);
    this.size = b;
    this.layout();
    return b;
  }

  /** Add an "add to library" button. */
  addLibrary(id: string, accent: string, onPress: () => void): IconButton {
    const b = new IconButton({ id: `${id}:library`, icon: 'library', label: 'Add to library', accent, radius: 0.012 });
    b.onPress = onPress;
    this.group.add(b.group);
    this.library = b;
    this.layout();
    return b;
  }

  /** Space the buttons evenly: pin, size, library, delete. */
  private layout(): void {
    const row = [this.pin, this.size, this.library, this.remove].filter((b): b is IconButton => b != null);
    row.forEach((b, i) => (b.group.position.x = (i - (row.length - 1) / 2) * 0.032));
  }

  show(target: Object3D, top: () => Vector3): void {
    this.target = target;
    this.top = top;
    this.group.visible = true;
  }

  hide(): void {
    this.target = null;
    this.group.visible = false;
  }

  /** Place the pair above the target, facing the eye (world space, whatever the parent). */
  update(eye: Vector3): void {
    if (!this.target || !this.group.visible) return;
    const at = this.top().add(new Vector3(0, 0.03, 0));
    faceViewer(at, eye, this.q);
    this.m.compose(at, this.q, this.s);
    const parent = this.group.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      this.m.premultiply(parent.matrixWorld.clone().invert());
    }
    this.group.matrix.copy(this.m);
    this.group.matrixWorldNeedsUpdate = true;
  }
}
