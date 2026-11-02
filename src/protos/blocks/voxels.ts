/**
 * The voxel model behind Blocks: a sparse grid of coloured cells, plus the
 * grid maths (cell lines and ray casting). Pure: no Three.js, so it is unit
 * tested on its own.
 *
 * Cells are integer [x, y, z] with 0 <= x, z < size and 0 <= y < height.
 * y = 0 sits on the plate.
 */

export type Cell = [number, number, number];

export interface Change {
  key: number;
  before: number | null;
  after: number | null;
}

export class VoxelGrid {
  private readonly cells = new Map<number, number>();

  constructor(
    readonly size = 16,
    readonly height = 16,
  ) {}

  get count(): number {
    return this.cells.size;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && z >= 0 && y >= 0 && x < this.size && z < this.size && y < this.height;
  }

  key(x: number, y: number, z: number): number {
    return (y * this.size + z) * this.size + x;
  }

  cellOf(key: number): Cell {
    const x = key % this.size;
    const z = Math.floor(key / this.size) % this.size;
    const y = Math.floor(key / (this.size * this.size));
    return [x, y, z];
  }

  get(x: number, y: number, z: number): number | null {
    return this.inBounds(x, y, z) ? (this.cells.get(this.key(x, y, z)) ?? null) : null;
  }

  has(x: number, y: number, z: number): boolean {
    return this.get(x, y, z) != null;
  }

  /** Set (colour) or clear (null) a cell. Returns the change, or null if nothing changed. */
  set(x: number, y: number, z: number, color: number | null): Change | null {
    if (!this.inBounds(x, y, z)) return null;
    const key = this.key(x, y, z);
    const before = this.cells.get(key) ?? null;
    if (before === color) return null;
    if (color == null) this.cells.delete(key);
    else this.cells.set(key, color);
    return { key, before, after: color };
  }

  /** Put changes back the way they were (undo). */
  revert(changes: readonly Change[]): void {
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      if (c.before == null) this.cells.delete(c.key);
      else this.cells.set(c.key, c.before);
    }
  }

  clear(): Change[] {
    const out: Change[] = [];
    for (const [key, before] of this.cells) out.push({ key, before, after: null });
    this.cells.clear();
    return out;
  }

  /** Every filled cell: [x, y, z, colour]. */
  *entries(): IterableIterator<[number, number, number, number]> {
    for (const [key, color] of this.cells) {
      const [x, y, z] = this.cellOf(key);
      yield [x, y, z, color];
    }
  }

  toJSON(): number[] {
    const out: number[] = [];
    for (const [x, y, z, c] of this.entries()) out.push(x, y, z, c);
    return out;
  }

  load(flat: readonly number[]): void {
    this.cells.clear();
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const [x, y, z, c] = flat.slice(i, i + 4);
      if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && this.inBounds(x, y, z)) this.cells.set(this.key(x, y, z), c >>> 0);
    }
  }
}

/** Every cell on a straight line from a to b, both ends included (3D DDA). */
export function cellsBetween(a: Cell, b: Cell): Cell[] {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
  const out: Cell[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const c: Cell = [Math.round(a[0] + d[0] * t), Math.round(a[1] + d[1] * t), Math.round(a[2] + d[2] * t)];
    const last = out[out.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1] || last[2] !== c[2]) out.push(c);
  }
  return out;
}

export interface RayHit {
  /** The filled cell the ray hit, or null if it hit the plate. */
  hit: Cell | null;
  /** The empty cell in front of the face it hit: where a new block goes. */
  place: Cell | null;
  /** Distance along the ray, in cell units. */
  t: number;
}

/**
 * Walk a ray through the grid (origin and direction in cell units; the grid
 * spans 0..size on x and z and 0..height on y, with the plate at y = 0).
 * Returns the first filled cell hit, or the plate cell under the ray.
 */
export function raycast(grid: VoxelGrid, origin: Cell | number[], dir: number[], maxT = 200): RayHit | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  // Clip to the grid box first.
  let t0 = 0;
  let t1 = maxT;
  const lo = [0, 0, 0];
  const hi = [grid.size, grid.height, grid.size];
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    let a = (lo[i] - o[i]) / d[i];
    let b = (hi[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  const eps = 1e-6;
  let x = Math.floor(ox + dx * (t0 + eps));
  let y = Math.floor(oy + dy * (t0 + eps));
  let z = Math.floor(oz + dz * (t0 + eps));
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const next = (p: number, s: number, dd: number, oo: number) => (Math.abs(dd) < 1e-9 ? Infinity : (p + (s > 0 ? 1 : 0) - oo) / dd);
  let tx = next(x, stepX, dx, ox);
  let ty = next(y, stepY, dy, oy);
  let tz = next(z, stepZ, dz, oz);
  const ddx = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(1 / dx);
  const ddy = Math.abs(dy) < 1e-9 ? Infinity : Math.abs(1 / dy);
  const ddz = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(1 / dz);
  let prev: Cell | null = null;
  let t = t0;
  for (let i = 0; i < 4 * (grid.size + grid.height) && t <= t1 + eps; i++) {
    if (grid.has(x, y, z)) return { hit: [x, y, z], place: prev && grid.inBounds(...prev) ? prev : null, t };
    prev = [x, y, z];
    if (tx <= ty && tx <= tz) {
      t = tx;
      x += stepX;
      tx += ddx;
    } else if (ty <= tz) {
      t = ty;
      y += stepY;
      ty += ddy;
    } else {
      t = tz;
      z += stepZ;
      tz += ddz;
    }
    // Leaving through the plate: place on the plate.
    if (y < 0) {
      const cell: Cell = [x, 0, z];
      return grid.inBounds(...cell) ? { hit: null, place: cell, t } : null;
    }
    if (!grid.inBounds(x, y, z)) return null;
  }
  return null;
}
