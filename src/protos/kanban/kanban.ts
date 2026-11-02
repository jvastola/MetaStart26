/**
 * Kanban: a task board standing at the back of your desk, with To do, Doing
 * and Done columns.
 *
 *   - Grab a card (thumb + middle) to pick it up; drop it in any column, at
 *     any height, to move it there. Drop it on the bin to delete it.
 *   - A quick pinch (thumb + index) on a card cycles its colour tag.
 *   - Round desk buttons: New card (type, or press Mic and say it) and
 *     Clear done (press twice).
 *   - Column headers count the cards; Doing turns amber past three, a soft
 *     limit on work in progress.
 *
 * With a mouse: drag a card to move it, click it to change its colour.
 * The board saves itself.
 */

import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { type LabContext, type Prototype, store } from '../../core/context.js';
import { HeldPose } from '../../core/grab.js';
import { grabDistance, type HandState, pointerDistance } from '../../core/hands.js';
import { IconButton } from '../../core/icon-button.js';
import { roundRect, wrap } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import { type BoardData, type Card, type Column, COLUMN_TITLES, COLUMNS, KanbanStore, starterBoard, type Tag, WIP_LIMIT } from './kanban-store.js';

const SAVE_KEY = 'kanban-v1';
const BOARD_W = 0.6;
const BOARD_H = 0.3;
const BOARD_POS = new Vector3(0, 0.17, -0.17);
const BOARD_TILT = -0.3;
const COL_W = BOARD_W / 3;
const CARD_W = 0.17;
const CARD_H = 0.042;
const HEADER = 0.045;
const STEP = CARD_H + 0.008;
/** A pinch released this quickly is a tap. */
const TAP = 0.35;
const CLEAR_ARM = 3;

const TAG_COLORS: Record<Tag, string> = { none: '#9aa1ad', red: '#ff6b6b', amber: '#ffc94d', green: '#7fe0b5', blue: '#8fb3ff' };

interface CardView {
  card: Card;
  group: Group;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  drawn: string;
  /** Board-local spot it eases toward. */
  target: Vector3;
}

export class KanbanPrototype implements Prototype {
  readonly id = 'kanban';
  readonly title = 'Kanban';
  readonly tagline = 'Move tasks across the board';
  readonly accent = ACCENTS.kanban;
  readonly trash = true;
  readonly howTo = [
    'Grab a card (thumb + middle) and drop it in another column to move it.',
    'Quick pinch (thumb + index) on a card to change its colour.',
    'Round buttons: New card, and Clear done (press twice). Drop a card on the bin to delete it.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private readonly store = new KanbanStore(this.load());
  private readonly board = new Group();
  private boardCanvas = document.createElement('canvas');
  private boardTexture!: CanvasTexture;
  private boardDrawn = '';
  private readonly views = new Map<number, CardView>();
  private readonly buttons = new Map<string, IconButton>();
  private held: { view: CardView; hand: HandState; pose: HeldPose; time: number; from: Vector3 } | null = null;
  private taps: { view: CardView; hand: HandState; time: number }[] = [];
  private clearArmed = 0;
  /** Board-local point of the last drop (tests). */
  private lastDrop: number[] = [];
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly q = new Quaternion();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.board.name = 'KanbanBoard';
    this.board.position.copy(BOARD_POS);
    this.board.rotation.x = BOARD_TILT;
    this.boardCanvas.width = 1200;
    this.boardCanvas.height = 600;
    this.boardTexture = new CanvasTexture(this.boardCanvas);
    this.boardTexture.colorSpace = SRGBColorSpace;
    const face = new Mesh(new PlaneGeometry(BOARD_W, BOARD_H), new MeshBasicMaterial({ map: this.boardTexture }));
    const back = new Mesh(new BoxGeometry(BOARD_W + 0.012, BOARD_H + 0.012, 0.01), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.6 }));
    back.position.z = -0.0055;
    this.board.add(back, face);
    // Two legs down to the desk.
    for (const x of [-BOARD_W / 2 + 0.04, BOARD_W / 2 - 0.04]) {
      const leg = new Mesh(new BoxGeometry(0.012, 0.2, 0.012), new MeshStandardMaterial({ color: '#2a2e36' }));
      leg.position.set(x, -BOARD_H / 2 - 0.06, -0.01);
      this.board.add(leg);
    }
    const shadow = blobShadow(BOARD_W + 0.1, 0.12, 0.6);
    shadow.position.set(0, 0.001, BOARD_POS.z);
    this.deskRoot.add(this.board, shadow);

    const row: [string, string, string][] = [
      ['add', 'plus', 'New card (type or say it)'],
      ['clear', 'trash', 'Clear done (press twice)'],
    ];
    row.forEach(([id, icon, label], i) => {
      const b = new IconButton({ id: `kanban:${id}`, icon, label, accent: this.accent, radius: 0.016 });
      b.group.position.set((i - 0.5) * 0.05, 0.001, 0.12);
      b.onPress = () => this.onButton(id);
      this.buttons.set(id, b);
      this.deskRoot.add(b.group);
    });
    for (const card of this.store.data.cards) this.viewFor(card);
    this.layout(true);
  }

  enter(): void {
    this.layout(true);
  }

  exit(): void {
    if (this.held) this.drop(this.held.view, null);
    this.held = null;
    this.taps = [];
    this.save();
  }

  fingerHints(): { index: string; middle: string } {
    return { index: 'colour', middle: 'move' };
  }

  holding(): boolean {
    return this.held != null;
  }

  // ------------------------------------------------------------ data

  private load(): BoardData {
    const saved = store.get<BoardData | null>(SAVE_KEY, null);
    return saved && Array.isArray(saved.cards) ? saved : starterBoard();
  }

  private save(): void {
    store.set(SAVE_KEY, this.store.data);
  }

  // ------------------------------------------------------------ views

  private viewFor(card: Card): CardView {
    let view = this.views.get(card.id);
    if (view) return view;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = Math.round((512 * CARD_H) / CARD_W);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const group = new Group();
    group.name = `Card:${card.id}`;
    const body = new Mesh(new BoxGeometry(CARD_W, CARD_H, 0.003), new MeshStandardMaterial({ color: '#f6f3ec', roughness: 0.8 }));
    const front = new Mesh(new PlaneGeometry(CARD_W, CARD_H), new MeshBasicMaterial({ map: texture, transparent: true }));
    front.position.z = 0.0016;
    group.add(body, front);
    this.board.add(group);
    view = { card, group, canvas, texture, drawn: '', target: new Vector3() };
    this.views.set(card.id, view);
    this.drawCard(view);
    return view;
  }

  private drawCard(view: CardView): void {
    const key = `${view.card.text}|${view.card.tag}`;
    if (key === view.drawn) return;
    view.drawn = key;
    const c = view.canvas.getContext('2d')!;
    const { width: w, height: h } = view.canvas;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#fbfaf6';
    roundRect(c, 0, 0, w, h, 14);
    c.fill();
    c.fillStyle = TAG_COLORS[view.card.tag];
    c.fillRect(0, 0, 18, h);
    c.fillStyle = '#20232a';
    c.font = '600 40px system-ui, sans-serif';
    c.textBaseline = 'middle';
    const lines = wrap(c, view.card.text, w - 60).slice(0, 2);
    lines.forEach((line, i) => c.fillText(line, 36, h / 2 + (i - (lines.length - 1) / 2) * 44));
    view.texture.needsUpdate = true;
  }

  private columnX(column: Column): number {
    return (COLUMNS.indexOf(column) - 1) * COL_W;
  }

  /** Card spacing in a column: closer together once it fills up. */
  private stepFor(n: number): number {
    return Math.min(STEP, (BOARD_H - HEADER - 0.02) / Math.max(1, n));
  }

  /** Where every card belongs; `snap` jumps there instead of easing. */
  private layout(snap = false): void {
    for (const column of COLUMNS) {
      const cards = this.store.column(column);
      const step = this.stepFor(cards.length);
      cards.forEach((card, i) => {
        const view = this.viewFor(card);
        view.target.set(this.columnX(column), BOARD_H / 2 - HEADER - CARD_H / 2 - i * step, 0.004 + i * 0.0004);
        if (snap && view !== this.held?.view) view.group.position.copy(view.target);
      });
    }
    // Views whose cards are gone.
    for (const [id, view] of this.views) {
      if (this.store.get(id)) continue;
      this.board.remove(view.group);
      view.texture.dispose();
      view.group.traverse((o) => (o as Mesh).geometry?.dispose());
      this.views.delete(id);
    }
    this.drawBoard();
  }

  private drawBoard(): void {
    const counts = COLUMNS.map((c) => this.store.column(c).length);
    const over = this.store.overLimit();
    const key = `${counts.join(',')}|${over}`;
    if (key === this.boardDrawn) return;
    this.boardDrawn = key;
    const c = this.boardCanvas.getContext('2d')!;
    const { width: w, height: h } = this.boardCanvas;
    c.fillStyle = '#1d2027';
    c.fillRect(0, 0, w, h);
    const colW = w / 3;
    COLUMNS.forEach((column, i) => {
      c.fillStyle = 'rgba(255,255,255,0.05)';
      roundRect(c, i * colW + 10, 10, colW - 20, h - 20, 22);
      c.fill();
      const warn = column === 'doing' && over;
      c.fillStyle = warn ? '#ffc94d' : column === 'done' ? '#7fe0b5' : '#f4f5f7';
      c.font = '700 40px system-ui, sans-serif';
      c.textBaseline = 'middle';
      c.fillText(`${COLUMN_TITLES[column]}  ${counts[i]}${column === 'doing' ? ` / ${WIP_LIMIT}` : ''}`, i * colW + 34, 50);
    });
    this.boardTexture.needsUpdate = true;
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.clearArmed = Math.max(0, this.clearArmed - dt);
    this.board.updateWorldMatrix(true, false);
    this.updateHold(dt);
    this.updateTaps(dt);
    const k = 1 - Math.exp(-dt * 12);
    for (const view of this.views.values()) {
      if (view === this.held?.view) continue;
      view.group.position.lerp(view.target, k);
      view.group.quaternion.slerp(this.q.identity(), k);
    }
    this.refreshButtons();
  }

  private nearest(hand: HandState, point: 'grab' | 'pinch'): CardView | null {
    let best: CardView | null = null;
    let bestD = hand.isMouse ? 0.03 : 0.05;
    for (const view of this.views.values()) {
      if (view === this.held?.view) continue;
      view.group.getWorldPosition(this.tmp);
      const d = point === 'grab' ? grabDistance(hand, this.tmp) : pointerDistance(hand, this.tmp);
      if (d < bestD) {
        bestD = d;
        best = view;
      }
    }
    return best;
  }

  private updateHold(dt: number): void {
    if (!this.held) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.grabStarted) continue;
        const view = this.nearest(hand, 'grab');
        if (!view) continue;
        if (hand.isMouse) {
          // Slide on a plane facing the camera through the card, starting from it.
          const at = view.group.getWorldPosition(new Vector3());
          this.ctx.camera.getWorldDirection(this.tmp2).negate();
          this.ctx.setMousePlane(at, this.tmp2);
          hand.pinchPoint.copy(at);
          hand.grabPoint.copy(at);
        }
        const pose = new HeldPose();
        pose.begin(hand, view.group);
        this.held = { view, hand, pose, time: 0, from: view.group.getWorldPosition(new Vector3()) };
        hand.clearEdges();
        Sfx.pinch(hand.isMouse ? undefined : hand.holdPoint);
        return;
      }
      return;
    }
    const h = this.held;
    h.time += dt;
    if (h.hand.grabbing && h.hand.tracked) {
      h.pose.apply(h.hand, h.view.group);
      this.ctx.trash.near(this.binPoint(h.hand));
      return;
    }
    this.held = null;
    if (h.hand.isMouse) this.ctx.setMousePlane(this.ctx.desk.getWorldPosition(this.tmp), this.tmp2.set(0, 1, 0));
    // A click that did not move it is a tap: next colour.
    if (h.hand.isMouse && h.time < TAP && h.view.group.getWorldPosition(this.tmp).distanceTo(h.from) < 0.01) {
      this.tag(h.view);
      return;
    }
    if (this.ctx.trash.take(this.binPoint(h.hand))) {
      this.store.remove(h.view.card.id);
      Sfx.trash(h.hand.holdPoint);
      this.ctx.toast(`Deleted "${h.view.card.text}".`);
      this.changed();
      return;
    }
    this.drop(h.view, h.hand);
  }

  /**
   * Where the bin should test a held card: the hand, or for the mouse (which
   * drags at board height) the point on the cursor's ray nearest the bin.
   */
  private binPoint(hand: HandState): Vector3 {
    if (!hand.isMouse) return hand.holdPoint;
    const bin = this.ctx.trash.group.getWorldPosition(this.tmp2).setY(this.tmp2.y + 0.03);
    const along = Math.max(0, this.tmp.copy(bin).sub(hand.rayOrigin).dot(hand.rayDir));
    return this.tmp.copy(hand.rayOrigin).addScaledVector(hand.rayDir, along);
  }

  /** Put a dropped card in the column (and at the height) it was let go over. */
  private drop(view: CardView, hand: HandState | null): void {
    const p = this.board.worldToLocal(view.group.getWorldPosition(this.tmp));
    this.lastDrop = [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
    const onBoard = Math.abs(p.z) < 0.15 && Math.abs(p.x) < BOARD_W / 2 + 0.06 && p.y > -BOARD_H / 2 - 0.12 && p.y < BOARD_H / 2 + 0.06;
    if (onBoard) {
      const column = COLUMNS.reduce((best, c) => (Math.abs(this.columnX(c) - p.x) < Math.abs(this.columnX(best) - p.x) ? c : best), COLUMNS[0]);
      const others = this.store.column(column).filter((c) => c.id !== view.card.id);
      const step = this.stepFor(others.length + 1);
      const index = Math.max(0, Math.round((BOARD_H / 2 - HEADER - CARD_H / 2 - p.y) / step));
      const moved = view.card.column !== column;
      this.store.move(view.card.id, column, Math.min(index, others.length));
      if (moved && column === 'done') Sfx.success(hand?.isMouse ? undefined : hand?.holdPoint);
      else Sfx.place(hand?.isMouse ? undefined : hand?.holdPoint);
    }
    // Off the board: it goes back where it was.
    this.changed();
  }

  /** Quick pinches on cards cycle their colour. */
  private updateTaps(dt: number): void {
    for (const t of this.taps) t.time += dt;
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked || hand.isMouse || !hand.pinchStarted) continue;
      const view = this.nearest(hand, 'pinch');
      if (!view) continue;
      this.taps.push({ view, hand, time: 0 });
      hand.clearEdges();
    }
    for (let i = this.taps.length - 1; i >= 0; i--) {
      const t = this.taps[i];
      if (t.hand.pinching && t.hand.tracked) continue;
      this.taps.splice(i, 1);
      if (t.time < TAP) this.tag(t.view);
    }
  }

  private tag(view: CardView): void {
    const tag = this.store.cycleTag(view.card.id);
    this.drawCard(view);
    Sfx.blip(tag === 'none' ? 520 : 760, view.group.getWorldPosition(this.tmp));
    this.save();
  }

  private changed(): void {
    this.layout();
    this.save();
  }

  // ------------------------------------------------------------ buttons

  private onButton(id: string): void {
    if (id === 'add') {
      this.ctx.openKeyboard({
        title: 'New card',
        placeholder: 'Type the task, or press Mic and say it',
        onSubmit: (text) => this.addCard(text),
      });
    }
    if (id === 'clear') {
      const n = this.store.column('done').length;
      if (this.clearArmed > 0) {
        this.clearArmed = 0;
        this.store.clearDone();
        Sfx.whoosh();
        this.ctx.toast(`Cleared ${n} done card${n === 1 ? '' : 's'}.`);
        this.changed();
      } else if (n > 0) {
        this.clearArmed = CLEAR_ARM;
        this.ctx.toast(`Press Clear done again to remove ${n} card${n === 1 ? '' : 's'}.`);
      }
    }
  }

  private addCard(text: string): void {
    const card = this.store.add(text);
    const view = this.viewFor(card);
    this.changed();
    // Pop in from just above the column.
    view.group.position.copy(view.target).setY(view.target.y + 0.05);
    Sfx.place();
    this.ctx.toast(`Added "${card.text}" to To do.`);
  }

  private refreshButtons(): void {
    const done = this.store.column('done').length;
    const clear = this.buttons.get('clear')!;
    clear.disabled = done === 0;
    clear.active = this.clearArmed > 0;
    clear.label = this.clearArmed > 0 ? `Press again to clear ${done} done` : 'Clear done (press twice)';
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      columns: Object.fromEntries(COLUMNS.map((c) => [c, this.store.column(c).map((card) => card.text)])),
      tags: Object.fromEntries(this.store.data.cards.map((c) => [c.text, c.tag])),
      holding: this.held != null,
      overLimit: this.store.overLimit(),
      lastDrop: this.lastDrop,
    };
  }

  debugActions = {
    press: (id: string) => this.buttons.get(id)?.press(true),
    add: (text: string) => this.addCard(text),
    /** World centre of the card with this text. */
    cardWorld: (text: string) => {
      const card = this.store.data.cards.find((c) => c.text === text);
      const view = card && this.views.get(card.id);
      if (!view) return null;
      const p = view.group.getWorldPosition(new Vector3());
      return { x: p.x, y: p.y, z: p.z };
    },
    /** World point in a column at a card slot (for drops). */
    slotWorld: (column: Column, index: number) => {
      this.board.updateWorldMatrix(true, false);
      const p = this.board.localToWorld(new Vector3(this.columnX(column), BOARD_H / 2 - HEADER - CARD_H / 2 - index * STEP, 0.01));
      return { x: p.x, y: p.y, z: p.z };
    },
    reset: () => {
      for (const view of this.views.values()) this.board.remove(view.group);
      this.views.clear();
      this.store.data = starterBoard();
      this.changed();
      this.layout(true);
    },
  };
}
