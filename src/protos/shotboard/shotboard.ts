/**
 * Shot Board: storyboard a scene by framing shots with your hands.
 *
 * A small set sits on your desk: a street, a campsite or a living room,
 * with a painted backdrop and the same three characters in each. Grab a
 * piece (thumb + middle finger) to move it; turn your wrist while holding
 * it to turn it. Scene switches sets, Light goes day / sunset / night, and
 * the panel suggests the next shot from the set's shot list. Frame a shot anywhere in the lab by pinching with both
 * hands and pulling them apart (the host owns that gesture); every shot
 * lands in the shared album, which this board shows on your wall. "Snap
 * view" captures straight ahead for one-handed or desktop use, and "Play"
 * runs the board as an animatic.
 */

import { BoxGeometry, type CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, PointLight, Vector3 } from '@iwsdk/core';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { SHOT_H, SHOT_W } from '../../core/camera-frame.js';
import { type LabContext, type Prototype, store } from '../../core/context.js';
import { HeldPose } from '../../core/grab.js';
import { grabDistance, type HandState } from '../../core/hands.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import { StoryboardWall } from '../../core/storyboard.js';
import { buildSet, type Light, LIGHTS, paintTexture, SET_IDS, type SetId, type SetSpec } from './sets.js';

const STAGE_W = 0.4;
const STAGE_D = 0.26;

interface Prop {
  group: Group;
  name: string;
}

const SET_KEY = 'shotboard-set-v1';
const LIGHT_KEY = 'shotboard-light-v1';
const GLOW: Record<Light, number> = { day: 0.15, sunset: 0.7, night: 1.6 };

export class ShotBoardPrototype implements Prototype {
  readonly id = 'shotboard';
  readonly title = 'Shot Board';
  readonly tagline = 'Frame shots with your hands';
  readonly accent = ACCENTS.shotboard;
  readonly howTo = [
    'Grab a figure (thumb + middle finger) to move it; turn your wrist to turn it.',
    'Pinch (thumb + index) with BOTH hands close together, pull apart to frame a shot.',
    'Let go to capture. It works anywhere in the lab.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private board!: StoryboardWall;
  private props: Prop[] = [];
  private selected: Prop | null = null;
  private drag: { prop: Prop; hand: HandState; pose: HeldPose } | null = null;
  private status = '';
  private readonly tmp = new Vector3();
  private set!: SetSpec;
  private light: Light = 'day';
  private setRoot = new Group();
  private backdropMat!: MeshBasicMaterial;
  private floorMat!: MeshStandardMaterial;
  private readonly lamp = new PointLight('#ffb35a', 0, 0.35, 1.5);

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.buildStage();

    this.panel = new CanvasPanel({ width: 0.36, height: 0.17, columns: 3, buttonHeight: 0.032, accent: this.accent });
    this.panel.mesh.name = 'ShotPanel';
    // Off to the right of the stage, angled toward the user.
    this.panel.mesh.position.set(STAGE_W / 2 + 0.13, 0.085, -0.02);
    this.panel.mesh.rotation.set(-0.25, -0.5, 0, 'YXZ');
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    // Storyboard: a 3 x 2 grid of the newest album shots.
    this.board = new StoryboardWall(ctx, this.wallRoot, this.accent);
  }

  private buildStage(): void {
    // The stage: a shallow box whose top is the set's floor, and a painted backdrop.
    const stage = new Mesh(new BoxGeometry(STAGE_W, 0.008, STAGE_D), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.9 }));
    stage.position.y = 0.004;
    this.floorMat = new MeshStandardMaterial({ roughness: 0.9 });
    const floor = new Mesh(new PlaneGeometry(STAGE_W, STAGE_D), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.0082;
    // Unlit, so the painted sky reads the same whatever the room light.
    this.backdropMat = new MeshBasicMaterial();
    const backdrop = new Mesh(new PlaneGeometry(STAGE_W, 0.16), this.backdropMat);
    backdrop.position.set(0, 0.088, -STAGE_D / 2 + 0.002);
    const frame = new Mesh(new BoxGeometry(STAGE_W + 0.008, 0.168, 0.004), new MeshStandardMaterial({ color: '#2a2e36' }));
    frame.position.set(0, 0.088, -STAGE_D / 2 - 0.001);
    this.deskRoot.add(stage, floor, frame, backdrop, this.setRoot, this.lamp);
    const saved = store.get<string>(SET_KEY, 'street');
    this.light = LIGHTS.includes(store.get<Light>(LIGHT_KEY, 'day')) ? store.get<Light>(LIGHT_KEY, 'day') : 'day';
    this.setScene(SET_IDS.includes(saved as SetId) ? (saved as SetId) : 'street');
  }

  /** Swap in a set: its floor, backdrop and props. */
  private setScene(id: SetId): void {
    this.drag = null;
    this.selected = null;
    for (const child of [...this.setRoot.children]) {
      this.setRoot.remove(child);
      child.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
      });
    }
    this.props = [];
    this.set = buildSet(id);
    store.set(SET_KEY, id);
    for (const spec of this.set.props) {
      const group = spec.group;
      group.position.set(spec.x, 0.008, spec.z);
      group.rotation.y = spec.yaw;
      group.name = spec.name;
      group.add(blobShadow(spec.shadow));
      this.setRoot.add(group);
      this.props.push({ group, name: spec.name });
    }
    (this.floorMat.map as CanvasTexture | null)?.dispose();
    this.floorMat.map = paintTexture(512, Math.round((512 * STAGE_D) / STAGE_W), this.set.paintFloor);
    this.floorMat.needsUpdate = true;
    this.setLight(this.light);
  }

  /** Day, sunset or night: repaint the sky, light the lamps and fires. */
  private setLight(light: Light): void {
    this.light = light;
    store.set(LIGHT_KEY, light);
    (this.backdropMat.map as CanvasTexture | null)?.dispose();
    this.backdropMat.map = paintTexture(640, 256, (c, w, h) => this.set.paintBackdrop(c, w, h, light));
    this.backdropMat.needsUpdate = true;
    for (const spec of this.set.props) for (const m of spec.glow ?? []) m.emissiveIntensity = GLOW[light];
    const at = this.set.nightLight;
    this.lamp.visible = at != null && light !== 'day';
    if (at) this.lamp.position.set(...at);
    this.lamp.intensity = light === 'night' ? 0.25 : 0.08;
    // A dim stage at night; full light by day.
    this.floorMat.color.set(light === 'day' ? '#ffffff' : light === 'sunset' ? '#e8c9a8' : '#6f7896');
  }

  enter(): void {
    this.status = this.ctx.immersive
      ? 'Pinch both hands close together and pull apart to frame a shot.'
      : 'Drag pieces on the stage, then Snap view to capture a shot.';
    this.board.layout();
    this.refresh();
  }

  exit(): void {
    this.drag = null;
  }

  /** Pinch (both hands) frames a shot; grab moves figures and cards. */
  fingerHints(): { index: string; middle: string } {
    return { index: 'snap', middle: 'move' };
  }

  holding(): boolean {
    return this.drag != null || this.board.dragging;
  }

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
    this.board.update(dt);
    this.updateGestures();
    this.updateDrag();
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
    if (this.drag == null) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.grabStarted || this.panel.contains(hand.holdPoint)) continue;
        const prop = this.propNear(hand);
        if (prop) {
          // Figures stay upright but turn with your wrist.
          const pose = new HeldPose();
          pose.begin(hand, prop.group, { upright: true });
          this.drag = { prop, hand, pose };
          this.selected = prop;
          Sfx.pinch(hand.holdPoint);
          break;
        }
      }
      return;
    }
    const { prop, hand } = this.drag;
    if (!hand.grabbing || !hand.tracked) {
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
      const d = grabDistance(hand, this.tmp);
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

  // ------------------------------------------------------------ UI

  private onButton(id: string): void {
    if (id === 'scene') {
      this.setScene(SET_IDS[(SET_IDS.indexOf(this.set.id) + 1) % SET_IDS.length]);
      this.status = `Scene: ${this.set.title}.`;
    }
    if (id === 'light') {
      this.setLight(LIGHTS[(LIGHTS.indexOf(this.light) + 1) % LIGHTS.length]);
      this.status = `Light: ${this.light}.`;
    }
    if (id === 'snap') this.snapView();
    if (id === 'undo') this.ctx.album.removeLast();
    if (id === 'play') this.board.play();
  }

  private refresh(): void {
    const count = this.ctx.album.shots.length;
    const list = this.set.shotList;
    const next = list[count % list.length];
    this.panel.setText(
      `Shot Board - ${this.set.title}, ${this.light} - ${count} shot${count === 1 ? '' : 's'}`,
      '',
      [`Next shot (${(count % list.length) + 1} of ${list.length}): ${next}`, this.status || (this.selected ? `Holding ${this.selected.name}: turn your wrist to turn it.` : 'Grab a piece (thumb + middle finger) to move it.')],
    );
    this.panel.setButtons([
      { id: 'scene', label: `Scene: ${this.set.title}` },
      { id: 'light', label: `Light: ${this.light}` },
      { id: 'snap', label: 'Snap view', tone: 'primary' },
      { id: 'play', label: this.board.playing >= 0 ? 'Playing' : 'Play', disabled: count === 0 },
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
      playing: this.board.playing,
      set: this.set.id,
      light: this.light,
      nightLight: this.lamp.visible,
      nextShot: this.set.shotList[this.ctx.album.shots.length % this.set.shotList.length],
    };
  }

  debugActions = {
    press: (id: string) => this.panel.press(id),
    cardWorld: (i: number) => this.board.cardWorld(i),
    shotIds: () => this.ctx.album.shots.map((s) => s.id),
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
