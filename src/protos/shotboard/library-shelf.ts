/**
 * The library shelf beside Shot Board's stage: small copies of everything in
 * the library (your saved things first, then ready-made props), six to a
 * page. Grab one (thumb + middle) to pull a full-size copy out; drop it on
 * the stage to add it to the scene.
 */

import { Box3, CanvasTexture, CircleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, PlaneGeometry, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { grabDistance, type HandState } from '../../core/hands.js';
import { IconButton } from '../../core/icon-button.js';

export interface ShelfEntry {
  /** Library item id, or `preset:<name>`. */
  id: string;
  name: string;
  /** Builds a fresh copy (null if it cannot be rebuilt). */
  make(): Object3D | null;
  /** True for things you saved (not ready-made props). */
  mine: boolean;
}

const PER_PAGE = 6;
const SLOT = 0.05;
const MINI = 0.034;

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

export class LibraryShelf {
  readonly group = new Group();
  private entries: ShelfEntry[] = [];
  private page = 0;
  private slots: { entry: ShelfEntry; mini: Group; pad: Mesh }[] = [];
  private readonly prev: IconButton;
  private readonly next: IconButton;
  private readonly label: Mesh;
  private readonly labelCanvas = document.createElement('canvas');
  private readonly labelTexture: CanvasTexture;
  private readonly padGeo = new CircleGeometry(SLOT * 0.45, 28);
  private readonly padMat: MeshStandardMaterial;
  private readonly mineMat: MeshStandardMaterial;
  private readonly tmp = new Vector3();

  constructor(accent: string) {
    this.group.name = 'LibraryShelf';
    this.padMat = new MeshStandardMaterial({ color: '#2f343e', roughness: 0.8 });
    this.mineMat = new MeshStandardMaterial({ color: accent, roughness: 0.6, emissive: accent, emissiveIntensity: 0.15 });
    const tray = new Mesh(new PlaneGeometry(SLOT * 2 + 0.02, SLOT * 3 + 0.05), new MeshBasicMaterial({ color: '#1d2027', transparent: true, opacity: 0.75 }));
    tray.rotation.x = -Math.PI / 2;
    tray.position.set(0, 0.0005, 0.005);
    tray.userData.hideInShots = true;
    this.group.add(tray);
    this.labelCanvas.width = 256;
    this.labelCanvas.height = 48;
    this.labelTexture = new CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = SRGBColorSpace;
    this.label = new Mesh(new PlaneGeometry(0.1, 0.019), new MeshBasicMaterial({ map: this.labelTexture, transparent: true }));
    this.label.rotation.x = -Math.PI / 2;
    this.label.position.set(0, 0.001, -SLOT * 1.5 - 0.012);
    this.group.add(this.label);
    this.prev = new IconButton({ id: 'library:prev', icon: 'minus', label: 'Previous page', accent, radius: 0.011 });
    this.next = new IconButton({ id: 'library:next', icon: 'plus', label: 'Next page', accent, radius: 0.011 });
    this.prev.group.position.set(-0.03, 0.001, SLOT * 1.5 + 0.018);
    this.next.group.position.set(0.03, 0.001, SLOT * 1.5 + 0.018);
    this.prev.onPress = () => this.turn(-1);
    this.next.onPress = () => this.turn(1);
    this.group.add(this.prev.group, this.next.group);
  }

  get pages(): number {
    return Math.max(1, Math.ceil(this.entries.length / PER_PAGE));
  }

  setEntries(entries: ShelfEntry[]): void {
    this.entries = entries;
    this.page = Math.min(this.page, this.pages - 1);
    this.build();
  }

  private turn(d: number): void {
    this.page = (this.page + d + this.pages) % this.pages;
    this.build();
  }

  /** Lay out the minis for this page. */
  private build(): void {
    for (const s of this.slots) {
      this.group.remove(s.mini, s.pad);
      disposeTree(s.mini);
    }
    this.slots = [];
    const page = this.entries.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE);
    page.forEach((entry, i) => {
      const object = entry.make();
      if (!object) return;
      const mini = fitTo(object, MINI);
      const x = (i % 2 === 0 ? -1 : 1) * SLOT * 0.5;
      const z = (Math.floor(i / 2) - 1) * SLOT;
      mini.position.set(x, 0.002, z);
      const pad = new Mesh(this.padGeo, entry.mine ? this.mineMat : this.padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(x, 0.001, z);
      pad.userData.hideInShots = true;
      this.group.add(pad, mini);
      this.slots.push({ entry, mini, pad });
    });
    const c = this.labelCanvas.getContext('2d')!;
    c.clearRect(0, 0, 256, 48);
    c.fillStyle = '#f4f5f7';
    c.font = '700 30px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`Library ${this.page + 1}/${this.pages}`, 128, 25);
    this.labelTexture.needsUpdate = true;
    this.prev.disabled = this.next.disabled = this.pages < 2;
  }

  /** The entry a grab at this hand would pull out, if any. */
  pick(hand: HandState): ShelfEntry | null {
    let best: ShelfEntry | null = null;
    let bestD = 0.03;
    for (const s of this.slots) {
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

  /** World position of a slot on this page (tests). */
  slotWorld(i: number): Vector3 | null {
    const s = this.slots[i];
    return s ? s.mini.getWorldPosition(new Vector3()).add(new Vector3(0, 0.012, 0)) : null;
  }

  debug(): { page: number; pages: number; names: string[] } {
    return { page: this.page, pages: this.pages, names: this.slots.map((s) => s.entry.name) };
  }
}
