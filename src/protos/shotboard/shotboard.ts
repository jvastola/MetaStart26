/**
 * Shot Board: storyboard a scene by framing shots with your hands.
 *
 * A small set sits on your desk: figures, a tree, a house, a lamp. Pinch a
 * piece to move it; turn your wrist while holding it to turn it. Frame a
 * shot anywhere in the lab by pinching with both hands and pulling them
 * apart (the host owns that gesture); every shot lands in the shared album,
 * which this board shows on your wall. "Snap view" captures straight ahead
 * for one-handed or desktop use, and "Play" runs the board as an animatic.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { SHOT_H, SHOT_W } from '../../core/camera-frame.js';
import type { LabContext, Prototype } from '../../core/context.js';
import { HeldPose } from '../../core/grab.js';
import { type HandState, pointerDistance } from '../../core/hands.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';

const STAGE_W = 0.4;
const STAGE_D = 0.26;
/** The board shows the newest shots. */
const BOARD_SLOTS = 6;

interface Prop {
  group: Group;
  name: string;
}

export class ShotBoardPrototype implements Prototype {
  readonly id = 'shotboard';
  readonly title = 'Shot Board';
  readonly tagline = 'Frame shots with your hands';
  readonly accent = ACCENTS.shotboard;
  readonly howTo = [
    'Pinch a figure to move it; turn your wrist to turn it.',
    'Pinch BOTH hands close together, pull apart to frame a shot.',
    'Let go to capture. It works anywhere in the lab.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private board!: CanvasPanel;
  private props: Prop[] = [];
  private selected: Prop | null = null;
  private drag: { prop: Prop; hand: HandState; pose: HeldPose } | null = null;
  private quads: Mesh[] = [];
  private playing = -1;
  private playTime = 0;
  private preview!: Mesh;
  private status = '';
  private readonly tmp = new Vector3();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.buildStage();

    this.panel = new CanvasPanel({ width: 0.36, height: 0.13, columns: 4, buttonHeight: 0.034, accent: this.accent });
    this.panel.mesh.name = 'ShotPanel';
    // Off to the right of the stage, angled toward the user.
    this.panel.mesh.position.set(STAGE_W / 2 + 0.13, 0.085, -0.02);
    this.panel.mesh.rotation.set(-0.25, -0.5, 0, 'YXZ');
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    // Storyboard: a 3 x 2 grid of the newest album shots.
    this.board = new CanvasPanel({ width: 0.66, height: 0.38, columns: 1, accent: this.accent });
    this.wallRoot.add(this.board.mesh);
    for (let i = 0; i < BOARD_SLOTS; i += 1) {
      const quad = new Mesh(new PlaneGeometry(0.19, 0.107), new MeshBasicMaterial({ color: '#ffffff' }));
      quad.position.set(-0.205 + (i % 3) * 0.205, 0.07 - Math.floor(i / 3) * 0.135, 0.004);
      quad.userData.hideInShots = true;
      quad.visible = false;
      this.wallRoot.add(quad);
      this.quads.push(quad);
    }
    this.preview = new Mesh(new PlaneGeometry(0.56, 0.315), new MeshBasicMaterial({ color: '#ffffff' }));
    this.preview.position.set(0, -0.01, 0.006);
    this.preview.userData.hideInShots = true;
    this.preview.visible = false;
    this.wallRoot.add(this.preview);
    ctx.album.onChange(() => this.layoutShots());
    this.layoutShots();
  }

  private buildStage(): void {
    const stage = new Mesh(new BoxGeometry(STAGE_W, 0.008, STAGE_D), new MeshStandardMaterial({ color: '#d9c7a3', roughness: 0.9 }));
    stage.position.y = 0.004;
    this.deskRoot.add(stage);
    const backdrop = new Mesh(new BoxGeometry(STAGE_W, 0.12, 0.006), new MeshStandardMaterial({ color: '#8fb3d9', roughness: 0.9 }));
    backdrop.position.set(0, 0.068, -STAGE_D / 2);
    this.deskRoot.add(backdrop);

    const figure = (color: string): Group => {
      const g = new Group();
      const mat = new MeshStandardMaterial({ color: new Color(color), roughness: 0.6 });
      const body = new Mesh(new CylinderGeometry(0.009, 0.014, 0.04, 14), mat);
      body.position.y = 0.028;
      const head = new Mesh(new SphereGeometry(0.01, 14, 10), new MeshStandardMaterial({ color: '#f1d2b6' }));
      head.position.y = 0.058;
      const nose = new Mesh(new BoxGeometry(0.004, 0.004, 0.006), mat);
      nose.position.set(0, 0.058, 0.011);
      g.add(body, head, nose);
      return g;
    };
    const tree = (): Group => {
      const g = new Group();
      const trunk = new Mesh(new CylinderGeometry(0.004, 0.005, 0.03, 8), new MeshStandardMaterial({ color: '#7a5233' }));
      trunk.position.y = 0.023;
      const top = new Mesh(new ConeGeometry(0.022, 0.05, 10), new MeshStandardMaterial({ color: '#4caf50' }));
      top.position.y = 0.06;
      g.add(trunk, top);
      return g;
    };
    const house = (): Group => {
      const g = new Group();
      const base = new Mesh(new BoxGeometry(0.05, 0.035, 0.04), new MeshStandardMaterial({ color: '#e9dcc3' }));
      base.position.y = 0.0255;
      const roof = new Mesh(new ConeGeometry(0.04, 0.03, 4), new MeshStandardMaterial({ color: '#b5533c' }));
      roof.position.y = 0.058;
      roof.rotation.y = Math.PI / 4;
      g.add(base, roof);
      return g;
    };
    const lamp = (): Group => {
      const g = new Group();
      const pole = new Mesh(new CylinderGeometry(0.002, 0.002, 0.07, 6), new MeshStandardMaterial({ color: '#2a2e36' }));
      pole.position.y = 0.043;
      const bulb = new Mesh(new SphereGeometry(0.008, 10, 8), new MeshBasicMaterial({ color: '#fff3b0' }));
      bulb.position.y = 0.08;
      g.add(pole, bulb);
      return g;
    };
    const place: [string, Group, number, number, number][] = [
      ['Hero', figure('#3f7fd9'), -0.06, 0.04, 0.4],
      ['Friend', figure('#e86fa4'), 0.02, 0.05, -0.6],
      ['Rival', figure('#d9483b'), 0.12, -0.03, -1.4],
      ['Tree', tree(), -0.15, -0.07, 0],
      ['House', house(), 0.1, -0.08, 0.3],
      ['Lamp', lamp(), -0.1, 0.08, 0],
    ];
    for (const [name, group, x, z, yaw] of place) {
      group.position.set(x, 0.008, z);
      group.rotation.y = yaw;
      group.name = name;
      group.add(blobShadow(name === 'House' ? 0.09 : 0.05));
      this.deskRoot.add(group);
      this.props.push({ group, name });
    }
  }

  enter(): void {
    this.status = this.ctx.immersive
      ? 'Pinch both hands close together and pull apart to frame a shot.'
      : 'Drag pieces on the stage, then Snap view to capture a shot.';
    this.layoutShots();
    this.refresh();
  }

  exit(): void {
    this.drag = null;
  }

  holding(): boolean {
    return this.drag != null;
  }

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
    this.board.update([], dt);
    this.updateGestures();
    this.updateDrag();
    this.updatePlayback(dt);
    this.refresh();
  }

  private updateGestures(): void {
    for (const hand of this.ctx.hands.both) {
      if (hand.gesture === 'left') this.turnSelected(-1);
      if (hand.gesture === 'right') this.turnSelected(1);
      if (hand.gesture === 'tap') this.snapView();
    }
  }

  private turnSelected(direction: number): void {
    if (!this.selected) return;
    this.selected.group.rotation.y += (direction * Math.PI) / 4;
    Sfx.blip(700);
  }

  // ------------------------------------------------------------ props

  private updateDrag(): void {
    const { left, right } = this.ctx.hands;
    const bothPinching = this.ctx.immersive && left.pinching && right.pinching;
    if (this.drag == null) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.pinchStarted || bothPinching || this.panel.contains(hand.pinchPoint)) continue;
        const prop = this.propNear(hand);
        if (prop) {
          // Figures stay upright but turn with your wrist.
          const pose = new HeldPose();
          pose.begin(hand, prop.group, { upright: true });
          this.drag = { prop, hand, pose };
          this.selected = prop;
          Sfx.pinch(hand.pinchPoint);
          break;
        }
      }
      return;
    }
    const { prop, hand } = this.drag;
    if (!hand.pinching || !hand.tracked) {
      prop.group.position.y = 0.008;
      this.drag = null;
      Sfx.place(prop.group.getWorldPosition(this.tmp));
      return;
    }
    this.drag.pose.apply(hand, prop.group, { upright: true });
    this.tmp.copy(prop.group.position);
    prop.group.position.set(
      Math.min(STAGE_W / 2 - 0.015, Math.max(-STAGE_W / 2 + 0.015, this.tmp.x)),
      0.018,
      Math.min(STAGE_D / 2 - 0.015, Math.max(-STAGE_D / 2 + 0.03, this.tmp.z)),
    );
  }

  private propNear(hand: HandState): Prop | null {
    let best: Prop | null = null;
    let bestDist = 0.045;
    for (const prop of this.props) {
      prop.group.getWorldPosition(this.tmp);
      this.tmp.y += 0.03;
      const d = pointerDistance(hand, this.tmp);
      if (d < bestDist) {
        bestDist = d;
        best = prop;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ shots

  /** Straight-ahead shot from the current view. */
  private snapView(): void {
    const cam = this.ctx.camera;
    const eye = cam.getWorldPosition(new Vector3());
    const target = eye.clone().add(cam.getWorldDirection(this.tmp));
    const caption = this.ctx.capture(eye, target, 50);
    this.status = `Shot ${this.ctx.album.shots.length} captured (${caption}).`;
  }

  private layoutShots(): void {
    if (!this.board) return;
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
    this.board.setText('Storyboard', '', all.length ? all.slice(-BOARD_SLOTS).map((s, i) => `${i + 1}. ${s.caption}`).join('   ') : 'No shots yet. Frame one with both hands.');
  }

  private updatePlayback(dt: number): void {
    if (this.playing < 0) return;
    const shots = this.ctx.album.shots.slice(-BOARD_SLOTS);
    this.playTime += dt;
    if (this.playTime > 1.6) {
      this.playTime = 0;
      this.playing += 1;
      if (this.playing >= shots.length) {
        this.playing = -1;
        this.preview.visible = false;
        this.layoutShots();
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

  private play(): void {
    if (this.ctx.album.shots.length === 0) return;
    this.playing = 0;
    this.playTime = 0;
    this.preview.visible = true;
    for (const q of this.quads) q.visible = false;
    const material = this.preview.material as MeshBasicMaterial;
    material.map = this.ctx.album.shots.slice(-BOARD_SLOTS)[0].texture;
    material.needsUpdate = true;
  }

  // ------------------------------------------------------------ UI

  private onButton(id: string): void {
    if (id === 'snap') this.snapView();
    if (id === 'turn') this.turnSelected(1);
    if (id === 'undo') this.ctx.album.removeLast();
    if (id === 'play') this.play();
  }

  private refresh(): void {
    const count = this.ctx.album.shots.length;
    this.panel.setText(
      `Shot Board - ${count} shot${count === 1 ? '' : 's'}`,
      '',
      [this.status, this.selected ? `Holding ${this.selected.name}: turn your wrist to turn it.` : 'Pinch a piece to move it.'],
    );
    this.panel.setButtons([
      { id: 'snap', label: 'Snap view', tone: 'primary' },
      { id: 'turn', label: 'Turn', disabled: !this.selected },
      { id: 'play', label: this.playing >= 0 ? 'Playing' : 'Play', disabled: count === 0 },
      { id: 'undo', label: 'Undo shot', disabled: count === 0 },
    ]);
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      shots: this.ctx.album.shots.map((s) => s.caption),
      selected: this.selected?.name ?? null,
      props: Object.fromEntries(
        this.props.map((p) => [p.name, [+p.group.position.x.toFixed(3), +p.group.position.z.toFixed(3), +p.group.rotation.y.toFixed(2)]]),
      ),
      playing: this.playing,
    };
  }

  debugActions = {
    press: (id: string) => this.panel.press(id),
    propWorld: (name: string) => {
      const prop = this.props.find((p) => p.name === name);
      if (!prop) return null;
      const v = prop.group.getWorldPosition(new Vector3());
      return { x: v.x, y: v.y + 0.03, z: v.z };
    },
    shotPixels: (index: number) => {
      const shot = this.ctx.album.shots[index];
      if (!shot?.target) return null;
      const buffer = new Uint8Array(4 * 16);
      this.ctx.renderer.readRenderTargetPixels(shot.target, SHOT_W / 2 - 2, SHOT_H / 2 - 2, 4, 4, buffer);
      return Array.from(buffer.slice(0, 8));
    },
  };
}
