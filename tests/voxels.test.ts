import { describe, expect, it } from 'vitest';
import { cellsBetween, raycast, VoxelGrid } from '../src/protos/blocks/voxels.js';

describe('VoxelGrid', () => {
  it('sets, gets and reports changes', () => {
    const g = new VoxelGrid(8, 8);
    expect(g.set(1, 0, 2, 0xff0000)).toEqual({ key: g.key(1, 0, 2), before: null, after: 0xff0000 });
    expect(g.get(1, 0, 2)).toBe(0xff0000);
    expect(g.set(1, 0, 2, 0xff0000)).toBeNull();
    expect(g.set(9, 0, 0, 1)).toBeNull();
    expect(g.count).toBe(1);
  });

  it('reverts a batch of changes in reverse order', () => {
    const g = new VoxelGrid(8, 8);
    g.set(0, 0, 0, 1);
    const changes = [g.set(0, 0, 0, 2)!, g.set(1, 0, 0, 3)!, g.set(0, 0, 0, null)!];
    g.revert(changes);
    expect(g.get(0, 0, 0)).toBe(1);
    expect(g.has(1, 0, 0)).toBe(false);
  });

  it('round-trips through JSON and maps keys back to cells', () => {
    const g = new VoxelGrid(16, 16);
    g.set(3, 5, 7, 0x123456);
    g.set(15, 15, 15, 0xffffff);
    const h = new VoxelGrid(16, 16);
    h.load(g.toJSON());
    expect(h.get(3, 5, 7)).toBe(0x123456);
    expect(h.get(15, 15, 15)).toBe(0xffffff);
    expect(h.cellOf(h.key(3, 5, 7))).toEqual([3, 5, 7]);
  });
});

describe('cellsBetween', () => {
  it('fills a gap-free line, both ends included', () => {
    const line = cellsBetween([0, 0, 0], [4, 2, 0]);
    expect(line[0]).toEqual([0, 0, 0]);
    expect(line[line.length - 1]).toEqual([4, 2, 0]);
    expect(line.length).toBe(5);
    for (let i = 1; i < line.length; i++) {
      const step = Math.max(...line[i].map((v, k) => Math.abs(v - line[i - 1][k])));
      expect(step).toBe(1);
    }
  });
  it('is one cell when both ends match', () => {
    expect(cellsBetween([2, 2, 2], [2, 2, 2])).toEqual([[2, 2, 2]]);
  });
});

describe('raycast', () => {
  it('lands on the plate when nothing is in the way', () => {
    const g = new VoxelGrid(8, 8);
    const r = raycast(g, [3.5, 6, 2.5], [0, -1, 0]);
    expect(r?.hit).toBeNull();
    expect(r?.place).toEqual([3, 0, 2]);
  });
  it('hits a block and places on the face it hit', () => {
    const g = new VoxelGrid(8, 8);
    g.set(3, 0, 2, 1);
    const down = raycast(g, [3.5, 6, 2.5], [0, -1, 0]);
    expect(down?.hit).toEqual([3, 0, 2]);
    expect(down?.place).toEqual([3, 1, 2]);
    const side = raycast(g, [-2, 0.5, 2.5], [1, 0, 0]);
    expect(side?.hit).toEqual([3, 0, 2]);
    expect(side?.place).toEqual([2, 0, 2]);
  });
  it('misses when the ray never enters the grid', () => {
    const g = new VoxelGrid(8, 8);
    expect(raycast(g, [-5, 5, -5], [-1, 0, 0])).toBeNull();
  });
  it('enters from outside at an angle', () => {
    const g = new VoxelGrid(8, 8);
    const r = raycast(g, [4, 20, 20], [0, -1, -1].map((v) => v / Math.SQRT2));
    expect(r?.place?.[1]).toBe(0);
  });
});
