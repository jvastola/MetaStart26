/**
 * A colour wheel you pinch: drag around the ring for hue, inside the square
 * for saturation (left to right) and brightness (bottom to top). A fingertip
 * touching the surface works too, and so does the mouse. Recent colours sit
 * in a row underneath for one-poke reuse.
 */

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { hexToHsv, type Hsv, hsvToHex, RING_IN, SQUARE, wheelHit } from './color.js';
import type { HandState } from './hands.js';
import { roundRect } from './panel.js';
import { Sfx } from './sfx.js';

const PX = 512;
const ROW = 96;
const RECENT = 6;
/** Fingertip within this depth of the surface counts as touching it. */
const TOUCH_FRONT = 0.006;
const TOUCH_BACK = -0.025;

export class ColorWheel {
  readonly mesh: Mesh;
  onChange: (hex: string) => void = () => {};
  private hsv: Hsv;
  private recent: string[] = [];
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly ring = document.createElement('canvas');
  private drag: { pointer: HandState; part: 'ring' | 'square'; via: 'pinch' | 'touch' } | null = null;
  private lastTick = 0;
  private dirty = true;
  private readonly local = new Vector3();

  constructor(
    private readonly size = 0.15,
    initial = '#7fe0b5',
  ) {
    this.hsv = hexToHsv(initial);
    this.canvas.width = PX;
    this.canvas.height = PX + ROW;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(size, (size * (PX + ROW)) / PX),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false }),
    );
    this.mesh.name = 'ColorWheel';
    this.mesh.renderOrder = 10;
    this.drawRing();
    this.redraw();
  }

  get hex(): string {
    return hsvToHex(this.hsv);
  }

  set(hex: string): void {
    this.hsv = hexToHsv(hex);
    this.dirty = true;
  }

  /** Pick a recent colour by index (microgesture shortcut). */
  cycleRecent(step: number): void {
    if (this.recent.length === 0) return;
    const i = Math.max(0, this.recent.indexOf(this.hex));
    this.choose(this.recent[(i + step + this.recent.length) % this.recent.length]);
  }

  /** True while a pointer is dragging on the wheel (the app should not draw then). */
  get active(): boolean {
    return this.drag != null;
  }

  update(pointers: readonly HandState[]): void {
    this.mesh.updateMatrixWorld(true);
    if (this.drag) {
      const p = this.drag.pointer;
      // A pinch-drag ends when the pinch opens; a touch-drag when the finger lifts off.
      const still = this.drag.via === 'pinch' ? p.pinching : this.touching(p);
      if (!still || !p.tracked) {
        this.remember(this.hex);
        this.drag = null;
      } else {
        const uv = this.uv(p);
        if (uv) this.apply(wheelHit(uv.x, uv.y, this.drag.part));
      }
    } else {
      for (const p of pointers) {
        if (!p.tracked) continue;
        const starting = p.isMouse ? p.pinchStarted : p.pinchStarted || this.touching(p);
        if (!starting) continue;
        const uv = this.uv(p);
        if (!uv) continue;
        if (uv.row != null) {
          const hex = this.recent[uv.row];
          if (hex && (p.pinchStarted || p.isMouse)) this.choose(hex);
          continue;
        }
        const hit = wheelHit(uv.x, uv.y);
        if (!hit) continue;
        this.drag = { pointer: p, part: hit.part, via: p.isMouse || p.pinchStarted ? 'pinch' : 'touch' };
        Sfx.pinch(p.isMouse ? undefined : p.pinchPoint);
        this.apply(hit);
        break;
      }
    }
    if (this.dirty) this.redraw();
  }

  private touching(p: HandState): boolean {
    if (p.isMouse) return false;
    this.local.copy(p.indexTip);
    const z = this.mesh.worldToLocal(this.local).z;
    return z < TOUCH_FRONT && z > TOUCH_BACK;
  }

  /**
   * Pointer position on the wheel in normalised units (radius 1, y up), or
   * the index of a recent-colour swatch when over that row.
   */
  private uv(p: HandState): { x: number; y: number; row?: number } | null {
    let lx: number;
    let ly: number;
    if (p.isMouse) {
      const o = this.mesh.worldToLocal(this.local.copy(p.rayOrigin)).clone();
      const d = this.mesh.worldToLocal(this.local.copy(p.rayOrigin).add(p.rayDir)).sub(o);
      if (Math.abs(d.z) < 1e-6) return null;
      const t = -o.z / d.z;
      if (t < 0) return null;
      lx = o.x + d.x * t;
      ly = o.y + d.y * t;
    } else {
      const src = p.pinching || p.pinchStarted ? p.pinchPoint : p.indexTip;
      const q = this.mesh.worldToLocal(this.local.copy(src));
      if (Math.abs(q.z) > 0.04) return null;
      lx = q.x;
      ly = q.y;
    }
    // Plane coordinates: the wheel is the top square, the swatch row below.
    const halfH = (this.size * (PX + ROW)) / PX / 2;
    const px = (lx / this.size + 0.5) * PX;
    const py = (halfH - ly) / (this.size / PX);
    if (px < 0 || px > PX || py < 0 || py > PX + ROW) return null;
    if (py > PX) return { x: 0, y: 0, row: Math.floor((px / PX) * RECENT) };
    return { x: (px - PX / 2) / (PX / 2), y: (PX / 2 - py) / (PX / 2) };
  }

  private apply(hit: ReturnType<typeof wheelHit>): void {
    if (!hit) return;
    if (hit.part === 'ring') {
      if (Math.abs(hit.h - this.lastTick) > 30) {
        this.lastTick = hit.h;
        Sfx.blip(500 + hit.h);
      }
      this.hsv = { ...this.hsv, h: hit.h, s: this.hsv.s < 0.05 ? 0.8 : this.hsv.s, v: this.hsv.v < 0.05 ? 0.9 : this.hsv.v };
    } else {
      this.hsv = { ...this.hsv, s: hit.s, v: hit.v };
    }
    this.dirty = true;
    this.onChange(this.hex);
  }

  private choose(hex: string): void {
    this.hsv = hexToHsv(hex);
    this.dirty = true;
    Sfx.blip(800);
    this.onChange(this.hex);
  }

  private remember(hex: string): void {
    this.recent = [hex, ...this.recent.filter((h) => h !== hex)].slice(0, RECENT);
    this.dirty = true;
  }

  /** The hue ring never changes, so draw it once. */
  private drawRing(): void {
    this.ring.width = this.ring.height = PX;
    const c = this.ring.getContext('2d')!;
    const mid = PX / 2;
    for (let deg = 0; deg < 360; deg += 1) {
      // Hue h sits at angle h counter-clockwise from +x; canvas angles run clockwise.
      c.beginPath();
      c.arc(mid, mid, mid - 4, (-(deg + 1.2) * Math.PI) / 180, (-deg * Math.PI) / 180);
      c.arc(mid, mid, (mid - 4) * RING_IN, (-deg * Math.PI) / 180, (-(deg + 1.2) * Math.PI) / 180, true);
      c.closePath();
      c.fillStyle = `hsl(${deg} 100% 50%)`;
      c.fill();
    }
  }

  private redraw(): void {
    this.dirty = false;
    const c = this.canvas.getContext('2d')!;
    const mid = PX / 2;
    const r = mid - 4;
    c.clearRect(0, 0, PX, PX + ROW);
    // Backing disc so the wheel reads against any room.
    c.beginPath();
    c.arc(mid, mid, mid, 0, Math.PI * 2);
    c.fillStyle = 'rgba(20,22,27,0.92)';
    c.fill();
    c.drawImage(this.ring, 0, 0);
    // Saturation/value square for the current hue.
    const sq = r * SQUARE;
    const x0 = mid - sq;
    const y0 = mid - sq;
    c.fillStyle = `hsl(${this.hsv.h} 100% 50%)`;
    c.fillRect(x0, y0, sq * 2, sq * 2);
    const white = c.createLinearGradient(x0, 0, x0 + sq * 2, 0);
    white.addColorStop(0, '#ffffff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = white;
    c.fillRect(x0, y0, sq * 2, sq * 2);
    const black = c.createLinearGradient(0, y0, 0, y0 + sq * 2);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000000');
    c.fillStyle = black;
    c.fillRect(x0, y0, sq * 2, sq * 2);
    // Markers.
    const a = (this.hsv.h * Math.PI) / 180;
    const rr = (r * (1 + RING_IN)) / 2;
    marker(c, mid + Math.cos(a) * rr, mid - Math.sin(a) * rr, 16);
    marker(c, x0 + this.hsv.s * sq * 2, y0 + (1 - this.hsv.v) * sq * 2, 14);
    // Current colour in the middle-bottom gap, recent colours underneath.
    c.beginPath();
    c.arc(mid, mid + sq + (r * RING_IN - sq) / 2, (r * RING_IN - sq) * 0.38, 0, Math.PI * 2);
    c.fillStyle = this.hex;
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = '#ffffff';
    c.stroke();
    const w = PX / RECENT;
    for (let i = 0; i < RECENT; i += 1) {
      roundRect(c, i * w + 8, PX + 12, w - 16, ROW - 24, 18);
      c.fillStyle = this.recent[i] ?? 'rgba(255,255,255,0.08)';
      c.fill();
      if (this.recent[i] === this.hex) {
        c.lineWidth = 5;
        c.strokeStyle = '#ffffff';
        c.stroke();
      }
    }
    this.texture.needsUpdate = true;
  }

  debug(): { hex: string; recent: string[]; dragging: boolean } {
    return { hex: this.hex, recent: [...this.recent], dragging: this.drag != null };
  }

  /** World position of a wheel point (normalised x, y) for tests. */
  worldAt(x: number, y: number): Vector3 {
    const halfH = (this.size * (PX + ROW)) / PX / 2;
    const lx = (x * this.size) / 2;
    const ly = halfH - ((PX / 2 - (y * PX) / 2) * this.size) / PX;
    this.mesh.updateMatrixWorld(true);
    return this.mesh.localToWorld(new Vector3(lx, ly, 0));
  }
}

function marker(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.lineWidth = 6;
  c.strokeStyle = '#ffffff';
  c.stroke();
  c.lineWidth = 2;
  c.strokeStyle = '#000000';
  c.stroke();
}
