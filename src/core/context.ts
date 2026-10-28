/**
 * The contract between the lab host (src/lab-system.ts) and each prototype.
 *
 * The host owns input, the desk/wall placement and the anchored room. A
 * prototype owns two groups: `deskRoot` (content that sits on the desk, in
 * desk space: +Z toward the user, y = 0 on the desk surface) and `wallRoot`
 * (content on the wall, facing +Z into the room). The host parents them,
 * shows the active prototype and hides the rest, so switching keeps state.
 */

import type { Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer, World } from '@iwsdk/core';
import type { HandState, Hands } from './hands.js';

export interface LabContext {
  readonly world: World;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly hands: Hands;
  readonly mouse: HandState;
  /** Hands in XR, the mouse otherwise. */
  readonly pointers: readonly HandState[];
  readonly immersive: boolean;
  /** Desk frame (world transform of the desk workspace). */
  readonly desk: Group;
  /** Wall frame. */
  readonly wall: Group;
  /** Viewer head position, world space, updated each frame. */
  readonly head: Vector3;
  /** Seconds since start. */
  readonly time: number;
  /** Where the mouse "pinch point" lands: a plane through point with normal. */
  setMousePlane(point: Vector3, normal: Vector3): void;
  toast(text: string): void;
  goHome(): void;
}

export interface Prototype {
  readonly id: string;
  readonly title: string;
  readonly tagline: string;
  readonly deskRoot: Group;
  readonly wallRoot: Group;
  /** Called once, before the first enter. */
  init(ctx: LabContext): void;
  enter(): void;
  exit(): void;
  update(dt: number): void;
  /** Snapshot for automated tests. */
  debugState?(): unknown;
  /** Test helpers callable from the browser console. */
  debugActions?: Record<string, (...args: never[]) => unknown>;
}

/** localStorage helpers that never throw. */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable: state just will not persist.
    }
  },
};

/** Local calendar day number, for streaks. */
export function dayNumber(date = new Date()): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}
