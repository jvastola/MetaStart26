/**
 * Prototype Lab host.
 *
 * Owns everything the prototypes share:
 *   - input: both hands (joints, pinch, microgestures) or the mouse;
 *   - the room: one anchored root (IWSDK persists the anchor between
 *     sessions), with a desk frame and a wall frame under it;
 *   - setup: find the desk and wall from plane detection, fall back to a
 *     saved pose, then to pinch-to-place;
 *   - navigation: the hub, a palm-up wrist menu, keyboard 0-9, ?p=<id>;
 *   - toasts, pause on system-menu blur, and a window.lab test hook.
 */

import {
  createSystem,
  CylinderGeometry,
  type Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector3,
  VisibilityState,
  XRAnchor,
  XRPlane,
} from '@iwsdk/core';
import { DeskMat, HandCursor, HandSkeleton } from './core/art.js';
import { Album, FrameCamera } from './core/camera-frame.js';
import { openSettings } from './core/settings-ui.js';
import { VirtualKeyboard } from './core/keyboard.js';
import { type LabContext, type Prototype, store } from './core/context.js';
import { HeldPose } from './core/grab.js';
import { HandState, Hands, pointerDistance } from './core/hands.js';
import { CanvasPanel } from './core/panel.js';
import { Sfx } from './core/sfx.js';
import { findDesk, findWall, type SurfacePose, surfaceBelow } from './core/surfaces.js';
import { ClayPrototype } from './protos/clay/clay.js';
import { ConjurePrototype } from './protos/conjure/conjure.js';
import { FocusPrototype } from './protos/focus/focus.js';
import { GolfPrototype } from './protos/golf/golf.js';
import { HubPrototype } from './protos/hub.js';
import { INTRO_DONE_KEY, IntroPrototype } from './protos/intro.js';
import { ShotBoardPrototype } from './protos/shotboard/shotboard.js';
import { SketchPrototype } from './protos/sketch/sketch.js';

const DESKTOP_DESK = new Vector3(0, 0.75, -0.5);
/** Desk grab bar: half length and position in desk space (front edge of the mat). */
const BAR_HALF = 0.12;
const BAR_Y = 0.012;
const BAR_Z = 0.235;
const DESK_KEY = 'lab-desk-v1';
type Setup = 'auto' | 'manual' | 'ready';

interface SavedPose {
  desk: [number, number, number, number];
  wall: [number, number, number, number];
  /** True when the wall frame sits on a detected wall (it then stays put when the desk moves). */
  realWall?: boolean;
}

export class LabSystem extends createSystem({
  planes: { required: [XRPlane] },
}) {
  private ctx!: LabContext & { immersive: boolean; time: number; pointers: readonly HandState[]; wristMenuOpen: boolean };
  private mat!: DeskMat;
  private deskBar!: Mesh;
  private keyboard = new VirtualKeyboard();
  private deskGrab: { hand: HandState; pose: HeldPose } | null = null;
  private realWall = false;
  private readonly barScratch = new Vector3();
  private album = new Album();
  private frame!: FrameCamera;
  private cursors: HandCursor[] = [];
  private skeletons: HandSkeleton[] = [];
  private coach!: CanvasPanel;
  private coachTime = 0;
  private readonly forward = new Vector3();
  private hands!: Hands;
  private mouse!: HandState;
  private room!: Group;
  private desk!: Group;
  private wall!: Group;
  private protos: Prototype[] = [];
  private active: Prototype | null = null;
  private initialized = new Set<string>();

  private setup: Setup = 'ready';
  /** True while the user is re-placing the desk by hand (no auto-placement). */
  private moving = false;
  private setupTime = 0;
  private ghost!: Group;
  private setupPanel!: CanvasPanel;
  private wristPanel!: CanvasPanel;
  private wristOpen = false;
  private toastPanel!: CanvasPanel;
  private toastTime = 0;

  private readonly head = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly mousePlanePoint = new Vector3();
  private readonly mousePlaneNormal = new Vector3(0, 1, 0);
  private readonly mouseNdc = new Vector3();
  private mouseDown = false;
  private mouseDownPending = false;
  private mouseUpPending = false;
  private readonly found: SurfacePose = { position: new Vector3(), yaw: 0, label: '' };
  private readonly foundWall: SurfacePose = { position: new Vector3(), yaw: 0, label: '' };

  init(): void {
    this.hands = new Hands();
    this.mouse = new HandState('right', true);

    // Anchored room root. Content is stored relative to it, so it reappears
    // in the same physical place next session when the anchor is restored.
    this.room = new Group();
    this.room.name = 'Room';
    const roomEntity = this.world.createTransformEntity(this.room);
    if (this.world.xrEnabled) roomEntity.addComponent(XRAnchor);
    this.desk = new Group();
    this.desk.name = 'Desk';
    this.wall = new Group();
    this.wall.name = 'Wall';
    this.world.createTransformEntity(this.desk, { parent: roomEntity });
    this.world.createTransformEntity(this.wall, { parent: roomEntity });

    const system = this;
    this.ctx = {
      world: this.world,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      hands: this.hands,
      mouse: this.mouse,
      pointers: [this.mouse],
      immersive: false,
      desk: this.desk,
      wall: this.wall,
      head: this.head,
      time: 0,
      wristMenuOpen: false,
      setMousePlane(point: Vector3, normal: Vector3) {
        system.mousePlanePoint.copy(point);
        system.mousePlaneNormal.copy(normal).normalize();
      },
      toast: (text: string) => this.toast(text),
      goHome: () => this.go('hub'),
      album: this.album,
      capture: (eye: Vector3, target: Vector3, fov: number) => this.shoot(eye, target, fov),
      openKeyboard: (request) => this.keyboard.open(request),
    };
    this.frame = new FrameCamera(this.renderer, this.scene, this.album);
    this.world.createTransformEntity(this.frame.line);

    this.buildChrome();
    this.setupMouse();

    const hub = new HubPrototype(() => this.protos.filter((p) => p.id !== 'hub' && p.id !== 'intro'), (id) => this.go(id));
    this.protos = [
      hub,
      new FocusPrototype(),
      new ConjurePrototype(),
      new ShotBoardPrototype(),
      new ClayPrototype(),
      new SketchPrototype(),
      new GolfPrototype(),
      new IntroPrototype(() => this.go('hub')),
    ];
    for (const p of this.protos) {
      p.deskRoot.visible = false;
      p.wallRoot.visible = false;
      this.desk.add(p.deskRoot);
      this.wall.add(p.wallRoot);
    }

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const immersive = state !== VisibilityState.NonImmersive;
        if (immersive === this.ctx.immersive) return;
        this.ctx.immersive = immersive;
        this.ctx.pointers = immersive ? this.hands.both : [this.mouse];
        if (this.enterButton) this.enterButton.style.display = immersive ? 'none' : 'block';
        if (immersive) {
          Sfx.unlock();
          this.beginSetup();
        } else {
          this.placeDesktop();
        }
      }),
    );

    this.placeDesktop();
    const requested = new URLSearchParams(location.search).get('p');
    // First launch opens the tutorial; ?p=<id> always wins.
    const first = store.get<boolean>(INTRO_DONE_KEY, false) ? 'hub' : 'intro';
    this.go(requested && this.protos.some((p) => p.id === requested) ? requested : first);
    this.buildDomNav();
    this.buildEnterButton();
    this.exposeDebugHooks();
  }

  // ------------------------------------------------------------ navigation

  go(id: string): void {
    const next = this.protos.find((p) => p.id === id);
    if (!next || next === this.active) return;
    if (this.keyboard.isOpen) this.keyboard.close(false);
    if (this.active) {
      this.active.exit();
      this.active.deskRoot.visible = false;
      this.active.wallRoot.visible = false;
    }
    if (!this.initialized.has(id)) {
      next.init(this.ctx);
      this.initialized.add(id);
    }
    this.active = next;
    // Default mouse plane: the desk surface.
    this.desk.getWorldPosition(this.tmp);
    this.ctx.setMousePlane(this.tmp, this.tmp2.set(0, 1, 0));
    next.deskRoot.visible = this.setup === 'ready';
    next.wallRoot.visible = this.setup === 'ready';
    this.mat.setAccent(next.accent);
    for (const c of this.cursors) c.setAccent(next.accent);
    next.enter();
    this.showHowTo(next, false);
    this.updateDomNav();
    try {
      const url = new URL(location.href);
      url.searchParams.set('p', id);
      history.replaceState(null, '', url);
    } catch {
      // Ignore: URL sync is a convenience only.
    }
  }

  // ------------------------------------------------------------ desk setup

  private placeDesktop(): void {
    this.setup = 'ready';
    this.setPose(this.desk, DESKTOP_DESK, 0);
    this.tmp.set(0, 0.36, -0.36);
    this.deskToRoom(this.tmp);
    this.setPose(this.wall, this.tmp, 0);
    this.showActive(true);
    this.ghost.visible = false;
    this.setupPanel.mesh.visible = false;
  }

  private beginSetup(): void {
    this.setup = 'auto';
    this.setupTime = 0;
    this.showActive(false);
  }

  private showActive(show: boolean): void {
    this.mat.mesh.visible = show;
    if (!this.active) return;
    this.active.deskRoot.visible = show;
    this.active.wallRoot.visible = show;
  }

  private updateSetup(dt: number): void {
    this.setupTime += dt;
    const planes = this.queries.planes.entities as unknown as Entity[];
    if (this.setup === 'auto') {
      // Give plane detection a moment to report the room.
      this.camera.getWorldDirection(this.tmp2);
      if (findDesk(planes, this.head, this.tmp2, this.found)) {
        this.finishSetup(this.found.position, this.found.yaw, `Found your ${this.found.label}.`);
        return;
      }
      // Quest can take a few seconds to report Space Setup planes.
      if (this.setupTime > 3) {
        const saved = store.get<SavedPose | null>(DESK_KEY, null);
        if (saved) {
          this.applySaved(saved);
          this.setup = 'ready';
          this.showActive(true);
          this.toast('Welcome back. Your desk is where you left it.');
          return;
        }
        this.setup = 'manual';
        this.setupTime = 0;
      }
      return;
    }
    if (this.setup === 'manual') {
      // Surfaces can still arrive late; take a detected desk whenever it shows up.
      this.camera.getWorldDirection(this.tmp2);
      if (!this.moving && findDesk(planes, this.head, this.tmp2, this.found)) {
        this.finishSetup(this.found.position, this.found.yaw, `Found your ${this.found.label}.`);
        return;
      }
      const hand = this.placementHand();
      const count = [...(planes as Iterable<Entity>)].length;
      const surfaces = `Room surfaces reported: ${count}${count === 0 ? ' (run Space Setup in Quest settings to enable auto-placement)' : ''}.`;
      this.setupPanel.mesh.visible = true;
      this.setupPanel.setText(
        'Set up',
        'Where is your desk?',
        [
          hand?.isController
            ? 'Hold the controller just above your desk, then pull the trigger.'
            : hand
              ? 'Hold your hand just above your desk or table, then pinch.'
              : 'Show your hands (or pick up a controller).',
          surfaces,
        ],
      );
      this.ghost.visible = hand != null;
      // Never leave someone with an empty room: place it in front of them.
      if (!this.moving && this.setupTime > (hand ? 15 : 5)) {
        this.camera.getWorldDirection(this.tmp2);
        this.tmp2.y = 0;
        this.tmp2.normalize();
        this.tmp.copy(this.head).addScaledVector(this.tmp2, 0.45);
        this.tmp.y = Math.max(0.55, this.head.y - 0.42);
        const yaw = Math.atan2(this.head.x - this.tmp.x, this.head.z - this.tmp.z);
        this.finishSetup(this.tmp, yaw, 'Placed in front of you. Palm up (or X/A), then Move desk to adjust.');
        return;
      }
      if (hand == null) {
        this.placeSetupPanelAtHead();
        return;
      }
      const surface = surfaceBelow(planes, hand.pinchPoint);
      this.tmp.copy(hand.pinchPoint);
      this.tmp.y = surface ?? hand.pinchPoint.y - 0.03;
      const yaw = Math.atan2(this.head.x - this.tmp.x, this.head.z - this.tmp.z);
      this.ghost.position.copy(this.tmp);
      this.ghost.rotation.set(0, yaw, 0);
      this.setupPanel.mesh.position.copy(this.tmp).add(this.tmp2.set(0, 0.16, 0));
      this.setupPanel.mesh.rotation.set(0, yaw, 0);
      if (hand.pinchStarted && this.setupTime > 0.5) {
        this.finishSetup(this.tmp, yaw, 'Desk set. Turn your left palm up for the menu.');
      }
    }
  }

  private placementHand(): HandState | null {
    const { left, right } = this.hands;
    if (left.tracked && left.pinchStarted) return left;
    if (right.tracked) return right;
    return left.tracked ? left : null;
  }

  private placeSetupPanelAtHead(): void {
    this.camera.getWorldDirection(this.tmp2);
    this.tmp2.y = 0;
    this.tmp2.normalize();
    const p = this.setupPanel.mesh.position.copy(this.head).addScaledVector(this.tmp2, 0.55);
    p.y -= 0.15;
    this.setupPanel.mesh.rotation.set(0, Math.atan2(-this.tmp2.x, -this.tmp2.z), 0);
  }

  private finishSetup(position: Vector3, yaw: number, message: string): void {
    // Callers may pass a scratch vector that we reuse below.
    const worldPos = position.clone();
    // Poses are stored relative to the anchored room, which only has yaw.
    this.room.updateMatrixWorld(true);
    const roomForward = this.room.getWorldDirection(new Vector3());
    const roomYawAngle = Math.atan2(roomForward.x, roomForward.z);
    const local = this.room.worldToLocal(this.tmp.copy(worldPos));
    this.setPose(this.desk, local, yaw - roomYawAngle);

    // Wall: from planes when we can, else 42 cm behind the desk.
    const planes = this.queries.planes.entities as unknown as Entity[];
    // Only use a real wall within arm's reach; otherwise stand the board behind the desk.
    const wallFound = findWall(planes, this.head, worldPos, this.foundWall);
    const wallReach = Math.hypot(this.foundWall.position.x - this.head.x, this.foundWall.position.z - this.head.z);
    this.realWall = wallFound && wallReach < 1.1;
    if (this.realWall) {
      const w = this.room.worldToLocal(this.tmp2.copy(this.foundWall.position));
      this.setPose(this.wall, w, this.foundWall.yaw - roomYawAngle);
    } else {
      this.placeDefaultWall();
    }
    this.saveDesk();
    this.setup = 'ready';
    this.moving = false;
    this.ghost.visible = false;
    this.setupPanel.mesh.visible = false;
    this.showActive(true);
    Sfx.place(worldPos);
    this.toast(message);
    if (!store.get<boolean>(INTRO_DONE_KEY, false)) this.go('intro');
  }

  private applySaved(saved: SavedPose): void {
    const [dx, dy, dz, dyaw] = saved.desk;
    const [wx, wy, wz, wyaw] = saved.wall;
    this.setPose(this.desk, this.tmp.set(dx, dy, dz), dyaw);
    this.setPose(this.wall, this.tmp.set(wx, wy, wz), wyaw);
    this.realWall = saved.realWall ?? false;
  }

  private saveDesk(): void {
    store.set(DESK_KEY, {
      desk: [this.desk.position.x, this.desk.position.y, this.desk.position.z, this.desk.rotation.y],
      wall: [this.wall.position.x, this.wall.position.y, this.wall.position.z, this.wall.rotation.y],
      realWall: this.realWall,
    } satisfies SavedPose);
  }

  /** The board stands 36 cm behind and above the desk when no real wall is in reach. */
  private placeDefaultWall(): void {
    this.tmp2.set(0, 0.36, -0.36);
    this.deskToRoom(this.tmp2);
    this.setPose(this.wall, this.tmp2, this.desk.rotation.y);
  }

  // ------------------------------------------------------------ desk grab bar

  /**
   * Pinch the bar on the front edge of the desk mat to move the whole
   * workspace: it follows your hand and turns with your wrist. The pinch is
   * consumed so the app underneath does not also react to it.
   */
  private updateDeskGrab(): void {
    const bar = this.deskBar;
    const mat = bar.material as MeshStandardMaterial;
    if (this.deskGrab == null) {
      let near = Infinity;
      for (const p of this.ctx.pointers) {
        if (!p.tracked) continue;
        const d = this.barDistance(p);
        near = Math.min(near, d);
        if (p.pinchStarted && d < 0.035) {
          const pose = new HeldPose();
          pose.begin(p, this.desk, { upright: true });
          this.deskGrab = { hand: p, pose };
          p.clearEdges();
          Sfx.pinch(p.isMouse ? undefined : p.pinchPoint);
          break;
        }
      }
      mat.emissiveIntensity = near < 0.08 ? 0.35 + (1 - near / 0.08) * 0.5 : 0.15;
      return;
    }
    const { hand, pose } = this.deskGrab;
    mat.emissiveIntensity = 1;
    if (!hand.pinching || !hand.tracked) {
      this.deskGrab = null;
      this.saveDesk();
      Sfx.place(this.desk.getWorldPosition(this.tmp));
      this.toast('Desk moved. It will stay here next time.');
      return;
    }
    pose.apply(hand, this.desk, { upright: true });
    this.desk.updateMatrixWorld(true);
    if (!this.realWall) this.placeDefaultWall();
  }

  /** Distance from a pointer to the grab bar (ray distance for the mouse). */
  private barDistance(p: HandState): number {
    this.desk.updateMatrixWorld(true);
    const a = this.desk.localToWorld(this.tmp.set(-BAR_HALF, BAR_Y, BAR_Z));
    const b = this.desk.localToWorld(this.tmp2.set(BAR_HALF, BAR_Y, BAR_Z));
    const ab = b.sub(a);
    const point = p.isMouse ? p.pinchPoint : p.pinchPoint;
    const t = Math.min(1, Math.max(0, this.barScratch.copy(point).sub(a).dot(ab) / ab.lengthSq()));
    const closest = this.barScratch.copy(a).addScaledVector(ab, t);
    return pointerDistance(p, closest);
  }

  private setPose(group: Group, position: Vector3, yaw: number): void {
    group.position.copy(position);
    group.rotation.set(0, yaw, 0);
    group.updateMatrixWorld(true);
  }

  /** Desk-space point to room space (in place). */
  private deskToRoom(v: Vector3): Vector3 {
    this.desk.updateMatrix();
    return v.applyMatrix4(this.desk.matrix);
  }

  // ------------------------------------------------------------ frame

  update(delta: number): void {
    const dt = Math.min(delta, 0.05);
    this.ctx.time += dt;
    this.player.head.getWorldPosition(this.head);
    if (this.ctx.immersive) {
      this.player.updateMatrixWorld(true);
      this.hands.update(this.world.xrFrame, this.world.xrReferenceSpace, this.player.matrixWorld, dt);
    }
    this.updateMouse();
    this.camera.getWorldDirection(this.forward);
    Sfx.setListener(this.head.x, this.head.y, this.head.z, this.forward.x, this.forward.y, this.forward.z);
    const handsVisible = this.ctx.immersive;
    this.cursors[0].update(this.hands.left, this.head, handsVisible);
    this.cursors[1].update(this.hands.right, this.head, handsVisible);
    if (this.skeletons.length) {
      this.skeletons[0].update(this.hands.left, handsVisible);
      this.skeletons[1].update(this.hands.right, handsVisible);
    }
    if (this.world.visibilityState.peek() === VisibilityState.VisibleBlurred) return;

    this.updateToast(dt);
    if (this.setup !== 'ready') {
      // Setup timeouts use real elapsed time, not the capped frame step.
      this.updateSetup(Math.min(delta, 1));
      return;
    }
    if (this.keyboard.isOpen) {
      // The keyboard has the user's attention: pause the app underneath.
      this.updateWristMenu(dt);
      this.keyboard.update(this.ctx.pointers, dt);
      return;
    }
    this.updateDeskGrab();
    this.updateWristMenu(dt);
    this.updateCoach(dt);
    // The director's frame works in every prototype, unless it owns the pinches.
    const frameEnabled = this.ctx.immersive && !this.wristOpen && this.deskGrab == null && !(this.active?.holding?.() ?? false);
    const caption = this.frame.update(this.hands.left, this.hands.right, this.head, frameEnabled, dt);
    if (caption) this.afterShot(caption);
    this.active?.update(dt);
  }

  /** Capture from code (Snap view, tests) with the same feedback as the gesture. */
  private shoot(eye: Vector3, target: Vector3, fov: number): string {
    const caption = this.frame.capture(eye, target, fov);
    this.afterShot(caption);
    return caption;
  }

  private afterShot(caption: string): void {
    Sfx.shutter();
    this.toast(`Shot ${this.album.shots.length} saved (${caption}). See it in Shot Board.`);
  }

  /** First-visit how-to card for a prototype (and on demand from the wrist menu). */
  private showHowTo(proto: Prototype, force: boolean): void {
    const key = `lab-howto-${proto.id}`;
    if (!proto.howTo || (!force && store.get<boolean>(key, false))) {
      this.coach.mesh.visible = false;
      return;
    }
    store.set(key, true);
    this.coach.setText(`How to use ${proto.title}`, '', proto.howTo.map((line, i) => `${i + 1}. ${line}`));
    this.coach.mesh.visible = true;
    this.coachTime = 30;
  }

  private updateCoach(dt: number): void {
    if (!this.coach.mesh.visible) return;
    this.coachTime -= dt;
    if (this.coachTime <= 0) this.coach.mesh.visible = false;
    this.coach.update(this.ctx.pointers, dt);
  }

  private updateWristMenu(dt: number): void {
    const left = this.hands.left;
    const faces = this.ctx.immersive && left.tracked && left.palmFaces(this.head, this.wristOpen ? 0.35 : 0.65);
    if (faces !== this.wristOpen) {
      this.wristOpen = faces;
      this.ctx.wristMenuOpen = faces;
      if (faces) Sfx.blip(900);
    }
    const panel = this.wristPanel;
    panel.mesh.visible = this.wristOpen;
    if (!this.wristOpen) return;
    // Float just above the palm, turned to face the head.
    panel.mesh.position.copy(left.palm).addScaledVector(left.palmNormal, 0.06);
    panel.mesh.position.y += 0.07;
    panel.mesh.rotation.set(0, Math.atan2(this.head.x - panel.mesh.position.x, this.head.z - panel.mesh.position.z), 0);
    panel.setText('', this.active?.title ?? 'Lab', '');
    panel.update([this.hands.right], dt);
  }

  private updateToast(dt: number): void {
    if (this.toastTime <= 0) return;
    this.toastTime -= dt;
    const mesh = this.toastPanel.mesh;
    mesh.visible = this.toastTime > 0;
    // Lazy-follow in the centre of view so it fits narrow fields of view.
    this.camera.getWorldDirection(this.tmp2);
    const target = this.tmp.copy(this.head).addScaledVector(this.tmp2, 0.6);
    target.y -= 0.12;
    mesh.position.lerp(target, 1 - Math.exp(-dt * 6));
    mesh.rotation.set(0, Math.atan2(this.head.x - mesh.position.x, this.head.z - mesh.position.z), 0);
    this.toastPanel.update([], dt);
  }

  toast(text: string): void {
    this.toastPanel.setText('', '', text);
    this.toastTime = 3;
    this.camera.getWorldDirection(this.tmp2);
    this.toastPanel.mesh.position.copy(this.head).addScaledVector(this.tmp2, 0.6);
    this.toastPanel.update([], 0);
  }

  // ------------------------------------------------------------ chrome

  private buildChrome(): void {
    const chrome = new Group();
    chrome.name = 'LabChrome';
    this.world.createTransformEntity(chrome);

    // Ghost desk outline for manual placement.
    this.ghost = new Group();
    const fill = new Mesh(
      new PlaneGeometry(0.6, 0.38),
      new MeshBasicMaterial({ color: '#7fe0b5', transparent: true, opacity: 0.18, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2;
    const ring = new Mesh(
      new RingGeometry(0.05, 0.06, 40),
      new MeshBasicMaterial({ color: '#7fe0b5', transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    this.ghost.add(fill, ring);
    this.ghost.visible = false;
    chrome.add(this.ghost);

    this.setupPanel = new CanvasPanel({ width: 0.34, height: 0.13, columns: 1 });
    this.setupPanel.mesh.visible = false;
    chrome.add(this.setupPanel.mesh);

    this.wristPanel = new CanvasPanel({ width: 0.17, height: 0.14, columns: 2, buttonHeight: 0.03 });
    this.wristPanel.setButtons([
      { id: 'home', label: 'Home', tone: 'primary' },
      { id: 'move', label: 'Move desk' },
      { id: 'help', label: 'How to' },
      { id: 'mute', label: 'Sound' },
    ]);
    this.wristPanel.onPress = (id) => {
      if (id === 'home') this.go('hub');
      if (id === 'help' && this.active) this.showHowTo(this.active, true);
      if (id === 'mute') {
        Sfx.setMuted(!Sfx.muted);
        this.toast(Sfx.muted ? 'Sound off.' : 'Sound on.');
      }
      if (id === 'move') {
        this.showActive(false);
        this.setup = 'manual';
        this.setupTime = 0;
        this.moving = true;
      }
    };
    this.wristPanel.mesh.visible = false;
    chrome.add(this.wristPanel.mesh);

    this.mat = new DeskMat();
    this.desk.add(this.mat.mesh);
    // Grab bar on the front edge of the mat: pinch it to move the workspace.
    this.deskBar = new Mesh(
      new CylinderGeometry(0.0075, 0.0075, BAR_HALF * 2, 20),
      new MeshStandardMaterial({ color: '#dfe6f0', roughness: 0.35, emissive: '#9fc7ff', emissiveIntensity: 0.15 }),
    );
    this.deskBar.rotation.z = Math.PI / 2;
    this.deskBar.position.set(0, BAR_Y, BAR_Z);
    this.deskBar.name = 'DeskGrabBar';
    this.deskBar.userData.hideInShots = true;
    this.desk.add(this.deskBar);
    // Keyboard lies tilted over the front of the desk, like a laptop's.
    this.keyboard.group.position.set(0, 0.07, 0.1);
    this.keyboard.group.rotation.x = -0.95;
    this.keyboard.group.userData.hideInShots = true;
    this.desk.add(this.keyboard.group);
    this.cursors = [new HandCursor(), new HandCursor()];
    for (const c of this.cursors) chrome.add(c.group);
    // ?skeleton=1 draws procedural hands (recordings, emulator without hand models).
    if (new URLSearchParams(location.search).get('skeleton') === '1') {
      this.hands.readAllJoints = true;
      this.skeletons = [new HandSkeleton(), new HandSkeleton()];
      for (const k of this.skeletons) chrome.add(k.group);
    }

    // How-to card: floats at the front-left of the desk, angled toward you.
    this.coach = new CanvasPanel({ width: 0.26, height: 0.13, columns: 1, buttonHeight: 0.026 });
    this.coach.mesh.name = 'HowToCard';
    this.coach.setButtons([{ id: 'ok', label: 'Got it', tone: 'primary' }]);
    this.coach.onPress = () => (this.coach.mesh.visible = false);
    this.coach.mesh.position.set(-0.36, 0.14, 0.06);
    this.coach.mesh.rotation.set(-0.2, 0.55, 0, 'YXZ');
    this.coach.mesh.visible = false;
    this.desk.add(this.coach.mesh);

    this.toastPanel = new CanvasPanel({ width: 0.26, height: 0.05, columns: 1 });
    this.toastPanel.mesh.visible = false;
    chrome.add(this.toastPanel.mesh);
  }

  // ------------------------------------------------------------ mouse

  private setupMouse(): void {
    const canvas = this.renderer.domElement;
    const toNdc = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      this.mouseNdc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, 0.5);
    };
    const down = (e: PointerEvent): void => {
      if (this.ctx.immersive) return;
      toNdc(e);
      this.mouseDown = true;
      this.mouseDownPending = true;
      Sfx.unlock();
    };
    const move = (e: PointerEvent): void => toNdc(e);
    const up = (): void => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      this.mouseUpPending = true;
    };
    const key = (e: KeyboardEvent): void => {
      if (this.keyboard.isOpen) {
        if (document.querySelector('.lab-settings')) return;
        const named: Record<string, string> = { Enter: 'enter', Escape: 'cancel', Backspace: 'del' };
        if (named[e.key]) this.keyboard.key(named[e.key]);
        else if (e.key === ' ') this.keyboard.key('space');
        else if (e.key.length === 1) this.keyboard.typeChar(e.key);
        e.preventDefault();
        return;
      }
      if (document.querySelector('.lab-settings')) return;
      const n = Number.parseInt(e.key, 10);
      if (Number.isInteger(n) && this.protos[n]) this.go(this.protos[n].id);
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', down),
      () => canvas.removeEventListener('pointermove', move),
      () => window.removeEventListener('pointerup', up),
      () => window.removeEventListener('keydown', key),
    );
  }

  /** Present the mouse as a pinching hand on the current mouse plane. */
  private updateMouse(): void {
    const m = this.mouse;
    m.pinchStarted = this.mouseDownPending;
    m.pinchEnded = this.mouseUpPending;
    m.pinching = this.mouseDown || this.mouseDownPending;
    this.mouseDownPending = false;
    this.mouseUpPending = false;
    m.gesture = null;
    if (this.ctx.immersive) {
      m.tracked = false;
      return;
    }
    const cam = this.camera;
    cam.updateMatrixWorld(true);
    cam.getWorldPosition(m.rayOrigin);
    m.rayDir.copy(this.mouseNdc).unproject(cam).sub(m.rayOrigin).normalize();
    m.tracked = true;
    const n = this.mousePlaneNormal;
    const denom = m.rayDir.dot(n);
    if (Math.abs(denom) < 1e-5) return;
    const t = this.tmp.copy(this.mousePlanePoint).sub(m.rayOrigin).dot(n) / denom;
    if (t <= 0) return;
    const before = this.tmp2.copy(m.pinchPoint);
    m.pinchPoint.copy(m.rayOrigin).addScaledVector(m.rayDir, t);
    m.indexTip.copy(m.pinchPoint);
    m.thumbTip.copy(m.pinchPoint);
    m.palm.copy(m.pinchPoint);
    m.pinchVelocity.copy(m.pinchPoint).sub(before).multiplyScalar(60);
    m.indexVelocity.copy(m.pinchVelocity);
  }

  // ------------------------------------------------------------ desktop nav

  private nav: HTMLDivElement | null = null;

  private enterButton: HTMLButtonElement | null = null;

  /**
   * Our own "Enter mixed reality" button. IWSDK only uses the browser's
   * offerSession prompt, which Quest does not always show again after a
   * reload, so the page keeps a button that always works.
   */
  private buildEnterButton(): void {
    if (!this.world.xrEnabled || !navigator.xr) return;
    const b = document.createElement('button');
    b.textContent = 'Enter mixed reality';
    b.style.cssText =
      'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:11;font:700 22px system-ui,sans-serif;' +
      'padding:18px 30px;border-radius:999px;border:0;background:#7fe0b5;color:#10241b;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.35);display:none';
    b.addEventListener('click', () => {
      Sfx.unlock();
      try {
        this.world.launchXR();
      } catch (error) {
        console.error('[Lab] Could not start XR', error);
        b.textContent = 'Could not start XR - tap to retry';
      }
    });
    document.body.appendChild(b);
    this.enterButton = b;
    this.cleanupFuncs.push(() => b.remove());
    void navigator.xr
      .isSessionSupported('immersive-ar')
      .then((ok) => {
        if (ok && !this.ctx.immersive) b.style.display = 'block';
      })
      .catch(() => {});
  }

  private buildDomNav(): void {
    const nav = document.createElement('div');
    nav.style.cssText =
      'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:calc(100% - 32px);font:600 13px system-ui,sans-serif;z-index:10';
    this.protos.forEach((p, i) => {
      const b = document.createElement('button');
      b.dataset.id = p.id;
      b.textContent = `${i} ${p.title}`;
      b.style.cssText =
        'border:1px solid #3a3f4a;border-radius:8px;padding:6px 10px;background:#1d2027;color:#eef0f3;cursor:pointer';
      b.addEventListener('click', () => this.go(p.id));
      nav.appendChild(b);
    });
    const gear = document.createElement('button');
    gear.textContent = 'Settings';
    gear.style.cssText = 'border:1px solid #3a3f4a;border-radius:8px;padding:6px 10px;background:#2b2f38;color:#eef0f3;cursor:pointer';
    gear.addEventListener('click', () =>
      openSettings(() => {
        // Let Conjure pick up new keys straight away.
        if (this.active?.id === 'conjure') this.active.enter();
      }),
    );
    nav.appendChild(gear);
    document.body.appendChild(nav);
    this.nav = nav;
    this.updateDomNav();
    this.cleanupFuncs.push(() => nav.remove());
  }

  private updateDomNav(): void {
    if (!this.nav) return;
    for (const b of Array.from(this.nav.children) as HTMLButtonElement[]) {
      b.style.background = b.dataset.id === this.active?.id ? '#2f7d5d' : '#1d2027';
    }
  }

  // ------------------------------------------------------------ tests

  private exposeDebugHooks(): void {
    const api = {
      go: (id: string) => this.go(id),
      active: () => this.active?.id,
      setup: () => this.setup,
      wrist: () => this.ctx.wristMenuOpen,
      shots: () => this.album.shots.map((s) => s.caption),
      framing: () => this.frame.active,
      keyboard: () => (this.keyboard.isOpen ? this.keyboard.value : null),
      keyWorld: (id: string) => this.keyboard.keyWorld(id),
      deskBar: () => {
        const p = this.desk.localToWorld(new Vector3(0, BAR_Y, BAR_Z));
        return { x: p.x, y: p.y, z: p.z };
      },
      deskPose: () => ({ x: +this.desk.position.x.toFixed(3), z: +this.desk.position.z.toFixed(3), yaw: +this.desk.rotation.y.toFixed(2) }),
      button: (id: string) => {
        for (const panel of CanvasPanel.all) {
          const p = panel.buttonWorld(id);
          if (p) {
            const n = panel.normalWorld();
            return { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z };
          }
        }
        return null;
      },
      view: () => {
        const f = this.camera.getWorldDirection(new Vector3());
        return { head: this.head.toArray().map((v) => +v.toFixed(3)), forward: f.toArray().map((v) => +v.toFixed(3)) };
      },
      planes: () =>
        [...(this.queries.planes.entities as Iterable<Entity>)].map((e) => {
          const o = e.object3D!;
          const p = o.getWorldPosition(new Vector3());
          const n = new Vector3(0, 1, 0).applyQuaternion(o.getWorldQuaternion(o.quaternion.clone()));
          const plane = e.getValue(XRPlane, '_plane') as (XRPlane & { semanticLabel?: string }) | undefined;
          return { label: plane?.semanticLabel ?? '', at: p.toArray().map((v) => +v.toFixed(2)), up: +n.y.toFixed(2) };
        }),
      coach: () => (this.coach.mesh.visible ? this.coach.title || this.coach.eyebrow : null),
      pressCoach: () => this.coach.press('ok'),
      state: () => this.active?.debugState?.() ?? null,
      act: (name: string, ...args: unknown[]) => {
        const fn = this.active?.debugActions?.[name] as ((...a: unknown[]) => unknown) | undefined;
        return fn ? fn(...args) : undefined;
      },
      deskToWorld: (x: number, y: number, z: number) => {
        const v = this.desk.localToWorld(new Vector3(x, y, z));
        return { x: v.x, y: v.y, z: v.z };
      },
      worldToScreen: (x: number, y: number, z: number) => {
        const v = new Vector3(x, y, z).project(this.camera);
        const rect = this.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      },
      hands: () =>
        this.hands.both.map((h) => ({ side: h.side, tracked: h.tracked, pinching: h.pinching, gap: h.indexTip.distanceTo(h.thumbTip) })),
    };
    (window as unknown as { lab: typeof api }).lab = api;
  }
}
