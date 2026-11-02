/**
 * Conjure: say what you want and it appears on your desk.
 *
 * 1. You speak (or pinch a prompt chip). The intent parser decides whether
 *    it is a new object or a follow-up ("make it blue", "bigger", "another").
 * 2. An instant offline sketch appears on the pedestal (kit.ts).
 * 3. If an AI provider is configured, Meshy or Tripo generates a real model
 *    in the background via our proxy and replaces the sketch when ready.
 * 4. Grab creations to place them anywhere; grab with both hands to scale
 *    and turn. A new creation takes the pedestal and only the previous one
 *    steps aside to a free shelf spot: nothing else moves. Things you placed
 *    by hand stay where you put them.
 *
 * Controls are round icon buttons in front of the pedestal; a small text-only
 * display behind it shows the conversation.
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
  Quaternion,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { Burst } from '../../core/burst.js';
import type { LabContext, Prototype } from '../../core/context.js';
import { ACCENTS, blobShadow } from '../../core/art.js';
import { HeldPose } from '../../core/grab.js';
import { grabDistance, type HandState } from '../../core/hands.js';
import { CanvasPanel } from '../../core/panel.js';
import { Sfx } from '../../core/sfx.js';
import { Voice } from '../../core/voice.js';
import { parseIntent } from './intent.js';
import { buildFromPrompt } from './kit.js';
import type { Selectable, SelectionSource } from '../../core/selection.js';
import { IconButton } from '../../core/icon-button.js';
import { ItemActions } from '../../core/item-actions.js';
import { pointerDistance } from '../../core/hands.js';
import { ProgressRing } from '../../core/progress-ring.js';
import { availableProviders, pollJob, type Provider, startJob, withTimeout } from './remote.js';

type Source = 'sketch' | Provider;

/** Undo steps. Removed items are kept (not disposed) until they drop out of the history. */
type HistoryEntry =
  | { kind: 'add'; items: Item[]; evicted: Item | null; slots: Map<Item, { slot: number | null; free: boolean }> }
  | { kind: 'remove'; items: Item[]; slots: Map<Item, { slot: number | null; free: boolean }> };

const MAX_HISTORY = 30;

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
  /** Geometry and materials shared with another item (a duplicate): do not dispose. */
  shared?: boolean;
  /** -1 = pedestal, 0.. = shelf spot, null = placed by hand. */
  slot: number | null;
  /** Set when repainted, so a pinned copy keeps the colour. */
  color?: string;
}

interface Hold {
  item: Item;
  hand: HandState;
  pose: HeldPose;
  /** Where it was picked up (a mouse click that does not move it is a tap). */
  from: Vector3;
}

/** Give up on an AI model after this long and keep the offline sketch. */
const GENERATION_LIMIT_MS = 4 * 60_000;
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
const SHELF_COMPACT = [new Vector3(-0.17, 0, 0.04), new Vector3(0.17, 0, 0.04), new Vector3(-0.17, 0, -0.09), new Vector3(0.17, 0, -0.09)];

/** The round buttons in front of the pedestal, left to right. */
const BUTTONS: [id: string, icon: string, label: string][] = [
  ['idea', 'conjure', 'Surprise me'],
  ['speak', 'speak', 'Speak'],
  ['type', 'type', 'Type'],
  ['again', 'redo', 'Another version'],
  ['provider', 'ai', 'AI: off'],
  ['clear', 'trash', 'Clear the desk'],
];

/** Lets a host app embed Conjure as a compact window. */
export interface ConjureOptions {
  /** A host's shared Undo, used for a spoken "undo". */
  undo?: () => boolean;
  /** 'compact' pulls the shelf in and the panel behind the pedestal. */
  layout?: 'full' | 'compact';
}

export class ConjurePrototype implements Prototype {
  readonly id = 'conjure';
  readonly title = 'Conjure';
  readonly tagline = 'Voice to 3D on your desk';
  readonly accent = ACCENTS.conjure;
  readonly howTo = [
    'Press the mic and say what you want, or the star for an idea.',
    'Follow up: "make it blue", "bigger", "another one".',
    'Grab a creation (thumb + middle finger) to move it; use both hands to scale.',
    'Drop a creation in the bin on the desk corner to delete it.',
  ];
  readonly trash = true;
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
  private chat: { who: 'You' | 'Conjure'; text: string }[] = [];
  private provider: Source = 'sketch';
  private generating: { item: Item; progress: number; token: number; started: number } | null = null;
  private readonly progressRing = new ProgressRing(0.1, '#b48cff');
  private history: HistoryEntry[] = [];
  /** Set by placeOnPedestal when a full shelf pushed its oldest item out. */
  private evicted: Item | null = null;
  /** Told when an undo step is added ('push') or used up here ('pop'), so a host can keep one undo order. */
  onHistory: ((event: 'push' | 'pop') => void) | null = null;
  private token = 0;
  private ideaOffset = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private shelf: Vector3[];
  private readonly selectables = new Map<Item, Selectable>();
  /** Lets a Selection find, move, copy, paint and delete creations. */
  readonly selectionSource: SelectionSource = {
    items: () => this.items.filter((i) => !this.holds.some((h) => h.item === i)).map((i) => this.selectableFor(i)),
    // Any creation, held ones included: a second hand on a held one scales it.
    grabbable: (w) => this.items.some((i) => i.holder.getWorldPosition(this.tmp2).distanceTo(w) < 0.08 * Math.max(0.7, i.holder.scale.x) + 0.04),
    remove: (items) => this.deleteItems(items.map((sel) => this.itemOf(sel)).filter((i): i is Item => i != null)),
    duplicate: (items) => {
      const copies: Selectable[] = [];
      for (const sel of items) {
        const item = this.itemOf(sel);
        if (!item) continue;
        const copy = this.duplicateItem(item);
        copies.push(this.selectableFor(copy));
      }
      const made = copies.map((sel) => this.itemOf(sel)).filter((i): i is Item => i != null);
      if (made.length) this.record({ kind: 'add', items: made, evicted: null, slots: this.slotSnapshot() });
      return copies;
    },
    recolor: (items, hex) => {
      for (const sel of items) {
        const item = this.itemOf(sel);
        if (item) {
          recolor(item.content, hex);
          item.color = hex;
        }
      }
    },
    pin: (items) => {
      for (const sel of items) {
        const item = this.itemOf(sel);
        if (item) this.pinItem(item);
      }
    },
    moved: (items) => {
      for (const sel of items) {
        const item = this.itemOf(sel);
        if (item) this.unslot(item);
      }
    },
  };
  private readonly buttons = new Map<string, IconButton>();
  /** Pin and delete for the tapped creation. */
  private itemActions!: ItemActions;
  private tapped: Item | null = null;
  private taps: { item: Item; hand: HandState; time: number }[] = [];

  constructor(private readonly options: ConjureOptions = {}) {
    this.shelf = options.layout === 'compact' ? SHELF_COMPACT : SHELF;
  }

  /** Switch between the full layout and the compact (window) layout. */
  setLayout(mode: 'full' | 'compact'): void {
    this.shelf = mode === 'compact' ? SHELF_COMPACT : SHELF;
    if (this.panel) this.panel.mesh.position.set(0, 0.085, mode === 'compact' ? -0.17 : -0.19);
    const z = mode === 'compact' ? 0.115 : 0.14;
    BUTTONS.forEach(([id], i) => this.buttons.get(id)?.group.position.set((i - (BUTTONS.length - 1) / 2) * 0.04, 0.001, z));
    this.restack();
  }

  /** Fold the controls away (a host app, when no hand is near) or bring them back. */
  setControlsVisible(on: boolean): void {
    this.panel.mesh.visible = on;
    for (const b of this.buttons.values()) b.group.visible = on;
  }

  /** No longer on the pedestal or shelf: it stays where it is. */
  private unslot(item: Item): void {
    item.free = true;
    item.slot = null;
  }

  /**
   * Put an item on the pedestal. Whatever was there steps aside to the first
   * free shelf spot; only when the shelf is full does its oldest item go.
   */
  private placeOnPedestal(item: Item): void {
    const current = this.items.find((i) => i !== item && i.slot === -1);
    if (current) {
      const used = new Set(this.items.filter((i) => i.slot != null && i.slot >= 0).map((i) => i.slot));
      let spot = this.shelf.findIndex((_, k) => !used.has(k));
      if (spot < 0) {
        const oldest = [...this.items].reverse().find((i) => i !== item && i.slot != null && i.slot >= 0)!;
        spot = oldest.slot!;
        this.burst.fire(this.tmp.copy(this.shelf[spot]).setY(0.05));
        this.remove(oldest, false);
        this.evicted = oldest;
      }
      current.slot = spot;
    }
    item.slot = -1;
    item.free = false;
    this.restack();
  }

  private selectableFor(item: Item): Selectable {
    let sel = this.selectables.get(item);
    if (!sel) {
      sel = {
        object: item.holder,
        source: this.selectionSource,
        bounds: (c) => {
          item.holder.getWorldPosition(c);
          c.y += 0.06 * item.holder.scale.y;
          return 0.075 * item.holder.scale.x;
        },
        // Selected things stay where they are instead of sliding back to the shelf.
        setLit: (on) => {
          if (on) this.unslot(item);
          glow(item.content, on, this.accent);
        },
      };
      this.selectables.set(item, sel);
    }
    return sel;
  }

  private itemOf(sel: Selectable): Item | undefined {
    for (const [item, s] of this.selectables) if (s === sel) return item;
    return undefined;
  }

  private duplicateItem(item: Item): Item {
    let content: Object3D;
    let shared = false;
    if (item.source === 'sketch') content = buildFromPrompt(item.prompt, item.variation).object;
    else {
      content = item.content.clone(true);
      shared = true;
      // Both now share geometry, so neither may dispose it.
      item.shared = true;
    }
    const holder = new Group();
    holder.add(content, blobShadow(0.13));
    holder.position.copy(item.holder.position).add(new Vector3(0.06, 0, 0.03));
    holder.quaternion.copy(item.holder.quaternion);
    holder.scale.copy(item.holder.scale);
    holder.userData.userScaled = true;
    const copy: Item = { ...item, holder, content, free: true, spin: false, shared, slot: null };
    this.items.push(copy);
    this.deskRoot.add(holder);
    return copy;
  }

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
    this.deskRoot.add(this.progressRing.group);

    // A small text-only display for the conversation (no buttons, so rays ignore it).
    this.panel = new CanvasPanel({ width: 0.32, height: 0.085, columns: 1, accent: this.accent });
    this.panel.mesh.name = 'ConjurePanel';
    this.panel.mesh.rotation.x = -0.3;
    this.deskRoot.add(this.panel.mesh);
    for (const [id, icon, label] of BUTTONS) {
      const b = new IconButton({ id: `conjure:${id}`, icon, label, accent: this.accent, radius: 0.016 });
      b.onPress = () => this.onButton(id);
      this.buttons.set(id, b);
      this.deskRoot.add(b.group);
    }
    this.setLayout(this.options.layout ?? 'full');
    this.itemActions = new ItemActions(
      `conjure-${this.options.layout ?? 'full'}`,
      this.accent,
      () => {
        if (this.tapped) this.pinItem(this.tapped);
      },
      () => {
        if (this.tapped) {
          Sfx.trash(this.tapped.holder.getWorldPosition(this.tmp));
          this.deleteItems([this.tapped]);
        }
      },
    );
    this.itemActions.addLibrary(`conjure-${this.options.layout ?? 'full'}`, this.accent, () => {
      const it = this.tapped;
      if (!it) return;
      this.ctx.library.add({ k: 'model', pr: it.prompt, va: it.variation, c: it.color ?? undefined, t: [0, 0, 0, 0, 0, 0, 1, 1], pinned: false });
      this.ctx.toast('Added to the library. Pull it out from the shelf in Shot Board.');
    });
    this.deskRoot.add(this.itemActions.group);

    this.provider = availableProviders()[0] ?? 'sketch';
  }

  enter(): void {
    // Keys may have been added or removed in Settings since last time.
    const available = availableProviders();
    if (this.provider !== 'sketch' && !available.includes(this.provider)) this.provider = available[0] ?? 'sketch';
    if (this.provider === 'sketch' && available.length > 0 && this.items.length === 0) this.provider = available[0];
    this.status = this.items.length === 0 ? 'Say or type what you want, or press the star for an idea.' : this.status;
    this.refresh();
  }

  exit(): void {
    this.holds = [];
    this.twoHand = null;
    this.voice.stop();
  }

  holding(): boolean {
    return this.holds.length > 0;
  }

  /** True if this hand is carrying a creation. */
  heldBy(hand: HandState): boolean {
    return this.holds.some((h) => h.hand === hand);
  }

  // ------------------------------------------------------------ intents

  /** Chat entry point: what the user typed or said, and Conjure's reply. */
  ask(text: string): void {
    this.chat.push({ who: 'You', text });
    this.run(text);
    this.chat.push({ who: 'Conjure', text: this.status || 'Done.' });
    this.chat = this.chat.slice(-4);
    this.refresh();
  }

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
        last.color = intent.color;
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
        if (last) this.deleteItems([last]);
        this.status = 'Removed it.';
        break;
      case 'undo':
        // A host app can make "undo" mean its shared undo.
        if (!(this.options.undo ? this.options.undo() : this.undoLast())) this.status = 'Nothing to undo.';
        break;
      case 'clear':
        if (this.items.length) this.deleteItems([...this.items]);
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
    const item: Item = { holder, content: object, prompt, recipe, source: 'sketch', variation, spin: false, free: false, radius: 0.08, slot: null };
    const slots = this.slotSnapshot();
    this.evicted = null;
    this.items.unshift(item);
    this.deskRoot.add(holder);
    holder.position.copy(PEDESTAL);
    holder.scale.setScalar(0.01);
    this.placeOnPedestal(item);
    this.record({ kind: 'add', items: [item], evicted: this.evicted, slots });
    this.evicted = null;
    this.burst.fire(this.tmp.copy(PEDESTAL).setY(0.06));
    Sfx.whoosh(this.deskRoot.localToWorld(this.tmp2.copy(PEDESTAL)));
    this.status = recipe === 'abstract' ? `Sketched "${prompt}" (abstract).` : `Sketched a ${recipe} for "${prompt}".`;
    if (this.provider !== 'sketch') void this.generateRemote(item, this.provider);
  }

  private async generateRemote(item: Item, provider: Provider): Promise<void> {
    const token = ++this.token;
    this.generating = { item, progress: 0, token, started: performance.now() };
    this.status = `Asking ${provider} for "${item.prompt}"...`;
    try {
      const id = await startJob(provider, item.prompt);
      if (this.generating?.token !== token) return;
      this.status = `${provider} is making "${item.prompt}"`;
      let misses = 0;
      while (performance.now() - this.generating.started < GENERATION_LIMIT_MS) {
        await new Promise((r) => setTimeout(r, 2000));
        if (this.generating?.token !== token) return;
        let job;
        try {
          job = await pollJob(provider, id);
          misses = 0;
        } catch (error) {
          // A dropped status check is not a failed job: try a few more times.
          if (++misses >= 3) throw error;
          continue;
        }
        if (this.generating?.token !== token) return;
        this.generating.progress = job.progress;
        if (job.status === 'failed') throw new Error(job.error ?? 'generation failed');
        if (job.status === 'succeeded' && job.modelUrl) {
          this.status = `Loading the ${item.prompt}...`;
          const gltf = await withTimeout(AssetManager.loadGLTF(job.modelUrl), 60_000, 'the model took too long to download');
          if (!this.items.includes(item) || this.generating?.token !== token) return;
          this.swapContent(item, gltf.scene, provider);
          return;
        }
      }
      throw new Error('it took longer than 4 minutes');
    } catch (error) {
      if (this.generating?.token === token) this.status = `${provider} could not make it (${(error as Error).message}). Keeping the sketch.`;
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
    disposeObject(item.content);
    item.holder.add(model);
    item.content = model;
    item.source = source;
    Sfx.success(item.holder.getWorldPosition(this.tmp2));
    this.burst.fire(this.tmp.copy(item.holder.position).setY(0.08));
    this.status = `Here is your ${item.prompt}, made with ${source}.`;
  }

  /** Hand a creation to the desk: it stays there in every app and next session. */
  private pinItem(item: Item): void {
    item.holder.updateWorldMatrix(true, false);
    const pos = item.holder.getWorldPosition(new Vector3());
    const quat = item.holder.getWorldQuaternion(new Quaternion());
    const scale = item.holder.getWorldScale(new Vector3()).x;
    this.ctx.deskObjects.addModel(item.prompt, item.variation, item.color ?? null, pos, quat, scale);
    this.remove(item);
    this.status = `Pinned the ${item.prompt} to the desk.`;
  }

  /** Show or hide a creation's pin and delete buttons. */
  private tapItem(item: Item | null): void {
    this.tapped = item;
    if (item) this.itemActions.show(item.holder, () => item.holder.localToWorld(new Vector3(0, 0.15, 0)));
    else this.itemActions.hide();
  }

  /** A quick pinch on a creation shows its buttons; a pinch elsewhere hides them. */
  private updateTaps(dt: number): void {
    for (const t of this.taps) t.time += dt;
    for (const hand of this.ctx.pointers) {
      // A mouse click also starts a grab: that path handles it.
      if (!hand.tracked || !hand.pinchStarted || (hand.isMouse && hand.grabStarted)) continue;
      const item = this.items.find((i) => pointerDistance(hand, i.holder.localToWorld(this.tmp.set(0, 0.06, 0))) < 0.07 * Math.max(0.7, i.holder.scale.x));
      if (item) {
        this.taps.push({ item, hand, time: 0 });
        hand.clearEdges();
      } else if (this.tapped) this.tapItem(null);
    }
    for (let i = this.taps.length - 1; i >= 0; i -= 1) {
      const t = this.taps[i];
      if (t.hand.pinching && t.hand.tracked) continue;
      this.taps.splice(i, 1);
      if (t.time < 0.4 && this.items.includes(t.item)) this.tapItem(this.tapped === t.item ? null : t.item);
    }
    this.itemActions.update(this.ctx.camera.getWorldPosition(this.tmp2));
  }

  /** Take an item off the desk. `dispose` false keeps it whole so Undo can bring it back. */
  private remove(item: Item, dispose = true): void {
    if (this.tapped === item) this.tapItem(null);
    this.items = this.items.filter((i) => i !== item);
    this.holds = this.holds.filter((h) => h.item !== item);
    if (this.generating?.item === item) this.generating = null;
    this.deskRoot.remove(item.holder);
    if (dispose && !item.shared) disposeObject(item.content);
    this.selectables.delete(item);
    this.restack();
  }

  /** Where every item sits now, so Undo can put them back. */
  private slotSnapshot(): Map<Item, { slot: number | null; free: boolean }> {
    return new Map(this.items.map((i) => [i, { slot: i.slot, free: i.free }]));
  }

  /** Delete items as one undo step. */
  private deleteItems(items: Item[]): void {
    if (!items.length) return;
    const slots = this.slotSnapshot();
    for (const item of items) this.remove(item, false);
    this.record({ kind: 'remove', items, slots });
  }

  private record(entry: HistoryEntry): void {
    this.history.push(entry);
    this.onHistory?.('push');
    while (this.history.length > MAX_HISTORY) {
      const old = this.history.shift()!;
      // Things removed that long ago can no longer come back.
      const gone = old.kind === 'remove' ? old.items : old.evicted ? [old.evicted] : [];
      for (const item of gone) if (!this.items.includes(item) && !item.shared) disposeObject(item.content);
    }
  }

  undo(): boolean {
    return this.undoLast();
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  /**
   * Undo the last creation, copy or delete. `fromHost` is set when a host's
   * shared Undo asks; false when this tool's own control did it. Returns
   * false when there was nothing to undo.
   */
  undoLast(fromHost = false): boolean {
    const entry = this.history.pop();
    if (!entry) return false;
    if (!fromHost) this.onHistory?.('pop');
    if (entry.kind === 'add') {
      for (const item of entry.items) if (this.items.includes(item)) this.remove(item);
      if (entry.evicted && !this.items.includes(entry.evicted)) this.restore(entry.evicted);
    } else {
      for (const item of entry.items) if (!this.items.includes(item)) this.restore(item);
    }
    // Everything back to the spot it had.
    for (const [item, at] of entry.slots) {
      if (!this.items.includes(item)) continue;
      item.slot = at.slot;
      item.free = at.free;
    }
    this.restack();
    this.status = entry.kind === 'add' ? 'Undid that.' : 'Brought it back.';
    Sfx.blip(520);
    this.refresh();
    return true;
  }

  private restore(item: Item): void {
    this.items.push(item);
    this.deskRoot.add(item.holder);
  }

  /** Each item heads for its own spot; nothing is reshuffled. */
  private restack(): void {
    for (const item of this.items) {
      item.holder.userData.target = item.free || item.slot == null ? undefined : item.slot === -1 ? PEDESTAL : this.shelf[Math.min(item.slot, this.shelf.length - 1)];
    }
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.panel.update([], dt);
    this.updateProgress(dt);
    this.updateTaps(dt);
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
      if (!hand.tracked || !hand.grabStarted) continue;
      const item = this.itemNear(hand);
      if (!item) continue;
      const other = this.holds.find((h) => h.item === item && h.hand !== hand);
      if (other) {
        // Second hand on the same object: scale and turn with both hands.
        const d = hand.holdPoint.distanceTo(other.hand.holdPoint);
        this.twoHand = {
          item,
          startDist: Math.max(d, 0.02),
          startScale: item.holder.scale.x,
          startAngle: Math.atan2(hand.holdPoint.x - other.hand.holdPoint.x, hand.holdPoint.z - other.hand.holdPoint.z),
          startYaw: item.holder.rotation.y,
        };
      }
      // Turning your wrist turns the object while you hold it.
      const pose = new HeldPose();
      pose.begin(hand, item.holder);
      this.holds.push({ item, hand, pose, from: item.holder.position.clone() });
      Sfx.pinch(hand.holdPoint);
    }

    if (this.twoHand) {
      const pair = this.holds.filter((h) => h.item === this.twoHand!.item);
      if (pair.length === 2) {
        const [a, b] = pair;
        const t = this.twoHand;
        const d = a.hand.holdPoint.distanceTo(b.hand.holdPoint);
        const s = Math.min(4, Math.max(0.2, (t.startScale * d) / t.startDist));
        t.item.holder.scale.setScalar(s);
        t.item.holder.userData.userScaled = true;
        const angle = Math.atan2(b.hand.holdPoint.x - a.hand.holdPoint.x, b.hand.holdPoint.z - a.hand.holdPoint.z);
        t.item.holder.rotation.y = t.startYaw + (angle - t.startAngle);
      } else {
        this.twoHand = null;
      }
    }

    for (let i = this.holds.length - 1; i >= 0; i -= 1) {
      const hold = this.holds[i];
      if (!hold.hand.grabbing || !hold.hand.tracked) {
        this.holds.splice(i, 1);
        this.release(hold);
        continue;
      }
      if (this.twoHand?.item === hold.item) continue;
      hold.pose.apply(hold.hand, hold.item.holder);
      this.ctx.trash.near(hold.hand.holdPoint);
    }
  }

  private release(hold: Hold): void {
    if (this.holds.some((h) => h.item === hold.item)) return;
    // A click (the mouse grabs and pinches at once) that did not move it: show its buttons.
    if (hold.hand.isMouse && hold.item.holder.position.distanceTo(hold.from) < 0.01) {
      this.tapItem(this.tapped === hold.item ? null : hold.item);
      return;
    }
    if (this.ctx.trash.take(hold.hand.holdPoint)) {
      this.deleteItems([hold.item]);
      this.status = `Threw away the ${hold.item.prompt}.`;
      return;
    }
    const p = hold.item.holder.position;
    if (Math.hypot(p.x - PEDESTAL.x, p.z - PEDESTAL.z) < 0.08 && p.y < 0.1) {
      // Back onto the pedestal: make it the current item.
      this.items = [hold.item, ...this.items.filter((i) => i !== hold.item)];
      this.placeOnPedestal(hold.item);
    } else {
      this.unslot(hold.item);
    }
    Sfx.place(hold.item.holder.getWorldPosition(this.tmp2));
  }

  private itemNear(hand: HandState): Item | null {
    let best: Item | null = null;
    let bestDist = Infinity;
    for (const item of this.items) {
      item.holder.getWorldPosition(this.tmp2);
      this.tmp2.y += 0.06 * item.holder.scale.y;
      const d = grabDistance(hand, this.tmp2);
      const reach = 0.08 * Math.max(0.7, item.holder.scale.x);
      if (d < reach && d < bestDist) {
        best = item;
        bestDist = d;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ UI

  private onButton(id: string): void {
    if (id === 'idea') {
      const prompt = PROMPT_IDEAS[this.ideaOffset % PROMPT_IDEAS.length];
      this.ideaOffset += 1;
      this.ask(prompt);
    }
    if (id === 'clear') this.ask('clear everything');
    if (id === 'speak') this.toggleVoice();
    if (id === 'again') this.run('another one');
    if (id === 'provider') this.cycleProvider();
    if (id === 'type') {
      this.ctx.openKeyboard({
        title: 'Ask Conjure',
        placeholder: 'e.g. "a tiny castle", "make it blue", "bigger" - or press Mic',
        onSubmit: (text) => this.ask(text),
      });
    }
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
        if (t) this.ask(t);
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
    const available = availableProviders();
    if (available.length === 0) {
      this.provider = 'sketch';
      this.status = 'AI is off. To use Meshy or Tripo, open Settings on the page (before entering MR) and add your API key. Sketches work offline.';
      return;
    }
    const order: Source[] = ['sketch', ...available];
    this.provider = order[(order.indexOf(this.provider) + 1) % order.length];
    this.status = this.provider === 'sketch' ? 'Offline sketches only.' : `Using ${this.provider} for full models.`;
  }

  /** The ring around a creation that an AI service is still making. */
  private updateProgress(dt: number): void {
    const g = this.generating;
    const ring = this.progressRing;
    ring.group.visible = g != null && this.items.includes(g.item);
    if (!g || !ring.group.visible) return;
    ring.group.position.copy(g.item.holder.position).setY(g.item.holder.position.y + 0.004);
    ring.group.scale.setScalar(Math.max(0.5, g.item.holder.scale.x));
    ring.progress = g.progress;
    ring.update(dt);
    // Refresh the status line about once a second (elapsed time, percent).
    const secs = Math.floor((performance.now() - g.started) / 1000);
    if (secs !== this.shownSecs) {
      this.shownSecs = secs;
      this.refresh();
    }
  }

  private shownSecs = -1;

  private refresh(): void {
    let body = this.status;
    if (this.voice.listening) body = `Listening: ${this.heard || '...'}`;
    else if (this.generating) body = `${this.status}: ${Math.round(this.generating.progress * 100)}% (${Math.floor((performance.now() - this.generating.started) / 1000)} s)`;
    // The last exchange, or the live status.
    const log = this.chat.slice(-2).map((m) => `${m.who}: ${m.text}`);
    const live = this.voice.listening || this.generating || log.length === 0 ? [body] : [];
    this.panel.setText(`Conjure - ${this.provider === 'sketch' ? 'offline sketch' : `AI: ${this.provider}`}`, '', [...log, ...live]);
    const speak = this.buttons.get('speak')!;
    speak.active = this.voice.listening;
    speak.label = this.voice.listening ? 'Stop listening' : 'Speak';
    this.buttons.get('again')!.disabled = this.items.length === 0;
    this.buttons.get('clear')!.disabled = this.items.length === 0;
    const ai = this.buttons.get('provider')!;
    ai.active = this.provider !== 'sketch';
    ai.label = this.provider === 'sketch' ? 'AI: off (offline sketches)' : `AI: ${this.provider}`;
  }


  // ------------------------------------------------------------ tests

  debugState(): unknown {
    return {
      items: this.items.map((i) => ({ slot: i.slot, pos: i.holder.position.toArray().map((v) => +v.toFixed(3)), prompt: i.prompt, recipe: i.recipe, source: i.source, free: i.free, scale: +i.holder.scale.x.toFixed(2), yaw: +i.holder.rotation.y.toFixed(2), pitch: +i.holder.rotation.x.toFixed(2), children: i.content.children.length })),
      provider: this.provider,
      status: this.status,
      chat: this.chat.map((m) => `${m.who}: ${m.text}`),
      holding: this.holds.length,
      generating: this.generating ? { progress: this.generating.progress, ring: this.progressRing.group.visible } : null,
    };
  }

  debugActions = {
    say: (text: string) => this.ask(text),
    press: (id: string) => this.buttons.get(id)?.press(true),
    itemWorld: (index: number) => {
      const item = this.items[index];
      if (!item) return null;
      const p = item.holder.getWorldPosition(new Vector3());
      return { x: p.x, y: p.y + 0.06 * item.holder.scale.y, z: p.z };
    },
  };
}

/** Make a creation glow while it is selected (and back). */
function glow(object: Object3D, on: boolean, hex: string): void {
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const std = m as MeshStandardMaterial;
      if (!std.emissive) continue;
      if (on) {
        std.userData.emissive ??= [std.emissive.getHex(), std.emissiveIntensity];
        std.emissive.set(hex);
        std.emissiveIntensity = 0.35;
      } else if (std.userData.emissive) {
        std.emissive.setHex(std.userData.emissive[0]);
        std.emissiveIntensity = std.userData.emissive[1];
        delete std.userData.emissive;
      }
    }
  });
}

export function recolor(object: Object3D, hex: string): void {
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

function disposeObject(object: Object3D): void {
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose();
  });
}
