import { describe, expect, it } from 'vitest';
import {
  applyGrab,
  buildMirror,
  buildNeighbors,
  grabAt,
  makeIcosphere,
  pushTips,
  smoothAt,
  toObj,
} from '../src/protos/clay/sculpt';

describe('sculpt', () => {
  const sphere = () => makeIcosphere(0.06, 8);

  it('builds a closed, shared-vertex icosphere', () => {
    const m = sphere();
    // 10 n^2 + 2 vertices and 20 n^2 faces for an indexed icosphere.
    expect(m.positions.length / 3).toBe(10 * 64 + 2);
    expect(m.indices.length / 3).toBe(20 * 64);
    for (let v = 0; v < m.positions.length; v += 3) {
      expect(Math.hypot(m.positions[v], m.positions[v + 1], m.positions[v + 2])).toBeCloseTo(0.06, 6);
    }
    // Closed mesh: every edge is used by exactly two triangles.
    const edges = new Map<string, number>();
    for (let i = 0; i < m.indices.length; i += 3) {
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const p = m.indices[i + a];
        const q = m.indices[i + b];
        const k = p < q ? `${p}-${q}` : `${q}-${p}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((c) => c === 2)).toBe(true);
  });

  it('pushes a dent where a fingertip presses in', () => {
    const m = sphere();
    // Fingertip 1 cm inside the surface at the top.
    const tips = new Float32Array([0, 0.06 + 0.008 - 0.01, 0]);
    const moved = pushTips(m.positions, tips, 1, 0.008);
    expect(moved).toBeGreaterThan(0);
    let topY = 0;
    for (let v = 0; v < m.positions.length; v += 3) {
      if (Math.abs(m.positions[v]) < 1e-6 && Math.abs(m.positions[v + 2]) < 1e-6 && m.positions[v + 1] > 0) topY = m.positions[v + 1];
    }
    expect(topY).toBeLessThan(0.06 - 0.009);
  });

  it('pulls nearby clay with the pinch and mirrors across x', () => {
    const m = sphere();
    const mirror = buildMirror(m.positions);
    const grab = grabAt(m.positions, 0.06, 0, 0, 0.02, mirror);
    expect(grab.indices.length).toBeGreaterThan(2);
    applyGrab(m.positions, grab, 0.03, 0, 0);
    let maxX = -Infinity;
    let minX = Infinity;
    for (let v = 0; v < m.positions.length; v += 3) {
      maxX = Math.max(maxX, m.positions[v]);
      minX = Math.min(minX, m.positions[v]);
    }
    expect(maxX).toBeGreaterThan(0.085);
    expect(minX).toBeLessThan(-0.085);
  });

  it('smoothing relaxes a spike', () => {
    const m = sphere();
    const nb = buildNeighbors(m.indices, m.positions.length / 3);
    const grab = grabAt(m.positions, 0, 0.06, 0, 0.004);
    applyGrab(m.positions, grab, 0, 0.03, 0);
    const peak = () => Math.max(...Array.from({ length: m.positions.length / 3 }, (_, v) => m.positions[v * 3 + 1]));
    const before = peak();
    for (let i = 0; i < 10; i += 1) smoothAt(m.positions, nb, 0, 0.07, 0, 0.04, 0.5);
    expect(peak()).toBeLessThan(before - 0.01);
  });

  it('exports OBJ', () => {
    const obj = toObj(makeIcosphere(1, 1));
    expect(obj.split('\n').filter((l) => l.startsWith('v ')).length).toBe(12);
    expect(obj.split('\n').filter((l) => l.startsWith('f ')).length).toBe(20);
  });
});

describe('pushTips', () => {
  it('still dents inward when the fingertip centre is inside the clay', () => {
    const m = makeIcosphere(0.06, 8);
    const before = Float32Array.from(m.positions);
    pushTips(m.positions, new Float32Array([0, 0.05, 0]), 1, 0.008);
    for (let v = 0; v < m.positions.length; v += 3) {
      const r0 = Math.hypot(before[v], before[v + 1], before[v + 2]);
      const r1 = Math.hypot(m.positions[v], m.positions[v + 1], m.positions[v + 2]);
      expect(r1).toBeLessThanOrEqual(r0 + 1e-7);
    }
  });
});
