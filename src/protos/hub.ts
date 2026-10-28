/**
 * The launcher: one panel standing on the far side of the desk with a button
 * per prototype. It doubles as the first lesson in the controller-free input
 * every prototype uses: poke a button with a fingertip, or pinch on it.
 */

import { Group } from '@iwsdk/core';
import type { LabContext, Prototype } from '../core/context.js';
import { CanvasPanel } from '../core/panel.js';

export class HubPrototype implements Prototype {
  readonly id = 'hub';
  readonly title = 'Lab';
  readonly tagline = 'Pick a prototype';
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();
  private ctx!: LabContext;
  private panel!: CanvasPanel;

  constructor(
    private readonly entries: () => Prototype[],
    private readonly pick: (id: string) => void,
  ) {}

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.panel = new CanvasPanel({ width: 0.46, height: 0.34, columns: 2, buttonHeight: 0.052 });
    this.panel.mesh.name = 'HubPanel';
    this.panel.mesh.position.set(0, 0.2, -0.1);
    this.panel.mesh.rotation.x = -0.18;
    this.panel.onPress = (id) => this.pick(id);
    this.deskRoot.add(this.panel.mesh);
  }

  enter(): void {
    this.panel.setText(
      'Meta VR Start 2026 - prototype lab',
      'What do you want to try?',
      this.ctx.immersive
        ? 'Poke a button with your fingertip, or pinch on it. Turn your left palm toward you any time for the menu.'
        : 'Click a prototype, or press 0-5. Enter XR to use your hands.',
    );
    this.panel.setButtons(
      this.entries().map((p) => ({ id: p.id, label: p.title, sub: p.tagline, tone: 'default' as const })),
    );
  }

  exit(): void {}

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
  }

  debugState(): unknown {
    return { buttons: this.panel.buttonIds };
  }

  debugActions = {
    press: (id: string) => this.panel.press(id),
  };
}
