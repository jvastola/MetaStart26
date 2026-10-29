/**
 * A slider lying on the desk: pinch the knob (or touch it, or click) and
 * slide along the track. Values run 0..1; the owner maps them to whatever
 * the slider controls and supplies the label text.
 */

import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { type HandState, pointerDistance } from './hands.js';
import { Sfx } from './sfx.js';

const GRAB = 0.035;
const TOUCH = 0.014;

export class DeskSlider {
  readonly group = new Group();
  onChange: (value: number) => void = () => {};
  private formatter: (value: number) => string = (v) => `${Math.round(v * 100)}%`;

  /** Text shown above the knob for a value. */
  get format(): (value: number) => string {
    return this.formatter;
  }

  set format(fn: (value: number) => string) {
    this.formatter = fn;
    this.lastText = '';
    this.layout();
  }
  value: number;
  private readonly knob: Mesh;
  private readonly knobMat = new MeshStandardMaterial({ color: '#f4f5f7', roughness: 0.3, emissive: '#9fc7ff', emissiveIntensity: 0.1 });
  private readonly label: Mesh;
  private readonly labelCanvas = document.createElement('canvas');
  private readonly labelTexture: CanvasTexture;
  private drag: { pointer: HandState; via: 'pinch' | 'touch' } | null = null;
  private lastText = '';
  private lastStep = -1;
  private readonly tmp = new Vector3();

  constructor(
    private readonly length = 0.2,
    initial = 0.5,
    accent = '#9fc7ff',
  ) {
    this.value = initial;
    const track = new Mesh(new CylinderGeometry(0.004, 0.004, length, 16), new MeshStandardMaterial({ color: '#3a404c', roughness: 0.6 }));
    track.rotation.z = Math.PI / 2;
    const fill = new Mesh(new CylinderGeometry(0.0045, 0.0045, 1, 16), new MeshBasicMaterial({ color: accent }));
    fill.rotation.z = Math.PI / 2;
    fill.name = 'SliderFill';
    this.knob = new Mesh(new SphereGeometry(0.011, 20, 14), this.knobMat);
    this.knob.position.y = 0.004;
    this.labelCanvas.width = 256;
    this.labelCanvas.height = 96;
    this.labelTexture = new CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = SRGBColorSpace;
    this.label = new Mesh(new PlaneGeometry(0.06, 0.0225), new MeshBasicMaterial({ map: this.labelTexture, transparent: true, depthWrite: false }));
    this.label.rotation.x = -0.6;
    this.group.add(track, fill, this.knob, this.label);
    this.group.position.y = 0.006;
    this.layout();
  }

  /** Track end points in world space. */
  private ends(): [Vector3, Vector3] {
    this.group.updateMatrixWorld(true);
    return [this.group.localToWorld(new Vector3(-this.length / 2, 0, 0)), this.group.localToWorld(new Vector3(this.length / 2, 0, 0))];
  }

  get active(): boolean {
    return this.drag != null;
  }

  update(pointers: readonly HandState[]): void {
    if (!this.group.visible) return;
    this.knob.updateMatrixWorld(true);
    const knobWorld = this.knob.getWorldPosition(this.tmp).clone();
    if (this.drag == null) {
      let near = Infinity;
      for (const p of pointers) {
        if (!p.tracked) continue;
        const d = pointerDistance(p, knobWorld);
        near = Math.min(near, d);
        const touch = !p.isMouse && p.indexTip.distanceTo(knobWorld) < TOUCH;
        if ((p.pinchStarted && d < GRAB) || touch) {
          this.drag = { pointer: p, via: p.pinchStarted || p.isMouse ? 'pinch' : 'touch' };
          Sfx.pinch(p.isMouse ? undefined : knobWorld);
          break;
        }
      }
      this.knobMat.emissiveIntensity = near < 0.06 ? 0.5 : 0.1;
      return;
    }
    const { pointer, via } = this.drag;
    const still = via === 'pinch' ? pointer.pinching : pointer.indexTip.distanceTo(knobWorld) < TOUCH * 2.5;
    if (!still || !pointer.tracked) {
      this.drag = null;
      Sfx.place(knobWorld);
      return;
    }
    // Project the pointer onto the track.
    const [a, b] = this.ends();
    const ab = b.clone().sub(a);
    const point = via === 'pinch' ? pointer.pinchPoint : pointer.indexTip;
    const t = Math.min(1, Math.max(0, point.clone().sub(a).dot(ab) / ab.lengthSq()));
    if (Math.abs(t - this.value) > 1e-4) {
      this.value = t;
      this.layout();
      const step = Math.round(t * 10);
      if (step !== this.lastStep) {
        this.lastStep = step;
        Sfx.blip(500 + step * 50, knobWorld);
      }
      this.onChange(t);
    }
    this.knobMat.emissiveIntensity = 0.9;
  }

  set(value: number): void {
    this.value = Math.min(1, Math.max(0, value));
    this.layout();
  }

  private layout(): void {
    const x = (this.value - 0.5) * this.length;
    this.knob.position.x = x;
    const fill = this.group.getObjectByName('SliderFill') as Mesh;
    fill.scale.y = Math.max(0.0001, this.value * this.length);
    fill.position.x = -this.length / 2 + (this.value * this.length) / 2;
    this.label.position.set(x, 0.03, 0);
    const text = this.format(this.value);
    if (text === this.lastText) return;
    this.lastText = text;
    const c = this.labelCanvas.getContext('2d')!;
    c.clearRect(0, 0, 256, 96);
    c.fillStyle = 'rgba(20,22,27,0.88)';
    c.beginPath();
    c.roundRect?.(8, 8, 240, 80, 30);
    c.fill();
    c.fillStyle = '#f4f5f7';
    c.font = '700 44px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 128, 50);
    this.labelTexture.needsUpdate = true;
  }

  /** World position of a slider value, for tests. */
  worldAt(value: number): Vector3 {
    this.group.updateMatrixWorld(true);
    return this.group.localToWorld(new Vector3((value - 0.5) * this.length, 0.004, 0));
  }
}
