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
  type Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector3,
  VisibilityState,
  XRAnchor,
  XRPlane,
} from '@iwsdk/core';
import { DeskMat, HandCursor, HandSkeleton } from './core/art.js';
import { type LabContext, type Prototype, store } from './core/context.js';
import { HandState, Hands } from './core/hands.js';
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

const DESKTOP_DESK = new Vector3(0, 0.75, -0.5);
const DESK_KEY = 'lab-desk-v1';
type Setup = 'auto' | 'manual' | 'ready';

interface SavedPose {
  desk: [number, number, number, number];
  wall: [number, number, number, number];
}

export class LabSystem extends createSystem({
  planes: { required: [XRPlane] },
}) {
  private ctx!: LabContext & { immersive: boolean; time: number; pointers: readonly HandState[]; wristMenuOpen: boolean };
  private mat!: DeskMat;
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
    };

    this.buildChrome();
    this.setupMouse();

    const hub = new HubPrototype(() => this.protos.filter((p) => p.id !== 'hub' && p.id !== 'intro'), (id) => this.go(id));
    this.protos = [
      hub,
      new FocusPrototype(),
      new ConjurePrototype(),
      new ShotBoardPrototype(),
      new ClayPrototype(),
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
    this.exposeDebugHooks();
  }

  // ------------------------------------------------------------ navigation

  go(id: string): void {
    const next = this.protos.find((p) => p.id === id);
    if (!next || next === this.active) return;
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
      if (this.setupTime > 1.5) {
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
      const hand = this.placementHand();
      this.setupPanel.mesh.visible = true;
      this.setupPanel.setText(
        'Set up',
        'Where is your desk?',
        hand
          ? 'Hold your hand just above your desk or table, then pinch.'
          : 'Show your hands to the headset.',
      );
      this.ghost.visible = hand != null;
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
    if (wallFound && wallReach < 1.1) {
      const w = this.room.worldToLocal(this.tmp2.copy(this.foundWall.position));
      this.setPose(this.wall, w, this.foundWall.yaw - roomYawAngle);
    } else {
      this.tmp2.set(0, 0.36, -0.36);
      this.deskToRoom(this.tmp2);
      this.setPose(this.wall, this.tmp2, this.desk.rotation.y);
    }
    store.set(DESK_KEY, {
      desk: [this.desk.position.x, this.desk.position.y, this.desk.position.z, this.desk.rotation.y],
      wall: [this.wall.position.x, this.wall.position.y, this.wall.position.z, this.wall.rotation.y],
    } satisfies SavedPose);
    this.setup = 'ready';
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
    this.updateWristMenu(dt);
    this.updateCoach(dt);
    this.active?.update(dt);
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

    this.setupPanel = new CanvasPanel({ width: 0.3, height: 0.11, columns: 1 });
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
      }
    };
    this.wristPanel.mesh.visible = false;
    chrome.add(this.wristPanel.mesh);

    this.mat = new DeskMat();
    this.desk.add(this.mat.mesh);
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
