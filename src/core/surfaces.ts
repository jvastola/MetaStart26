/**
 * Finds the user's desk and a nearby wall from WebXR plane detection.
 *
 * Quest reports planes from the user's Space Setup with labels such as
 * "table" and "wall". Judges test in rooms we have never seen, so every
 * lookup degrades gracefully: prefer a labelled plane, accept any plane of
 * the right shape and height, and otherwise return false so the caller can
 * fall back to pinch placement.
 */

import { type Entity, Quaternion, Vector3, XRPlane } from '@iwsdk/core';

export interface SurfacePose {
  position: Vector3;
  yaw: number;
  label: string;
}

const UP = new Vector3(0, 1, 0);
const tmpN = new Vector3();
const tmpQ = new Quaternion();
const tmpLocal = new Vector3();

interface PlaneInfo {
  entity: Entity;
  label: string;
  normal: Vector3;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function describe(entity: Entity): PlaneInfo | null {
  const object = entity.object3D;
  const plane = entity.getValue(XRPlane, '_plane') as XRPlane | undefined;
  if (object == null || plane == null) return null;
  object.updateMatrixWorld(true);
  object.getWorldQuaternion(tmpQ);
  const normal = tmpN.copy(UP).applyQuaternion(tmpQ).clone();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of plane.polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  if (!Number.isFinite(minX)) return null;
  const label = ((plane as XRPlane & { semanticLabel?: string }).semanticLabel ?? '').toLowerCase();
  return { entity, label, normal, minX, maxX, minZ, maxZ };
}

/**
 * The desk in front of the user: a horizontal plane at desk height, labelled
 * table/desk when possible. The workspace centre sits a comfortable reach
 * in from the edge nearest the user.
 */
export function findDesk(planes: readonly Entity[], head: Vector3, forward: Vector3, out: SurfacePose): boolean {
  let best: { score: number; info: PlaneInfo; point: Vector3 } | null = null;
  for (const entity of planes) {
    const info = describe(entity);
    if (info == null || info.normal.y < 0.9) continue;
    const object = entity.object3D!;
    const height = object.getWorldPosition(tmpLocal).y;
    if (height < 0.4 || height > 1.2) continue;
    // Nearest point on the plane's bounds to the head, then 22 cm inward.
    const local = object.worldToLocal(tmpLocal.copy(head));
    const cx = (info.minX + info.maxX) / 2;
    const cz = (info.minZ + info.maxZ) / 2;
    let x = clamp(local.x, info.minX + 0.1, info.maxX - 0.1);
    let z = clamp(local.z, info.minZ + 0.1, info.maxZ - 0.1);
    const toCx = cx - x;
    const toCz = cz - z;
    const len = Math.hypot(toCx, toCz);
    const inward = Math.min(0.22, len);
    if (len > 1e-4) {
      x += (toCx / len) * inward;
      z += (toCz / len) * inward;
    }
    const point = object.localToWorld(new Vector3(x, 0, z));
    const dx = point.x - head.x;
    const dz = point.z - head.z;
    const reach = Math.hypot(dx, dz);
    if (reach > 1.4) continue;
    // Only surfaces in front of the user: seated users face their desk.
    const facing = reach > 1e-3 ? (dx * forward.x + dz * forward.z) / (reach * Math.hypot(forward.x, forward.z) || 1) : 1;
    if (facing < 0.2) continue;
    const labelled = info.label.includes('table') || info.label.includes('desk');
    const score = reach + (1 - facing) * 0.6 - (labelled ? 0.5 : 0);
    if (best == null || score < best.score) best = { score, info, point };
  }
  if (best == null) return false;
  out.position.copy(best.point);
  out.yaw = Math.atan2(head.x - best.point.x, head.z - best.point.z);
  out.label = best.info.label || 'surface';
  return true;
}

/**
 * The wall behind the desk: a vertical plane in front of the user. The board
 * centre is placed straight ahead of the desk at a comfortable eye level.
 */
export function findWall(
  planes: readonly Entity[],
  head: Vector3,
  desk: Vector3,
  out: SurfacePose,
): boolean {
  let best: { dist: number; point: Vector3; yaw: number; label: string } | null = null;
  const fx = desk.x - head.x;
  const fz = desk.z - head.z;
  const flen = Math.hypot(fx, fz) || 1;
  for (const entity of planes) {
    const info = describe(entity);
    if (info == null || Math.abs(info.normal.y) > 0.2) continue;
    // Must face back toward the user.
    if (info.normal.x * fx + info.normal.z * fz > -0.3 * flen) continue;
    const object = entity.object3D!;
    // Project the desk centre onto the wall plane, keep it within bounds.
    const local = object.worldToLocal(tmpLocal.copy(desk));
    const x = clamp(local.x, info.minX + 0.25, info.maxX - 0.25);
    const z = clamp(local.z, info.minZ + 0.2, info.maxZ - 0.2);
    const point = object.localToWorld(new Vector3(x, 0, z));
    const dist = Math.hypot(point.x - desk.x, point.z - desk.z);
    if (dist > 1.6) continue;
    if (best == null || dist < best.dist) {
      best = { dist, point, yaw: Math.atan2(info.normal.x, info.normal.z), label: info.label || 'wall' };
    }
  }
  if (best == null) return false;
  out.position.copy(best.point);
  // Pull 1 cm off the wall so content never z-fights with it.
  out.position.x += Math.sin(best.yaw) * 0.01;
  out.position.z += Math.cos(best.yaw) * 0.01;
  out.position.y = clamp(head.y - 0.05, desk.y + 0.35, desk.y + 0.75);
  out.yaw = best.yaw;
  out.label = best.label;
  return true;
}

/** Height of a horizontal plane just under `point`, if any. */
export function surfaceBelow(planes: readonly Entity[], point: Vector3, maxGap = 0.15): number | null {
  let bestY: number | null = null;
  for (const entity of planes) {
    const info = describe(entity);
    if (info == null || info.normal.y < 0.9) continue;
    const object = entity.object3D!;
    const local = object.worldToLocal(tmpLocal.copy(point));
    if (local.x < info.minX || local.x > info.maxX || local.z < info.minZ || local.z > info.maxZ) continue;
    if (local.y < -0.02 || local.y > maxGap) continue;
    const y = object.getWorldPosition(tmpLocal).y;
    if (bestY == null || y > bestY) bestY = y;
  }
  return bestY;
}

function clamp(v: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, v));
}
