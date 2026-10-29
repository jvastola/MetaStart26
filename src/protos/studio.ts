/**
 * Studio: Sketch, Conjure and the storyboard together in one workspace.
 *
 * Draw in the air with thumb + index, ask Conjure for objects by voice or
 * keyboard, grab strokes and creations with thumb + middle to arrange a
 * scene, then frame shots with both hands. Shots land on the storyboard on
 * your wall, which plays back as an animatic.
 *
 * Studio embeds its own Sketch and Conjure instances (with separate saved
 * strokes) and decides who gets each gesture: Conjure looks first, so a
 * grab on a creation picks it up rather than a stroke behind it.
 */

import { Group, Vector3 } from '@iwsdk/core';
import { ACCENTS } from '../core/art.js';
import type { LabContext, Prototype } from '../core/context.js';
import { StoryboardWall } from '../core/storyboard.js';
import { ConjurePrototype } from './conjure/conjure.js';
import { SketchPrototype } from './sketch/sketch.js';

export class StudioPrototype implements Prototype {
  readonly id = 'studio';
  readonly title = 'Studio';
  readonly tagline = 'Sketch, conjure and storyboard';
  readonly accent = ACCENTS.studio;
  readonly howTo = [
    'Pinch (thumb + index) to draw. Speak or Type to conjure objects.',
    'Grab (thumb + middle) to move strokes and creations.',
    'Pinch both hands together, pull apart: the shot goes on the storyboard.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private board!: StoryboardWall;
  private status = '';
  private readonly sketch = new SketchPrototype({
    saveKey: 'studio-sketch-v1',
    heading: 'Studio',
    // Right of the pedestal and shelf, angled toward you.
    panel: { position: [0.4, 0.09, 0.06], rotation: [-0.25, -0.65, 0] },
    wheel: { position: [-0.4, 0.13, 0.06], rotation: [-0.2, 0.65, 0], visible: false },
    // Conjure owns the thumb microgestures here (tap = speak).
    gestures: false,
    extraButtons: () => [
      { id: 'snap', label: 'Snap view', span: 2, tone: 'primary' },
      { id: 'play', label: this.board?.playing >= 0 ? 'Playing' : 'Play board', span: 2, disabled: this.ctx.album.shots.length === 0 },
    ],
    onExtra: (id) => {
      if (id === 'snap') this.snapView();
      if (id === 'play') this.board.play();
    },
  });
  private readonly conjure = new ConjurePrototype();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.sketch.init(ctx);
    this.conjure.init(ctx);
    this.deskRoot.add(this.conjure.deskRoot, this.sketch.deskRoot);
    this.wallRoot.add(this.conjure.wallRoot, this.sketch.wallRoot);
    this.board = new StoryboardWall(ctx, this.wallRoot, this.accent);
  }

  enter(): void {
    this.conjure.enter();
    this.sketch.enter();
    this.board.layout();
  }

  exit(): void {
    this.sketch.exit();
    this.conjure.exit();
    this.board.stop();
  }

  holding(): boolean {
    return this.conjure.holding() || this.sketch.holding();
  }

  update(dt: number): void {
    this.board.update(dt);
    this.conjure.update(dt);
    // A hand that just picked up a creation does not also draw or grab a stroke.
    for (const hand of this.ctx.pointers) {
      if ((hand.grabStarted || hand.pinchStarted) && this.conjure.heldBy(hand)) hand.clearEdges();
    }
    this.sketch.update(dt);
  }

  /** Straight-ahead shot from the current view (desktop, or one hand busy). */
  private snapView(): void {
    const cam = this.ctx.camera;
    const eye = cam.getWorldPosition(new Vector3());
    const target = eye.clone().add(cam.getWorldDirection(new Vector3()));
    const caption = this.ctx.capture(eye, target, 50);
    this.status = `Shot ${this.ctx.album.shots.length} captured (${caption}).`;
  }

  debugState(): unknown {
    return {
      sketch: this.sketch.debugState(),
      conjure: this.conjure.debugState(),
      shots: this.ctx.album.shots.length,
      playing: this.board.playing,
      status: this.status,
    };
  }

  debugActions = {
    press: (id: string) => {
      if (['color', 'size', 'undo', 'clear', 'snap', 'play'].includes(id)) this.sketch.debugActions.press(id);
      else this.conjure.debugActions.press(id);
    },
    say: (text: string) => this.conjure.debugActions.say(text),
    itemWorld: (index: number) => this.conjure.debugActions.itemWorld(index),
    strokePoint: (stroke: number, point: number) => this.sketch.debugActions.strokePoint(stroke, point),
    clear: () => this.sketch.debugActions.clear(),
  };
}
