/**
 * The storyboard wall: the newest album shots in a 3 x 2 grid, plus an
 * animatic player. Shot Board and Studio both hang one on their wall.
 */

import { type Group, Mesh, MeshBasicMaterial, PlaneGeometry } from '@iwsdk/core';
import type { LabContext } from './context.js';
import { CanvasPanel } from './panel.js';
import { Sfx } from './sfx.js';

/** The board shows the newest shots. */
export const BOARD_SLOTS = 6;

export class StoryboardWall {
  readonly board: CanvasPanel;
  private readonly quads: Mesh[] = [];
  private readonly preview: Mesh;
  /** Index of the shot being played, or -1. */
  playing = -1;
  private playTime = 0;

  constructor(
    private readonly ctx: LabContext,
    parent: Group,
    accent: string,
  ) {
    this.board = new CanvasPanel({ width: 0.66, height: 0.38, columns: 1, accent });
    this.board.mesh.name = 'Storyboard';
    parent.add(this.board.mesh);
    for (let i = 0; i < BOARD_SLOTS; i += 1) {
      const quad = new Mesh(new PlaneGeometry(0.19, 0.107), new MeshBasicMaterial({ color: '#ffffff' }));
      quad.position.set(-0.205 + (i % 3) * 0.205, 0.07 - Math.floor(i / 3) * 0.135, 0.004);
      quad.userData.hideInShots = true;
      quad.visible = false;
      parent.add(quad);
      this.quads.push(quad);
    }
    this.preview = new Mesh(new PlaneGeometry(0.56, 0.315), new MeshBasicMaterial({ color: '#ffffff' }));
    this.preview.position.set(0, -0.01, 0.006);
    this.preview.userData.hideInShots = true;
    this.preview.visible = false;
    parent.add(this.preview);
    ctx.album.onChange(() => this.layout());
    this.layout();
  }

  layout(): void {
    const shots = this.ctx.album.shots.slice(-BOARD_SLOTS);
    this.quads.forEach((quad, i) => {
      const shot = shots[i];
      const material = quad.material as MeshBasicMaterial;
      quad.visible = shot != null && this.playing < 0;
      if (shot && material.map !== shot.texture) {
        material.map = shot.texture;
        material.needsUpdate = true;
      }
    });
    const all = this.ctx.album.shots;
    this.board.setText(
      'Storyboard',
      '',
      all.length ? all.slice(-BOARD_SLOTS).map((s, i) => `${i + 1}. ${s.caption}`).join('   ') : 'No shots yet. Frame one with both hands.',
    );
  }

  update(dt: number): void {
    this.board.update([], dt);
    if (this.playing < 0) return;
    const shots = this.ctx.album.shots.slice(-BOARD_SLOTS);
    this.playTime += dt;
    if (this.playTime > 1.6) {
      this.playTime = 0;
      this.playing += 1;
      if (this.playing >= shots.length) {
        this.stop();
        return;
      }
      Sfx.blip(500 + this.playing * 60);
    }
    const material = this.preview.material as MeshBasicMaterial;
    const shot = shots[this.playing];
    if (shot && material.map !== shot.texture) {
      material.map = shot.texture;
      material.needsUpdate = true;
    }
  }

  /** Run the board as an animatic, one shot every 1.6 s. */
  play(): void {
    if (this.ctx.album.shots.length === 0) return;
    this.playing = 0;
    this.playTime = 0;
    this.preview.visible = true;
    for (const q of this.quads) q.visible = false;
    const material = this.preview.material as MeshBasicMaterial;
    material.map = this.ctx.album.shots.slice(-BOARD_SLOTS)[0].texture;
    material.needsUpdate = true;
  }

  stop(): void {
    this.playing = -1;
    this.preview.visible = false;
    this.layout();
  }
}
