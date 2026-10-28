/**
 * Sculpting maths on a plain vertex buffer. Pure (no Three.js), so it is
 * unit-tested and cheap: everything works on typed arrays in clay-local
 * metres, and nothing allocates per frame except a pull's grab set.
 */

export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Indexed icosphere: an icosahedron whose faces are split `detail` times. */
export function makeIcosphere(radius: number, detail: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const n = Math.max(1, detail);
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const len = Math.hypot(x, y, z);
    x = (x / len) * radius;
    y = (y / len) * radius;
    z = (z / len) * radius;
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(x, y, z);
      lookup.set(key, id);
    }
    return id;
  };
  for (const [ia, ib, ic] of faces) {
    const a = base[ia];
    const b = base[ib];
    const c = base[ic];
    // Grid of points on the face: row i has i+1 points.
    const rows: number[][] = [];
    for (let i = 0; i <= n; i += 1) {
      const row: number[] = [];
      for (let j = 0; j <= i; j += 1) {
        const u = i === 0 ? 0 : j / n;
        const v = (i - j) / n;
        const w = 1 - (i / n);
        row.push(
          vertex(
            a[0] * w + b[0] * v + c[0] * u,
            a[1] * w + b[1] * v + c[1] * u,
            a[2] * w + b[2] * v + c[2] * u,
          ),
        );
      }
      rows.push(row);
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        indices.push(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1]);
        if (j < i) indices.push(rows[i][j], rows[i + 1][j + 1], rows[i][j + 1]);
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Vertex adjacency in compressed form: neighbours of v are list[start[v]..start[v+1]). */
export interface Neighbors {
  start: Uint32Array;
  list: Uint32Array;
}

export function buildNeighbors(indices: Uint32Array, vertexCount: number): Neighbors {
  const sets: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    sets[a].add(b).add(c);
    sets[b].add(a).add(c);
    sets[c].add(a).add(b);
  }
  const start = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v += 1) start[v + 1] = start[v] + sets[v].size;
  const list = new Uint32Array(start[vertexCount]);
  for (let v = 0; v < vertexCount; v += 1) list.set([...sets[v]], start[v]);
  return { start, list };
}

/** For each vertex, the index of its mirror across x = 0 (or itself). */
export function buildMirror(positions: Float32Array): Int32Array {
  const count = positions.length / 3;
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const map = new Map<string, number>();
  for (let v = 0; v < count; v += 1) map.set(key(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]), v);
  const mirror = new Int32Array(count);
  for (let v = 0; v < count; v += 1) {
    mirror[v] = map.get(key(-positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])) ?? v;
  }
  return mirror;
}

/**
 * Fingertips as spheres that carve: any vertex inside a tip sphere slides
 * inward along its line to the clay centre (the origin) until it leaves the
 * sphere. Pressing always dents, however deep the finger goes. `tips` holds
 * x,y,z triples. Returns how many vertices moved.
 */
export function pushTips(positions: Float32Array, tips: Float32Array, tipCount: number, tipRadius: number, minRadius = 0.004): number {
  let moved = 0;
  const r2 = tipRadius * tipRadius;
  for (let t = 0; t < tipCount; t += 1) {
    const tx = tips[t * 3];
    const ty = tips[t * 3 + 1];
    const tz = tips[t * 3 + 2];
    const t2 = tx * tx + ty * ty + tz * tz;
    for (let v = 0; v < positions.length; v += 3) {
      const px = positions[v];
      const py = positions[v + 1];
      const pz = positions[v + 2];
      const dx = px - tx;
      const dy = py - ty;
      const dz = pz - tz;
      if (dx * dx + dy * dy + dz * dz >= r2) continue;
      const len = Math.sqrt(px * px + py * py + pz * pz);
      if (len < 1e-7) continue;
      // Where the radial line u*s enters the tip sphere: s^2 - 2 s (u.T) + |T|^2 - r^2 = 0.
      const ux = px / len;
      const uy = py / len;
      const uz = pz / len;
      const b = ux * tx + uy * ty + uz * tz;
      const disc = b * b - t2 + r2;
      if (disc < 0) continue;
      const s = Math.max(minRadius, b - Math.sqrt(disc));
      if (s >= len) continue;
      positions[v] = ux * s;
      positions[v + 1] = uy * s;
      positions[v + 2] = uz * s;
      moved += 1;
    }
  }
  return moved;
}

/** Laplacian smoothing within `radius` of a point, falling off to the edge. */
export function smoothAt(
  positions: Float32Array,
  neighbors: Neighbors,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  strength: number,
): number {
  let moved = 0;
  const count = positions.length / 3;
  for (let v = 0; v < count; v += 1) {
    const dx = positions[v * 3] - cx;
    const dy = positions[v * 3 + 1] - cy;
    const dz = positions[v * 3 + 2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= radius) continue;
    const s = neighbors.start[v];
    const e = neighbors.start[v + 1];
    if (e === s) continue;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = s; i < e; i += 1) {
      const n = neighbors.list[i] * 3;
      ax += positions[n];
      ay += positions[n + 1];
      az += positions[n + 2];
    }
    const inv = 1 / (e - s);
    const w = strength * (1 - d / radius);
    positions[v * 3] += (ax * inv - positions[v * 3]) * w;
    positions[v * 3 + 1] += (ay * inv - positions[v * 3 + 1]) * w;
    positions[v * 3 + 2] += (az * inv - positions[v * 3 + 2]) * w;
    moved += 1;
  }
  return moved;
}

/** Push vertices along their normals near a point (adds clay). */
export function inflateAt(
  positions: Float32Array,
  normals: Float32Array,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  amount: number,
): number {
  let moved = 0;
  for (let v = 0; v < positions.length; v += 3) {
    const dx = positions[v] - cx;
    const dy = positions[v + 1] - cy;
    const dz = positions[v + 2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= radius) continue;
    const w = amount * (1 - d / radius) ** 2;
    positions[v] += normals[v] * w;
    positions[v + 1] += normals[v + 1] * w;
    positions[v + 2] += normals[v + 2] * w;
    moved += 1;
  }
  return moved;
}

/** A pinch grab: nearby vertices, their weights and where they started. */
export interface Grab {
  indices: Uint32Array;
  weights: Float32Array;
  origins: Float32Array;
}

export function nearestDistance(positions: Float32Array, x: number, y: number, z: number): number {
  let best = Infinity;
  for (let v = 0; v < positions.length; v += 3) {
    const d = Math.hypot(positions[v] - x, positions[v + 1] - y, positions[v + 2] - z);
    if (d < best) best = d;
  }
  return best;
}

export function grabAt(positions: Float32Array, x: number, y: number, z: number, radius: number, mirror?: Int32Array): Grab {
  const found = new Map<number, number>();
  for (let v = 0; v < positions.length / 3; v += 1) {
    const d = Math.hypot(positions[v * 3] - x, positions[v * 3 + 1] - y, positions[v * 3 + 2] - z);
    if (d < radius) found.set(v, (1 - d / radius) ** 2);
  }
  if (mirror) {
    // Mirrored vertices are tagged with a negative weight so the x motion flips.
    for (const [v, w] of [...found]) {
      const m = mirror[v];
      if (m !== v && !found.has(m)) found.set(m, -w);
    }
  }
  const indices = new Uint32Array(found.size);
  const weights = new Float32Array(found.size);
  const origins = new Float32Array(found.size * 3);
  let i = 0;
  for (const [v, w] of found) {
    indices[i] = v;
    weights[i] = w;
    origins.set(positions.subarray(v * 3, v * 3 + 3), i * 3);
    i += 1;
  }
  return { indices, weights, origins };
}

/** Move a grab by (dx, dy, dz); mirrored vertices move with x flipped. */
export function applyGrab(positions: Float32Array, grab: Grab, dx: number, dy: number, dz: number): void {
  for (let i = 0; i < grab.indices.length; i += 1) {
    const v = grab.indices[i] * 3;
    const w = grab.weights[i];
    const aw = Math.abs(w);
    positions[v] = grab.origins[i * 3] + dx * w;
    positions[v + 1] = grab.origins[i * 3 + 1] + dy * aw;
    positions[v + 2] = grab.origins[i * 3 + 2] + dz * aw;
  }
}

/** Wavefront OBJ text for export. */
export function toObj(mesh: Mesh): string {
  const lines = ['# Clay sculpt'];
  for (let v = 0; v < mesh.positions.length; v += 3) {
    lines.push(`v ${mesh.positions[v].toFixed(5)} ${mesh.positions[v + 1].toFixed(5)} ${mesh.positions[v + 2].toFixed(5)}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(`f ${mesh.indices[i] + 1} ${mesh.indices[i + 1] + 1} ${mesh.indices[i + 2] + 1}`);
  }
  return `${lines.join('\n')}\n`;
}
