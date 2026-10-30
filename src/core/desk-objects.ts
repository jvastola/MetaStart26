/**
 * Things that live on the desk itself, outside any app: anything you pinned
 * (clay prints, Sketch strokes, Conjure creations) and photo prints from the
 * camera gesture. They show in every app (Home included) and are saved for
 * next session.
 *
 *   - Tap one (a quick pinch on it, or a click) to show its two buttons:
 *     pin (locked in place, or not) and delete. Tap again or elsewhere to
 *     hide them. Nothing else clutters the desk.
 *   - A pinned object stays exactly where it is and cannot be knocked.
 *     Unpinned, grab it (thumb + middle) to move it, or drop it on the bin.
 *
 * The host owns one and updates it before the active app, so a pinch or
 * grab on a desk object never also reaches the app underneath.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  type Object3D,
  PlaneGeometry,
  type Quaternion,
  Texture,
  Vector3,
  type WebGLRenderer,
} from '@iwsdk/core';
import { blobShadow } from './art.js';
import { makeIcosphere } from '../protos/clay/sculpt.js';
import { buildFromPrompt } from '../protos/conjure/kit.js';
import { Stroke } from '../protos/sketch/sketch.js';
import { SHOT_H, SHOT_W, type Shot } from './camera-frame.js';
import { store } from './context.js';
import { HeldPose } from './grab.js';
import { grabDistance, type HandState, pointerDistance } from './hands.js';
import { ItemActions } from './item-actions.js';
import { Sfx } from './sfx.js';
import type { TrashBin } from './trash.js';

const SAVE_KEY = 'desk-objects-v1';
/** Old per-app keys for pinned prints, read once and moved here. */
const OLD_PIN_KEYS = ['clay-pinned-v1', 'studio-clay-pinned-v1'];
const LIMITS: Record<Kind, number> = { photo: 16, print: 8, stroke: 40, model: 12 };
/** Clay sculptures are icospheres of this detail; their faces are rebuilt from it. */
const CLAY_DETAIL = 22;
/** A pinch released within this long is a tap. */
const TAP = 0.4;

export type Kind = 'print' | 'photo' | 'stroke' | 'model';

interface Saved {
  k: Kind;
  /** Holder position xyz, quaternion xyzw, scale (desk-local). */
  t: number[];
  pinned: boolean;
  /** Print: vertex positions (base64 float32), colour, mesh [scale, rotY, lift], height. */
  v?: string;
  c?: string;
  m?: [number, number, number];
  h?: number;
  /** Photo: JPEG data URL and width in metres. */
  img?: string;
  w?: number;
  /** Stroke: points (base64 float32, stroke-local) and brush radius. */
  p?: string;
  r?: number;
  /** Model: prompt and variation (colour in c if it was repainted). */
  pr?: string;
  va?: number;
}

export interface DeskObject {
  readonly kind: Kind;
  readonly holder: Group;
  pinned: boolean;
  /** Centre (world) and grab reach. */
  center(out: Vector3): Vector3;
  /** Top (world), where the buttons float. */
  top(out: Vector3): Vector3;
  reach: number;
  /** Precise distance from a pointer, for thin things like strokes (else centre distance is used). */
  hit?(hand: HandState, point: 'grab' | 'pinch'): number;
  /** Data to save (without the transform and pin, which are common). */
  data: Partial<Saved>;
  dispose(): void;
  /** Grows from small when it appears. */
  pop: number;
}

function toBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromBase64(text: string): Float32Array {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

let clayIndex: BufferAttribute | null = null;
function clayFaces(): BufferAttribute {
  if (!clayIndex) clayIndex = new BufferAttribute(makeIcosphere(0.055, CLAY_DETAIL).indices, 1);
  return clayIndex;
}

/** Repaint every mesh (cloning materials so other things keep theirs). */
function paint(object: Object3D, hex: string): void {
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: Material): Material => {
      const next = m.clone();
      (next as MeshStandardMaterial).color?.set(hex);
      return next;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

function disposeTree(object: Object3D): void {
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose();
  });
}

export class DeskObjects {
  readonly group = new Group();
  objects: DeskObject[] = [];
  /** The tapped object, whose pin and delete buttons are showing. */
  selected: DeskObject | null = null;
  private readonly actions: ItemActions;
  private holds: { obj: DeskObject; hand: HandState; pose: HeldPose; time: number; from: Vector3 }[] = [];
  private taps: { obj: DeskObject; hand: HandState; time: number }[] = [];
  private readonly tmp = new Vector3();
  /** Lets mouse drags slide on a plane through the object (set by the host). */
  mousePlane: ((point: Vector3) => void) | null = null;
  mouseRelease: (() => void) | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly trash: TrashBin,
  ) {
    this.group.name = 'DeskObjects';
    this.actions = new ItemActions(
      'desk',
      '#ffc94d',
      () => {
        if (this.selected) this.togglePin(this.selected);
      },
      () => {
        if (this.selected) {
          Sfx.trash(this.selected.holder.getWorldPosition(this.tmp));
          this.remove(this.selected);
        }
      },
    );
    this.group.add(this.actions.group);
  }

  // ------------------------------------------------------------ making

  /** Add a made object at a world pose, pinned (locked) by default. */
  private adopt(obj: DeskObject, worldPos: Vector3, worldQuat: Quaternion, worldScale: number, pinned = true): DeskObject {
    this.group.updateMatrixWorld(true);
    this.group.add(obj.holder);
    obj.holder.position.copy(this.group.worldToLocal(worldPos.clone()));
    const parentQ = this.group.getWorldQuaternion(obj.holder.quaternion.clone()).invert();
    obj.holder.quaternion.copy(worldQuat).premultiply(parentQ);
    obj.holder.scale.setScalar(worldScale / this.group.getWorldScale(this.tmp).x);
    obj.pinned = pinned;
    this.objects.push(obj);
    this.trim();
    this.save();
    return obj;
  }

  /**
   * Pin a clay print to the desk. `positions` are the sculpture's vertices,
   * `mesh` its scale, turn and lift in the holder.
   */
  addPrint(positions: Float32Array, color: string, mesh: [number, number, number], height: number, worldPos: Vector3, worldQuat: Quaternion, worldScale: number): DeskObject {
    return this.adopt(this.buildPrint(positions, color, mesh, height), worldPos, worldQuat, worldScale);
  }

  /** Pin a Sketch stroke: points are stroke-local (centred), as Sketch keeps them. */
  addStroke(points: Float32Array, color: string, radius: number, worldPos: Vector3, worldQuat: Quaternion, worldScale: number): DeskObject {
    return this.adopt(this.buildStroke(points, color, radius), worldPos, worldQuat, worldScale);
  }

  /** Pin a Conjure creation (rebuilt from its prompt; AI-made models pin as their offline sketch). */
  addModel(prompt: string, variation: number, color: string | null, worldPos: Vector3, worldQuat: Quaternion, worldScale: number): DeskObject {
    return this.adopt(this.buildModel(prompt, variation, color), worldPos, worldQuat, worldScale);
  }

  private buildPrint(positions: Float32Array, color: string, m: [number, number, number], height: number): DeskObject {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(clayFaces());
    geometry.computeVertexNormals();
    const material = new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
    const mesh = new Mesh(geometry, material);
    mesh.scale.setScalar(m[0]);
    mesh.rotation.y = m[1];
    mesh.position.y = m[2];
    mesh.frustumCulled = false;
    const holder = new Group();
    holder.add(mesh);
    return {
      kind: 'print',
      holder,
      pinned: true,
      reach: Math.max(0.045, height * 0.6),
      center: (out) => holder.localToWorld(out.set(0, height / 2, 0)),
      top: (out) => holder.localToWorld(out.set(0, height, 0)),
      data: { v: toBase64(positions), c: color, m, h: height },
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
      pop: 1,
    };
  }

  private buildStroke(points: Float32Array, color: string, radius: number): DeskObject {
    const stroke = new Stroke(color, radius);
    const p = new Vector3();
    let extent = 0;
    for (let i = 0; i + 2 < points.length; i += 3) {
      stroke.add(p.set(points[i], points[i + 1], points[i + 2]));
      extent = Math.max(extent, p.length());
    }
    const holder = new Group();
    holder.add(stroke.group);
    return {
      kind: 'stroke',
      holder,
      pinned: true,
      reach: 0.025,
      // Distance to the line itself, so a pinned stroke never claims a pinch beside it.
      hit: (hand, point) => {
        holder.updateMatrixWorld(true);
        let best = Infinity;
        const w = new Vector3();
        for (const q of stroke.points) {
          holder.localToWorld(w.copy(q));
          best = Math.min(best, point === 'grab' ? grabDistance(hand, w) : pointerDistance(hand, w));
        }
        return best - radius * holder.scale.x;
      },
      center: (out) => holder.getWorldPosition(out),
      top: (out) => holder.getWorldPosition(out).add(new Vector3(0, extent * holder.scale.y, 0)),
      data: { p: toBase64(points), c: color, r: radius },
      dispose: () => stroke.dispose(),
      pop: 1,
    };
  }

  private buildModel(prompt: string, variation: number, color: string | null): DeskObject {
    const { object } = buildFromPrompt(prompt, variation);
    if (color) paint(object, color);
    const holder = new Group();
    holder.add(object, blobShadow(0.13));
    return {
      kind: 'model',
      holder,
      pinned: true,
      reach: 0.08,
      center: (out) => holder.localToWorld(out.set(0, 0.06, 0)),
      top: (out) => holder.localToWorld(out.set(0, 0.14, 0)),
      data: { pr: prompt, va: variation, c: color ?? undefined },
      dispose: () => disposeTree(object),
      pop: 1,
    };
  }

  /** A photo print of a shot, popping out where it was framed, facing `facing`. */
  addPhotoFromShot(shot: Shot, at: Vector3, facing: Vector3, width: number): DeskObject | null {
    const canvas = this.readShot(shot);
    if (!canvas) return null;
    const obj = this.buildPhoto(canvas, width, canvas.toDataURL('image/jpeg', 0.82));
    this.group.updateMatrixWorld(true);
    this.group.add(obj.holder);
    obj.holder.position.copy(this.group.worldToLocal(at.clone()));
    // Never below the desk top.
    obj.holder.position.y = Math.max(obj.holder.position.y, 0.06);
    obj.holder.lookAt(facing);
    obj.pinned = false;
    obj.pop = 0;
    this.objects.push(obj);
    this.trim();
    this.save();
    Sfx.whoosh(at);
    return obj;
  }

  /** Copy a shot's pixels into a canvas (render targets are stored bottom-up). */
  private readShot(shot: Shot): HTMLCanvasElement | null {
    if (!shot.target) return null;
    const pixels = new Uint8Array(SHOT_W * SHOT_H * 4);
    this.renderer.readRenderTargetPixels(shot.target, 0, 0, SHOT_W, SHOT_H, pixels);
    const canvas = document.createElement('canvas');
    canvas.width = SHOT_W;
    canvas.height = SHOT_H;
    const c = canvas.getContext('2d')!;
    const image = c.createImageData(SHOT_W, SHOT_H);
    const row = SHOT_W * 4;
    for (let y = 0; y < SHOT_H; y += 1) image.data.set(pixels.subarray((SHOT_H - 1 - y) * row, (SHOT_H - y) * row), y * row);
    c.putImageData(image, 0, 0);
    return canvas;
  }

  private buildPhoto(source: HTMLCanvasElement, width: number, img: string): DeskObject {
    const height = (width * SHOT_H) / SHOT_W;
    const texture = new CanvasTexture(source);
    // The pixels are as rendered into the shot (linear), like the storyboard cards.
    texture.colorSpace = NoColorSpace;
    const card = new Mesh(new BoxGeometry(width + 0.012, height + 0.02, 0.003), new MeshStandardMaterial({ color: '#f6f3ec', roughness: 0.7 }));
    const picture = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture }));
    picture.position.set(0, 0.004, 0.0017);
    const holder = new Group();
    holder.add(card, picture);
    return {
      kind: 'photo',
      holder,
      pinned: false,
      reach: Math.max(0.05, width * 0.6),
      center: (out) => holder.getWorldPosition(out),
      top: (out) => holder.localToWorld(out.set(0, height / 2 + 0.01, 0)),
      data: { img, w: width },
      dispose: () => {
        (picture.material as MeshBasicMaterial).map?.dispose();
        card.geometry.dispose();
        picture.geometry.dispose();
      },
      pop: 1,
    };
  }

  /** Keep the counts sensible: the oldest unpinned things go first. */
  private trim(): void {
    for (const kind of Object.keys(LIMITS) as Kind[]) {
      while (this.objects.filter((o) => o.kind === kind).length > LIMITS[kind]) {
        const victim = this.objects.find((o) => o.kind === kind && !o.pinned) ?? this.objects.find((o) => o.kind === kind)!;
        this.remove(victim);
      }
    }
  }

  remove(obj: DeskObject): void {
    this.objects = this.objects.filter((o) => o !== obj);
    this.holds = this.holds.filter((h) => h.obj !== obj);
    if (this.selected === obj) this.select(null);
    obj.holder.removeFromParent();
    obj.dispose();
    this.save();
  }

  togglePin(obj: DeskObject): void {
    obj.pinned = !obj.pinned;
    this.holds = this.holds.filter((h) => h.obj !== obj);
    this.refreshActions();
    Sfx.blip(obj.pinned ? 900 : 600);
    this.save();
  }

  /** Show (or hide, with null) one object's pin and delete buttons. */
  select(obj: DeskObject | null): void {
    this.selected = obj;
    if (obj) this.actions.show(obj.holder, () => obj.top(new Vector3()));
    else this.actions.hide();
    this.refreshActions();
  }

  private refreshActions(): void {
    const obj = this.selected;
    if (!obj) return;
    this.actions.pin.active = obj.pinned;
    this.actions.pin.label = obj.pinned ? 'Pinned in place (press to unpin and move)' : 'Not pinned: grab to move (press to pin)';
  }

  // ------------------------------------------------------------ hands

  /** True if this hand is carrying or tapping a desk object. */
  owns(hand: HandState): boolean {
    return this.holds.some((h) => h.hand === hand) || this.taps.some((t) => t.hand === hand);
  }

  private nearest(hand: HandState, unpinnedOnly: boolean, point: 'grab' | 'pinch'): DeskObject | null {
    let best: DeskObject | null = null;
    let bestD = Infinity;
    for (const obj of this.objects) {
      if (unpinnedOnly && obj.pinned) continue;
      const d = obj.hit ? obj.hit(hand, point) : point === 'grab' ? grabDistance(hand, obj.center(this.tmp)) : pointerDistance(hand, obj.center(this.tmp));
      if (d < obj.reach && d < bestD) {
        best = obj;
        bestD = d;
      }
    }
    return best;
  }

  update(pointers: readonly HandState[], dt: number, eye: Vector3): void {
    for (const obj of this.objects) {
      if (obj.pop < 1) {
        obj.pop = Math.min(1, obj.pop + dt * 4);
        obj.holder.scale.setScalar(0.3 + 0.7 * (1 - (1 - obj.pop) ** 3));
      }
    }
    for (const t of this.taps) t.time += dt;
    for (const h of this.holds) h.time += dt;
    if (!this.group.visible) return;
    for (const hand of pointers) {
      if (!hand.tracked) continue;
      // Grab: pick up an unpinned object.
      if (hand.grabStarted && !this.owns(hand)) {
        const obj = this.nearest(hand, true, 'grab');
        if (obj) {
          if (hand.isMouse && this.mousePlane) {
            const at = obj.holder.getWorldPosition(new Vector3());
            this.mousePlane(at);
            hand.pinchPoint.copy(at);
            hand.grabPoint.copy(at);
          }
          const pose = new HeldPose();
          pose.begin(hand, obj.holder);
          this.holds.push({ obj, hand, pose, time: 0, from: obj.holder.getWorldPosition(new Vector3()) });
          hand.clearEdges();
          Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
          continue;
        }
      }
      // Pinch: a tap on an object shows its buttons; a pinch elsewhere hides them.
      if (hand.pinchStarted && !this.owns(hand)) {
        const obj = this.nearest(hand, false, 'pinch');
        if (obj) {
          this.taps.push({ obj, hand, time: 0 });
          hand.clearEdges();
        } else if (this.selected) this.select(null);
      }
    }
    // Taps end when the pinch opens.
    for (let i = this.taps.length - 1; i >= 0; i -= 1) {
      const t = this.taps[i];
      if (t.hand.pinching && t.hand.tracked) continue;
      this.taps.splice(i, 1);
      if (t.time < TAP) this.select(this.selected === t.obj ? null : t.obj);
    }
    // Carrying.
    for (let i = this.holds.length - 1; i >= 0; i -= 1) {
      const h = this.holds[i];
      if (h.hand.grabbing && h.hand.tracked) {
        h.pose.apply(h.hand, h.obj.holder);
        this.trash.near(h.hand.holdPoint);
        continue;
      }
      this.holds.splice(i, 1);
      if (h.hand.isMouse) this.mouseRelease?.();
      if (this.trash.take(h.hand.holdPoint)) {
        this.remove(h.obj);
        continue;
      }
      // A click that did not move it (the mouse grabs and pinches at once) is a tap.
      if (h.time < TAP && h.obj.holder.getWorldPosition(this.tmp).distanceTo(h.from) < 0.01) {
        this.select(this.selected === h.obj ? null : h.obj);
        continue;
      }
      Sfx.place(h.obj.holder.getWorldPosition(this.tmp));
      this.save();
    }
    this.actions.update(eye);
  }

  // ------------------------------------------------------------ saving

  save(): void {
    const out: Saved[] = this.objects.map((o) => {
      const h = o.holder;
      return { ...o.data, k: o.kind, pinned: o.pinned, t: [...h.position.toArray(), ...h.quaternion.toArray(), o.pop < 1 ? 1 : h.scale.x] } as Saved;
    });
    store.set(SAVE_KEY, out);
  }

  load(): void {
    const saved = store.get<Saved[]>(SAVE_KEY, []);
    // Prints pinned by an earlier version were saved per app: move them here.
    for (const key of OLD_PIN_KEYS) {
      for (const old of store.get<{ v: string; c: string; m: [number, number, number]; t: number[]; h: number }[]>(key, [])) {
        saved.push({ k: 'print', v: old.v, c: old.c, m: old.m, h: old.h, t: old.t, pinned: true });
      }
      if (store.get<unknown[] | null>(key, null)) store.set(key, []);
    }
    for (const s of saved) {
      try {
        let obj: DeskObject | null = null;
        if (s.k === 'print' && s.v && s.m && s.c) obj = this.buildPrint(fromBase64(s.v), s.c, s.m, s.h ?? 0.1);
        else if (s.k === 'stroke' && s.p && s.c) obj = this.buildStroke(fromBase64(s.p), s.c, s.r ?? 0.005);
        else if (s.k === 'model' && s.pr) obj = this.buildModel(s.pr, s.va ?? 0, s.c ?? null);
        else if (s.k === 'photo' && s.img) {
          const photo = this.buildPhoto(document.createElement('canvas'), s.w ?? 0.12, s.img);
          const image = new Image();
          image.onload = () => {
            // A fresh texture: an uploaded one cannot change size in place.
            const material = (photo.holder.children[1] as Mesh).material as MeshBasicMaterial;
            const old = material.map;
            const tex = new Texture(image);
            tex.colorSpace = NoColorSpace;
            tex.needsUpdate = true;
            material.map = tex;
            material.needsUpdate = true;
            old?.dispose();
          };
          image.src = s.img;
          obj = photo;
        }
        if (obj) this.restore(obj, s);
      } catch {
        // A damaged entry: skip it.
      }
    }
    this.save();
  }

  private restore(obj: DeskObject, s: Saved): void {
    const [x, y, z, qx, qy, qz, qw, sc] = s.t;
    this.group.add(obj.holder);
    obj.holder.position.set(x, y, z);
    obj.holder.quaternion.set(qx, qy, qz, qw);
    obj.holder.scale.setScalar(sc ?? 1);
    obj.pinned = s.pinned;
    this.objects.push(obj);
  }

  debug(): { kind: Kind; pinned: boolean; pos: number[]; selected: boolean }[] {
    return this.objects.map((o) => ({ kind: o.kind, pinned: o.pinned, pos: o.holder.position.toArray().map((v) => +v.toFixed(3)), selected: o === this.selected }));
  }
}
