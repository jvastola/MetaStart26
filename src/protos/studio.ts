/**
 * Studio: a small desk OS. A dock of round buttons on the left opens tools
 * as windows:
 *
 *   Draw     - drawing tools; while it is open, a pinch draws in the air
 *   Conjure  - voice/typed 3D objects on a pedestal
 *   Clay     - the sculpting turntable, with Print copy
 *   Board    - the storyboard that collects two-hand shots
 *
 * Keeping it tidy:
 *   - each window's bar has pin, focus and hide buttons;
 *   - unpinned windows fold their controls away while no hand is near, and
 *     unfold as you reach toward them;
 *   - focus gives one tool the desk: the others hide, the tool moves to the
 *     middle and shows its full controls; press focus again to go back.
 *
 * Strokes, creations and prints live on the desk, not in the windows. Loop
 * a box around any of them (hold a grab in empty air and move) to select them
 * together; grab to move, both hands to scale, the bin or menu to delete.
 *
 * Who gets a gesture: window bars, then the selection, then Clay, Conjure,
 * and Sketch last. A tool that takes a pinch or grab consumes it.
 */

import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { ACCENTS, withAlpha } from '../core/art.js';
import { type LabContext, type Prototype, store } from '../core/context.js';
import type { HandState } from '../core/hands.js';
import { IconButton } from '../core/icon-button.js';
import { roundRect } from '../core/panel.js';
import { Selection } from '../core/selection.js';
import { Sfx } from '../core/sfx.js';
import { StoryboardWall } from '../core/storyboard.js';
import { DeskWindow, type WindowOptions } from '../core/window.js';
import { ClayPrototype } from './clay/clay.js';
import { ConjurePrototype } from './conjure/conjure.js';
import { SketchPrototype } from './sketch/sketch.js';

const LAYOUT_KEY = 'studio-layout-v2';

type WindowId = 'draw' | 'conjure' | 'clay' | 'board';
const WINDOW_IDS: WindowId[] = ['draw', 'conjure', 'clay', 'board'];

interface SavedWindow {
  open: boolean;
  p: [number, number, number];
  yaw: number;
  pinned?: boolean;
}

/** Where windows start, desk-local (+Z toward you), and whether they start open. */
const DEFAULTS: Record<WindowId, SavedWindow> = {
  draw: { open: true, p: [0.5, 0, 0.06], yaw: -0.6 },
  conjure: { open: true, p: [0.215, 0, -0.03], yaw: 0 },
  clay: { open: false, p: [-0.225, 0, -0.03], yaw: 0 },
  board: { open: true, p: [0, 0.36, -0.36], yaw: 0 },
};

/** Where a focused tool goes. */
const FOCUS_POSE: Record<WindowId, [number, number, number] | null> = {
  draw: null,
  conjure: [0, 0, -0.03],
  clay: [0, 0, -0.03],
  board: [0, 0.3, -0.24],
};

export class StudioPrototype implements Prototype {
  readonly id = 'studio';
  readonly title = 'Studio';
  readonly tagline = 'A desk of tools, side by side';
  readonly accent = ACCENTS.studio;
  readonly trash = true;
  readonly howTo = [
    'Round buttons on the left open tools. Point at one to see its name.',
    'Window bars: pin keeps controls out, focus gives a tool the desk.',
    'Hold a grab (thumb + middle) in empty air and stretch a box to select.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private board!: StoryboardWall;
  private selection!: Selection;
  private status = '';
  private readonly windows = new Map<WindowId, DeskWindow>();
  private readonly dock = new Map<string, IconButton>();
  private focusState: { id: WindowId; saved: Record<WindowId, SavedWindow> } | null = null;
  private readonly sketch = new SketchPrototype({
    saveKey: 'studio-sketch-v1',
    // Window-local: the round tools, with the colour wheel just behind them.
    tools: { position: [0, 0, 0], rotation: [0, 0, 0] },
    wheel: { position: [0, 0.12, -0.07], rotation: [-0.25, 0, 0], visible: false },
    // Conjure owns the thumb microgestures here (tap = speak).
    gestures: false,
    selection: () => this.selection,
  });
  private readonly conjure = new ConjurePrototype({ layout: 'compact' });
  private readonly clay = new ClayPrototype({ keyPrefix: 'studio-', layout: 'compact', gestures: false, printsParent: this.deskRoot });

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.selection = new Selection(ctx, this.accent);
    this.selection.armed = () => this.sketch.selecting;
    this.selection.paintColor = () => this.sketch.brushColor;
    this.sketch.init(ctx);
    this.conjure.init(ctx);
    this.clay.init(ctx);
    this.selection.addSource(this.conjure.selectionSource);
    this.selection.addSource(this.clay.selectionSource);
    // Strokes live on the desk, outside every window.
    this.deskRoot.add(this.sketch.deskRoot, this.selection.group);
    this.wallRoot.add(this.sketch.wallRoot, this.conjure.wallRoot, this.clay.wallRoot);

    const draw = this.addWindow({
      id: 'draw',
      title: 'Draw',
      accent: ACCENTS.sketch,
      tray: { width: 0.16, depth: 0.11, z: 0 },
      handle: { position: [0, 0.006, 0.07], length: 0.12 },
      reach: { center: [0, 0.03, 0], radius: 0.1 },
    });
    draw.content.add(this.sketch.toolsRoot);
    draw.onExpand = (on) => (this.sketch.toolsRoot.visible = on && draw.open);

    const conjure = this.addWindow({
      id: 'conjure',
      title: 'Conjure',
      accent: ACCENTS.conjure,
      tray: { width: 0.46, depth: 0.4, z: -0.03 },
      handle: { position: [0, 0.008, 0.155], length: 0.24 },
      reach: { center: [0, 0.06, -0.03], radius: 0.22 },
    });
    conjure.content.add(this.conjure.deskRoot);
    conjure.onExpand = (on) => this.conjure.setControlsVisible(on);

    const clay = this.addWindow({
      id: 'clay',
      title: 'Clay',
      accent: ACCENTS.clay,
      tray: { width: 0.42, depth: 0.46, z: -0.02 },
      handle: { position: [0, 0.008, 0.2], length: 0.2 },
      reach: { center: [0, 0.07, 0], radius: 0.2 },
    });
    clay.content.add(this.clay.deskRoot);
    clay.onExpand = (on) => this.clay.setControlsVisible(on);

    const board = this.addWindow({
      id: 'board',
      title: 'Storyboard',
      accent: ACCENTS.shotboard,
      handle: { position: [0, -0.215, 0.07], length: 0.3 },
      reach: { center: [0, 0, 0], radius: 0.35 },
    });
    this.board = new StoryboardWall(ctx, board.content, ACCENTS.shotboard);

    this.buildDock();
    this.loadLayout();
  }

  private addWindow(opts: WindowOptions & { id: WindowId }): DeskWindow {
    const w = new DeskWindow(opts);
    w.onMoved = () => this.saveLayout();
    w.onHide = () => this.setOpen(opts.id, false);
    w.onFocus = () => this.toggleFocus(opts.id);
    w.onPin = () => this.saveLayout();
    this.deskRoot.add(w.root);
    this.windows.set(opts.id, w);
    return w;
  }

  /** A column of round buttons on a small tray to the left of the desk. */
  private buildDock(): void {
    const dock = new Group();
    dock.name = 'StudioDock';
    dock.position.set(-0.48, 0, 0.02);
    dock.rotation.y = 0.45;
    const items: [string, string, string, string][] = [
      ['draw', 'draw', 'Draw', ACCENTS.sketch],
      ['conjure', 'conjure', 'Conjure', ACCENTS.conjure],
      ['clay', 'clay', 'Clay', ACCENTS.clay],
      ['board', 'board', 'Storyboard', ACCENTS.shotboard],
      ['snap', 'snap', 'Snap view', this.accent],
      ['play', 'play', 'Play the storyboard', this.accent],
      ['tidy', 'reset', 'Tidy windows', this.accent],
    ];
    const gap = 0.045;
    items.forEach(([id, icon, label, accent], i) => {
      const b = new IconButton({ id: `dock:${id}`, icon, label, accent, radius: 0.016 });
      b.group.position.set(0, 0.002, (i - (items.length - 1) / 2) * gap);
      b.onPress = () => this.onDock(id);
      this.dock.set(id, b);
      dock.add(b.group);
    });
    // Tray.
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 640;
    const c = canvas.getContext('2d')!;
    roundRect(c, 4, 4, 120, 632, 48);
    c.fillStyle = 'rgba(28,31,38,0.6)';
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = withAlpha(this.accent, 0.7);
    c.stroke();
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const tray = new Mesh(new PlaneGeometry(0.06, items.length * gap + 0.02), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    tray.rotation.x = -Math.PI / 2;
    tray.position.y = 0.001;
    tray.userData.hideInShots = true;
    dock.add(tray);
    this.deskRoot.add(dock);
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

  fingerHints(hand: HandState): { index: string; middle: string } {
    const sketch = this.sketch.fingerHints(hand);
    return { index: sketch.index, middle: this.selection.grabbableNear(hand.grabbing ? hand.grabPoint : hand.tips[2]) ? 'move' : 'select' };
  }

  holding(): boolean {
    return (
      [...this.windows.values()].some((w) => w.moving) ||
      this.selection.busy ||
      this.board.dragging ||
      this.sketch.holding() ||
      (this.win('conjure').open && this.conjure.holding()) ||
      (this.win('clay').open && this.clay.holding())
    );
  }

  update(dt: number): void {
    const pointers = this.ctx.pointers;
    for (const w of this.windows.values()) w.update(pointers, dt);
    // Storyboard cards take their grabs before an air grab could start a selection box.
    if (this.win('board').open) this.board.update(dt);
    this.selection.update(dt);
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
      this.sketch.toolsRoot.visible = open && w.expanded;
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
    if (WINDOW_IDS.includes(id as WindowId)) {
      // Opening something else ends focus mode.
      if (this.focusState && this.focusState.id !== id) this.unfocus();
      this.setOpen(id as WindowId, !this.win(id as WindowId).open);
    }
    if (id === 'snap') this.snapView();
    if (id === 'play') {
      if (!this.win('board').open) this.setOpen('board', true);
      this.board.play();
    }
    if (id === 'tidy') this.resetLayout();
  }

  /** Focus: this tool gets the desk; press again to go back. */
  private toggleFocus(id: WindowId): void {
    if (this.focusState?.id === id) {
      this.unfocus();
      return;
    }
    if (this.focusState) this.unfocus();
    const saved = this.snapshot();
    this.focusState = { id, saved };
    for (const other of WINDOW_IDS) if (other !== id && this.win(other).open) this.setOpen(other, false);
    const w = this.win(id);
    if (!w.open) this.setOpen(id, true);
    const pose = FOCUS_POSE[id];
    if (pose) {
      w.root.position.set(...pose);
      w.root.rotation.set(0, 0, 0);
    }
    w.pinned = true;
    w.focused = true;
    if (id === 'clay') {
      this.clay.setLayout('full');
      w.trayVisible = false;
    }
    if (id === 'conjure') {
      this.conjure.setLayout('full');
      w.trayVisible = false;
    }
    Sfx.whoosh();
  }

  private unfocus(): void {
    const state = this.focusState;
    if (!state) return;
    this.focusState = null;
    const w = this.win(state.id);
    w.focused = false;
    w.trayVisible = true;
    if (state.id === 'clay') this.clay.setLayout('compact');
    if (state.id === 'conjure') this.conjure.setLayout('compact');
    this.apply(state.saved);
    Sfx.whoosh();
  }

  private snapshot(): Record<WindowId, SavedWindow> {
    const out = {} as Record<WindowId, SavedWindow>;
    for (const [id, w] of this.windows) {
      const p = w.root.position;
      out[id] = { open: w.open, p: [p.x, p.y, p.z].map((v) => +v.toFixed(4)) as [number, number, number], yaw: +w.root.rotation.y.toFixed(4), pinned: w.pinned };
    }
    return out;
  }

  private apply(layout: Partial<Record<WindowId, SavedWindow>>): void {
    for (const id of WINDOW_IDS) {
      const s = layout[id] ?? DEFAULTS[id];
      const w = this.win(id);
      w.root.position.set(...s.p);
      w.root.rotation.set(0, s.yaw, 0);
      w.pinned = s.pinned ?? false;
      if (w.open !== s.open) this.setOpen(id, s.open);
      if (id === 'draw') {
        this.sketch.toolsRoot.visible = s.open && w.expanded;
        this.sketch.drawEnabled = s.open;
      }
    }
  }

  private refreshDock(): void {
    for (const id of WINDOW_IDS) this.dock.get(id)!.active = this.win(id).open;
    this.dock.get('play')!.disabled = this.ctx.album.shots.length === 0;
    this.dock.get('play')!.active = this.board.playing >= 0;
  }

  private saveLayout(): void {
    // Focus mode is temporary: save the layout it will return to.
    store.set(LAYOUT_KEY, this.focusState ? this.focusState.saved : this.snapshot());
  }

  private loadLayout(): void {
    this.apply(store.get<Partial<Record<WindowId, SavedWindow>>>(LAYOUT_KEY, {}));
  }

  private resetLayout(): void {
    if (this.focusState) {
      this.focusState = null;
      for (const w of this.windows.values()) {
        w.focused = false;
        w.trayVisible = true;
      }
      this.clay.setLayout('compact');
      this.conjure.setLayout('compact');
    }
    this.apply({});
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
        [...this.windows].map(([id, w]) => [
          id,
          { open: w.open, moving: w.moving, pinned: w.pinned, expanded: w.expanded, pos: w.root.position.toArray().map((v) => +v.toFixed(3)), yaw: +w.root.rotation.y.toFixed(2) },
        ]),
      ),
      focus: this.focusState?.id ?? null,
      selection: this.selection.debug(),
      sketch: this.sketch.debugState(),
      conjure: this.conjure.debugState(),
      clay: this.clay.debugState(),
      shots: this.ctx.album.shots.length,
      playing: this.board.playing,
      status: this.status,
    };
  }

  debugActions = {
    /** Press a dock button: draw, conjure, clay, board, snap, play, tidy (a "win:" prefix is accepted). */
    dock: (id: string) => this.dock.get(id.replace(/^win:/, ''))?.press(true),
    press: (id: string) => {
      const name = id.replace(/^win:/, '');
      if (this.dock.has(name)) this.onDock(name);
      else if (['color', 'size', 'erase', 'select', 'undo', 'clear'].includes(id)) this.sketch.debugActions.press(id);
      else if (['print', 'clearPrints', 'sculpt', 'smooth', 'inflate', 'mirror', 'spin', 'export'].includes(id)) this.clay.debugActions.press(id);
      else this.conjure.debugActions.press(id);
    },
    focus: (id: WindowId) => this.toggleFocus(id),
    say: (text: string) => this.conjure.debugActions.say(text),
    itemWorld: (index: number) => this.conjure.debugActions.itemWorld(index),
    strokePoint: (stroke: number, point: number) => this.sketch.debugActions.strokePoint(stroke, point),
    printWorld: (index: number) => this.clay.debugActions.printWorld(index),
    clayWorld: (x: number, y: number, z: number) => this.clay.debugActions.clayWorld(x, y, z),
    clear: () => this.sketch.debugActions.clear(),
    windowWorld: (id: WindowId) => {
      const d = this.win(id).debug();
      const v = (p: Vector3) => ({ x: p.x, y: p.y, z: p.z });
      return { handle: v(d.handle), pin: v(d.pin), focus: v(d.focus), hide: v(d.hide) };
    },
    resetLayout: () => this.resetLayout(),
  };
}
