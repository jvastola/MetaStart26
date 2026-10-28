/**
 * A small particle burst for success moments (card done, model generated).
 * One InstancedMesh, no allocation per frame.
 */

import { Color, InstancedMesh, Matrix4, MeshBasicMaterial, type Object3D, SphereGeometry, Vector3 } from '@iwsdk/core';

const COUNT = 18;

export class Burst {
  readonly mesh: InstancedMesh;
  private readonly velocities: Vector3[] = [];
  private readonly positions: Vector3[] = [];
  private life = 0;
  private readonly m = new Matrix4();

  constructor(parent: Object3D, color = '#7fe0b5') {
    this.mesh = new InstancedMesh(
      new SphereGeometry(0.004, 6, 4),
      new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity: 1 }),
      COUNT,
    );
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    for (let i = 0; i < COUNT; i += 1) {
      this.velocities.push(new Vector3());
      this.positions.push(new Vector3());
    }
    parent.add(this.mesh);
  }

  /** Fire at a point in the parent's space. */
  fire(at: Vector3): void {
    for (let i = 0; i < COUNT; i += 1) {
      const a = (i / COUNT) * Math.PI * 2;
      const up = 0.25 + ((i * 7) % 5) * 0.06;
      this.velocities[i].set(Math.cos(a) * 0.18, up, Math.sin(a) * 0.18);
      this.positions[i].copy(at);
    }
    this.life = 0.7;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (this.life <= 0) return;
    this.life -= dt;
    const material = this.mesh.material as MeshBasicMaterial;
    material.opacity = Math.max(0, this.life / 0.7);
    for (let i = 0; i < COUNT; i += 1) {
      this.velocities[i].y -= 0.9 * dt;
      this.positions[i].addScaledVector(this.velocities[i], dt);
      this.m.makeTranslation(this.positions[i]);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.life <= 0) this.mesh.visible = false;
  }
}
