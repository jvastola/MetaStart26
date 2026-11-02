/**
 * The library shelf beside Shot Board's stage: small copies of everything in
 * the library (your saved things first, then ready-made props) in one long
 * column, two across, that scrolls.
 *
 *   - Pinch (thumb + index) on the shelf and slide toward or away from you to
 *     scroll; let go mid-slide and it glides on. With a mouse, drag empty
 *     shelf space or use the wheel while pointing at it.
 *   - Grab (thumb + middle) a thing to pull a full-size copy out; drop it on
 *     the stage to add it to the scene.
 *
 * Things fade out toward the ends of the shelf; a bar on the side shows
 * where you are in the list.
 */

import { Box3, CanvasTexture, CircleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, PlaneGeometry, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { grabDistance, type HandState } from '../../core/hands.js';

export interface ShelfEntry {
  /** Library item id, or `preset:<name>`. */
  id: string;
  name: string;
  /** Builds a fresh copy (null if it cannot be rebuilt). */
  make(): Object3D | null;
  /** True for things you saved (not ready-made props). */
  mine: boolean;
}

const ROW = 0.05;
const COL = 0.05;
const MINI = 0.034;
/** Rows fully in view; the shelf is a little longer so the ends can fade. */
const VIEW_ROWS = 3;
const HALF = (VIEW_ROWS / 2) * ROW;
const TRAY_W = COL * 2 + 0.02;
const TRAY_D = VIEW_ROWS * ROW + 0.03;

/** Wrap an object so it stands on y = 0, centred, with its largest side `size`. */
export function fitTo(object: Object3D, size: number): Group {
  const box = new Box3().setFromObject(object);
  const dims = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const inner = new Group();
  inner.add(object);
  object.position.sub(new Vector3(center.x, box.min.y, center.z));
  const outer = new Group();
  outer.add(inner);
  outer.scale.setScalar(size / Math.max(dims.x, dims.y, dims.z, 1e-4));
  return outer;
}

function disposeTree(o: Object3D): void {
  o.traverse((x) => {
    const m = x as Mesh;
    if (m.isMesh) m.geometry?.dispose();
  });
}

interface Slot {
  entry: ShelfEntry;
  mini: Group;
  pad: Mesh;
  /** 0..1: how much it shows (fades at the ends). */
  show: number;
}

export class LibraryShelf {
  readonly group = new Group();
  private entries: ShelfEntry[] = [];
  private slots: Slot[] = [];
  /** Metres scrolled down the list. */
  private scroll = 0;
  private velocity = 0;
  private drag: { hand: HandState; z0: number; scroll0: number; lastZ: number } | null = null;
  private hovered = false;
  private readonly tray: Mesh;
  private readonly bar: Mesh;
  private readonly thumb: Mesh;
  private readonly label: Mesh;
  private readonly labelCanvas = document.createElement('canvas');
  private readonly labelTexture: CanvasTexture;
  private readonly padGeo = new CircleGeometry(COL * 0.45, 28);
  private readonly padMat: MeshStandardMaterial;
  private readonly mineMat: MeshStandardMaterial;
  private readonly tmp = new Vector3();
  private readonly local = new Vector3();

  constructor(accent: string) {
    this.group.name = 'LibraryShelf';
    this.padMat = new MeshStandardMaterial({ color: '#2f343e', roughness: 0.8 });
    this.mineMat = new MeshStandardMaterial({ color: accent, roughness: 0.6, emissive: accent, emissiveIntensity: 0.15 });
    this.tray = new Mesh(new PlaneGeometry(TRAY_W, TRAY_D), new MeshBasicMaterial({ color: '#1d2027', transparent: true, opacity: 0.75 }));
    this.tray.rotation.x = -Math.PI / 2;
    this.tray.position.y = 0.0005;
    this.tray.userData.hideInShots = true;
    this.bar = new Mesh(new PlaneGeometry(0.003, TRAY_D - 0.02), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.15 }));
    this.bar.rotation.x = -Math.PI / 2;
    this.bar.position.set(TRAY_W / 2 - 0.004, 0.0008, 0);
    this.thumb = new Mesh(new PlaneGeometry(0.004, 1), new MeshBasicMaterial({ color: accent }));
    this.thumb.rotation.x = -Math.PI / 2;
    this.thumb.position.set(TRAY_W / 2 - 0.004, 0.001, 0);
    this.labelCanvas.width = 256;
    this.labelCanvas.height = 48;
    this.labelTexture = new CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = SRGBColorSpace;
    this.label = new Mesh(new PlaneGeometry(0.1, 0.019), new MeshBasicMaterial({ map: this.labelTexture, transparent: true }));
    this.label.rotation.x = -Math.PI / 2;
    this.label.position.set(0, 0.001, -TRAY_D / 2 - 0.012);
    this.group.add(this.tray, this.bar, this.thumb, this.label);
    // Desktop: the wheel scrolls while the cursor is over the shelf.
    window.addEventListener('wheel', (e) => {
      if (!this.hovered || !this.group.visible) return;
      this.velocity = 0;
      this.scrollTo(this.scroll + e.deltaY * 0.0003);
    });
  }

  /** True while a hand is scrolling the shelf. */
  get scrolling(): boolean {
    return this.drag != null;
  }

  get maxScroll(): number {
    return Math.max(0, (Math.ceil(this.entries.length / 2) - VIEW_ROWS) * ROW);
  }

  setEntries(entries: ShelfEntry[]): void {
    this.entries = entries;
    for (const s of this.slots) {
      this.group.remove(s.mini, s.pad);
      disposeTree(s.mini);
    }
    this.slots = [];
    entries.forEach((entry) => {
      const object = entry.make();
      if (!object) return;
      const mini = fitTo(object, MINI);
      const pad = new Mesh(this.padGeo, entry.mine ? this.mineMat : this.padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.userData.hideInShots = true;
      this.group.add(pad, mini);
      this.slots.push({ entry, mini, pad, show: 1 });
    });
    const c = this.labelCanvas.getContext('2d')!;
    c.clearRect(0, 0, 256, 48);
    c.fillStyle = '#f4f5f7';
    c.font = '700 30px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`Library (${this.slots.length})`, 128, 25);
    this.labelTexture.needsUpdate = true;
    this.scrollTo(this.scroll);
  }

  scrollTo(value: number): void {
    this.scroll = Math.min(this.maxScroll, Math.max(0, value));
    this.layout();
  }

  /** Place every mini for the current scroll; fade the ones near the ends. */
  private layout(): void {
    this.slots.forEach((s, i) => {
      const x = (i % 2 === 0 ? -1 : 1) * COL * 0.5 - 0.003;
      const z = -HALF + ROW / 2 + Math.floor(i / 2) * ROW - this.scroll;
      // Full inside the view, shrinking to nothing just past its ends.
      const over = Math.abs(z) - (HALF - ROW / 2);
      s.show = over <= 0 ? 1 : Math.max(0, 1 - over / (ROW * 0.6));
      const on = s.show > 0.05;
      s.mini.visible = s.pad.visible = on;
      if (!on) return;
      s.mini.position.set(x, 0.002, z);
      s.mini.scale.setScalar((s.mini.userData.base ??= s.mini.scale.x) * s.show);
      s.pad.position.set(x, 0.001, z);
      s.pad.scale.setScalar(s.show);
    });
    // Scroll bar: thumb length is the share of the list in view.
    const rows = Math.max(1, Math.ceil(this.entries.length / 2));
    const track = TRAY_D - 0.02;
    const len = Math.min(1, VIEW_ROWS / rows) * track;
    this.thumb.scale.y = len;
    const t = this.maxScroll > 0 ? this.scroll / this.maxScroll : 0;
    this.thumb.position.z = -track / 2 + len / 2 + t * (track - len);
    this.thumb.visible = this.bar.visible = rows > VIEW_ROWS;
  }

  /** A pointer's position on the shelf (shelf-local), or null if it is not over it. */
  private onTray(hand: HandState): Vector3 | null {
    this.group.updateWorldMatrix(true, false);
    if (hand.isMouse) {
      // Where the cursor's ray meets the shelf plane.
      const o = this.group.worldToLocal(this.local.copy(hand.rayOrigin));
      const e = this.group.worldToLocal(this.tmp.copy(hand.rayOrigin).add(hand.rayDir));
      const dy = e.y - o.y;
      if (Math.abs(dy) < 1e-6) return null;
      const t = -o.y / dy;
      if (t <= 0) return null;
      o.lerp(e, t);
      o.y = 0;
    } else this.group.worldToLocal(this.local.copy(hand.pinchPoint));
    const p = this.local;
    return Math.abs(p.x) < TRAY_W / 2 + 0.01 && Math.abs(p.z) < TRAY_D / 2 + 0.01 && p.y > -0.02 && p.y < 0.06 ? p : null;
  }

  /** Scrolling: pinch and slide (or click and drag empty shelf). Run after pulls are handled. */
  update(pointers: readonly HandState[], dt: number): void {
    this.hovered = pointers.some((h) => h.isMouse && h.tracked && this.onTray(h) != null);
    if (this.drag) {
      const { hand } = this.drag;
      const p = hand.tracked && hand.pinching ? this.onTray(hand) ?? this.groupLocal(hand) : null;
      if (!p) {
        this.drag = null;
      } else {
        // The list follows the finger.
        const z = p.z;
        this.velocity = (this.drag.lastZ - z) / Math.max(dt, 1e-3);
        this.drag.lastZ = z;
        this.scrollTo(this.drag.scroll0 + (this.drag.z0 - z));
        return;
      }
    }
    for (const hand of pointers) {
      if (!hand.tracked || !hand.pinchStarted) continue;
      const p = this.onTray(hand);
      if (!p) continue;
      this.drag = { hand, z0: p.z, scroll0: this.scroll, lastZ: p.z };
      this.velocity = 0;
      hand.clearEdges();
      return;
    }
    // Glide after a flick, slowing down.
    if (Math.abs(this.velocity) > 0.005) {
      this.scrollTo(this.scroll + this.velocity * dt);
      this.velocity *= Math.exp(-dt * 4);
      if (this.scroll <= 0 || this.scroll >= this.maxScroll) this.velocity = 0;
    } else this.velocity = 0;
  }

  /** A pinching hand's position in shelf space even once it slides off the end. */
  private groupLocal(hand: HandState): Vector3 | null {
    if (hand.isMouse) return null;
    return this.group.worldToLocal(this.local.copy(hand.pinchPoint));
  }

  /** The entry a grab at this hand would pull out, if any (only things in view). */
  pick(hand: HandState): ShelfEntry | null {
    let best: ShelfEntry | null = null;
    // The cursor needs to be on the thing; a hand gets a little more room.
    let bestD = hand.isMouse ? 0.016 : 0.03;
    for (const s of this.slots) {
      if (s.show < 0.5) continue;
      s.mini.getWorldPosition(this.tmp);
      this.tmp.y += 0.012;
      const d = grabDistance(hand, this.tmp);
      if (d < bestD) {
        bestD = d;
        best = s.entry;
      }
    }
    return best;
  }

  /** World position of an entry's mini (tests). */
  slotWorld(i: number): Vector3 | null {
    const s = this.slots[i];
    return s ? s.mini.getWorldPosition(new Vector3()).add(new Vector3(0, 0.012, 0)) : null;
  }

  /** World position of a point on the tray, shelf-local x/z (tests). */
  trayWorld(x: number, z: number): Vector3 {
    this.group.updateWorldMatrix(true, false);
    return this.group.localToWorld(new Vector3(x, 0.002, z));
  }

  debug(): { scroll: number; maxScroll: number; total: number; inView: string[] } {
    return {
      scroll: +this.scroll.toFixed(4),
      maxScroll: +this.maxScroll.toFixed(4),
      total: this.slots.length,
      inView: this.slots.filter((s) => s.show >= 0.5).map((s) => s.entry.name),
    };
  }
}
