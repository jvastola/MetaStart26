/**
 * A bin in the front-right corner of the desk. Drop anything you are holding
 * over it to throw it away. The host owns one and shows it for prototypes
 * that set `trash: true`; prototypes call `near()` every frame while they
 * hold something (the bin opens up) and `take()` when it is let go.
 */

import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry, Vector3 } from '@iwsdk/core';
import { blobShadow } from './art.js';
import { Sfx } from './sfx.js';

/** Desk-local position of the bin. */
export const TRASH_POS = new Vector3(0.335, 0, 0.17);
const RADIUS = 0.04;
const HEIGHT = 0.055;
/** Drops count if within this horizontal distance of the bin and below REACH_Y. */
const REACH_XZ = 0.075;
const REACH_Y = 0.22;

export class TrashBin {
  readonly group = new Group();
  private readonly rimMat = new MeshStandardMaterial({ color: '#ff6b6b', emissive: '#ff6b6b', emissiveIntensity: 0.25, roughness: 0.4 });
  private hovered = false;
  private open = 0;
  private gulp = 0;
  private readonly local = new Vector3();
  /** Things thrown away this session (tests). */
  count = 0;

  constructor() {
    const body = new Mesh(
      new CylinderGeometry(RADIUS, RADIUS * 0.82, HEIGHT, 28, 1, true),
      new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.55, side: 2 }),
    );
    body.position.y = HEIGHT / 2;
    const bottom = new Mesh(new CylinderGeometry(RADIUS * 0.82, RADIUS * 0.82, 0.003, 28), new MeshStandardMaterial({ color: '#1c1f25' }));
    bottom.position.y = 0.0015;
    const rim = new Mesh(new TorusGeometry(RADIUS, 0.0035, 8, 40), this.rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = HEIGHT;
    this.group.add(body, bottom, rim, blobShadow(0.12));
    this.group.position.copy(TRASH_POS);
    this.group.name = 'TrashBin';
    this.group.userData.hideInShots = true;
    this.group.visible = false;
  }

  /** True if a world point is over the bin's mouth. */
  over(world: Vector3): boolean {
    if (!this.group.visible) return false;
    this.group.updateMatrixWorld(true);
    const q = this.group.worldToLocal(this.local.copy(world));
    return Math.hypot(q.x, q.z) < REACH_XZ && q.y < REACH_Y && q.y > -0.03;
  }

  /** Call every frame while holding something at `world`: the bin lights up when it is over it. */
  near(world: Vector3): boolean {
    const over = this.over(world);
    this.hovered ||= over;
    return over;
  }

  /** Call on release: true (and a crumple sound) if the drop landed in the bin. */
  take(world: Vector3): boolean {
    if (!this.over(world)) return false;
    this.count += 1;
    this.gulp = 1;
    Sfx.trash(this.group.getWorldPosition(this.local));
    return true;
  }

  /** Host calls this once per frame after the active prototype's update. */
  update(dt: number): void {
    const k = Math.min(1, dt * 12);
    this.open += ((this.hovered ? 1 : 0) - this.open) * k;
    this.gulp = Math.max(0, this.gulp - dt * 3);
    this.hovered = false;
    const s = 1 + this.open * 0.18 - Math.sin(this.gulp * Math.PI) * 0.12;
    this.group.scale.set(s, 1 + this.open * 0.1, s);
    this.rimMat.emissiveIntensity = 0.25 + this.open * 1.1;
  }
}
