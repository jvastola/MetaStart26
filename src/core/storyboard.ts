/**
 * The storyboard: the newest album shots as framed 3D cards on a gentle arc,
 * a title strip above, and round buttons on a ledge below (play, remove the
 * last shot). Playing lifts each shot into a large card in front, one every
 * 1.6 s, like an animatic. Shot Board hangs one on the wall; Studio has one
 * as a window.
 */

import {
  BoxGeometry,
  CanvasTexture,
  type Group,
  Group as ThreeGroup,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';
import type { LabContext } from './context.js';
import { IconButton } from './icon-button.js';
import { CanvasPanel } from './panel.js';
import { Sfx } from './sfx.js';

/** The board shows the newest shots. */
export const BOARD_SLOTS = 6;

const CARD_W = 0.19;
const CARD_H = 0.107;
const COLS = 3;

interface Card {
  group: ThreeGroup;
  picture: Mesh;
  badge: Mesh;
  badgeCanvas: HTMLCanvasElement;
  badgeTexture: CanvasTexture;
  index: number;
}

export class StoryboardWall {
  /** Title strip (text only). */
  readonly board: CanvasPanel;
  private readonly cards: Card[] = [];
  private readonly preview: ThreeGroup;
  private readonly previewPicture: Mesh;
  private readonly playButton: IconButton;
  private readonly undoButton: IconButton;
  /** Index of the shot being played, or -1. */
  playing = -1;
  private playTime = 0;

  constructor(
    private readonly ctx: LabContext,
    parent: Group,
    accent: string,
  ) {
    this.board = new CanvasPanel({ width: 0.66, height: 0.05, columns: 1, accent });
    this.board.mesh.name = 'Storyboard';
    this.board.mesh.position.set(0, 0.165, 0);
    parent.add(this.board.mesh);

    // A soft backing so the cards read against a bright room.
    const back = new Mesh(new PlaneGeometry(0.7, 0.3), new MeshBasicMaterial({ color: '#14161b', transparent: true, opacity: 0.55, depthWrite: false }));
    back.position.set(0, 0.0, -0.03);
    back.userData.hideInShots = true;
    parent.add(back);

    const frameMat = new MeshStandardMaterial({ color: '#23262e', roughness: 0.5, metalness: 0.1 });
    for (let i = 0; i < BOARD_SLOTS; i += 1) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const group = new ThreeGroup();
      // A gentle arc: side cards come forward and turn toward the middle.
      const side = col - (COLS - 1) / 2;
      group.position.set(side * 0.215, 0.07 - row * 0.135, Math.abs(side) * 0.035);
      group.rotation.y = -side * 0.22;
      const frame = new Mesh(new BoxGeometry(CARD_W + 0.012, CARD_H + 0.012, 0.008), frameMat);
      frame.position.z = -0.004;
      const picture = new Mesh(new PlaneGeometry(CARD_W, CARD_H), new MeshBasicMaterial({ color: '#ffffff' }));
      picture.position.z = 0.0005;
      const badgeCanvas = document.createElement('canvas');
      badgeCanvas.width = badgeCanvas.height = 64;
      const badgeTexture = new CanvasTexture(badgeCanvas);
      badgeTexture.colorSpace = SRGBColorSpace;
      const badge = new Mesh(new PlaneGeometry(0.022, 0.022), new MeshBasicMaterial({ map: badgeTexture, transparent: true }));
      badge.position.set(-CARD_W / 2 + 0.016, CARD_H / 2 - 0.016, 0.002);
      group.add(frame, picture, badge);
      group.userData.hideInShots = true;
      group.visible = false;
      parent.add(group);
      this.cards.push({ group, picture, badge, badgeCanvas, badgeTexture, index: -1 });
    }

    this.preview = new ThreeGroup();
    const pFrame = new Mesh(new BoxGeometry(0.58, 0.335, 0.01), frameMat);
    pFrame.position.z = -0.005;
    this.previewPicture = new Mesh(new PlaneGeometry(0.56, 0.315), new MeshBasicMaterial({ color: '#ffffff' }));
    this.previewPicture.position.z = 0.001;
    this.preview.add(pFrame, this.previewPicture);
    this.preview.position.set(0, 0.005, 0.07);
    this.preview.userData.hideInShots = true;
    this.preview.visible = false;
    parent.add(this.preview);

    // A ledge under the board with round buttons on it.
    const ledge = new Mesh(new BoxGeometry(0.2, 0.006, 0.06), frameMat);
    ledge.position.set(0, -0.175, 0.03);
    ledge.userData.hideInShots = true;
    parent.add(ledge);
    this.playButton = new IconButton({ id: `board:play:${Math.random().toString(36).slice(2, 6)}`, icon: 'play', label: 'Play the storyboard', accent, radius: 0.015 });
    this.playButton.group.position.set(-0.035, -0.172, 0.03);
    this.playButton.onPress = () => (this.playing >= 0 ? this.stop() : this.play());
    this.undoButton = new IconButton({ id: `board:undo:${Math.random().toString(36).slice(2, 6)}`, icon: 'undo', label: 'Remove the last shot', accent, radius: 0.015 });
    this.undoButton.group.position.set(0.035, -0.172, 0.03);
    this.undoButton.onPress = () => ctx.album.removeLast();
    parent.add(this.playButton.group, this.undoButton.group);

    ctx.album.onChange(() => this.layout());
    this.layout();
  }

  layout(): void {
    const all = this.ctx.album.shots;
    const shots = all.slice(-BOARD_SLOTS);
    const first = all.length - shots.length;
    this.cards.forEach((card, i) => {
      const shot = shots[i];
      card.group.visible = shot != null && this.playing < 0;
      if (!shot) return;
      const material = card.picture.material as MeshBasicMaterial;
      if (material.map !== shot.texture) {
        material.map = shot.texture;
        material.needsUpdate = true;
      }
      if (card.index !== first + i) {
        card.index = first + i;
        const c = card.badgeCanvas.getContext('2d')!;
        c.clearRect(0, 0, 64, 64);
        c.fillStyle = 'rgba(20,22,27,0.85)';
        c.beginPath();
        c.arc(32, 32, 30, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#f4f5f7';
        c.font = '700 34px system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(card.index + 1), 32, 34);
        card.badgeTexture.needsUpdate = true;
      }
    });
    this.board.setText(
      `Storyboard - ${all.length} shot${all.length === 1 ? '' : 's'}`,
      '',
      all.length ? '' : 'No shots yet. Pinch both hands together and pull apart to frame one.',
    );
    this.playButton.disabled = all.length === 0;
    this.undoButton.disabled = all.length === 0;
  }

  update(dt: number): void {
    this.board.update([], dt);
    this.playButton.active = this.playing >= 0;
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
    const material = this.previewPicture.material as MeshBasicMaterial;
    const shot = shots[this.playing];
    if (shot && material.map !== shot.texture) {
      material.map = shot.texture;
      material.needsUpdate = true;
    }
    // Ease the preview forward as each shot starts.
    const k = Math.min(1, this.playTime / 0.25);
    this.preview.scale.setScalar(0.92 + k * 0.08);
  }

  /** Run the board as an animatic, one shot every 1.6 s. */
  play(): void {
    if (this.ctx.album.shots.length === 0) return;
    this.playing = 0;
    this.playTime = 0;
    this.preview.visible = true;
    for (const c of this.cards) c.group.visible = false;
    const material = this.previewPicture.material as MeshBasicMaterial;
    material.map = this.ctx.album.shots.slice(-BOARD_SLOTS)[0].texture;
    material.needsUpdate = true;
  }

  stop(): void {
    this.playing = -1;
    this.preview.visible = false;
    this.layout();
  }
}
