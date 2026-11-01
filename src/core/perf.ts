/**
 * Frame timing for the on-device performance pass. It always measures
 * (cheaply) so tests can read it; `?perf=1` also shows a small readout in the
 * corner of your view: frames per second, the slowest recent frame, and how
 * long the app's own update took.
 */

import { CanvasTexture, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';

const N = 120;

export interface PerfStats {
  /** Average frames per second over the last ~2 s. */
  fps: number;
  /** Average and worst time between frames, ms. */
  frameMs: number;
  worstFrameMs: number;
  /** Average and worst time spent in the app's update, ms. */
  updateMs: number;
  worstUpdateMs: number;
  /** JS heap in MB, where the browser reports it (Chromium). */
  heapMB: number | null;
  samples: number;
}

export class PerfMeter {
  private readonly frame = new Float32Array(N);
  private readonly update = new Float32Array(N);
  private i = 0;
  private count = 0;
  private start = 0;
  private last = 0;
  private redraw = 0;
  private mesh: Mesh | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private texture: CanvasTexture | null = null;

  /** Show the readout, parented to the camera. */
  show(camera: Object3D): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 96;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(new PlaneGeometry(0.08, 0.03), new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }));
    this.mesh.renderOrder = 60;
    this.mesh.userData.hideInShots = true;
    this.mesh.position.set(-0.11, -0.09, -0.4);
    camera.add(this.mesh);
  }

  begin(): void {
    const now = performance.now();
    if (this.last > 0) this.frame[this.i] = now - this.last;
    this.last = now;
    this.start = now;
  }

  end(): void {
    this.update[this.i] = performance.now() - this.start;
    this.i = (this.i + 1) % N;
    this.count = Math.min(N, this.count + 1);
    if (this.mesh && (this.redraw -= 1) <= 0) {
      this.redraw = 30;
      this.draw();
    }
  }

  stats(): PerfStats {
    let f = 0;
    let wf = 0;
    let u = 0;
    let wu = 0;
    const n = Math.max(1, this.count);
    for (let k = 0; k < this.count; k++) {
      f += this.frame[k];
      wf = Math.max(wf, this.frame[k]);
      u += this.update[k];
      wu = Math.max(wu, this.update[k]);
    }
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: f > 0 ? (1000 * n) / f : 0,
      frameMs: f / n,
      worstFrameMs: wf,
      updateMs: u / n,
      worstUpdateMs: wu,
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
      samples: this.count,
    };
  }

  private draw(): void {
    const c = this.canvas!.getContext('2d')!;
    const s = this.stats();
    c.clearRect(0, 0, 256, 96);
    c.fillStyle = 'rgba(20,22,27,0.8)';
    c.fillRect(0, 0, 256, 96);
    // Green at 72 fps or better, amber below, red under 60.
    c.fillStyle = s.fps >= 71 ? '#7fe0b5' : s.fps >= 60 ? '#ffc94d' : '#ff7a7a';
    c.font = '700 34px system-ui, sans-serif';
    c.fillText(`${s.fps.toFixed(0)} fps`, 12, 40);
    c.fillStyle = '#f4f5f7';
    c.font = '22px system-ui, sans-serif';
    c.fillText(`worst ${s.worstFrameMs.toFixed(1)} ms`, 130, 38);
    c.fillText(`app ${s.updateMs.toFixed(2)} ms (max ${s.worstUpdateMs.toFixed(1)})`, 12, 78);
    this.texture!.needsUpdate = true;
  }
}
