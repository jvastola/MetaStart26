/**
 * Home screen: one app tile per prototype, standing in a gentle arc at the
 * back of the desk. Poke a tile with a fingertip, pinch it, or click it.
 * Tiles lift toward your finger on hover so you can tell what you are about
 * to press before you press it.
 */

import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { ACCENTS, withAlpha } from '../core/art.js';
import type { LabContext, Prototype } from '../core/context.js';
import type { HandState } from '../core/hands.js';
import { CanvasPanel, roundRect } from '../core/panel.js';
import { Sfx } from '../core/sfx.js';

const TILE_W = 0.1;
const TILE_H = 0.118;
const POKE_DEPTH = 0.004;

interface TileSpec {
  id: string;
  label: string;
  sub: string;
  accent: string;
}

/** Simple vector icons, drawn into a square of size `s` at the origin. */
const ICONS: Record<string, (c: CanvasRenderingContext2D, s: number) => void> = {
  focus: (c, s) => {
    c.fillStyle = '#fbfaf6';
    roundRect(c, s * 0.18, s * 0.26, s * 0.5, s * 0.36, s * 0.05);
    c.fill();
    c.strokeStyle = '#2f7d5d';
    c.lineWidth = s * 0.06;
    c.beginPath();
    c.moveTo(s * 0.28, s * 0.44);
    c.lineTo(s * 0.38, s * 0.53);
    c.lineTo(s * 0.56, s * 0.34);
    c.stroke();
    c.strokeStyle = '#ffffff';
    c.lineWidth = s * 0.045;
    c.beginPath();
    c.arc(s * 0.7, s * 0.68, s * 0.14, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(s * 0.7, s * 0.68);
    c.lineTo(s * 0.7, s * 0.6);
    c.moveTo(s * 0.7, s * 0.68);
    c.lineTo(s * 0.76, s * 0.7);
    c.stroke();
  },
  conjure: (c, s) => {
    const star = (x: number, y: number, r: number) => {
      c.beginPath();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.32;
        c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      c.closePath();
      c.fill();
    };
    c.fillStyle = '#ffffff';
    star(s * 0.46, s * 0.5, s * 0.26);
    star(s * 0.74, s * 0.28, s * 0.1);
    star(s * 0.72, s * 0.74, s * 0.07);
  },
  shotboard: (c, s) => {
    c.strokeStyle = '#ffffff';
    c.lineWidth = s * 0.06;
    const corner = (x: number, y: number, dx: number, dy: number) => {
      c.beginPath();
      c.moveTo(x, y + dy * s * 0.14);
      c.lineTo(x, y);
      c.lineTo(x + dx * s * 0.14, y);
      c.stroke();
    };
    corner(s * 0.2, s * 0.26, 1, 1);
    corner(s * 0.8, s * 0.26, -1, 1);
    corner(s * 0.2, s * 0.74, 1, -1);
    corner(s * 0.8, s * 0.74, -1, -1);
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(s * 0.5, s * 0.43, s * 0.07, 0, Math.PI * 2);
    c.fill();
    roundRect(c, s * 0.43, s * 0.5, s * 0.14, s * 0.16, s * 0.04);
    c.fill();
  },
  clay: (c, s) => {
    c.fillStyle = '#fff1e8';
    c.beginPath();
    c.moveTo(s * 0.3, s * 0.7);
    c.bezierCurveTo(s * 0.12, s * 0.5, s * 0.3, s * 0.2, s * 0.5, s * 0.28);
    c.bezierCurveTo(s * 0.72, s * 0.18, s * 0.9, s * 0.5, s * 0.7, s * 0.7);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.beginPath();
    c.ellipse(s * 0.45, s * 0.46, s * 0.05, s * 0.07, 0.3, 0, Math.PI * 2);
    c.fill();
  },
  golf: (c, s) => {
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.ellipse(s * 0.5, s * 0.74, s * 0.3, s * 0.07, 0, 0, Math.PI * 2);
    c.fill();
    c.fillRect(s * 0.47, s * 0.22, s * 0.04, s * 0.52);
    c.fillStyle = '#ffd166';
    c.beginPath();
    c.moveTo(s * 0.51, s * 0.22);
    c.lineTo(s * 0.76, s * 0.31);
    c.lineTo(s * 0.51, s * 0.4);
    c.closePath();
    c.fill();
  },
  sketch: (c, s) => {
    c.strokeStyle = '#ffffff';
    c.lineWidth = s * 0.07;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(s * 0.2, s * 0.62);
    c.bezierCurveTo(s * 0.35, s * 0.2, s * 0.45, s * 0.85, s * 0.6, s * 0.45);
    c.bezierCurveTo(s * 0.68, s * 0.28, s * 0.78, s * 0.36, s * 0.8, s * 0.3);
    c.stroke();
  },
  studio: (c, s) => {
    // A drawn stroke, a conjured star and a camera frame corner.
    c.strokeStyle = '#ffffff';
    c.lineCap = 'round';
    c.lineWidth = s * 0.06;
    c.beginPath();
    c.moveTo(s * 0.18, s * 0.7);
    c.bezierCurveTo(s * 0.3, s * 0.4, s * 0.42, s * 0.85, s * 0.56, s * 0.6);
    c.stroke();
    c.fillStyle = '#ffffff';
    c.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? s * 0.15 : s * 0.05;
      c.lineTo(s * 0.68 + Math.cos(a) * r, s * 0.34 + Math.sin(a) * r);
    }
    c.closePath();
    c.fill();
    c.lineWidth = s * 0.05;
    c.beginPath();
    c.moveTo(s * 0.2, s * 0.36);
    c.lineTo(s * 0.2, s * 0.2);
    c.lineTo(s * 0.36, s * 0.2);
    c.moveTo(s * 0.8, s * 0.64);
    c.lineTo(s * 0.8, s * 0.8);
    c.lineTo(s * 0.64, s * 0.8);
    c.stroke();
  },
  intro: (c, s) => {
    c.strokeStyle = '#ffffff';
    c.lineWidth = s * 0.06;
    c.beginPath();
    c.arc(s * 0.5, s * 0.5, s * 0.28, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#ffffff';
    c.font = `700 ${s * 0.36}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('?', s * 0.5, s * 0.52);
  },
};

class AppTile {
  readonly mesh: Mesh;
  hover = false;
  private hoverAmount = 0;
  private readonly lastDepth = { left: 1, right: 1 };
  private readonly local = new Vector3();
  private readonly base = new Vector3();

  constructor(readonly spec: TileSpec) {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = Math.round((400 * TILE_H) / TILE_W);
    const c = canvas.getContext('2d')!;
    const s = canvas.width;
    // Icon square with a soft accent gradient.
    const g = c.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, spec.accent);
    g.addColorStop(1, withAlpha(spec.accent, 0.55));
    roundRect(c, 14, 14, s - 28, s - 28, 70);
    c.fillStyle = g;
    c.fill();
    c.save();
    c.translate(14, 14);
    ICONS[spec.id]?.(c, s - 28);
    c.restore();
    c.fillStyle = '#f4f5f7';
    c.font = '700 52px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillText(spec.label, s / 2, s + 4, s - 20);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    this.mesh = new Mesh(new PlaneGeometry(TILE_W, TILE_H), new MeshBasicMaterial({ map: texture, transparent: true }));
    this.mesh.name = `Tile:${spec.id}`;
    this.mesh.renderOrder = 10;
  }

  place(x: number, y: number, z: number, yaw: number): void {
    this.base.set(x, y, z);
    this.mesh.position.copy(this.base);
    this.mesh.rotation.set(-0.18, yaw, 0, 'YXZ');
  }

  /** Returns true when pressed this frame. */
  update(pointers: readonly HandState[], dt: number): boolean {
    this.mesh.updateMatrixWorld(true);
    let hover = false;
    let pressed = false;
    for (const p of pointers) {
      if (!p.tracked) continue;
      if (p.isMouse) {
        const hit = this.rayHit(p);
        hover ||= hit;
        if (hit && p.pinchStarted) pressed = true;
        continue;
      }
      const tip = this.toLocal(p.indexTip);
      const inside = Math.abs(tip.x) < TILE_W / 2 && Math.abs(tip.y) < TILE_H / 2;
      const last = this.lastDepth[p.side];
      this.lastDepth[p.side] = tip.z;
      if (inside && tip.z < 0.06 && tip.z > -0.03) hover = true;
      if (inside && last > POKE_DEPTH && tip.z <= POKE_DEPTH && tip.z > -0.03) pressed = true;
      if (p.pinchStarted) {
        const q = this.toLocal(p.pinchPoint);
        if (Math.abs(q.x) < TILE_W / 2 && Math.abs(q.y) < TILE_H / 2 && Math.abs(q.z) < 0.04) pressed = true;
      }
    }
    if (hover && !this.hover && pointers.some((p) => !p.isMouse && p.tracked)) Sfx.hover(this.mesh.getWorldPosition(this.local));
    this.hover = hover;
    // Lift toward the user and grow a little on hover.
    this.hoverAmount += ((hover ? 1 : 0) - this.hoverAmount) * Math.min(1, dt * 14);
    this.mesh.scale.setScalar(1 + this.hoverAmount * 0.07);
    this.mesh.position.copy(this.base);
    this.mesh.translateZ(this.hoverAmount * 0.012);
    return pressed;
  }

  private toLocal(world: Vector3): Vector3 {
    this.local.copy(world);
    return this.mesh.worldToLocal(this.local);
  }

  private rayHit(p: HandState): boolean {
    const o = this.toLocal(p.rayOrigin).clone();
    const d = this.toLocal(this.local.copy(p.rayOrigin).add(p.rayDir)).sub(o);
    if (Math.abs(d.z) < 1e-6) return false;
    const t = -o.z / d.z;
    if (t < 0) return false;
    const x = o.x + d.x * t;
    const y = o.y + d.y * t;
    return Math.abs(x) < TILE_W / 2 && Math.abs(y) < TILE_H / 2;
  }
}

export class HubPrototype implements Prototype {
  readonly id = 'hub';
  readonly title = 'Home';
  readonly tagline = 'Pick an app';
  readonly accent = ACCENTS.hub;
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();
  private ctx!: LabContext;
  private header!: CanvasPanel;
  private tiles: AppTile[] = [];
  private cooldown = 0;

  constructor(
    private readonly entries: () => Prototype[],
    private readonly pick: (id: string) => void,
  ) {}

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.header = new CanvasPanel({ width: 0.44, height: 0.055, columns: 1, accent: this.accent });
    this.header.mesh.name = 'HomeHeader';
    this.header.mesh.position.set(0, 0.33, -0.15);
    this.header.mesh.rotation.x = -0.18;
    this.deskRoot.add(this.header.mesh);

    const specs: TileSpec[] = [
      ...this.entries().map((p) => ({ id: p.id, label: p.title, sub: p.tagline, accent: p.accent })),
      { id: 'intro', label: 'Tutorial', sub: 'Learn the hand moves', accent: ACCENTS.intro },
    ];
    // Two rows in a gentle arc: four on top, the rest below.
    const rows = [specs.slice(0, 4), specs.slice(4)];
    rows.forEach((row, r) => {
      row.forEach((spec, i) => {
        const tile = new AppTile(spec);
        const x = (i - (row.length - 1) / 2) * (TILE_W + 0.025);
        const z = -0.13 + Math.abs(x) * 0.25;
        tile.place(x, 0.235 - r * (TILE_H + 0.02), z, -x * 1.2);
        this.deskRoot.add(tile.mesh);
        this.tiles.push(tile);
      });
    });
  }

  enter(): void {
    this.header.setText(
      'Hands Lab',
      '',
      this.ctx.immersive
        ? 'Poke an app with your fingertip, or pinch it. Palm up any time for Home.'
        : 'Click an app, or press 0-7. Enter mixed reality to use your hands.',
    );
    // Ignore the poke that opened Home so it cannot also press a tile.
    this.cooldown = 0.3;
  }

  exit(): void {}

  update(dt: number): void {
    this.header.update([], dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    for (const tile of this.tiles) {
      if (tile.update(this.ctx.pointers, dt) && this.cooldown <= 0) {
        this.cooldown = 0.5;
        Sfx.click(tile.mesh.getWorldPosition(new Vector3()));
        this.pick(tile.spec.id);
        return;
      }
    }
  }

  debugState(): unknown {
    return { buttons: this.tiles.map((t) => t.spec.id), hover: this.tiles.filter((t) => t.hover).map((t) => t.spec.id) };
  }

  debugActions = {
    press: (id: string) => this.pick(id),
    tileWorld: (id: string) => {
      const tile = this.tiles.find((t) => t.spec.id === id);
      if (!tile) return null;
      tile.mesh.updateMatrixWorld(true);
      const p = tile.mesh.getWorldPosition(new Vector3());
      const n = new Vector3(0, 0, 1).transformDirection(tile.mesh.matrixWorld);
      return { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z };
    },
  };
}
