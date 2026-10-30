/**
 * Small icons just past the index and middle fingertips that say what each
 * pinch does right now: thumb + index (draw, press, twist, snap...) and
 * thumb + middle (move, select, size...). The active app decides; they
 * brighten as the fingers close and grow while the pinch is held.
 */

import { CanvasTexture, CircleGeometry, Group, Mesh, MeshBasicMaterial, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import type { HandState } from './hands.js';
import { drawIcon } from './icons.js';

export interface FingerHint {
  /** Icon for thumb + index, or null for none. */
  index?: string | null;
  /** Icon for thumb + middle, or null for none. */
  middle?: string | null;
}

const RADIUS = 0.0075;

interface Sprite {
  mesh: Mesh;
  material: MeshBasicMaterial;
  icon: string | null;
  color: string;
  amount: number;
}

export class FingerHints {
  readonly group = new Group();
  private readonly sprites = new Map<HandState, [Sprite, Sprite]>();
  private readonly textures = new Map<string, CanvasTexture>();
  private readonly tmp = new Vector3();
  private readonly fwd = new Vector3();
  private readonly back = new Vector3();

  constructor() {
    this.group.name = 'FingerHints';
    this.group.userData.hideInShots = true;
  }

  private texture(icon: string, color: string): CanvasTexture {
    const key = `${icon}|${color}`;
    let t = this.textures.get(key);
    if (t) return t;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const c = canvas.getContext('2d')!;
    c.beginPath();
    c.arc(48, 48, 45, 0, Math.PI * 2);
    c.fillStyle = 'rgba(20,22,27,0.82)';
    c.fill();
    c.lineWidth = 6;
    c.strokeStyle = color;
    c.stroke();
    c.translate(20, 20);
    drawIcon(c, icon, 56, '#ffffff');
    t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    this.textures.set(key, t);
    return t;
  }

  private sprite(): Sprite {
    const material = new MeshBasicMaterial({ transparent: true, depthTest: false, opacity: 0 });
    const mesh = new Mesh(new CircleGeometry(RADIUS, 24), material);
    mesh.renderOrder = 45;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, material, icon: null, color: '', amount: 0 };
  }

  /**
   * `hint(hand)` returns what each pinch does for that hand (or null to show
   * nothing); `colors` are the index and middle accents.
   */
  update(hands: readonly HandState[], eye: Vector3, show: boolean, hint: (hand: HandState) => FingerHint | null, colors: [string, string], dt: number): void {
    for (const hand of hands) {
      let pair = this.sprites.get(hand);
      if (!pair) {
        pair = [this.sprite(), this.sprite()];
        this.sprites.set(hand, pair);
      }
      const visible = show && hand.tracked && !hand.isMouse && !hand.isController;
      const h = visible ? hint(hand) : null;
      // Just past the fingertip and a little toward the back of the hand.
      this.fwd.set(0, 0, -1).applyQuaternion(hand.orientation);
      this.back.set(0, 1, 0).applyQuaternion(hand.orientation);
      const fingers: [Vector3, string | null | undefined, boolean, number][] = [
        [hand.tips[1], h?.index, hand.pinching, hand.indexTip.distanceTo(hand.thumbTip)],
        [hand.tips[2], h?.middle, hand.grabbing, hand.tips[2].distanceTo(hand.thumbTip)],
      ];
      fingers.forEach(([tip, icon, active, gap], i) => {
        const s = pair![i];
        if (!icon) {
          s.mesh.visible = false;
          s.amount = 0;
          return;
        }
        if (icon !== s.icon || colors[i] !== s.color) {
          s.icon = icon;
          s.color = colors[i];
          s.material.map = this.texture(icon, colors[i]);
          s.material.needsUpdate = true;
        }
        // Brighter as the fingers close; bigger while the pinch is held.
        const near = Math.min(1, Math.max(0, (0.08 - gap) / 0.06));
        const target = active ? 1 : 0.35 + near * 0.5;
        s.amount += (target - s.amount) * Math.min(1, dt * 12);
        s.material.opacity = s.amount;
        s.mesh.visible = true;
        s.mesh.position.copy(tip).addScaledVector(this.fwd, 0.014).addScaledVector(this.back, 0.012);
        s.mesh.scale.setScalar(active ? 1.35 : 1);
        s.mesh.lookAt(eye);
      });
    }
  }

  /** For tests: what each hand currently shows. */
  debug(): { side: string; index: string | null; middle: string | null }[] {
    return [...this.sprites].map(([hand, [a, b]]) => ({ side: hand.side, index: a.mesh.visible ? a.icon : null, middle: b.mesh.visible ? b.icon : null }));
  }
}
