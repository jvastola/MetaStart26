/**
 * A ring of small dots that fills as a long job progresses (AI generation).
 * A bright dot keeps circling even at 0%, so it never looks frozen.
 */

import { CircleGeometry, Group, Mesh, MeshBasicMaterial } from '@iwsdk/core';

const DOTS = 24;
const dotGeometry = new CircleGeometry(0.0035, 10);

export class ProgressRing {
  readonly group = new Group();
  private readonly dots: Mesh[] = [];
  private readonly on: MeshBasicMaterial;
  private readonly off = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18, depthWrite: false });
  private readonly spark = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false });
  private time = 0;
  /** 0..1 */
  progress = 0;

  constructor(radius: number, accent: string) {
    this.on = new MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthWrite: false });
    this.group.name = 'ProgressRing';
    this.group.userData.hideInShots = true;
    for (let i = 0; i < DOTS; i++) {
      const a = (i / DOTS) * Math.PI * 2;
      const dot = new Mesh(dotGeometry, this.off);
      dot.rotation.x = -Math.PI / 2;
      // Clockwise from the front, seen from above.
      dot.position.set(Math.sin(a) * radius, 0, Math.cos(a) * radius);
      this.group.add(dot);
      this.dots.push(dot);
    }
    this.group.visible = false;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    const filled = Math.round(Math.min(1, Math.max(0, this.progress)) * DOTS);
    const spark = Math.floor(this.time * 12) % DOTS;
    for (let i = 0; i < DOTS; i++) this.dots[i].material = i === spark ? this.spark : i < filled ? this.on : this.off;
  }
}
