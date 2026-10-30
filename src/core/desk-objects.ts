/**
 * Things that live on the desk itself, outside any app: clay prints you
 * pinned and photo prints from the camera gesture. They show in every app
 * (Home included) and are saved for next session.
 *
 *   - A pinned object stays exactly where it is and cannot be knocked.
 *   - Press its pin to unlock it: grab it (thumb + middle) to move it,
 *     drop it on the bin to delete it, press the pin again to lock it.
 *
 * The host owns one and updates it before the active app, so a grab on a
 * desk object never also reaches the app underneath.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PlaneGeometry,
  BoxGeometry,
  Texture,
  Vector3,
  type Quaternion,
  type WebGLRenderer,
} from '@iwsdk/core';
import { makeIcosphere } from '../protos/clay/sculpt.js';
import { SHOT_H, SHOT_W, type Shot } from './camera-frame.js';
import { HeldPose } from './grab.js';
import { grabDistance, type HandState } from './hands.js';
import { IconButton } from './icon-button.js';
import { store } from './context.js';
import { Sfx } from './sfx.js';
import type { TrashBin } from './trash.js';

const SAVE_KEY = 'desk-objects-v1';
/** Old per-app keys for pinned prints, read once and moved here. */
const OLD_PIN_KEYS = ['clay-pinned-v1', 'studio-clay-pinned-v1'];
const MAX_PHOTOS = 16;
const MAX_PRINTS = 8;
/** Clay sculptures are icospheres of this detail; their faces are rebuilt from it. */
const CLAY_DETAIL = 22;

type Kind = 'print' | 'photo';

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
}

export interface DeskObject {
  readonly kind: Kind;
  readonly holder: Group;
  pinned: boolean;
  readonly pinButton: IconButton;
  /** Centre (world) and grab reach. */
  center(out: Vector3): Vector3;
  reach: number;
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
  if (!clayIndex) {
    const sphere = makeIcosphere(0.055, CLAY_DETAIL);
    clayIndex = new BufferAttribute(sphere.indices, 1);
  }
  return clayIndex;
}

export class DeskObjects {
  readonly group = new Group();
  objects: DeskObject[] = [];
  private holds: { obj: DeskObject; hand: HandState; pose: HeldPose }[] = [];
  private readonly tmp = new Vector3();
  private counter = 0;

  /** Lets mouse drags slide on a plane through the object (set by the host). */
  mousePlane: ((point: Vector3) => void) | null = null;
  mouseRelease: (() => void) | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly trash: TrashBin,
  ) {
    this.group.name = 'DeskObjects';
  }

  // ------------------------------------------------------------ making

  private pinButton(obj: () => DeskObject, radius: number): IconButton {
    const b = new IconButton({ id: `desk:pin:${(this.counter += 1)}`, icon: 'pin', label: 'Pinned: press to unlock and move', accent: '#ffc94d', radius });
    b.active = true;
    b.onPress = () => this.togglePin(obj());
    return b;
  }

  /**
   * Pin a clay print to the desk. `positions` are the sculpture's vertices,
   * `mesh` its scale, turn and lift in the holder; `world` the holder's pose.
   */
  addPrint(positions: Float32Array, color: string, mesh: [number, number, number], height: number, worldPos: Vector3, worldQuat: Quaternion, worldScale: number, pinned = true): DeskObject {
    const obj = this.buildPrint(positions, color, mesh, height);
    this.place(obj, worldPos, worldQuat, worldScale);
    obj.pinned = pinned;
    obj.pinButton.active = pinned;
    this.objects.push(obj);
    this.trim();
    this.save();
    return obj;
  }

  private buildPrint(positions: Float32Array, color: string, m: [number, number, number], height: number): DeskObject {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(clayFaces());
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const material = new MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
    const mesh = new Mesh(geometry, material);
    mesh.scale.setScalar(m[0]);
    mesh.rotation.y = m[1];
    mesh.position.y = m[2];
    mesh.frustumCulled = false;
    const holder = new Group();
    holder.add(mesh);
    const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * m[0];
    let obj!: DeskObject;
    const pin = this.pinButton(() => obj, 0.01);
    pin.group.position.set(0, 0.001, reach + 0.018);
    holder.add(pin.group);
    obj = {
      kind: 'print',
      holder,
      pinned: true,
      pinButton: pin,
      reach: Math.max(0.045, height * 0.6),
      center: (out) => holder.localToWorld(out.set(0, height / 2, 0)),
      data: { v: toBase64(positions), c: color, m, h: height },
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
      pop: 1,
    };
    return obj;
  }

  /** A photo print of a shot, popping out where it was framed, facing `facing`. */
  addPhotoFromShot(shot: Shot, at: Vector3, facing: Vector3, width: number): DeskObject | null {
    const canvas = this.readShot(shot);
    if (!canvas) return null;
    const obj = this.buildPhoto(canvas, width, canvas.toDataURL('image/jpeg', 0.82));
    this.desk().updateMatrixWorld(true);
    this.group.add(obj.holder);
    obj.holder.position.copy(this.group.worldToLocal(at.clone()));
    // Never below the desk top.
    obj.holder.position.y = Math.max(obj.holder.position.y, 0.06);
    // Face the viewer, upright.
    const look = this.group.worldToLocal(facing.clone());
    obj.holder.lookAt(this.group.localToWorld(look));
    obj.pinned = false;
    obj.pinButton.active = false;
    obj.pop = 0;
    this.objects.push(obj);
    this.trim();
    this.save();
    Sfx.whoosh(at);
    return obj;
  }

  private desk(): Group {
    return (this.group.parent as Group) ?? this.group;
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

  private buildPhoto(source: HTMLCanvasElement | HTMLImageElement, width: number, img: string): DeskObject {
    const height = (width * SHOT_H) / SHOT_W;
    const texture = new CanvasTexture(source as HTMLCanvasElement);
    // The pixels are as rendered into the shot (linear), like the storyboard cards.
    texture.colorSpace = NoColorSpace;
    const card = new Mesh(new BoxGeometry(width + 0.012, height + 0.02, 0.003), new MeshStandardMaterial({ color: '#f6f3ec', roughness: 0.7 }));
    const picture = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture }));
    picture.position.set(0, 0.004, 0.0017);
    const holder = new Group();
    holder.add(card, picture);
    let obj!: DeskObject;
    const pin = this.pinButton(() => obj, 0.008);
    // On the white margin, bottom right, facing out of the photo.
    pin.group.position.set(width / 2 - 0.01, -height / 2 - 0.004, 0.002);
    pin.group.rotation.x = Math.PI / 2;
    holder.add(pin.group);
    obj = {
      kind: 'photo',
      holder,
      pinned: false,
      pinButton: pin,
      reach: Math.max(0.05, width * 0.6),
      center: (out) => holder.getWorldPosition(out),
      data: { img, w: width },
      dispose: () => {
        texture.dispose();
        card.geometry.dispose();
        picture.geometry.dispose();
      },
      pop: 1,
    };
    return obj;
  }

  private place(obj: DeskObject, worldPos: Vector3, worldQuat: Quaternion, worldScale: number): void {
    this.group.updateMatrixWorld(true);
    this.group.add(obj.holder);
    obj.holder.position.copy(this.group.worldToLocal(worldPos.clone()));
    const parentQ = this.group.getWorldQuaternion(obj.holder.quaternion.clone()).invert();
    obj.holder.quaternion.copy(worldQuat).premultiply(parentQ);
    obj.holder.scale.setScalar(worldScale);
  }

  /** Keep the counts sensible: the oldest unpinned things go first. */
  private trim(): void {
    for (const [kind, max] of [['photo', MAX_PHOTOS], ['print', MAX_PRINTS]] as const) {
      while (this.objects.filter((o) => o.kind === kind).length > max) {
        const victim = this.objects.find((o) => o.kind === kind && !o.pinned) ?? this.objects.find((o) => o.kind === kind)!;
        this.remove(victim);
      }
    }
  }

  remove(obj: DeskObject): void {
    this.objects = this.objects.filter((o) => o !== obj);
    this.holds = this.holds.filter((h) => h.obj !== obj);
    obj.holder.removeFromParent();
    obj.dispose();
    this.save();
  }

  togglePin(obj: DeskObject): void {
    obj.pinned = !obj.pinned;
    obj.pinButton.active = obj.pinned;
    obj.pinButton.label = obj.pinned ? 'Pinned: press to unlock and move' : 'Unlocked: grab to move, press to pin';
    this.holds = this.holds.filter((h) => h.obj !== obj);
    Sfx.blip(obj.pinned ? 900 : 600);
    this.save();
  }

  // ------------------------------------------------------------ hands

  /** True if this hand is carrying a desk object. */
  owns(hand: HandState): boolean {
    return this.holds.some((h) => h.hand === hand);
  }

  update(pointers: readonly HandState[], dt: number): void {
    for (const obj of this.objects) {
      if (obj.pop < 1) {
        obj.pop = Math.min(1, obj.pop + dt * 4);
        obj.holder.scale.setScalar(0.3 + 0.7 * (1 - (1 - obj.pop) ** 3));
      }
    }
    if (!this.group.visible) return;
    // Pick up: unlocked objects only.
    for (const hand of pointers) {
      if (!hand.tracked || !hand.grabStarted || this.owns(hand)) continue;
      let best: DeskObject | null = null;
      let bestD = Infinity;
      for (const obj of this.objects) {
        if (obj.pinned) continue;
        const d = grabDistance(hand, obj.center(this.tmp));
        if (d < obj.reach && d < bestD) {
          best = obj;
          bestD = d;
        }
      }
      if (!best) continue;
      if (hand.isMouse && this.mousePlane) {
        const at = best.holder.getWorldPosition(new Vector3());
        this.mousePlane(at);
        hand.pinchPoint.copy(at);
        hand.grabPoint.copy(at);
      }
      const pose = new HeldPose();
      pose.begin(hand, best.holder);
      this.holds.push({ obj: best, hand, pose });
      hand.clearEdges();
      Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
    }
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
      Sfx.place(h.obj.holder.getWorldPosition(this.tmp));
      this.save();
    }
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
        if (s.k === 'print' && s.v && s.m && s.c) {
          const obj = this.buildPrint(fromBase64(s.v), s.c, s.m, s.h ?? 0.1);
          this.restore(obj, s);
        } else if (s.k === 'photo' && s.img) {
          const image = new Image();
          const obj = this.buildPhoto(document.createElement('canvas'), s.w ?? 0.12, s.img);
          image.onload = () => {
            // A fresh texture: an uploaded one cannot change size in place.
            const material = (obj.holder.children[1] as Mesh).material as MeshBasicMaterial;
            const old = material.map;
            const tex = new Texture(image);
            tex.colorSpace = NoColorSpace;
            tex.needsUpdate = true;
            material.map = tex;
            material.needsUpdate = true;
            old?.dispose();
          };
          image.src = s.img;
          this.restore(obj, s);
        }
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
    obj.pinButton.active = s.pinned;
    obj.pinButton.label = s.pinned ? 'Pinned: press to unlock and move' : 'Unlocked: grab to move, press to pin';
    this.objects.push(obj);
  }

  debug(): { kind: Kind; pinned: boolean; pos: number[] }[] {
    return this.objects.map((o) => ({ kind: o.kind, pinned: o.pinned, pos: o.holder.position.toArray().map((v) => +v.toFixed(3)) }));
  }
}
