/**
 * Shot Board: storyboard a scene by framing shots with your hands.
 *
 * A small set sits on your desk: figures, a tree, a house, a lamp. Pinch a
 * piece to move it around the stage (thumb-swipe or "Turn" to rotate it).
 * To take a shot, pinch with both hands and pull them apart like a
 * director's frame: the rectangle between your pinches becomes the camera
 * frame, seen from your eyes. Release to capture it into the storyboard on
 * your wall. "Snap view" captures straight ahead, for one-handed or
 * desktop use. "Play" runs the board as an animatic.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
  WebGLRenderTarget,
} from '@iwsdk/core';
import type { LabContext, Prototype } from '../../core/context.js';
import { type HandState, pointerDistance } from '../../core/hands.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';

const STAGE_W = 0.4;
const STAGE_D = 0.26;
const MAX_SHOTS = 6;
const SHOT_W = 480;
const SHOT_H = 270;
const MIN_FRAME = 0.08;
const UP = new Vector3(0, 1, 0);

interface Prop {
  group: Group;
  name: string;
}

interface Shot {
  target: WebGLRenderTarget;
  quad: Mesh;
  caption: string;
}

export class ShotBoardPrototype implements Prototype {
  readonly id = 'shotboard';
  readonly title = 'Shot Board';
  readonly tagline = 'Frame shots with your hands';
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private board!: CanvasPanel;
  private props: Prop[] = [];
  private selected: Prop | null = null;
  private drag: { prop: Prop; hand: HandState } | null = null;
  private shots: Shot[] = [];
  private shotCam = new PerspectiveCamera(50, SHOT_W / SHOT_H, 0.01, 20);
  private frameLine!: LineLoop;
  private framing = 0;
  private playing = -1;
  private playTime = 0;
  private preview!: Mesh;
  private status = '';
  private readonly tmp = new Vector3();
  private readonly center = new Vector3();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    this.buildStage();

    this.panel = new CanvasPanel({ width: 0.36, height: 0.13, columns: 4, buttonHeight: 0.034, accent: '#ffcf70' });
    this.panel.mesh.name = 'ShotPanel';
    // Off to the right of the stage, angled toward the user.
    this.panel.mesh.position.set(STAGE_W / 2 + 0.13, 0.085, -0.02);
    this.panel.mesh.rotation.set(-0.25, -0.5, 0, 'YXZ');
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    // Storyboard on the wall: a 3 x 2 grid of shots.
    this.board = new CanvasPanel({ width: 0.66, height: 0.38, columns: 1, accent: '#ffcf70' });
    this.board.setText('Storyboard', '', '');
    this.wallRoot.add(this.board.mesh);
    this.preview = new Mesh(new PlaneGeometry(0.56, 0.315), new MeshBasicMaterial({ color: '#ffffff' }));
    this.preview.position.set(0, -0.01, 0.004);
    this.preview.visible = false;
    this.wallRoot.add(this.preview);

    // Frame rectangle shown while both hands frame a shot.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(12), 3));
    this.frameLine = new LineLoop(geometry, new LineBasicMaterial({ color: '#ffcf70' }));
    this.frameLine.frustumCulled = false;
    this.frameLine.visible = false;
    ctx.world.createTransformEntity(this.frameLine);
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
      this.deskRoot.add(group);
      this.props.push({ group, name });
    }
  }

  enter(): void {
    this.status = this.ctx.immersive
      ? 'Pinch with both hands and pull apart to frame a shot. Release to capture.'
      : 'Drag pieces on the stage, then Snap view to capture a shot.';
    this.refresh();
  }

  exit(): void {
    this.drag = null;
    this.frameLine.visible = false;
    this.framing = 0;
  }

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
    this.board.update([], dt);
    this.updateGestures();
    this.updateDrag();
    this.updateFrame(dt);
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
    const framingNow = this.ctx.immersive && left.pinching && right.pinching;
    if (this.drag == null) {
      for (const hand of this.ctx.pointers) {
        if (!hand.tracked || !hand.pinchStarted || framingNow || this.panel.contains(hand.pinchPoint)) continue;
        const prop = this.propNear(hand);
        if (prop) {
          this.drag = { prop, hand };
          this.selected = prop;
          Sfx.pinch();
          break;
        }
      }
      return;
    }
    const { prop, hand } = this.drag;
    if (!hand.pinching || !hand.tracked) {
      prop.group.position.y = 0.008;
      this.drag = null;
      Sfx.place();
      return;
    }
    this.tmp.copy(hand.pinchPoint);
    this.deskRoot.worldToLocal(this.tmp);
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

  // ------------------------------------------------------------ framing

  private updateFrame(dt: number): void {
    const { left, right } = this.ctx.hands;
    const active = this.ctx.immersive && this.drag == null && left.tracked && right.tracked && left.pinching && right.pinching;
    if (active) {
      this.computeFrame(left.pinchPoint, right.pinchPoint);
      const big = Math.max(this.frameSize.x, this.frameSize.y) > MIN_FRAME;
      this.frameLine.visible = big;
      if (big) {
        if (this.framing === 0) Sfx.blip(980);
        this.framing += dt;
      }
      return;
    }
    if (this.framing > 0.25 && this.frameLine.visible) this.captureFrame();
    this.framing = 0;
    this.frameLine.visible = false;
  }

  /**
   * Build a frame rectangle facing the head with the two pinch points on
   * opposite corners, and write its corners into the line geometry.
   */
  private computeFrame(p: Vector3, q: Vector3): void {
    const head = this.ctx.head;
    this.center.copy(p).add(q).multiplyScalar(0.5);
    this.fForward.copy(this.center).sub(head).normalize();
    this.fRight.crossVectors(this.fForward, UP).normalize();
    this.fUp.crossVectors(this.fRight, this.fForward).normalize();
    this.tmp.copy(q).sub(p);
    const w = Math.abs(this.tmp.dot(this.fRight));
    const h = Math.abs(this.tmp.dot(this.fUp));
    const pos = this.frameLine.geometry.getAttribute('position') as Float32BufferAttribute;
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < 4; i += 1) {
      this.tmp
        .copy(this.center)
        .addScaledVector(this.fRight, (corners[i * 2] * w) / 2)
        .addScaledVector(this.fUp, (corners[i * 2 + 1] * h) / 2);
      pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    pos.needsUpdate = true;
    this.frameSize.set(w, h, this.center.distanceTo(head));
  }

  private readonly frameSize = new Vector3();
  private readonly fForward = new Vector3();
  private readonly fRight = new Vector3();
  private readonly fUp = new Vector3();

  private captureFrame(): void {
    const [w, h, dist] = [this.frameSize.x, this.frameSize.y, this.frameSize.z];
    const aspect = Math.min(2.4, Math.max(1, w / Math.max(h, 1e-3)));
    const height = w / aspect;
    const fov = (2 * Math.atan(height / 2 / Math.max(dist, 0.05)) * 180) / Math.PI;
    this.capture(this.ctx.head, this.center, Math.min(90, Math.max(12, fov)));
  }

  /** Straight-ahead shot from the current view. */
  private snapView(): void {
    const cam = this.ctx.camera;
    cam.getWorldDirection(this.tmp);
    const eye = cam.getWorldPosition(new Vector3());
    this.capture(eye, eye.clone().add(this.tmp), 50);
  }

  private capture(eye: Vector3, target: Vector3, fov: number): void {
    if (this.shots.length >= MAX_SHOTS) this.removeShot(0);
    const renderer = this.ctx.renderer;
    const scene = this.ctx.scene;
    const rt = new WebGLRenderTarget(SHOT_W, SHOT_H);
    this.shotCam.fov = fov;
    this.shotCam.aspect = SHOT_W / SHOT_H;
    this.shotCam.position.copy(eye);
    this.shotCam.lookAt(target);
    this.shotCam.updateProjectionMatrix();
    this.shotCam.updateMatrixWorld(true);

    // Hide our UI while rendering, and paint a neutral previs backdrop.
    const hidden = [this.panel.mesh, this.board.mesh, this.frameLine, this.preview, ...this.shots.map((s) => s.quad)];
    const was = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const background = scene.background;
    scene.background = new Color('#cdd7e3');
    const xrEnabled = renderer.xr.enabled;
    const previous = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, this.shotCam);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xrEnabled;
    scene.background = background;
    hidden.forEach((o, i) => (o.visible = was[i]));

    const caption = fov < 25 ? 'close-up' : fov < 45 ? 'medium' : 'wide';
    const quad = new Mesh(new PlaneGeometry(0.19, 0.107), new MeshBasicMaterial({ map: rt.texture }));
    this.wallRoot.add(quad);
    this.shots.push({ target: rt, quad, caption });
    this.layoutShots();
    Sfx.success();
    this.status = `Shot ${this.shots.length} captured (${caption}).`;
  }

  private layoutShots(): void {
    this.shots.forEach((shot, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      shot.quad.position.set(-0.205 + col * 0.205, 0.07 - row * 0.135, 0.004);
    });
    this.board.setText('Storyboard', '', this.shots.map((s, i) => `${i + 1}. ${s.caption}`).join('   ') || 'No shots yet.');
  }

  private removeShot(index: number): void {
    const [shot] = this.shots.splice(index, 1);
    if (!shot) return;
    this.wallRoot.remove(shot.quad);
    shot.quad.geometry.dispose();
    (shot.quad.material as MeshBasicMaterial).dispose();
    shot.target.dispose();
    this.layoutShots();
  }

  private updatePlayback(dt: number): void {
    if (this.playing < 0) return;
    this.playTime += dt;
    if (this.playTime > 1.6) {
      this.playTime = 0;
      this.playing += 1;
      if (this.playing >= this.shots.length) {
        this.playing = -1;
        this.preview.visible = false;
        for (const s of this.shots) s.quad.visible = true;
        return;
      }
      Sfx.blip(500 + this.playing * 60);
    }
    const material = this.preview.material as MeshBasicMaterial;
    const shot = this.shots[this.playing];
    if (shot && material.map !== shot.target.texture) {
      material.map = shot.target.texture;
      material.needsUpdate = true;
    }
  }

  private play(): void {
    if (this.shots.length === 0) return;
    this.playing = 0;
    this.playTime = 0;
    this.preview.visible = true;
    for (const s of this.shots) s.quad.visible = false;
    (this.preview.material as MeshBasicMaterial).map = this.shots[0].target.texture;
    (this.preview.material as MeshBasicMaterial).needsUpdate = true;
  }

  // ------------------------------------------------------------ UI

  private onButton(id: string): void {
    if (id === 'snap') this.snapView();
    if (id === 'turn') this.turnSelected(1);
    if (id === 'undo') this.removeShot(this.shots.length - 1);
    if (id === 'play') this.play();
    if (id === 'home') this.ctx.goHome();
  }

  private refresh(): void {
    this.panel.setText(
      `Shot Board - ${this.shots.length}/${MAX_SHOTS} shots`,
      '',
      [this.status, this.selected ? `Selected: ${this.selected.name}. Thumb-swipe or Turn to rotate.` : 'Pinch a piece to move it.'],
    );
    this.panel.setButtons([
      { id: 'snap', label: 'Snap view', tone: 'primary' },
      { id: 'turn', label: 'Turn', disabled: !this.selected },
      { id: 'play', label: this.playing >= 0 ? 'Playing' : 'Play', disabled: this.shots.length === 0 },
      { id: 'undo', label: 'Undo shot', disabled: this.shots.length === 0 },
    ]);
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      shots: this.shots.map((s) => s.caption),
      selected: this.selected?.name ?? null,
      props: Object.fromEntries(this.props.map((p) => [p.name, [+p.group.position.x.toFixed(3), +p.group.position.z.toFixed(3)]])),
      framing: this.frameLine.visible,
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
      const shot = this.shots[index];
      if (!shot) return null;
      const buffer = new Uint8Array(4 * 16);
      this.ctx.renderer.readRenderTargetPixels(shot.target, SHOT_W / 2 - 2, SHOT_H / 2 - 2, 4, 4, buffer);
      return Array.from(buffer.slice(0, 8));
    },
  };
}
