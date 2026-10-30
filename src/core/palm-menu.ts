/**
 * The hand menu: turn your left palm toward your face and a small halo opens
 * above it, with round icon buttons fanned along its upper edge and the app's
 * name in the middle. Poke or pinch a button with your other hand. It faces
 * you and stays upright however the wrist is turned.
 */

import {
  CanvasTexture,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { IconButton } from './icon-button.js';
import { faceViewer } from './item-actions.js';

export interface PalmItem {
  id: string;
  icon: string;
  label: string;
}

const RADIUS = 0.062;

export class PalmMenu {
  readonly group = new Group();
  readonly buttons = new Map<string, IconButton>();
  onPress: (id: string) => void = () => {};
  private readonly halo: Mesh;
  private readonly ring: Mesh;
  private readonly ringMat: MeshBasicMaterial;
  private readonly title: Mesh;
  private readonly titleCanvas = document.createElement('canvas');
  private readonly titleTexture: CanvasTexture;
  private titleText = '';
  private open = 0;
  private spin = 0;
  private readonly q = new Quaternion();

  constructor(items: PalmItem[], accent = '#9fc7ff') {
    this.group.name = 'PalmMenu';
    this.group.userData.hideInShots = true;
    this.group.visible = false;

    // A soft disc and a thin accent ring, lying in the button plane (local XZ).
    const glow = document.createElement('canvas');
    glow.width = glow.height = 256;
    const g = glow.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grad.addColorStop(0, 'rgba(30,34,44,0.85)');
    grad.addColorStop(0.7, 'rgba(30,34,44,0.55)');
    grad.addColorStop(1, 'rgba(30,34,44,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const glowTex = new CanvasTexture(glow);
    glowTex.colorSpace = SRGBColorSpace;
    this.halo = new Mesh(new CircleGeometry(RADIUS + 0.03, 48), new MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false }));
    this.halo.rotation.x = -Math.PI / 2;
    this.ringMat = new MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.7 });
    this.ring = new Mesh(new RingGeometry(RADIUS - 0.0015, RADIUS, 64, 1, Math.PI * 0.08, Math.PI * 0.84), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.001;

    this.titleCanvas.width = 320;
    this.titleCanvas.height = 96;
    this.titleTexture = new CanvasTexture(this.titleCanvas);
    this.titleTexture.colorSpace = SRGBColorSpace;
    this.title = new Mesh(new PlaneGeometry(0.07, 0.021), new MeshBasicMaterial({ map: this.titleTexture, transparent: true, depthWrite: false }));
    this.title.rotation.x = -Math.PI / 2;
    this.title.position.set(0, 0.002, 0.01);
    this.group.add(this.halo, this.ring, this.title);

    // Buttons fanned over the top half of the ring (local -Z is up).
    items.forEach((item, i) => {
      const a = (-0.42 + (0.84 * i) / Math.max(1, items.length - 1)) * Math.PI;
      const b = new IconButton({ id: `palm:${item.id}`, icon: item.icon, label: item.label, accent, radius: 0.016 });
      b.group.position.set(Math.sin(a) * RADIUS, 0.002, -Math.cos(a) * RADIUS);
      b.onPress = () => this.onPress(item.id);
      this.buttons.set(item.id, b);
      this.group.add(b.group);
    });
  }

  setTitle(text: string, accent: string): void {
    const key = `${text}|${accent}`;
    if (key === this.titleText) return;
    this.titleText = key;
    this.ringMat.color.set(accent);
    const c = this.titleCanvas.getContext('2d')!;
    c.clearRect(0, 0, 320, 96);
    c.fillStyle = accent;
    c.beginPath();
    c.arc(30, 48, 12, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#f4f5f7';
    c.font = '700 46px system-ui, sans-serif';
    c.textBaseline = 'middle';
    c.fillText(text, 54, 50, 260);
    this.titleTexture.needsUpdate = true;
  }

  /** Show it above the palm (or hide it), facing `eye`. */
  update(visible: boolean, palm: Vector3, palmNormal: Vector3, eye: Vector3, dt: number): void {
    this.open += ((visible ? 1 : 0) - this.open) * Math.min(1, dt * 14);
    this.group.visible = this.open > 0.02;
    if (!this.group.visible) return;
    const at = palm.clone().addScaledVector(palmNormal, 0.05);
    at.y += 0.06;
    this.group.position.copy(at);
    faceViewer(at, eye, this.group.quaternion);
    // Open with a little pop; the ring turns slowly.
    this.group.scale.setScalar(0.6 + 0.4 * this.open);
    this.spin += dt * 0.25;
    this.ring.rotation.z = Math.sin(this.spin) * 0.08;
  }
}
