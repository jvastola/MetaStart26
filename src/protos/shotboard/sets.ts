/**
 * Sets for Shot Board: a painted backdrop, a floor and props for each scene,
 * plus a suggested shot list. The same three characters (Hero, Friend,
 * Rival) appear in every set, so a story can move between scenes.
 *
 * Everything is small (the stage is 40 x 26 cm) and built from simple
 * shapes. Materials are shared within a set.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from '@iwsdk/core';

export type SetId = 'street' | 'camp' | 'room';
export const SET_IDS: SetId[] = ['street', 'camp', 'room'];
export type Light = 'day' | 'sunset' | 'night';
export const LIGHTS: Light[] = ['day', 'sunset', 'night'];

export interface PropSpec {
  name: string;
  group: Group;
  x: number;
  z: number;
  yaw: number;
  /** Shadow size. */
  shadow: number;
  /** Glows at night (lamps, fires, windows). */
  glow?: MeshStandardMaterial[];
}

export interface SetSpec {
  id: SetId;
  title: string;
  props: PropSpec[];
  /** Paints the backdrop for a time of day. */
  paintBackdrop(c: CanvasRenderingContext2D, w: number, h: number, light: Light): void;
  /** Paints the floor (top view, +y toward the back). */
  paintFloor(c: CanvasRenderingContext2D, w: number, h: number): void;
  /** Where a warm light sits at night (stage-local), if anywhere. */
  nightLight: [number, number, number] | null;
  shotList: string[];
}

const std = (color: string, roughness = 0.7): MeshStandardMaterial => new MeshStandardMaterial({ color: new Color(color), roughness });

// ------------------------------------------------------------ props

/** A small figure with legs, arms and hair, facing +z. */
export function figure(shirt: string, hair: string, pants = '#36405a'): Group {
  const g = new Group();
  const skin = std('#f1d2b6', 0.6);
  const shirtMat = std(shirt, 0.6);
  const pantsMat = std(pants, 0.7);
  for (const s of [-1, 1]) {
    const leg = new Mesh(new CylinderGeometry(0.0035, 0.0035, 0.022, 8), pantsMat);
    leg.position.set(s * 0.0045, 0.011, 0);
    g.add(leg);
    const arm = new Mesh(new CylinderGeometry(0.0027, 0.0027, 0.02, 8), shirtMat);
    arm.position.set(s * 0.0125, 0.032, 0);
    arm.rotation.z = s * 0.18;
    g.add(arm);
  }
  const body = new Mesh(new CylinderGeometry(0.0085, 0.0095, 0.024, 12), shirtMat);
  body.position.y = 0.034;
  const head = new Mesh(new SphereGeometry(0.0085, 14, 10), skin);
  head.position.y = 0.054;
  const hairCap = new Mesh(new SphereGeometry(0.009, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), std(hair, 0.8));
  hairCap.position.y = 0.0555;
  hairCap.rotation.x = -0.25;
  const nose = new Mesh(new BoxGeometry(0.003, 0.003, 0.004), skin);
  nose.position.set(0, 0.053, 0.0085);
  g.add(body, head, hairCap, nose);
  return g;
}

function pine(scale = 1): Group {
  const g = new Group();
  const trunk = new Mesh(new CylinderGeometry(0.004, 0.005, 0.025, 8), std('#7a5233'));
  trunk.position.y = 0.0125;
  g.add(trunk);
  const leaf = std('#3f8f4f', 0.85);
  [0.035, 0.055, 0.072].forEach((y, i) => {
    const cone = new Mesh(new ConeGeometry(0.026 - i * 0.006, 0.03, 10), leaf);
    cone.position.y = y;
    g.add(cone);
  });
  g.scale.setScalar(scale);
  return g;
}

function roundTree(): Group {
  const g = new Group();
  const trunk = new Mesh(new CylinderGeometry(0.004, 0.006, 0.04, 8), std('#7a5233'));
  trunk.position.y = 0.02;
  const crown = new Mesh(new SphereGeometry(0.025, 14, 10), std('#58a85a', 0.85));
  crown.position.y = 0.058;
  crown.scale.y = 0.9;
  g.add(trunk, crown);
  return g;
}

function house(wall: string, roof: string): PropSpec['group'] & { userData: { glow: MeshStandardMaterial[] } } {
  const g = new Group() as Group & { userData: { glow: MeshStandardMaterial[] } };
  const base = new Mesh(new BoxGeometry(0.06, 0.04, 0.045), std(wall));
  base.position.y = 0.02;
  const top = new Mesh(new ConeGeometry(0.047, 0.03, 4), std(roof));
  top.position.y = 0.055;
  top.rotation.y = Math.PI / 4;
  top.scale.z = 0.8;
  const door = new Mesh(new BoxGeometry(0.012, 0.02, 0.002), std('#6b4a2f'));
  door.position.set(-0.012, 0.01, 0.023);
  const windowMat = new MeshStandardMaterial({ color: '#9fd0ff', emissive: '#ffcf70', emissiveIntensity: 0, roughness: 0.3 });
  const win = new Mesh(new BoxGeometry(0.012, 0.01, 0.002), windowMat);
  win.position.set(0.012, 0.024, 0.023);
  g.add(base, top, door, win);
  g.userData.glow = [windowMat];
  return g;
}

function streetLamp(): { group: Group; glow: MeshStandardMaterial } {
  const g = new Group();
  const pole = new Mesh(new CylinderGeometry(0.0018, 0.0022, 0.075, 6), std('#2a2e36'));
  pole.position.y = 0.0375;
  const arm = new Mesh(new BoxGeometry(0.014, 0.002, 0.002), std('#2a2e36'));
  arm.position.set(0.006, 0.074, 0);
  const glow = new MeshStandardMaterial({ color: '#fff3b0', emissive: '#ffd27a', emissiveIntensity: 0.2 });
  const bulb = new Mesh(new SphereGeometry(0.005, 10, 8), glow);
  bulb.position.set(0.012, 0.07, 0);
  g.add(pole, arm, bulb);
  return { group: g, glow };
}

function car(color: string): Group {
  const g = new Group();
  const body = new Mesh(new BoxGeometry(0.05, 0.012, 0.024), std(color, 0.4));
  body.position.y = 0.011;
  const cabin = new Mesh(new BoxGeometry(0.026, 0.011, 0.021), std('#cfe6ff', 0.2));
  cabin.position.set(-0.003, 0.022, 0);
  g.add(body, cabin);
  const wheel = std('#1d2027');
  for (const x of [-0.016, 0.016])
    for (const z of [-0.012, 0.012]) {
      const w = new Mesh(new CylinderGeometry(0.0055, 0.0055, 0.004, 12), wheel);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.0055, z);
      g.add(w);
    }
  return g;
}

function bench(): Group {
  const g = new Group();
  const wood = std('#9a6b43');
  const seat = new Mesh(new BoxGeometry(0.04, 0.003, 0.012), wood);
  seat.position.y = 0.012;
  const back = new Mesh(new BoxGeometry(0.04, 0.012, 0.003), wood);
  back.position.set(0, 0.02, -0.006);
  g.add(seat, back);
  for (const x of [-0.016, 0.016]) {
    const leg = new Mesh(new BoxGeometry(0.003, 0.012, 0.01), std('#2a2e36'));
    leg.position.set(x, 0.006, 0);
    g.add(leg);
  }
  return g;
}

function tent(): Group {
  const g = new Group();
  const body = new Mesh(new ConeGeometry(0.04, 0.045, 4, 1, true), std('#e0793f', 0.8));
  body.position.y = 0.0225;
  body.rotation.y = Math.PI / 4;
  body.scale.z = 1.3;
  const door = new Mesh(new ConeGeometry(0.012, 0.025, 3), std('#3a2a20'));
  door.position.set(0, 0.0125, 0.028);
  g.add(body, door);
  return g;
}

function campfire(): { group: Group; glow: MeshStandardMaterial } {
  const g = new Group();
  const logMat = std('#6b4a2f');
  for (let i = 0; i < 3; i++) {
    const log = new Mesh(new CylinderGeometry(0.0025, 0.0025, 0.026, 6), logMat);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = (i * Math.PI) / 3;
    log.position.y = 0.003;
    g.add(log);
  }
  const glow = new MeshStandardMaterial({ color: '#ffb347', emissive: '#ff7a1a', emissiveIntensity: 0.5, transparent: true, opacity: 0.9 });
  const flame = new Mesh(new ConeGeometry(0.008, 0.022, 8), glow);
  flame.position.y = 0.016;
  const ring = new Mesh(new TorusGeometry(0.016, 0.003, 6, 14), std('#7d7f86', 0.9));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.002;
  g.add(flame, ring);
  return { group: g, glow };
}

function rock(size: number): Group {
  const g = new Group();
  const m = new Mesh(new DodecahedronGeometry(size, 0), std('#8a8d94', 0.95));
  m.position.y = size * 0.6;
  m.scale.y = 0.7;
  g.add(m);
  return g;
}

function sofa(color: string): Group {
  const g = new Group();
  const mat = std(color, 0.9);
  const seat = new Mesh(new BoxGeometry(0.07, 0.012, 0.028), mat);
  seat.position.y = 0.012;
  const back = new Mesh(new BoxGeometry(0.07, 0.022, 0.008), mat);
  back.position.set(0, 0.021, -0.012);
  g.add(seat, back);
  for (const x of [-0.035, 0.035]) {
    const arm = new Mesh(new BoxGeometry(0.008, 0.018, 0.028), mat);
    arm.position.set(x, 0.015, 0);
    g.add(arm);
  }
  return g;
}

function table(): Group {
  const g = new Group();
  const wood = std('#b07a4f', 0.6);
  const top = new Mesh(new CylinderGeometry(0.022, 0.022, 0.003, 20), wood);
  top.position.y = 0.022;
  const leg = new Mesh(new CylinderGeometry(0.003, 0.004, 0.022, 8), wood);
  leg.position.y = 0.011;
  const mug = new Mesh(new CylinderGeometry(0.004, 0.004, 0.007, 10), std('#f4f5f7', 0.4));
  mug.position.set(0.008, 0.027, 0);
  g.add(top, leg, mug);
  return g;
}

function floorLamp(): { group: Group; glow: MeshStandardMaterial } {
  const g = new Group();
  const pole = new Mesh(new CylinderGeometry(0.0015, 0.0015, 0.06, 6), std('#2a2e36'));
  pole.position.y = 0.03;
  const glow = new MeshStandardMaterial({ color: '#fff1d0', emissive: '#ffd27a', emissiveIntensity: 0.2, side: 2 });
  const shade = new Mesh(new ConeGeometry(0.012, 0.014, 14, 1, true), glow);
  shade.position.y = 0.064;
  const base = new Mesh(new CylinderGeometry(0.008, 0.008, 0.002, 12), std('#2a2e36'));
  base.position.y = 0.001;
  g.add(pole, shade, base);
  return { group: g, glow };
}

function plant(): Group {
  const g = new Group();
  const pot = new Mesh(new CylinderGeometry(0.008, 0.006, 0.012, 12), std('#c0533a'));
  pot.position.y = 0.006;
  const leaves = new Mesh(new SphereGeometry(0.013, 10, 8), std('#4f9a52', 0.85));
  leaves.position.y = 0.022;
  g.add(pot, leaves);
  return g;
}

// ------------------------------------------------------------ painting

const SKIES: Record<Light, [string, string]> = {
  day: ['#8ec5f2', '#d9eefc'],
  sunset: ['#4a3f7a', '#f2a65a'],
  night: ['#0b1026', '#24305a'],
};

function sky(c: CanvasRenderingContext2D, w: number, h: number, light: Light): void {
  const [top, bottom] = SKIES[light];
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  if (light === 'night') {
    c.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 60; i++) c.fillRect((i * 97) % w, (i * 53) % (h * 0.6), 2, 2);
    c.beginPath();
    c.arc(w * 0.8, h * 0.2, h * 0.08, 0, Math.PI * 2);
    c.fillStyle = '#f4f1d0';
    c.fill();
  } else {
    c.beginPath();
    c.arc(w * (light === 'sunset' ? 0.25 : 0.82), h * (light === 'sunset' ? 0.7 : 0.18), h * 0.09, 0, Math.PI * 2);
    c.fillStyle = light === 'sunset' ? '#ffcf70' : '#fff6c8';
    c.fill();
  }
}

const shade = (light: Light, day: string, sunset: string, night: string): string => (light === 'day' ? day : light === 'sunset' ? sunset : night);

// ------------------------------------------------------------ sets

export function buildSet(id: SetId): SetSpec {
  const hero = figure('#3f7fd9', '#3a2a20');
  const friend = figure('#e86fa4', '#d9a441', '#4a3f6b');
  const rival = figure('#d9483b', '#1d2027', '#2a2e36');
  if (id === 'street') {
    const lamp = streetLamp();
    const home = house('#e9dcc3', '#b5533c');
    const shop = house('#cfe0ea', '#3f6f8f');
    return {
      id,
      title: 'Street',
      props: [
        { name: 'Hero', group: hero, x: -0.07, z: 0.06, yaw: 0.5, shadow: 0.04 },
        { name: 'Friend', group: friend, x: 0.0, z: 0.07, yaw: -0.4, shadow: 0.04 },
        { name: 'Rival', group: rival, x: 0.13, z: 0.0, yaw: -1.3, shadow: 0.04 },
        { name: 'House', group: home, x: -0.1, z: -0.08, yaw: 0.15, shadow: 0.09, glow: home.userData.glow },
        { name: 'Shop', group: shop, x: 0.08, z: -0.085, yaw: -0.1, shadow: 0.09, glow: shop.userData.glow },
        { name: 'Car', group: car('#d9483b'), x: 0.04, z: -0.005, yaw: Math.PI / 2 + 0.1, shadow: 0.06 },
        { name: 'Lamp', group: lamp.group, x: -0.03, z: -0.03, yaw: 0, shadow: 0.03, glow: [lamp.glow] },
        { name: 'Tree', group: roundTree(), x: -0.16, z: 0.02, yaw: 0, shadow: 0.06 },
        { name: 'Bench', group: bench(), x: 0.15, z: 0.08, yaw: -0.5, shadow: 0.05 },
      ],
      paintBackdrop: (c, w, h, light) => {
        sky(c, w, h, light);
        // City skyline with lit windows at night.
        const bldg = shade(light, '#9aa7b8', '#5a4a6a', '#1a2038');
        let x = 0;
        let k = 0;
        while (x < w) {
          const bw = 40 + ((k * 37) % 50);
          const bh = h * (0.3 + ((k * 23) % 30) / 100);
          c.fillStyle = bldg;
          c.fillRect(x, h - bh, bw - 4, bh);
          if (light !== 'day') {
            c.fillStyle = 'rgba(255,214,120,0.85)';
            for (let wy = h - bh + 8; wy < h - 10; wy += 16) for (let wx = x + 6; wx < x + bw - 12; wx += 12) if ((wx * 7 + wy * 3) % 5 < 2) c.fillRect(wx, wy, 5, 7);
          }
          x += bw;
          k++;
        }
      },
      paintFloor: (c, w, h) => {
        c.fillStyle = '#b9b4a8';
        c.fillRect(0, 0, w, h);
        // A road across the middle, pavement either side.
        c.fillStyle = '#4a4f58';
        c.fillRect(0, h * 0.38, w, h * 0.3);
        c.fillStyle = '#f4f1d0';
        for (let x = 10; x < w; x += 60) c.fillRect(x, h * 0.52, 30, 4);
        c.strokeStyle = 'rgba(0,0,0,0.12)';
        for (let x = 0; x < w; x += 32) {
          c.beginPath();
          c.moveTo(x, 0);
          c.lineTo(x, h * 0.38);
          c.moveTo(x, h * 0.68);
          c.lineTo(x, h);
          c.stroke();
        }
      },
      nightLight: [-0.018, 0.075, -0.03],
      shotList: [
        'Wide: the whole street, establishing where we are',
        'Medium: Hero and Friend meet on the pavement',
        'Over the shoulder: Friend, looking at Hero',
        'Close-up: Rival watching from by the car',
        'Low angle: Rival steps out',
        'Wide: everyone at the lamp post',
      ],
    };
  }
  if (id === 'camp') {
    const fire = campfire();
    return {
      id,
      title: 'Campsite',
      props: [
        { name: 'Hero', group: hero, x: -0.05, z: 0.05, yaw: 0.9, shadow: 0.04 },
        { name: 'Friend', group: friend, x: 0.05, z: 0.06, yaw: -0.9, shadow: 0.04 },
        { name: 'Rival', group: rival, x: 0.15, z: -0.06, yaw: -2.2, shadow: 0.04 },
        { name: 'Fire', group: fire.group, x: 0, z: 0.02, yaw: 0, shadow: 0.05, glow: [fire.glow] },
        { name: 'Tent', group: tent(), x: -0.1, z: -0.06, yaw: 0.4, shadow: 0.1 },
        { name: 'Pine', group: pine(1.2), x: -0.16, z: 0.03, yaw: 0, shadow: 0.06 },
        { name: 'Pine 2', group: pine(0.9), x: 0.12, z: -0.09, yaw: 0, shadow: 0.05 },
        { name: 'Rock', group: rock(0.014), x: 0.08, z: 0.0, yaw: 0, shadow: 0.04 },
        { name: 'Boulder', group: rock(0.022), x: 0.16, z: 0.07, yaw: 0.6, shadow: 0.05 },
      ],
      paintBackdrop: (c, w, h, light) => {
        sky(c, w, h, light);
        // Two ranges of hills, then a tree line.
        const far = shade(light, '#7fa3c9', '#6a4f7a', '#1d2546');
        const near = shade(light, '#4f8a5a', '#3f4a4a', '#141a2a');
        const range = (base: number, amp: number, color: string, seed: number) => {
          c.fillStyle = color;
          c.beginPath();
          c.moveTo(0, h);
          for (let x = 0; x <= w; x += 8) c.lineTo(x, h * base - Math.abs(Math.sin(x * 0.012 + seed) * amp + Math.sin(x * 0.031 + seed * 2) * amp * 0.4));
          c.lineTo(w, h);
          c.fill();
        };
        range(0.62, h * 0.22, far, 1);
        range(0.82, h * 0.12, near, 4);
        c.fillStyle = shade(light, '#2f6b3f', '#2a3a33', '#0c1220');
        for (let x = 6; x < w; x += 22) {
          const th = 24 + ((x * 13) % 18);
          c.beginPath();
          c.moveTo(x, h - th);
          c.lineTo(x - 9, h);
          c.lineTo(x + 9, h);
          c.fill();
        }
      },
      paintFloor: (c, w, h) => {
        c.fillStyle = '#6fa257';
        c.fillRect(0, 0, w, h);
        c.fillStyle = 'rgba(0,0,0,0.06)';
        for (let i = 0; i < 400; i++) c.fillRect((i * 131) % w, (i * 71) % h, 3, 3);
        // A dirt path to the fire.
        c.fillStyle = '#b8955f';
        c.beginPath();
        c.ellipse(w * 0.5, h * 0.4, w * 0.12, h * 0.12, 0, 0, Math.PI * 2);
        c.fill();
        c.fillRect(w * 0.46, h * 0.4, w * 0.08, h * 0.6);
      },
      nightLight: [0, 0.03, 0.02],
      shotList: [
        'Wide: the camp at dusk, tent and fire',
        'Two-shot: Hero and Friend by the fire',
        'Close-up: Friend telling a story',
        'Point of view: something moves in the trees',
        'Medium: Rival steps out from behind the pine',
        'Close-up: Hero reacts',
      ],
    };
  }
  const lamp = floorLamp();
  return {
    id,
    title: 'Living room',
    props: [
      { name: 'Hero', group: hero, x: -0.04, z: 0.07, yaw: 0.2, shadow: 0.04 },
      { name: 'Friend', group: friend, x: 0.05, z: 0.02, yaw: -0.7, shadow: 0.04 },
      { name: 'Rival', group: rival, x: 0.16, z: 0.07, yaw: -1.6, shadow: 0.04 },
      { name: 'Sofa', group: sofa('#5a7ec2'), x: -0.06, z: -0.07, yaw: 0, shadow: 0.09 },
      { name: 'Table', group: table(), x: -0.05, z: -0.01, yaw: 0, shadow: 0.05 },
      { name: 'Lamp', group: lamp.group, x: -0.15, z: -0.08, yaw: 0, shadow: 0.03, glow: [lamp.glow] },
      { name: 'Plant', group: plant(), x: 0.15, z: -0.09, yaw: 0, shadow: 0.03 },
      { name: 'Armchair', group: armchair('#c2775a'), x: 0.09, z: -0.06, yaw: -0.5, shadow: 0.05 },
    ],
    paintBackdrop: (c, w, h, light) => {
      // A wall with a window onto the sky, and a picture.
      c.fillStyle = '#e8dcc8';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#c9b79c';
      c.fillRect(0, h * 0.85, w, h * 0.15);
      const wx = w * 0.56;
      const wy = h * 0.12;
      const ww = w * 0.3;
      const wh = h * 0.5;
      c.save();
      c.beginPath();
      c.rect(wx, wy, ww, wh);
      c.clip();
      c.translate(wx, wy);
      sky(c, ww, wh, light);
      c.restore();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 8;
      c.strokeRect(wx, wy, ww, wh);
      c.beginPath();
      c.moveTo(wx + ww / 2, wy);
      c.lineTo(wx + ww / 2, wy + wh);
      c.moveTo(wx, wy + wh / 2);
      c.lineTo(wx + ww, wy + wh / 2);
      c.stroke();
      c.fillStyle = '#7a5233';
      c.fillRect(w * 0.14, h * 0.2, w * 0.18, h * 0.28);
      c.fillStyle = '#f2a65a';
      c.fillRect(w * 0.15, h * 0.22, w * 0.16, h * 0.24);
      c.fillStyle = '#4a3f7a';
      c.beginPath();
      c.moveTo(w * 0.15, h * 0.46);
      c.lineTo(w * 0.23, h * 0.3);
      c.lineTo(w * 0.31, h * 0.46);
      c.fill();
      if (light !== 'day') {
        c.fillStyle = `rgba(10,14,40,${light === 'night' ? 0.45 : 0.2})`;
        c.fillRect(0, 0, w, h);
      }
    },
    paintFloor: (c, w, h) => {
      c.fillStyle = '#a8784f';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(0,0,0,0.15)';
      c.lineWidth = 2;
      for (let y = 0; y < h; y += 18) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
        for (let x = (y * 3) % 90; x < w; x += 90) {
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x, y + 18);
          c.stroke();
        }
      }
      // A rug.
      c.fillStyle = '#c05a5a';
      c.fillRect(w * 0.2, h * 0.25, w * 0.45, h * 0.45);
      c.strokeStyle = '#f2d18a';
      c.lineWidth = 6;
      c.strokeRect(w * 0.23, h * 0.29, w * 0.39, h * 0.37);
    },
    nightLight: [-0.15, 0.07, -0.08],
    shotList: [
      'Wide: the room, sofa and window',
      'Medium: Hero comes in',
      'Two-shot: Hero and Friend at the table',
      'Insert: the mug on the table',
      'Over the shoulder: Rival at the door',
      'Close-up: Friend looks out of the window',
    ],
  };
}

/** A one-seat armchair: a narrow sofa. */
function armchair(color: string): Group {
  const g = sofa(color);
  g.scale.x = 0.5;
  return g;
}

export function paintTexture(width: number, height: number, paint: (c: CanvasRenderingContext2D, w: number, h: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d')!, width, height);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export const unlit = (texture: CanvasTexture): MeshBasicMaterial => new MeshBasicMaterial({ map: texture });

/** Ready-made props for the library shelf. */
export const PRESETS: { name: string; make: () => Group }[] = [
  { name: 'Hero', make: () => figure('#3f7fd9', '#3a2a20') },
  { name: 'Friend', make: () => figure('#e86fa4', '#d9a441', '#4a3f6b') },
  { name: 'Rival', make: () => figure('#d9483b', '#1d2027', '#2a2e36') },
  { name: 'Extra', make: () => figure('#5aa95a', '#7a5233') },
  { name: 'Pine', make: () => pine() },
  { name: 'Round tree', make: () => roundTree() },
  { name: 'House', make: () => house('#e9dcc3', '#b5533c') },
  { name: 'Shop', make: () => house('#cfe0ea', '#3f6f8f') },
  { name: 'Street lamp', make: () => streetLamp().group },
  { name: 'Red car', make: () => car('#d9483b') },
  { name: 'Blue car', make: () => car('#3f7fd9') },
  { name: 'Bench', make: () => bench() },
  { name: 'Tent', make: () => tent() },
  { name: 'Campfire', make: () => campfire().group },
  { name: 'Rock', make: () => rock(0.016) },
  { name: 'Sofa', make: () => sofa('#5a7ec2') },
  { name: 'Armchair', make: () => armchair('#c2775a') },
  { name: 'Table', make: () => table() },
  { name: 'Floor lamp', make: () => floorLamp().group },
  { name: 'Plant', make: () => plant() },
];
