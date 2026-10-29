/**
 * A flat UI panel drawn with Canvas 2D and pressed directly with your hands.
 *
 * Seated, within-reach UI works best as direct touch, so buttons respond to:
 *   - a fingertip poke (the index tip crossing the panel surface),
 *   - a pinch made on top of the button,
 *   - a mouse click (desktop preview).
 * Panels face +Z. Keep them inside a narrow cone in front of the user so they
 * also fit the smaller field of view of Meta VR Glasses.
 */

import {
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import type { HandState } from './hands.js';
import { Sfx } from './sfx.js';

export type Tone = 'default' | 'primary' | 'danger' | 'active';

export interface PanelButton {
  id: string;
  label: string;
  tone?: Tone;
  /** Optional second line under the label. */
  sub?: string;
  disabled?: boolean;
  /** Colour stripe on the button's left edge. */
  accent?: string;
  /** How many grid columns the button spans (default 1). */
  span?: number;
}

export interface PanelOptions {
  width: number;
  height: number;
  /** Canvas pixels per metre. */
  ppm?: number;
  columns?: number;
  /** Height of one button row in metres. */
  buttonHeight?: number;
  accent?: string;
  /** Seconds before the panel accepts another press (lower for keyboards). */
  pressCooldown?: number;
}

export const THEME = {
  bg: 'rgba(20, 22, 27, 0.92)',
  border: 'rgba(255, 255, 255, 0.14)',
  text: '#f4f5f7',
  dim: '#aeb3bd',
  accent: '#7fe0b5',
  button: '#2b2f38',
  buttonHover: '#3a404c',
  primary: '#2f7d5d',
  danger: '#8a3434',
  active: '#3a5fa8',
};

const POKE_DEPTH = 0.004;
const HOVER_DEPTH = 0.05;
const PRESS_COOLDOWN = 0.35;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CanvasPanel {
  /** Every panel, so tests can find a button by id. */
  static readonly all: CanvasPanel[] = [];
  readonly mesh: Mesh;
  eyebrow = '';
  title = '';
  body: string[] = [];
  onPress: (id: string) => void = () => {};
  /** Optional custom drawing in the free area between text and buttons. */
  drawExtra: ((ctx: CanvasRenderingContext2D, area: Rect) => void) | null = null;

  private buttons: PanelButton[] = [];
  private rects: Rect[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly opts: Required<PanelOptions>;
  private readonly w: number;
  private readonly h: number;
  private dirty = true;
  private hover = -1;
  private flash = -1;
  private flashTime = 0;
  private cooldown = 0;
  private lastPressed = -1;
  private readonly lastDepth = { left: 1, right: 1 };
  private readonly local = new Vector3();

  constructor(options: PanelOptions) {
    this.opts = {
      ppm: 1600,
      columns: 3,
      buttonHeight: 0.04,
      accent: THEME.accent,
      pressCooldown: PRESS_COOLDOWN,
      ...options,
    };
    this.w = Math.round(this.opts.width * this.opts.ppm);
    this.h = Math.round(this.opts.height * this.opts.ppm);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    const material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(this.opts.width, this.opts.height), material);
    this.mesh.renderOrder = 10;
    CanvasPanel.all.push(this);
  }

  /** World-space centre of a button, for automated pokes. Null if absent. */
  buttonWorld(id: string): Vector3 | null {
    const index = this.buttons.findIndex((b) => b.id === id);
    if (index < 0 || !isVisible(this.mesh)) return null;
    if (this.dirty) this.redraw();
    const r = this.rects[index];
    const x = ((r.x + r.w / 2) / this.w - 0.5) * this.opts.width;
    const y = (0.5 - (r.y + r.h / 2) / this.h) * this.opts.height;
    this.mesh.updateMatrixWorld(true);
    return this.mesh.localToWorld(new Vector3(x, y, 0));
  }

  /** The panel's facing direction in world space. */
  normalWorld(): Vector3 {
    this.mesh.updateMatrixWorld(true);
    return new Vector3(0, 0, 1).transformDirection(this.mesh.matrixWorld);
  }

  setText(eyebrow: string, title: string, body: string | string[]): void {
    const lines = Array.isArray(body) ? body : [body];
    if (eyebrow === this.eyebrow && title === this.title && lines.join('\n') === this.body.join('\n')) return;
    this.eyebrow = eyebrow;
    this.title = title;
    this.body = lines;
    this.dirty = true;
  }

  setButtons(buttons: PanelButton[]): void {
    const same =
      buttons.length === this.buttons.length &&
      buttons.every((b, i) => {
        const o = this.buttons[i];
        return o.id === b.id && o.label === b.label && o.tone === b.tone && o.sub === b.sub && o.disabled === b.disabled && o.accent === b.accent && o.span === b.span;
      });
    if (same) return;
    this.buttons = buttons;
    this.hover = -1;
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  get buttonIds(): string[] {
    return this.buttons.map((b) => b.id);
  }

  /** Programmatic press, used by tests and microgesture shortcuts. */
  press(id: string): void {
    const index = this.buttons.findIndex((b) => b.id === id);
    if (index < 0 || this.buttons[index].disabled) return;
    this.flash = index;
    this.flashTime = 0.2;
    this.dirty = true;
    this.mesh.getWorldPosition(this.local);
    Sfx.click(this.local);
    this.onPress(id);
  }

  update(pointers: readonly HandState[], dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) {
        this.flash = -1;
        this.dirty = true;
      }
    }
    if (!this.mesh.visible || !isVisible(this.mesh)) {
      if (this.dirty) this.redraw();
      return;
    }
    this.mesh.updateMatrixWorld();
    let hover = -1;
    for (const p of pointers) {
      if (!p.tracked) continue;
      if (p.isMouse) {
        const hit = this.rayHit(p.rayOrigin, p.rayDir);
        if (hit >= 0) {
          hover = hit;
          if (p.pinchStarted) this.tryPress(hit);
        }
        continue;
      }
      // Poke with the index fingertip.
      const tip = this.toLocal(p.indexTip);
      const inside = this.buttonAt(tip.x, tip.y);
      const depth = tip.z;
      const last = this.lastDepth[p.side];
      this.lastDepth[p.side] = depth;
      if (inside >= 0 && depth < HOVER_DEPTH && depth > -0.03) hover = inside;
      if (inside >= 0 && last > POKE_DEPTH && depth <= POKE_DEPTH && depth > -0.03) {
        this.tryPress(inside);
      }
      // Or pinch on the button.
      if (p.pinchStarted) {
        const q = this.toLocal(p.pinchPoint);
        if (Math.abs(q.z) < 0.035) {
          const b = this.buttonAt(q.x, q.y);
          if (b >= 0) this.tryPress(b);
        }
      }
    }
    if (hover !== this.hover) {
      if (hover >= 0 && pointers.some((p) => p.tracked && !p.isMouse)) {
        this.mesh.getWorldPosition(this.local);
        Sfx.hover(this.local);
      }
      this.hover = hover;
      this.dirty = true;
    }
    if (this.dirty) this.redraw();
  }

  /** True if a world point (e.g. a pinch) is over the panel face. */
  contains(world: Vector3, depth = 0.04): boolean {
    const q = this.toLocal(world);
    return Math.abs(q.z) < depth && Math.abs(q.x) < this.opts.width / 2 && Math.abs(q.y) < this.opts.height / 2;
  }

  private tryPress(index: number): void {
    // Debounce per button: a different button can be pressed right away.
    if (this.cooldown > 0 && index === this.lastPressed) return;
    this.lastPressed = index;
    const button = this.buttons[index];
    if (!button || button.disabled) return;
    this.cooldown = this.opts.pressCooldown;
    this.press(button.id);
  }

  private toLocal(world: Vector3): Vector3 {
    this.local.copy(world);
    return this.mesh.worldToLocal(this.local);
  }

  private rayHit(origin: Vector3, dir: Vector3): number {
    // Work in panel space: intersect the ray with the plane z = 0.
    const o = this.toLocal(origin);
    const ox = o.x;
    const oy = o.y;
    const oz = o.z;
    this.local.copy(origin).add(dir);
    const d = this.mesh.worldToLocal(this.local);
    const dx = d.x - ox;
    const dy = d.y - oy;
    const dz = d.z - oz;
    if (Math.abs(dz) < 1e-6) return -1;
    const t = -oz / dz;
    if (t < 0) return -1;
    return this.buttonAt(ox + dx * t, oy + dy * t);
  }

  /** Button index under a local-space point (metres, origin at centre). */
  private buttonAt(x: number, y: number): number {
    const px = (x / this.opts.width + 0.5) * this.w;
    const py = (0.5 - y / this.opts.height) * this.h;
    for (let i = 0; i < this.rects.length; i += 1) {
      const r = this.rects[i];
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
    }
    return -1;
  }

  private layout(): Rect {
    const { columns, buttonHeight, ppm } = this.opts;
    const pad = 0.012 * ppm;
    const gap = 0.006 * ppm;
    const bh = buttonHeight * ppm;
    const bw = (this.w - pad * 2 - gap * (columns - 1)) / columns;
    // Flow buttons into rows, honouring spans.
    const rows: { button: number; col: number; span: number }[][] = [[]];
    let col = 0;
    this.buttons.forEach((b, i) => {
      const span = Math.min(columns, Math.max(1, b.span ?? 1));
      if (col + span > columns) {
        rows.push([]);
        col = 0;
      }
      rows[rows.length - 1].push({ button: i, col, span });
      col += span;
    });
    const rowCount = this.buttons.length ? rows.length : 0;
    const top = this.h - pad - rowCount * bh - (rowCount - 1) * gap;
    this.rects = new Array(this.buttons.length);
    rows.forEach((row, r) => {
      // Centre a short row.
      const used = row.reduce((a, c) => a + c.span, 0);
      const offset = ((columns - used) * (bw + gap)) / 2;
      for (const cell of row) {
        this.rects[cell.button] = {
          x: pad + offset + cell.col * (bw + gap),
          y: top + r * (bh + gap),
          w: cell.span * bw + (cell.span - 1) * gap,
          h: bh,
        };
      }
    });
    return { x: pad, y: 0, w: this.w - pad * 2, h: rowCount > 0 ? top - gap : this.h - pad };
  }

  private redraw(): void {
    this.dirty = false;
    const ctx = this.ctx;
    const { ppm } = this.opts;
    const u = ppm / 1000; // pixels per millimetre
    ctx.clearRect(0, 0, this.w, this.h);
    roundRect(ctx, 1, 1, this.w - 2, this.h - 2, 12 * u);
    ctx.fillStyle = THEME.bg;
    ctx.fill();
    ctx.strokeStyle = THEME.border;
    ctx.lineWidth = 1.2 * u;
    ctx.stroke();

    const free = this.layout();
    const pad = 12 * u;
    let y = pad;
    ctx.textBaseline = 'top';
    if (this.eyebrow) {
      ctx.fillStyle = this.opts.accent;
      ctx.beginPath();
      ctx.arc(pad + 2 * u, y + 2.6 * u, 2 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `700 ${6 * u}px system-ui, sans-serif`;
      ctx.fillText(this.eyebrow.toUpperCase(), pad + 7 * u, y);
      y += 9 * u;
    }
    if (this.title) {
      ctx.fillStyle = THEME.text;
      ctx.font = `700 ${11 * u}px system-ui, sans-serif`;
      ctx.fillText(this.title, pad, y);
      y += 15 * u;
    }
    ctx.font = `400 ${7 * u}px system-ui, sans-serif`;
    ctx.fillStyle = THEME.dim;
    for (const line of this.body) {
      for (const wrapped of wrap(ctx, line, this.w - pad * 2)) {
        if (y > free.h - 6 * u) break;
        ctx.fillText(wrapped, pad, y);
        y += 9.5 * u;
      }
    }
    if (this.drawExtra) {
      this.drawExtra(ctx, { x: pad, y, w: this.w - pad * 2, h: Math.max(0, free.h - y) });
    }

    this.buttons.forEach((b, i) => {
      const r = this.rects[i];
      let fill = THEME.button;
      if (b.tone === 'primary') fill = THEME.primary;
      if (b.tone === 'danger') fill = THEME.danger;
      if (b.tone === 'active') fill = THEME.active;
      if (i === this.hover) fill = lighten(fill);
      if (i === this.flash) fill = this.opts.accent;
      roundRect(ctx, r.x, r.y, r.w, r.h, 7 * u);
      ctx.globalAlpha = b.disabled ? 0.4 : 1;
      ctx.fillStyle = fill;
      ctx.fill();
      if (b.accent && i !== this.flash) {
        ctx.save();
        roundRect(ctx, r.x, r.y, r.w, r.h, 7 * u);
        ctx.clip();
        ctx.fillStyle = b.accent;
        ctx.fillRect(r.x, r.y, 3.5 * u, r.h);
        ctx.restore();
      }
      ctx.fillStyle = i === this.flash ? '#10241b' : THEME.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelSize = Math.min(7.5 * u, r.h * 0.42);
      ctx.font = `600 ${labelSize}px system-ui, sans-serif`;
      if (b.sub) {
        ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h * 0.36, r.w - 6 * u);
        ctx.font = `400 ${labelSize * 0.72}px system-ui, sans-serif`;
        ctx.fillStyle = i === this.flash ? '#10241b' : THEME.dim;
        ctx.fillText(b.sub, r.x + r.w / 2, r.y + r.h * 0.7, r.w - 6 * u);
      } else {
        ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2, r.w - 6 * u);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.globalAlpha = 1;
    });
    this.texture.needsUpdate = true;
  }
}

function isVisible(object: { visible: boolean; parent: unknown }): boolean {
  let o = object as { visible: boolean; parent: { visible: boolean; parent: unknown } | null };
  while (o) {
    if (!o.visible) return false;
    o = o.parent as typeof o;
  }
  return true;
}

function lighten(color: string): string {
  if (color === THEME.button) return THEME.buttonHover;
  return color === THEME.primary ? '#3a9a72' : color === THEME.danger ? '#a84444' : '#4a72c4';
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
