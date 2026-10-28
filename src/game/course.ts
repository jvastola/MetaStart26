/**
 * Course data and the seeded hole generator.
 *
 * Everything here is pure (no Three.js, no DOM), so it runs in unit tests.
 * Coordinates are board-local metres on the table plane: x is right, z points
 * toward the player, and the playfield is centred on the origin.
 */

export const BOARD_WIDTH = 0.6;
export const BOARD_DEPTH = 0.38;
export const BALL_RADIUS = 0.011;
export const CUP_RADIUS = 0.021;
export const WALL_HEIGHT = 0.022;
export const HOLES_PER_ROUND = 3;

export interface Vec2 {
  x: number;
  z: number;
}

/** A wall block: centre, half extents and yaw (radians) on the board plane. */
export interface Block {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  angle: number;
}

/** A round bumper post. */
export interface Post {
  x: number;
  z: number;
  r: number;
}

export interface HoleLayout {
  index: number;
  tee: Vec2;
  cup: Vec2;
  blocks: Block[];
  posts: Post[];
  par: number;
}

/** mulberry32: small, fast, and the same sequence on every device. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Today's course seed, e.g. 20261028. Everyone gets the same course per day. */
export function dailySeed(date: Date = new Date()): number {
  return (
    date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
  );
}

const HALF_W = BOARD_WIDTH / 2;
const HALF_D = BOARD_DEPTH / 2;

/** Signed distance from a point to a block's surface (negative inside). */
export function blockDistance(block: Block, x: number, z: number): number {
  const c = Math.cos(-block.angle);
  const s = Math.sin(-block.angle);
  const dx = x - block.cx;
  const dz = z - block.cz;
  const lx = Math.abs(dx * c - dz * s) - block.hx;
  const lz = Math.abs(dx * s + dz * c) - block.hz;
  const ox = Math.max(lx, 0);
  const oz = Math.max(lz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(lx, lz), 0);
}

/** Shortest open path from tee to cup for a ball, or Infinity if blocked. */
export function shortestPathLength(
  hole: Pick<HoleLayout, 'tee' | 'cup' | 'blocks' | 'posts'>,
  cell = 0.01,
): number {
  const cols = Math.floor(BOARD_WIDTH / cell);
  const rows = Math.floor(BOARD_DEPTH / cell);
  const clearance = BALL_RADIUS + 0.003;
  const open = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = -HALF_W + (c + 0.5) * cell;
      const z = -HALF_D + (r + 0.5) * cell;
      let free =
        x > -HALF_W + clearance &&
        x < HALF_W - clearance &&
        z > -HALF_D + clearance &&
        z < HALF_D - clearance;
      for (const b of hole.blocks) {
        if (!free) break;
        if (blockDistance(b, x, z) < clearance) free = false;
      }
      for (const p of hole.posts) {
        if (!free) break;
        if (Math.hypot(x - p.x, z - p.z) < p.r + clearance) free = false;
      }
      open[r * cols + c] = free ? 1 : 0;
    }
  }
  const toCell = (v: Vec2): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((v.x + HALF_W) / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((v.z + HALF_D) / cell)));
    return r * cols + c;
  };
  const start = toCell(hole.tee);
  const goal = toCell(hole.cup);
  if (!open[start] || !open[goal]) return Infinity;
  // Breadth-first search over 8-connected cells, weighted approximately by
  // counting diagonal steps as sqrt(2) via a Dijkstra-lite two-queue pass.
  const dist = new Float32Array(cols * rows).fill(Infinity);
  dist[start] = 0;
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const cur = queue[head];
    const cr = Math.floor(cur / cols);
    const cc = cur % cols;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const nr = cr + dr;
        const nc = cc + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const next = nr * cols + nc;
        if (!open[next]) continue;
        const step = dr !== 0 && dc !== 0 ? Math.SQRT2 : 1;
        if (dist[cur] + step < dist[next] - 1e-6) {
          dist[next] = dist[cur] + step;
          queue.push(next);
        }
      }
    }
  }
  return dist[goal] * cell;
}

function parFor(pathLength: number, straight: number, blocked: number): number {
  const detour = pathLength / Math.max(straight, 0.01);
  let par = 2;
  if (detour > 1.35 || blocked >= 3) par = 3;
  if (detour > 1.9) par = 4;
  return par;
}

type Archetype = 'gate' | 'zigzag' | 'posts' | 'banks';
const ARCHETYPES: Archetype[] = ['gate', 'zigzag', 'posts', 'banks'];

function buildObstacles(
  archetype: Archetype,
  rand: () => number,
  difficulty: number,
): { blocks: Block[]; posts: Post[] } {
  const blocks: Block[] = [];
  const posts: Post[] = [];
  const thin = 0.008;
  switch (archetype) {
    case 'gate': {
      // A full-width wall with one gap you have to thread.
      const z = (rand() - 0.5) * 0.08;
      const gap = 0.075 - difficulty * 0.02;
      const gx = (rand() - 0.5) * (BOARD_WIDTH - 0.2);
      const leftW = gx - gap / 2 + HALF_W;
      const rightW = HALF_W - (gx + gap / 2);
      blocks.push({ cx: -HALF_W + leftW / 2, cz: z, hx: leftW / 2, hz: thin, angle: 0 });
      blocks.push({ cx: HALF_W - rightW / 2, cz: z, hx: rightW / 2, hz: thin, angle: 0 });
      if (difficulty > 0.4) {
        posts.push({ x: gx, z: z - 0.07, r: 0.014 });
      }
      break;
    }
    case 'zigzag': {
      // Two walls from alternating sides: an S-bend.
      const len = BOARD_WIDTH * (0.55 + difficulty * 0.12);
      const side = rand() < 0.5 ? -1 : 1;
      blocks.push({ cx: side * (HALF_W - len / 2), cz: 0.055, hx: len / 2, hz: thin, angle: 0 });
      blocks.push({ cx: -side * (HALF_W - len / 2), cz: -0.055, hx: len / 2, hz: thin, angle: 0 });
      break;
    }
    case 'posts': {
      const count = 4 + Math.round(difficulty * 4);
      for (let i = 0; i < count; i += 1) {
        posts.push({
          x: (rand() - 0.5) * (BOARD_WIDTH - 0.08),
          z: (rand() - 0.5) * 0.16,
          r: 0.012 + rand() * 0.01,
        });
      }
      break;
    }
    case 'banks': {
      // Angled walls in the middle that you can bank shots off.
      const count = 2 + Math.round(difficulty);
      for (let i = 0; i < count; i += 1) {
        blocks.push({
          cx: (i / (count - 1) - 0.5) * (BOARD_WIDTH - 0.18),
          cz: (rand() - 0.5) * 0.1,
          hx: 0.05 + rand() * 0.03,
          hz: thin,
          angle: (rand() - 0.5) * 1.6,
        });
      }
      break;
    }
  }
  return { blocks, posts };
}

/**
 * Generate one hole. Retries until the cup is reachable with room for the
 * ball, so every generated hole is playable.
 */
export function generateHole(seed: number, index: number): HoleLayout {
  const rand = seededRandom(seed * 31 + index * 7919);
  const difficulty = HOLES_PER_ROUND > 1 ? index / (HOLES_PER_ROUND - 1) : 0;
  // Rotate the archetype order per day so the three holes differ.
  const offset = Math.floor(rand() * ARCHETYPES.length);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const archetype = ARCHETYPES[(offset + index + attempt) % ARCHETYPES.length];
    const tee = { x: (rand() - 0.5) * (BOARD_WIDTH - 0.16), z: HALF_D - 0.045 };
    const cup = { x: (rand() - 0.5) * (BOARD_WIDTH - 0.12), z: -HALF_D + 0.05 };
    const { blocks, posts } = buildObstacles(archetype, rand, difficulty);
    // Keep the tee and cup clear of obstacles.
    const clear = (v: Vec2, room: number): boolean =>
      blocks.every((b) => blockDistance(b, v.x, v.z) > room) &&
      posts.every((p) => Math.hypot(v.x - p.x, v.z - p.z) > p.r + room);
    if (!clear(tee, 0.03) || !clear(cup, 0.04)) continue;
    const path = shortestPathLength({ tee, cup, blocks, posts });
    if (!Number.isFinite(path)) continue;
    const straight = Math.hypot(cup.x - tee.x, cup.z - tee.z);
    return {
      index,
      tee,
      cup,
      blocks,
      posts,
      par: parFor(path, straight, blocks.length + posts.length / 3),
    };
  }
  // Fallback: an open green, always playable.
  return {
    index,
    tee: { x: 0, z: HALF_D - 0.045 },
    cup: { x: 0, z: -HALF_D + 0.05 },
    blocks: [],
    posts: [],
    par: 2,
  };
}

export function generateRound(seed: number): HoleLayout[] {
  const holes: HoleLayout[] = [];
  for (let i = 0; i < HOLES_PER_ROUND; i += 1) holes.push(generateHole(seed, i));
  return holes;
}
