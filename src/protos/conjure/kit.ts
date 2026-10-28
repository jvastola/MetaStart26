/**
 * Offline "sketch" generator: builds a stylised model from primitives by
 * reading the nouns, colours and size words in a prompt.
 *
 * It exists so Conjure still works with no network and no AI service (the
 * competition's "take it away" test), and as instant feedback while a remote
 * model generates. Everything is ~0.14 m tall, origin on the ground.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from '@iwsdk/core';
import { hashString as hash, seededRandom } from '../../core/random.js';
import { COLORS } from './intent.js';

type Part = [geometry: () => import('@iwsdk/core').BufferGeometry, color: string, x: number, y: number, z: number, sx?: number, sy?: number, sz?: number, rx?: number, rz?: number];

export interface KitResult {
  object: Group;
  /** Which recipe was used, or 'abstract'. */
  recipe: string;
}

const RECIPES: { words: string[]; name: string; parts: (c: string) => Part[] }[] = [
  {
    name: 'mushroom',
    words: ['mushroom', 'toadstool', 'shroom'],
    parts: (c) => [
      [() => new CylinderGeometry(0.018, 0.024, 0.07, 16), '#efe6d2', 0, 0.035, 0],
      [() => new SphereGeometry(0.055, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), c || COLORS.red, 0, 0.065, 0, 1, 0.75, 1],
      [() => new SphereGeometry(0.008, 8, 6), '#ffffff', 0.025, 0.098, 0.02],
      [() => new SphereGeometry(0.007, 8, 6), '#ffffff', -0.03, 0.094, -0.01],
      [() => new SphereGeometry(0.006, 8, 6), '#ffffff', 0.0, 0.104, -0.03],
    ],
  },
  {
    name: 'tree',
    words: ['tree', 'pine', 'forest', 'bonsai'],
    parts: (c) => [
      [() => new CylinderGeometry(0.01, 0.014, 0.05, 10), '#7a5233', 0, 0.025, 0],
      [() => new ConeGeometry(0.05, 0.06, 12), c || COLORS.green, 0, 0.07, 0],
      [() => new ConeGeometry(0.04, 0.05, 12), c || COLORS.green, 0, 0.1, 0],
      [() => new ConeGeometry(0.028, 0.04, 12), c || COLORS.green, 0, 0.128, 0],
    ],
  },
  {
    name: 'house',
    words: ['house', 'home', 'cabin', 'cottage', 'hut', 'building'],
    parts: (c) => [
      [() => new BoxGeometry(0.09, 0.065, 0.07), c || '#e9dcc3', 0, 0.0325, 0],
      [() => new ConeGeometry(0.075, 0.05, 4), '#b5533c', 0, 0.09, 0, 1, 1, 0.8, 0, 0],
      [() => new BoxGeometry(0.02, 0.035, 0.002), '#5b3a26', 0, 0.0175, 0.036],
      [() => new BoxGeometry(0.018, 0.016, 0.002), '#9fd0f0', 0.028, 0.04, 0.036],
    ],
  },
  {
    name: 'castle',
    words: ['castle', 'tower', 'fortress', 'keep'],
    parts: (c) => {
      const stone = c || '#b9b4aa';
      const parts: Part[] = [[() => new BoxGeometry(0.09, 0.06, 0.09), stone, 0, 0.03, 0]];
      for (const [x, z] of [[-0.045, -0.045], [0.045, -0.045], [-0.045, 0.045], [0.045, 0.045]]) {
        parts.push([() => new CylinderGeometry(0.016, 0.016, 0.09, 12), stone, x, 0.045, z]);
        parts.push([() => new ConeGeometry(0.02, 0.03, 12), '#3f5fa8', x, 0.105, z]);
      }
      parts.push([() => new BoxGeometry(0.022, 0.03, 0.002), '#4a3322', 0, 0.015, 0.046]);
      return parts;
    },
  },
  {
    name: 'mug',
    words: ['mug', 'cup', 'coffee', 'tea'],
    parts: (c) => [
      [() => new CylinderGeometry(0.035, 0.032, 0.08, 24, 1, true), c || COLORS.white, 0, 0.04, 0],
      [() => new CylinderGeometry(0.032, 0.032, 0.004, 24), c || COLORS.white, 0, 0.002, 0],
      [() => new CylinderGeometry(0.031, 0.031, 0.002, 24), '#4a2c1c', 0, 0.068, 0],
      [() => new TorusGeometry(0.018, 0.005, 8, 16), c || COLORS.white, 0.04, 0.042, 0, 1, 1, 1, 0, Math.PI / 2],
    ],
  },
  {
    name: 'lamp',
    words: ['lamp', 'light', 'lantern'],
    parts: (c) => [
      [() => new CylinderGeometry(0.035, 0.04, 0.01, 20), '#2c2f36', 0, 0.005, 0],
      [() => new CylinderGeometry(0.004, 0.004, 0.09, 8), '#c3c7cf', 0, 0.05, 0],
      [() => new ConeGeometry(0.045, 0.045, 20, 1, true), c || COLORS.yellow, 0, 0.11, 0],
      [() => new SphereGeometry(0.012, 12, 8), '#fff6c8', 0, 0.098, 0],
    ],
  },
  {
    name: 'rocket',
    words: ['rocket', 'spaceship', 'ship', 'shuttle'],
    parts: (c) => [
      [() => new CylinderGeometry(0.022, 0.022, 0.09, 20), c || COLORS.white, 0, 0.065, 0],
      [() => new ConeGeometry(0.022, 0.04, 20), COLORS.red, 0, 0.13, 0],
      [() => new BoxGeometry(0.06, 0.03, 0.004), COLORS.red, 0, 0.03, 0],
      [() => new BoxGeometry(0.004, 0.03, 0.06), COLORS.red, 0, 0.03, 0],
      [() => new SphereGeometry(0.009, 12, 8), '#7fd0ff', 0, 0.08, 0.02],
    ],
  },
  {
    name: 'robot',
    words: ['robot', 'bot', 'droid', 'android'],
    parts: (c) => [
      [() => new BoxGeometry(0.06, 0.06, 0.04), c || COLORS.silver, 0, 0.06, 0],
      [() => new BoxGeometry(0.045, 0.035, 0.035), c || COLORS.silver, 0, 0.11, 0],
      [() => new SphereGeometry(0.006, 8, 6), '#38e0ff', -0.011, 0.113, 0.018],
      [() => new SphereGeometry(0.006, 8, 6), '#38e0ff', 0.011, 0.113, 0.018],
      [() => new BoxGeometry(0.014, 0.03, 0.014), '#555a63', -0.016, 0.015, 0],
      [() => new BoxGeometry(0.014, 0.03, 0.014), '#555a63', 0.016, 0.015, 0],
      [() => new CylinderGeometry(0.002, 0.002, 0.02, 6), '#555a63', 0, 0.138, 0],
    ],
  },
  {
    name: 'animal',
    words: ['cat', 'dog', 'fox', 'animal', 'pet', 'bear', 'pig', 'cow', 'horse'],
    parts: (c) => [
      [() => new SphereGeometry(0.035, 16, 12), c || COLORS.orange, 0, 0.05, 0, 1.4, 0.9, 1],
      [() => new SphereGeometry(0.024, 16, 12), c || COLORS.orange, 0.055, 0.08, 0],
      [() => new ConeGeometry(0.008, 0.018, 8), c || COLORS.orange, 0.05, 0.105, 0.012],
      [() => new ConeGeometry(0.008, 0.018, 8), c || COLORS.orange, 0.05, 0.105, -0.012],
      [() => new SphereGeometry(0.005, 8, 6), '#1b1b1b', 0.077, 0.083, 0.008],
      [() => new SphereGeometry(0.005, 8, 6), '#1b1b1b', 0.077, 0.083, -0.008],
      ...[[-0.03, 0.015], [0.03, 0.015], [-0.03, -0.015], [0.03, -0.015]].map(
        ([x, z]) => [() => new CylinderGeometry(0.007, 0.007, 0.03, 8), c || COLORS.orange, x, 0.015, z] as Part,
      ),
      [() => new ConeGeometry(0.012, 0.05, 8), c || COLORS.orange, -0.065, 0.065, 0, 1, 1, 1, 0, 1.2],
    ],
  },
  {
    name: 'flower',
    words: ['flower', 'rose', 'tulip', 'daisy', 'plant'],
    parts: (c) => {
      const parts: Part[] = [
        [() => new CylinderGeometry(0.003, 0.003, 0.1, 6), '#3f8a4a', 0, 0.05, 0],
        [() => new SphereGeometry(0.012, 12, 8), '#f2c53d', 0, 0.105, 0],
      ];
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        parts.push([() => new SphereGeometry(0.012, 10, 8), c || COLORS.pink, Math.cos(a) * 0.02, 0.105, Math.sin(a) * 0.02, 1.2, 0.4, 1]);
      }
      return parts;
    },
  },
  {
    name: 'cactus',
    words: ['cactus', 'succulent'],
    parts: (c) => [
      [() => new CylinderGeometry(0.03, 0.025, 0.035, 16), '#b4683f', 0, 0.0175, 0],
      [() => CapsuleLike(0.017, 0.09), c || '#4f9a5a', 0, 0.08, 0],
      [() => CapsuleLike(0.01, 0.035), c || '#4f9a5a', 0.026, 0.09, 0, 1, 1, 1, 0, -0.9],
    ],
  },
  {
    name: 'crystal',
    words: ['crystal', 'gem', 'diamond', 'jewel'],
    parts: (c) => [
      [() => new OctahedronGeometry(0.045), c || COLORS.teal, 0, 0.07, 0, 0.8, 1.5, 0.8],
      [() => new OctahedronGeometry(0.022), c || COLORS.teal, 0.04, 0.03, 0.01, 0.8, 1.4, 0.8, 0, -0.5],
    ],
  },
  {
    name: 'planet',
    words: ['planet', 'saturn', 'moon', 'world', 'globe'],
    parts: (c) => [
      [() => new SphereGeometry(0.045, 32, 16), c || COLORS.orange, 0, 0.07, 0],
      [() => new TorusGeometry(0.068, 0.004, 6, 48), '#e9dcc3', 0, 0.07, 0, 1, 1, 1, 1.2, 0.3],
    ],
  },
  {
    name: 'snowman',
    words: ['snowman', 'snow'],
    parts: () => [
      [() => new SphereGeometry(0.035, 20, 14), '#f7f7f7', 0, 0.035, 0],
      [() => new SphereGeometry(0.026, 20, 14), '#f7f7f7', 0, 0.085, 0],
      [() => new SphereGeometry(0.018, 20, 14), '#f7f7f7', 0, 0.123, 0],
      [() => new ConeGeometry(0.004, 0.02, 8), COLORS.orange, 0, 0.123, 0.025, 1, 1, 1, Math.PI / 2, 0],
    ],
  },
];

/** A capsule-ish shape (cylinder with sphere caps) as one geometry helper. */
function CapsuleLike(radius: number, length: number): import('@iwsdk/core').BufferGeometry {
  return new CylinderGeometry(radius, radius, length, 14);
}

export function buildFromPrompt(prompt: string, variation = 0): KitResult {
  const text = prompt.toLowerCase();
  let color = '';
  for (const [name, hex] of Object.entries(COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      color = hex;
      break;
    }
  }
  let scale = 1;
  if (/\b(tiny|small|little|mini)\b/.test(text)) scale = 0.7;
  if (/\b(big|large|giant|huge)\b/.test(text)) scale = 1.35;
  const flat = /\b(low ?poly|faceted|geometric)\b/.test(text);

  const recipe = RECIPES.find((r) => r.words.some((w) => new RegExp(`\\b${w}s?\\b`).test(text)));
  const group = new Group();
  const materials = new Map<string, Material>();
  const material = (hex: string): Material => {
    let m = materials.get(hex);
    if (!m) {
      m = new MeshStandardMaterial({ color: new Color(hex), roughness: 0.55, flatShading: flat });
      materials.set(hex, m);
    }
    return m;
  };

  if (recipe) {
    for (const [geo, hex, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0] of recipe.parts(color)) {
      const mesh = new Mesh(geo(), material(hex));
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.set(rx, 0, rz);
      group.add(mesh);
    }
  } else {
    // Abstract stacked sculpture, seeded by the prompt so it is repeatable.
    const rand = seededRandom(hash(text) + variation * 977);
    const base = new Color(color || `hsl(${Math.floor(rand() * 360)}, 60%, 55%)`);
    let y = 0;
    const shapes = [
      () => new IcosahedronGeometry(0.03, flat ? 0 : 1),
      () => new DodecahedronGeometry(0.028),
      () => new BoxGeometry(0.045, 0.045, 0.045),
      () => new TorusGeometry(0.025, 0.009, 10, 24),
      () => new SphereGeometry(0.028, 16, 12),
    ];
    for (let i = 0; i < 4; i += 1) {
      const s = 1 - i * 0.16;
      const hex = `#${base.clone().offsetHSL((rand() - 0.5) * 0.15, 0, (rand() - 0.5) * 0.2).getHexString()}`;
      const mesh = new Mesh(shapes[Math.floor(rand() * shapes.length)](), material(hex));
      y += 0.028 * s;
      mesh.position.set((rand() - 0.5) * 0.02, y, (rand() - 0.5) * 0.02);
      mesh.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      mesh.scale.setScalar(s);
      y += 0.024 * s;
      group.add(mesh);
    }
  }
  group.scale.setScalar(scale);
  group.rotation.y = variation * 0.7;
  return { object: group, recipe: recipe?.name ?? 'abstract' };
}

export const KIT_NOUNS = RECIPES.map((r) => r.name);
