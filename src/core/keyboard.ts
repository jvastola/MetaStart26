/**
 * A virtual keyboard that lies tilted on the front of the desk, like a
 * laptop keyboard. Poke keys with a fingertip (or pinch them, or click);
 * the Mic key dictates into the text field. On desktop the physical
 * keyboard types into it too.
 *
 * Apps open it through `LabContext.openKeyboard`; while it is open the host
 * pauses the app underneath so key presses never leak into it.
 */

import { Group } from '@iwsdk/core';
import type { HandState } from './hands.js';
import { CanvasPanel, type PanelButton } from './panel.js';
import { Sfx } from './sfx.js';
import { Voice } from './voice.js';

export interface KeyboardRequest {
  title: string;
  placeholder?: string;
  initial?: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const MAX_LENGTH = 80;

export class VirtualKeyboard {
  readonly group = new Group();
  private readonly panel: CanvasPanel;
  private request: KeyboardRequest | null = null;
  private text = '';
  private shift = false;
  private readonly voice = new Voice();
  private heard = '';
  private cursorBlink = 0;

  constructor() {
    this.panel = new CanvasPanel({ width: 0.4, height: 0.2, columns: 10, buttonHeight: 0.028, pressCooldown: 0.12, accent: '#9fc7ff' });
    this.panel.mesh.name = 'VirtualKeyboard';
    this.panel.onPress = (id) => this.key(id);
    this.group.add(this.panel.mesh);
    this.group.visible = false;
    this.group.name = 'KeyboardRoot';
  }

  get isOpen(): boolean {
    return this.request != null;
  }

  get value(): string {
    return this.text;
  }

  open(request: KeyboardRequest): void {
    this.request = request;
    this.text = request.initial ?? '';
    this.shift = this.text.length === 0;
    this.group.visible = true;
    this.refresh();
    Sfx.whoosh();
  }

  close(submit: boolean): void {
    const request = this.request;
    if (!request) return;
    this.voice.stop();
    this.request = null;
    this.group.visible = false;
    const text = this.text.trim();
    if (submit && text) {
      Sfx.success();
      request.onSubmit(text);
    } else request.onCancel?.();
  }

  /** Type a character or a named key (used by the physical keyboard too). */
  key(id: string): void {
    if (!this.request) return;
    if (id === 'enter') return this.close(true);
    if (id === 'cancel') return this.close(false);
    if (id === 'del') this.text = this.text.slice(0, -1);
    else if (id === 'shift') this.shift = !this.shift;
    else if (id === 'space') this.text += ' ';
    else if (id === 'mic') this.toggleMic();
    else if (id.length === 1 && this.text.length < MAX_LENGTH) {
      this.text += this.shift ? id.toUpperCase() : id;
      this.shift = false;
    }
    this.refresh();
  }

  /** A character from a physical keyboard, typed as-is. */
  typeChar(c: string): void {
    if (!this.request || this.text.length >= MAX_LENGTH) return;
    this.text += c;
    this.shift = false;
    this.refresh();
  }

  private toggleMic(): void {
    if (this.voice.listening) {
      this.voice.stop();
      return;
    }
    const ok = this.voice.start({
      onPartial: (t) => {
        this.heard = t;
        this.refresh();
      },
      onFinal: (t) => {
        this.heard = '';
        if (t) this.text = (this.text ? `${this.text} ` : '') + t;
        this.refresh();
      },
      onError: () => {
        this.heard = '';
        this.refresh();
      },
      onEnd: () => {
        this.heard = '';
        this.refresh();
      },
    });
    if (!ok) this.heard = 'Voice is not available in this browser - type instead.';
    this.refresh();
  }

  update(pointers: readonly HandState[], dt: number): void {
    if (!this.request) return;
    this.panel.update(pointers, dt);
    // Blink the cursor.
    this.cursorBlink += dt;
    if (this.cursorBlink > 0.5) {
      this.cursorBlink = 0;
      this.refresh(true);
    }
  }

  private cursorOn = true;

  private refresh(blink = false): void {
    if (!this.request) return;
    if (blink) this.cursorOn = !this.cursorOn;
    else this.cursorOn = true;
    const shown = this.text || '';
    const body = this.voice.listening ? `Listening: ${this.heard || '...'}` : this.heard || (shown ? '' : this.request.placeholder ?? '');
    this.panel.setText(this.request.title, `${shown}${this.cursorOn ? '|' : ' '}`, body);
    const letter = (c: string): PanelButton => ({ id: c, label: this.shift ? c.toUpperCase() : c });
    this.panel.setButtons([
      ...[...ROWS[0]].map(letter),
      ...[...ROWS[1]].map(letter),
      { id: 'del', label: 'Del' },
      { id: 'shift', label: 'Shift', tone: this.shift ? 'active' : 'default' },
      ...[...ROWS[2]].map(letter),
      { id: ',', label: ',' },
      { id: '.', label: '.' },
      { id: 'cancel', label: 'Cancel', span: 2, tone: 'danger' },
      { id: 'mic', label: this.voice.listening ? 'Stop' : 'Mic', span: 2, tone: this.voice.listening ? 'active' : 'default' },
      { id: 'space', label: 'Space', span: 4 },
      { id: 'enter', label: 'Enter', span: 2, tone: 'primary' },
    ]);
  }

  /** World position of a key, for tests. */
  keyWorld(id: string): { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null {
    const p = this.panel.buttonWorld(id);
    if (!p) return null;
    const n = this.panel.normalWorld();
    return { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z };
  }
}
