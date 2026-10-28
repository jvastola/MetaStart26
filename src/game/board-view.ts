/**
 * Everything you see on the table: the green, rails, obstacles, cup and flag,
 * the ball, and the aim guide. Built from a handful of shared geometries and
 * materials so rebuilding a hole only creates lightweight Mesh objects.
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import {
  BALL_RADIUS,
  BOARD_DEPTH,
  BOARD_WIDTH,
  CUP_RADIUS,
  type HoleLayout,
  WALL_HEIGHT,
} from './course.js';

const GREEN_THICKNESS = 0.008;
const RAIL = 0.016;
export const PREVIEW_DOTS = 18;

const unitBox = new BoxGeometry(1, 1, 1);
const unitCylinder = new CylinderGeometry(1, 1, 1, 28);
const ballGeometry = new SphereGeometry(BALL_RADIUS, 24, 16);
const dotGeometry = new SphereGeometry(0.0028, 8, 6);
const ringGeometry = new RingGeometry(BALL_RADIUS * 1.6, BALL_RADIUS * 2.1, 32);

const mat = {
  green: new MeshStandardMaterial({ color: '#3f9b4f', roughness: 0.95 }),
  fringe: new MeshStandardMaterial({ color: '#2c6b38', roughness: 0.95 }),
  rail: new MeshStandardMaterial({ color: '#c9915a', roughness: 0.6 }),
  block: new MeshStandardMaterial({ color: '#e7d3b0', roughness: 0.55 }),
  post: new MeshStandardMaterial({ color: '#ef6f4f', roughness: 0.4 }),
  cup: new MeshBasicMaterial({ color: '#0b0d0b' }),
  pole: new MeshStandardMaterial({ color: '#f4f4f0', roughness: 0.3 }),
  flag: new MeshStandardMaterial({ color: '#ffcc33', roughness: 0.5, emissive: '#553300' }),
  tee: new MeshStandardMaterial({ color: '#d7f5dc', roughness: 0.8 }),
  ball: new MeshStandardMaterial({ color: '#ffffff', roughness: 0.25, emissive: '#000000' }),
  shaft: new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 }),
  dots: new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.75 }),
  ring: new MeshBasicMaterial({ color: '#7fffd4', transparent: true, opacity: 0.0 }),
  ghost: new MeshBasicMaterial({ color: '#7fffd4', transparent: true, opacity: 0.35 }),
};

function box(
  material: MeshStandardMaterial | MeshBasicMaterial,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): Mesh {
  const mesh = new Mesh(unitBox, material);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  return mesh;
}

function cylinder(
  material: MeshStandardMaterial | MeshBasicMaterial,
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
): Mesh {
  const mesh = new Mesh(unitCylinder, material);
  mesh.scale.set(r, h, r);
  mesh.position.set(x, y, z);
  return mesh;
}

const LOW = new Color('#7fffd4');
const MID = new Color('#ffd166');
const HIGH = new Color('#ff5d5d');

export class BoardView {
  /** Placed on the table. Local +Z faces the player, y=0 is the green's top. */
  readonly root = new Group();
  readonly ball: Mesh;
  private readonly course = new Group();
  private readonly ghost: Mesh;
  private readonly flag = new Group();
  private readonly shaft: Mesh;
  private readonly ring: Mesh;
  private readonly dots: InstancedMesh;
  private readonly tmpMatrix = new Matrix4();
  private readonly tmpVec = new Vector3();
  private readonly tmpColor = new Color();

  constructor() {
    this.root.name = 'DeskLinksBoard';
    const w = BOARD_WIDTH;
    const d = BOARD_DEPTH;
    const base = new Group();
    base.add(box(mat.fringe, w + RAIL * 2 + 0.02, GREEN_THICKNESS * 0.8, d + RAIL * 2 + 0.02, 0, -GREEN_THICKNESS * 0.6, 0));
    base.add(box(mat.green, w, GREEN_THICKNESS, d, 0, -GREEN_THICKNESS / 2, 0));
    const ry = WALL_HEIGHT / 2 - GREEN_THICKNESS / 2;
    const rh = WALL_HEIGHT + GREEN_THICKNESS;
    base.add(box(mat.rail, w + RAIL * 2, rh, RAIL, 0, ry, -d / 2 - RAIL / 2));
    base.add(box(mat.rail, w + RAIL * 2, rh, RAIL, 0, ry, d / 2 + RAIL / 2));
    base.add(box(mat.rail, RAIL, rh, d, -w / 2 - RAIL / 2, ry, 0));
    base.add(box(mat.rail, RAIL, rh, d, w / 2 + RAIL / 2, ry, 0));
    this.root.add(base);
    this.root.add(this.course);

    this.ghost = box(mat.ghost, w + RAIL * 2, 0.004, d + RAIL * 2, 0, 0.002, 0);
    this.ghost.visible = false;
    this.root.add(this.ghost);

    this.ball = new Mesh(ballGeometry, mat.ball);
    this.ball.name = 'Ball';
    this.root.add(this.ball);

    this.ring = new Mesh(ringGeometry, mat.ring);
    this.ring.rotation.x = -Math.PI / 2;
    this.root.add(this.ring);

    this.shaft = new Mesh(unitBox, mat.shaft);
    this.shaft.visible = false;
    this.root.add(this.shaft);

    this.dots = new InstancedMesh(dotGeometry, mat.dots, PREVIEW_DOTS);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.root.add(this.dots);
  }

  /** Swap in a new hole's obstacles, cup and tee. */
  buildHole(hole: HoleLayout): void {
    for (const child of [...this.course.children]) this.course.remove(child);
    const y = WALL_HEIGHT / 2;
    for (const b of hole.blocks) {
      // Board yaw is about +Y; our 2D angle rotates x toward z, which is -yaw.
      this.course.add(box(mat.block, b.hx * 2, WALL_HEIGHT, b.hz * 2, b.cx, y, b.cz, -b.angle));
    }
    for (const p of hole.posts) {
      this.course.add(cylinder(mat.post, p.r, WALL_HEIGHT * 1.2, p.x, WALL_HEIGHT * 0.6, p.z));
    }
    this.course.add(cylinder(mat.cup, CUP_RADIUS, 0.001, hole.cup.x, 0.0006, hole.cup.z));
    this.course.add(cylinder(mat.tee, 0.014, 0.0008, hole.tee.x, 0.0004, hole.tee.z));

    this.flag.clear();
    const poleH = 0.11;
    this.flag.add(cylinder(mat.pole, 0.0018, poleH, 0, poleH / 2, 0));
    this.flag.add(box(mat.flag, 0.035, 0.022, 0.002, 0.018, poleH - 0.012, 0));
    this.flag.position.set(hole.cup.x, 0, hole.cup.z);
    this.course.add(this.flag);
  }

  setBall(x: number, z: number, sinkDepth = 0): void {
    this.ball.position.set(x, BALL_RADIUS - sinkDepth, z);
    this.ring.position.set(x, 0.0008, z);
  }

  /** Lift the flag out while the ball is close, like a caddie would. */
  setFlagLift(amount: number): void {
    this.flag.position.y = amount * 0.06;
  }

  setPlacing(placing: boolean): void {
    this.ghost.visible = placing;
    this.course.visible = !placing;
    this.ball.visible = !placing;
  }

  /** Highlight ring under the ball: 0 = hidden, 1 = a hand can grab it. */
  setReach(amount: number, pinched: boolean): void {
    mat.ring.opacity = pinched ? 0.9 : amount * 0.6;
    mat.ball.emissive.setRGB(amount * 0.15, amount * 0.25, amount * 0.22);
  }

  /** Aim shaft from the ball, coloured by power (0..1). */
  showAim(dirX: number, dirZ: number, power: number): void {
    const len = 0.03 + power * 0.14;
    const yaw = Math.atan2(dirX, dirZ);
    this.shaft.visible = true;
    this.shaft.scale.set(0.004, 0.002, len);
    this.shaft.rotation.set(0, yaw, 0);
    this.shaft.position.set(
      this.ball.position.x + (dirX * len) / 2,
      0.003,
      this.ball.position.z + (dirZ * len) / 2,
    );
    if (power < 0.5) this.tmpColor.copy(LOW).lerp(MID, power * 2);
    else this.tmpColor.copy(MID).lerp(HIGH, (power - 0.5) * 2);
    mat.shaft.color.copy(this.tmpColor);
  }

  hideAim(): void {
    this.shaft.visible = false;
    this.dots.count = 0;
  }

  /** Dotted predicted path. `points` holds x,z pairs. */
  setPreview(points: Float32Array, count: number): void {
    const n = Math.min(count, PREVIEW_DOTS);
    for (let i = 0; i < n; i += 1) {
      this.tmpVec.set(points[i * 2], 0.003, points[i * 2 + 1]);
      this.tmpMatrix.makeTranslation(this.tmpVec);
      this.dots.setMatrixAt(i, this.tmpMatrix);
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
  }

  /** Convert a world-space point into board-local coordinates (in place). */
  toLocal(world: Vector3): Vector3 {
    return this.root.worldToLocal(world);
  }

  get object(): Object3D {
    return this.root;
  }
}
