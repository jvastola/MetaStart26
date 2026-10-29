/**
 * Conjure: say what you want and it appears on your desk.
 *
 * 1. You speak (or pinch a prompt chip). The intent parser decides whether
 *    it is a new object or a follow-up ("make it blue", "bigger", "another").
 * 2. An instant offline sketch appears on the pedestal (kit.ts).
 * 3. If an AI provider is configured, Meshy or Tripo generates a real model
 *    in the background via our proxy and replaces the sketch when ready.
 * 4. Pinch to pick creations up and place them anywhere; pinch with both
 *    hands to scale and turn. Older creations move to the shelf.
 */

import {
  AssetManager,
  Box3,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Material,
  type Object3D,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { Burst } from '../../core/burst.js';
import type { LabContext, Prototype } from '../../core/context.js';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { type HandState, pointerDistance } from '../../core/hands.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import { Voice } from '../../core/voice.js';
import { parseIntent } from './intent.js';
import { buildFromPrompt } from './kit.js';
import { gen3dEndpoint, pollJob, type Provider, startJob } from './remote.js';

type Source = 'sketch' | Provider;

interface Item {
  holder: Group;
  content: Object3D;
  prompt: string;
  recipe: string;
  source: Source;
  variation: number;
  spin: boolean;
  /** Placed by hand somewhere other than the pedestal or shelf. */
  free: boolean;
  radius: number;
}

interface Hold {
  item: Item;
  hand: HandState;
  offset: Vector3;
}

const PEDESTAL = new Vector3(0, 0.014, 0);
const SHELF = [new Vector3(-0.19, 0, 0.03), new Vector3(0.19, 0, 0.03), new Vector3(-0.27, 0, -0.09), new Vector3(0.27, 0, -0.09)];
const MODEL_SIZE = 0.14;
const PROMPT_IDEAS = [
  'red mushroom',
  'tiny castle',
  'low poly fox',
  'desk lamp',
  'blue rocket',
  'snowman',
  'pink flower',
  'teal crystal',
  'little robot',
  'coffee mug',
  'pine tree',
  'ringed planet',
];
const MAX_ITEMS = 1 + SHELF.length;

export class ConjurePrototype implements Prototype {
  readonly id = 'conjure';
  readonly title = 'Conjure';
  readonly tagline = 'Voice to 3D on your desk';
  readonly accent = ACCENTS.conjure;
  readonly howTo = [
    'Press Speak and say what you want, or pinch an idea.',
    'Follow up: "make it blue", "bigger", "another one".',
    'Pinch a creation to move it; use both hands to scale.',
  ];
  readonly deskRoot = new Group();
  readonly wallRoot = new Group();

  private ctx!: LabContext;
  private panel!: CanvasPanel;
  private items: Item[] = [];
  private holds: Hold[] = [];
  private twoHand: { item: Item; startDist: number; startScale: number; startAngle: number; startYaw: number } | null = null;
  private orbit!: Mesh;
  private burst!: Burst;
  private voice = new Voice();
  private heard = '';
  private status = '';
  private provider: Source = 'sketch';
  private generating: { item: Item; progress: number; token: number } | null = null;
  private token = 0;
  private ideaOffset = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  init(ctx: LabContext): void {
    this.ctx = ctx;
    const pedestal = new Mesh(new CylinderGeometry(0.075, 0.08, 0.014, 48), new MeshStandardMaterial({ color: '#2a2e36', roughness: 0.5 }));
    pedestal.position.y = 0.007;
    const rim = new Mesh(new TorusGeometry(0.076, 0.002, 6, 64), new MeshBasicMaterial({ color: '#b48cff' }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.014;
    this.orbit = new Mesh(new TorusGeometry(0.06, 0.0025, 6, 64), new MeshBasicMaterial({ color: '#b48cff', transparent: true, opacity: 0.8 }));
    this.orbit.visible = false;
    this.deskRoot.add(pedestal, rim, this.orbit);
    this.burst = new Burst(this.deskRoot, '#b48cff');

    this.panel = new CanvasPanel({ width: 0.38, height: 0.16, columns: 4, buttonHeight: 0.032, accent: this.accent });
    this.panel.mesh.name = 'ConjurePanel';
    this.panel.mesh.position.set(0, 0.09, -0.19);
    this.panel.mesh.rotation.x = -0.3;
    this.panel.onPress = (id) => this.onButton(id);
    this.deskRoot.add(this.panel.mesh);

    this.provider = gen3dEndpoint() ? 'meshy' : 'sketch';
  }

  enter(): void {
    this.status = this.items.length === 0 ? 'Say what you want, or pinch an idea below.' : this.status;
    this.refresh();
  }

  exit(): void {
    this.holds = [];
    this.twoHand = null;
    this.voice.stop();
  }

  // ------------------------------------------------------------ intents

  run(text: string): void {
    const intent = parseIntent(text);
    const last = this.items[0];
    switch (intent.kind) {
      case 'create':
        this.create(intent.prompt);
        break;
      case 'recolor':
        if (!last) return this.create(text);
        recolor(last.content, intent.color);
        this.status = `Made it ${intent.name}.`;
        Sfx.blip(820);
        break;
      case 'scale':
        if (!last) return;
        last.holder.scale.multiplyScalar(intent.factor);
        last.holder.userData.userScaled = true;
        last.radius *= intent.factor;
        this.status = intent.factor > 1 ? 'Bigger.' : 'Smaller.';
        Sfx.blip(intent.factor > 1 ? 900 : 600);
        break;
      case 'spin':
        if (last) last.spin = !last.spin;
        break;
      case 'again':
        if (last) this.create(last.prompt, last.variation + 1);
        break;
      case 'delete':
        if (last) this.remove(last);
        this.status = 'Removed it.';
        break;
      case 'clear':
        for (const item of [...this.items]) this.remove(item);
        this.status = 'Cleared the desk.';
        break;
      case 'none':
        break;
    }
    this.refresh();
  }

  private create(prompt: string, variation = 0): void {
    const { object, recipe } = buildFromPrompt(prompt, variation);
    const holder = new Group();
    holder.add(object, blobShadow(0.13));
    const item: Item = { holder, content: object, prompt, recipe, source: 'sketch', variation, spin: false, free: false, radius: 0.08 };
    this.items.unshift(item);
    this.deskRoot.add(holder);
    holder.position.copy(PEDESTAL);
    holder.scale.setScalar(0.01);
    this.restack();
    if (this.items.length > MAX_ITEMS) this.remove(this.items[this.items.length - 1]);
    this.burst.fire(this.tmp.copy(PEDESTAL).setY(0.06));
    Sfx.whoosh(this.deskRoot.localToWorld(this.tmp2.copy(PEDESTAL)));
    this.status = recipe === 'abstract' ? `Sketched "${prompt}" (abstract).` : `Sketched a ${recipe} for "${prompt}".`;
    if (this.provider !== 'sketch') void this.generateRemote(item, this.provider);
  }

  private async generateRemote(item: Item, provider: Provider): Promise<void> {
    const endpoint = gen3dEndpoint();
    if (!endpoint) return;
    const token = ++this.token;
    this.generating = { item, progress: 0, token };
    this.status = `Asking ${provider} for "${item.prompt}"...`;
    try {
      const id = await startJob(endpoint, provider, item.prompt);
      for (let i = 0; i < 180; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        if (this.generating?.token !== token) return;
        const job = await pollJob(endpoint, provider, id);
        this.generating.progress = job.progress;
        if (job.status === 'failed') throw new Error(job.error ?? 'generation failed');
        if (job.status === 'succeeded' && job.modelUrl) {
          const gltf = await AssetManager.loadGLTF(job.modelUrl);
          if (!this.items.includes(item)) return;
          this.swapContent(item, gltf.scene, provider);
          return;
        }
      }
      throw new Error('timed out');
    } catch (error) {
      this.status = `${provider} could not make it (${(error as Error).message}). Keeping the sketch.`;
    } finally {
      if (this.generating?.token === token) this.generating = null;
      this.refresh();
    }
  }

  private swapContent(item: Item, model: Object3D, source: Source): void {
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const scale = MODEL_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
    model.scale.setScalar(scale);
    const center = box.getCenter(new Vector3());
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    item.holder.remove(item.content);
    dispose(item.content);
    item.holder.add(model);
    item.content = model;
    item.source = source;
    Sfx.success(item.holder.getWorldPosition(this.tmp2));
    this.burst.fire(this.tmp.copy(item.holder.position).setY(0.08));
    this.status = `Here is your ${item.prompt}, made with ${source}.`;
  }

  private remove(item: Item): void {
    this.items = this.items.filter((i) => i !== item);
    this.holds = this.holds.filter((h) => h.item !== item);
    if (this.generating?.item === item) this.generating = null;
    this.deskRoot.remove(item.holder);
    dispose(item.content);
    this.restack();
  }

  /** Newest on the pedestal, older ones onto the shelf (unless placed by hand). */
  private restack(): void {
    let slot = 0;
    this.items.forEach((item, i) => {
      if (item.free) return;
      if (i === 0) item.holder.userData.target = PEDESTAL;
      else item.holder.userData.target = SHELF[Math.min(slot++, SHELF.length - 1)];
    });
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.panel.update(this.ctx.pointers, dt);
    this.updateGestures();
    this.updateGrabs();
    const k = 1 - Math.exp(-dt * 8);
    for (const item of this.items) {
      const target = item.holder.userData.target as Vector3 | undefined;
      const held = this.holds.some((h) => h.item === item);
      if (!held && !item.free && target) {
        item.holder.position.lerp(target, k);
        // Grow in from nothing; shelf items sit at 70 %.
        const goal = target === PEDESTAL ? 1 : 0.7;
        const s = item.holder.scale.x;
        if (Math.abs(s - goal) > 0.001 && !item.holder.userData.userScaled) item.holder.scale.setScalar(s + (goal - s) * k);
      }
      if (item.spin) item.holder.rotation.y += dt * 0.8;
    }
    this.orbit.visible = this.generating != null;
    if (this.generating) {
      this.orbit.position.set(0, 0.05 + Math.sin(this.ctx.time * 3) * 0.02, 0);
      this.orbit.rotation.set(Math.PI / 2 + Math.sin(this.ctx.time) * 0.4, this.ctx.time * 2, 0);
    }
    this.burst.update(dt);
    this.refresh();
  }

  private updateGestures(): void {
    for (const hand of this.ctx.hands.both) {
      if (hand.gesture === 'tap') this.toggleVoice();
      if (hand.gesture === 'up') this.run('make it bigger');
      if (hand.gesture === 'down') this.run('make it smaller');
      if (hand.gesture === 'right') this.run('another one');
    }
  }

  private updateGrabs(): void {
    for (const hand of this.ctx.pointers) {
      if (!hand.tracked || !hand.pinchStarted || this.panel.contains(hand.pinchPoint)) continue;
      const item = this.itemNear(hand);
      if (!item) continue;
      const other = this.holds.find((h) => h.item === item && h.hand !== hand);
      if (other) {
        // Second hand on the same object: scale and turn with both hands.
        const d = hand.pinchPoint.distanceTo(other.hand.pinchPoint);
        this.twoHand = {
          item,
          startDist: Math.max(d, 0.02),
          startScale: item.holder.scale.x,
          startAngle: Math.atan2(hand.pinchPoint.x - other.hand.pinchPoint.x, hand.pinchPoint.z - other.hand.pinchPoint.z),
          startYaw: item.holder.rotation.y,
        };
      }
      const world = item.holder.getWorldPosition(new Vector3());
      this.holds.push({ item, hand, offset: world.sub(hand.pinchPoint) });
      Sfx.pinch(hand.pinchPoint);
    }

    if (this.twoHand) {
      const pair = this.holds.filter((h) => h.item === this.twoHand!.item);
      if (pair.length === 2) {
        const [a, b] = pair;
        const t = this.twoHand;
        const d = a.hand.pinchPoint.distanceTo(b.hand.pinchPoint);
        const s = Math.min(4, Math.max(0.2, (t.startScale * d) / t.startDist));
        t.item.holder.scale.setScalar(s);
        t.item.holder.userData.userScaled = true;
        const angle = Math.atan2(b.hand.pinchPoint.x - a.hand.pinchPoint.x, b.hand.pinchPoint.z - a.hand.pinchPoint.z);
        t.item.holder.rotation.y = t.startYaw + (angle - t.startAngle);
      } else {
        this.twoHand = null;
      }
    }

    for (let i = this.holds.length - 1; i >= 0; i -= 1) {
      const hold = this.holds[i];
      if (!hold.hand.pinching || !hold.hand.tracked) {
        this.holds.splice(i, 1);
        this.release(hold);
        continue;
      }
      if (this.twoHand?.item === hold.item) continue;
      this.tmp.copy(hold.hand.pinchPoint).add(hold.offset);
      this.deskRoot.worldToLocal(this.tmp);
      hold.item.holder.position.copy(this.tmp);
    }
  }

  private release(hold: Hold): void {
    if (this.holds.some((h) => h.item === hold.item)) return;
    const p = hold.item.holder.position;
    if (Math.hypot(p.x - PEDESTAL.x, p.z - PEDESTAL.z) < 0.08 && p.y < 0.1) {
      // Back onto the pedestal: make it the current item.
      hold.item.free = false;
      this.items = [hold.item, ...this.items.filter((i) => i !== hold.item)];
      this.restack();
    } else {
      hold.item.free = true;
    }
    Sfx.place(hold.item.holder.getWorldPosition(this.tmp2));
  }

  private itemNear(hand: HandState): Item | null {
    let best: Item | null = null;
    let bestDist = Infinity;
    for (const item of this.items) {
      item.holder.getWorldPosition(this.tmp2);
      this.tmp2.y += 0.06 * item.holder.scale.y;
      const d = pointerDistance(hand, this.tmp2);
      const reach = 0.08 * Math.max(0.7, item.holder.scale.x);
      if (d < reach && d < bestDist) {
        best = item;
        bestDist = d;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ UI

  private ideas(): string[] {
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) out.push(PROMPT_IDEAS[(this.ideaOffset + i) % PROMPT_IDEAS.length]);
    return out;
  }

  private onButton(id: string): void {
    if (id.startsWith('idea')) {
      const prompt = this.ideas()[Number(id.slice(4))];
      this.ideaOffset = (this.ideaOffset + 4) % PROMPT_IDEAS.length;
      this.run(prompt);
    }
    if (id === 'speak') this.toggleVoice();
    if (id === 'again') this.run('another one');
    if (id === 'provider') this.cycleProvider();
    if (id === 'home') this.ctx.goHome();
  }

  private toggleVoice(): void {
    if (this.voice.listening) {
      this.voice.stop();
      return;
    }
    const ok = this.voice.start({
      onPartial: (t) => (this.heard = t),
      onFinal: (t) => {
        this.heard = '';
        if (t) this.run(t);
      },
      onError: (e) => {
        this.heard = '';
        this.status = `Voice error (${e}). Pinch an idea instead.`;
      },
      onEnd: () => (this.heard = ''),
    });
    if (ok) this.heard = '...';
    else this.status = 'Voice is not available in this browser. Pinch an idea instead.';
  }

  private cycleProvider(): void {
    if (!gen3dEndpoint()) {
      this.provider = 'sketch';
      this.status = 'AI generation is off: no endpoint configured (see README). Sketches still work offline.';
      return;
    }
    const order: Source[] = ['sketch', 'meshy', 'tripo'];
    this.provider = order[(order.indexOf(this.provider) + 1) % order.length];
    this.status = this.provider === 'sketch' ? 'Offline sketches only.' : `Using ${this.provider} for full models.`;
  }

  private refresh(): void {
    let body = this.status;
    if (this.voice.listening) body = `Listening: ${this.heard || '...'}`;
    else if (this.generating) body = `${this.status} ${Math.round(this.generating.progress * 100)}%`;
    this.panel.setText(`Conjure - ${this.provider === 'sketch' ? 'offline sketch' : `AI: ${this.provider}`}`, '', [
      body,
      this.ctx.immersive ? 'Try: "make it blue", "bigger", "another one". Pinch to move, both hands to scale.' : 'Drag creations around the desk.',
    ]);
    const ideas = this.ideas();
    this.panel.setButtons([
      ...ideas.map((idea, i) => ({ id: `idea${i}`, label: idea })),
      { id: 'speak', label: this.voice.listening ? 'Stop' : 'Speak', tone: this.voice.listening ? ('active' as const) : ('primary' as const) },
      { id: 'again', label: 'Another', disabled: this.items.length === 0 },
      { id: 'provider', label: this.provider === 'sketch' ? 'AI: off' : `AI: ${this.provider}` },
      { id: 'home', label: 'Lab menu' },
    ]);
  }

  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      items: this.items.map((i) => ({ prompt: i.prompt, recipe: i.recipe, source: i.source, free: i.free, scale: +i.holder.scale.x.toFixed(2), children: i.content.children.length })),
      provider: this.provider,
      status: this.status,
      holding: this.holds.length,
    };
  }

  debugActions = {
    say: (text: string) => this.run(text),
    press: (id: string) => this.panel.press(id),
    itemWorld: (index: number) => {
      const item = this.items[index];
      if (!item) return null;
      const p = item.holder.getWorldPosition(new Vector3());
      return { x: p.x, y: p.y + 0.06 * item.holder.scale.y, z: p.z };
    },
  };
}

function recolor(object: Object3D, hex: string): void {
  const swapped = new Map<Material, Material>();
  const swap = (m: Material): Material => {
    let next = swapped.get(m);
    if (!next) {
      next = m.clone();
      (next as MeshStandardMaterial).color?.set(hex);
      swapped.set(m, next);
    }
    return next;
  };
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  for (const old of swapped.keys()) old.dispose();
}

function dispose(object: Object3D): void {
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose();
  });
}
