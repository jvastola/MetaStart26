/**
 * Studio: a small desk OS. A dock on the left opens tools as windows:
 *
 *   Draw     - the Sketch toolbar; while it is open, a pinch draws in the air
 *   Conjure  - voice/typed 3D objects on a pedestal
 *   Clay     - the sculpting turntable, with Print copy
 *   Board    - the storyboard that collects two-hand shots
 *
 * Several can be open at once. Each window has a handle bar along its front:
 * pinch or grab it to move the window, poke the red button to close it. The
 * layout is saved. Strokes, creations and prints live on the desk itself, so
 * closing or moving a tool leaves them where they are. The desk's bin deletes
 * anything dropped in it.
 *
 * Who gets a gesture: window handles first, then Clay, then Conjure, and
 * Sketch last. A tool that takes a pinch or grab consumes it, so a grab on a
 * creation never also grabs the stroke behind it.
 */

import { Group, Vector3 } from '@iwsdk/core';
import { ACCENTS } from '../core/art.js';
import { type LabContext, type Prototype, store } from '../core/context.js';
import type { HandState } from '../core/hands.js';
import { CanvasPanel, type PanelButton } from '../core/panel.js';
import { Sfx } from '../core/sfx.js';
import { StoryboardWall } from '../core/storyboard.js';
import { DeskWindow } from '../core/window.js';
import { ClayPrototype } from './clay/clay.js';
import { ConjurePrototype } from './conjure/conjure.js';
import { SketchPrototype } from './sketch/sketch.js';

const LAYOUT_KEY = 'studio-layout-v1';

type WindowId = 'draw' | 'conjure' | 'clay' | 'board';

interface SavedWindow {
  open: boolean;
  p: [number, number, number];
  yaw: number;
}

/** Where windows start, desk-local (+Z toward you), and whether they start open. */
const DEFAULTS: Record<WindowId, SavedWindow> = {
  draw: { open: true, p: [0.57, 0, 0.0], yaw: -0.8 },
  conjure: { open: true, p: [0.215, 0, -0.03], yaw: 0 },
  clay: { open: false, p: [-0.225, 0, -0.03], yaw: 0 },
  board: { open: true, p: [0, 0.36, -0.36], yaw: 0 },
};

export class StudioPrototype implements Prototype {
  readonly id = 'studio';
  readonly title = 'Studio';
  readonly tagline = 'A desk of tools, side by side';
  readonly accent = ACCENTS.studio;
  readonly trash = true;
  readonly howTo = [
    'The dock on the left opens tools: Draw, Conjure, Clay, Board.',
    "Pinch or grab a window's bar to move it; the red button closes it.",
    'Pinch to draw, grab to move things, bin to delete, two hands for a shot.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private dock!: CanvasPanel;
  private board!: StoryboardWall;
  private status = '';
  private readonly windows = new Map<WindowId, DeskWindow>();
  private readonly sketch = new SketchPrototype({
    saveKey: 'studio-sketch-v1',
    heading: 'Draw',
    // Window-local: the toolbar faces you, the colour wheel sits on its left.
    panel: { position: [0, 0.1, 0], rotation: [-0.35, 0, 0] },
    wheel: { position: [-0.27, 0.11, 0.03], rotation: [-0.3, 0.45, 0], visible: false },
    // Conjure owns the thumb microgestures here (tap = speak).
    gestures: false,
  });
  private readonly conjure = new ConjurePrototype({ layout: 'compact' });
  private readonly clay = new ClayPrototype({ keyPrefix: 'studio-', layout: 'compact', gestures: false, printsParent: this.deskRoot });

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.sketch.init(ctx);
    this.conjure.init(ctx);
    this.clay.init(ctx);
    // Strokes live on the desk, outside every window.
    this.deskRoot.add(this.sketch.deskRoot);
    this.wallRoot.add(this.sketch.wallRoot, this.conjure.wallRoot, this.clay.wallRoot);

    const draw = this.addWindow({ id: 'draw', title: 'Draw', accent: ACCENTS.sketch, handle: { position: [0, 0.008, 0.075], length: 0.22 } });
    draw.content.add(this.sketch.toolsRoot);
    const conjure = this.addWindow({
      id: 'conjure',
      title: 'Conjure',
      accent: ACCENTS.conjure,
      tray: { width: 0.46, depth: 0.4, z: -0.03 },
      handle: { position: [0, 0.008, 0.155], length: 0.24 },
    });
    conjure.content.add(this.conjure.deskRoot);
    const clay = this.addWindow({
      id: 'clay',
      title: 'Clay',
      accent: ACCENTS.clay,
      tray: { width: 0.42, depth: 0.44, z: -0.01 },
      handle: { position: [0, 0.008, 0.195], length: 0.2 },
    });
    clay.content.add(this.clay.deskRoot);
    const board = this.addWindow({ id: 'board', title: 'Storyboard', accent: ACCENTS.shotboard, handle: { position: [0, -0.205, 0.02], length: 0.3 } });
    this.board = new StoryboardWall(ctx, board.content, ACCENTS.shotboard);

    // The dock: on the left of the desk, angled toward you.
    this.dock = new CanvasPanel({ width: 0.22, height: 0.17, columns: 2, buttonHeight: 0.028, accent: this.accent });
    this.dock.mesh.name = 'StudioDock';
    this.dock.mesh.position.set(-0.5, 0.1, 0.1);
    this.dock.mesh.rotation.set(-0.35, 0.75, 0, 'YXZ');
    this.dock.onPress = (id) => this.onDock(id);
    this.deskRoot.add(this.dock.mesh);

    this.loadLayout();
  }

  private addWindow(opts: ConstructorParameters<typeof DeskWindow>[0] & { id: WindowId }): DeskWindow {
    const w = new DeskWindow(opts);
    w.onMoved = () => this.saveLayout();
    w.onClose = () => this.setOpen(opts.id, false);
    this.deskRoot.add(w.root);
    this.windows.set(opts.id, w);
    return w;
  }

  private win(id: WindowId): DeskWindow {
    return this.windows.get(id)!;
  }

  enter(): void {
    this.sketch.enter();
    if (this.win('conjure').open) this.conjure.enter();
    if (this.win('clay').open) this.clay.enter();
    this.board.layout();
    this.refreshDock();
  }

  exit(): void {
    this.sketch.exit();
    this.conjure.exit();
    this.clay.exit();
    this.board.stop();
    this.saveLayout();
  }

  holding(): boolean {
    return (
      [...this.windows.values()].some((w) => w.moving) ||
      this.sketch.holding() ||
      (this.win('conjure').open && this.conjure.holding()) ||
      (this.win('clay').open && this.clay.holding())
    );
  }

  update(dt: number): void {
    const pointers = this.ctx.pointers;
    for (const w of this.windows.values()) w.update(pointers);
    this.dock.update(pointers, dt);
    if (this.win('board').open) this.board.update(dt);
    if (this.win('clay').open) {
      this.clay.update(dt);
      this.consume((h) => this.clay.owns(h));
    }
    if (this.win('conjure').open) {
      this.conjure.update(dt);
      this.consume((h) => this.conjure.heldBy(h));
    }
    this.sketch.update(dt);
    this.refreshDock();
  }

  /** A tool took these hands this frame: no other tool sees their pinch or grab start. */
  private consume(owns: (hand: HandState) => boolean): void {
    for (const hand of this.ctx.pointers) {
      if ((hand.pinchStarted || hand.grabStarted) && owns(hand)) hand.clearEdges();
    }
  }

  // ------------------------------------------------------------ windows

  private setOpen(id: WindowId, open: boolean): void {
    const w = this.win(id);
    const was = w.open;
    w.open = open;
    if (id === 'draw') {
      this.sketch.toolsRoot.visible = open;
      this.sketch.drawEnabled = open;
    }
    if (open !== was) {
      if (id === 'conjure') open ? this.conjure.enter() : this.conjure.exit();
      if (id === 'clay') open ? this.clay.enter() : this.clay.exit();
      if (id === 'board') open ? this.board.layout() : this.board.stop();
      Sfx.blip(open ? 760 : 520);
    }
    this.saveLayout();
    this.refreshDock();
  }

  private onDock(id: string): void {
    if (id.startsWith('win:')) {
      const w = id.slice(4) as WindowId;
      this.setOpen(w, !this.win(w).open);
    }
    if (id === 'snap') this.snapView();
    if (id === 'play') {
      if (!this.win('board').open) this.setOpen('board', true);
      this.board.play();
    }
    if (id === 'reset') this.resetLayout();
  }

  private refreshDock(): void {
    const tone = (id: WindowId): PanelButton['tone'] => (this.win(id).open ? 'active' : 'default');
    const shots = this.ctx.album.shots.length;
    this.dock.setText('Studio', '', this.status || 'Open tools here. Move a window by its bar.');
    this.dock.setButtons([
      { id: 'win:draw', label: 'Draw', tone: tone('draw'), accent: ACCENTS.sketch },
      { id: 'win:conjure', label: 'Conjure', tone: tone('conjure'), accent: ACCENTS.conjure },
      { id: 'win:clay', label: 'Clay', tone: tone('clay'), accent: ACCENTS.clay },
      { id: 'win:board', label: 'Board', tone: tone('board'), accent: ACCENTS.shotboard },
      { id: 'snap', label: 'Snap view', tone: 'primary' },
      { id: 'play', label: this.board.playing >= 0 ? 'Playing' : 'Play', disabled: shots === 0 },
    ]);
  }

  private saveLayout(): void {
    const out: Partial<Record<WindowId, SavedWindow>> = {};
    for (const [id, w] of this.windows) {
      const p = w.root.position;
      out[id] = { open: w.open, p: [p.x, p.y, p.z].map((v) => +v.toFixed(4)) as [number, number, number], yaw: +w.root.rotation.y.toFixed(4) };
    }
    store.set(LAYOUT_KEY, out);
  }

  private loadLayout(): void {
    const saved = store.get<Partial<Record<WindowId, SavedWindow>>>(LAYOUT_KEY, {});
    for (const [id, w] of this.windows) {
      const s = saved[id] ?? DEFAULTS[id];
      w.root.position.set(...s.p);
      w.root.rotation.set(0, s.yaw, 0);
      w.open = s.open;
      if (id === 'draw') {
        this.sketch.toolsRoot.visible = s.open;
        this.sketch.drawEnabled = s.open;
      }
    }
  }

  private resetLayout(): void {
    store.set(LAYOUT_KEY, {});
    this.loadLayout();
    this.saveLayout();
  }

  /** Straight-ahead shot from the current view (desktop, or one hand busy). */
  private snapView(): void {
    const cam = this.ctx.camera;
    const eye = cam.getWorldPosition(new Vector3());
    const target = eye.clone().add(cam.getWorldDirection(new Vector3()));
    const caption = this.ctx.capture(eye, target, 50);
    this.status = `Shot ${this.ctx.album.shots.length} captured (${caption}).`;
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      windows: Object.fromEntries(
        [...this.windows].map(([id, w]) => [id, { open: w.open, moving: w.moving, pos: w.root.position.toArray().map((v) => +v.toFixed(3)), yaw: +w.root.rotation.y.toFixed(2) }]),
      ),
      sketch: this.sketch.debugState(),
      conjure: this.conjure.debugState(),
      clay: this.clay.debugState(),
      shots: this.ctx.album.shots.length,
      playing: this.board.playing,
      status: this.status,
    };
  }

  debugActions = {
    /** Press a dock button: win:draw, win:conjure, win:clay, win:board, snap, play, reset. */
    dock: (id: string) => this.dock.press(id),
    press: (id: string) => {
      if (id.startsWith('win:') || id === 'snap' || id === 'play' || id === 'reset') this.dock.press(id);
      else if (['color', 'size', 'erase', 'undo', 'clear'].includes(id)) this.sketch.debugActions.press(id);
      else if (['print', 'clearPrints', 'sculpt', 'smooth', 'inflate', 'mirror', 'export'].includes(id)) this.clay.debugActions.press(id);
      else this.conjure.debugActions.press(id);
    },
    say: (text: string) => this.conjure.debugActions.say(text),
    itemWorld: (index: number) => this.conjure.debugActions.itemWorld(index),
    strokePoint: (stroke: number, point: number) => this.sketch.debugActions.strokePoint(stroke, point),
    printWorld: (index: number) => this.clay.debugActions.printWorld(index),
    clayWorld: (x: number, y: number, z: number) => this.clay.debugActions.clayWorld(x, y, z),
    clear: () => this.sketch.debugActions.clear(),
    windowWorld: (id: WindowId) => {
      const d = this.win(id).debug();
      return { handle: { x: d.handle.x, y: d.handle.y, z: d.handle.z }, close: { x: d.close.x, y: d.close.y, z: d.close.z } };
    },
    resetLayout: () => this.resetLayout(),
  };
}
