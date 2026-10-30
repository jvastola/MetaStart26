/**
 * Line icons drawn on a canvas, for the round desk buttons. Each draws in a
 * square of side `s` with its origin at the top-left, in the current stroke
 * and fill colours. Kept simple and bold so they read at 3 cm across.
 */

type Draw = (c: CanvasRenderingContext2D, s: number) => void;

const line = (c: CanvasRenderingContext2D, pts: [number, number][], s: number, close = false): void => {
  c.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x * s, y * s) : c.lineTo(x * s, y * s)));
  if (close) c.closePath();
  c.stroke();
};
const circle = (c: CanvasRenderingContext2D, x: number, y: number, r: number, s: number, fill = false): void => {
  c.beginPath();
  c.arc(x * s, y * s, r * s, 0, Math.PI * 2);
  if (fill) c.fill();
  else c.stroke();
};
const arrowHead = (c: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number, s: number): void => {
  c.beginPath();
  c.moveTo((x + Math.cos(angle) * size) * s, (y + Math.sin(angle) * size) * s);
  c.lineTo((x + Math.cos(angle + 2.4) * size) * s, (y + Math.sin(angle + 2.4) * size) * s);
  c.lineTo((x + Math.cos(angle - 2.4) * size) * s, (y + Math.sin(angle - 2.4) * size) * s);
  c.closePath();
  c.fill();
};
const star = (c: CanvasRenderingContext2D, x: number, y: number, r: number, s: number): void => {
  c.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.35;
    c.lineTo((x + Math.cos(a) * rr) * s, (y + Math.sin(a) * rr) * s);
  }
  c.closePath();
  c.fill();
};
const curvedArrow = (c: CanvasRenderingContext2D, s: number, dir: 1 | -1): void => {
  c.beginPath();
  const a0 = dir === 1 ? Math.PI * 1.05 : -0.05 * Math.PI;
  const a1 = dir === 1 ? Math.PI * 2.1 : -1.1 * Math.PI;
  c.arc(0.5 * s, 0.55 * s, 0.24 * s, a0, a1, dir === -1);
  c.stroke();
  const end = a1;
  const ex = 0.5 + Math.cos(end) * 0.24;
  const ey = 0.55 + Math.sin(end) * 0.24;
  arrowHead(c, ex, ey, end + (dir === 1 ? Math.PI / 2 : -Math.PI / 2), 0.11, s);
};

export const ICONS: Record<string, Draw> = {
  draw: (c, s) => {
    line(c, [[0.25, 0.75], [0.3, 0.6], [0.68, 0.22], [0.78, 0.32], [0.4, 0.7], [0.25, 0.75]], s, true);
    line(c, [[0.6, 0.3], [0.7, 0.4]], s);
  },
  conjure: (c, s) => {
    star(c, 0.45, 0.52, 0.3, s);
    star(c, 0.76, 0.26, 0.11, s);
  },
  clay: (c, s) => {
    c.beginPath();
    c.moveTo(0.28 * s, 0.72 * s);
    c.bezierCurveTo(0.12 * s, 0.5 * s, 0.3 * s, 0.2 * s, 0.5 * s, 0.28 * s);
    c.bezierCurveTo(0.74 * s, 0.18 * s, 0.9 * s, 0.52 * s, 0.72 * s, 0.72 * s);
    c.closePath();
    c.fill();
  },
  board: (c, s) => {
    c.strokeRect(0.18 * s, 0.26 * s, 0.64 * s, 0.48 * s);
    line(c, [[0.5, 0.26], [0.5, 0.74]], s);
    line(c, [[0.18, 0.5], [0.82, 0.5]], s);
  },
  snap: (c, s) => {
    c.strokeRect(0.18 * s, 0.34 * s, 0.64 * s, 0.42 * s);
    line(c, [[0.36, 0.34], [0.42, 0.24], [0.58, 0.24], [0.64, 0.34]], s);
    circle(c, 0.5, 0.55, 0.12, s);
  },
  play: (c, s) => {
    c.beginPath();
    c.moveTo(0.36 * s, 0.24 * s);
    c.lineTo(0.76 * s, 0.5 * s);
    c.lineTo(0.36 * s, 0.76 * s);
    c.closePath();
    c.fill();
  },
  pin: (c, s) => {
    c.beginPath();
    c.arc(0.5 * s, 0.36 * s, 0.15 * s, 0, Math.PI * 2);
    c.fill();
    line(c, [[0.5, 0.5], [0.5, 0.82]], s);
    line(c, [[0.32, 0.52], [0.68, 0.52]], s);
  },
  focus: (c, s) => {
    for (const [x, y, dx, dy] of [[0.22, 0.22, 1, 1], [0.78, 0.22, -1, 1], [0.22, 0.78, 1, -1], [0.78, 0.78, -1, -1]] as const) {
      line(c, [[x, y + dy * 0.16], [x, y], [x + dx * 0.16, y]], s);
    }
    circle(c, 0.5, 0.5, 0.09, s, true);
  },
  hide: (c, s) => line(c, [[0.26, 0.6], [0.74, 0.6]], s),
  close: (c, s) => {
    line(c, [[0.3, 0.3], [0.7, 0.7]], s);
    line(c, [[0.7, 0.3], [0.3, 0.7]], s);
  },
  colour: (c, s) => {
    const colors = ['#ff6b6b', '#ffd166', '#7fe0b5', '#6fb8ff', '#c7a6ff', '#ff9ad5'];
    colors.forEach((col, i) => {
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(0.5 * s, 0.5 * s);
      c.arc(0.5 * s, 0.5 * s, 0.3 * s, (i / 6) * Math.PI * 2, ((i + 1) / 6) * Math.PI * 2);
      c.closePath();
      c.fill();
    });
    c.fillStyle = '#1b1e24';
    circle(c, 0.5, 0.5, 0.12, s, true);
  },
  size: (c, s) => {
    circle(c, 0.24, 0.58, 0.05, s, true);
    circle(c, 0.44, 0.55, 0.08, s, true);
    circle(c, 0.7, 0.5, 0.13, s, true);
  },
  erase: (c, s) => {
    c.save();
    c.translate(0.5 * s, 0.5 * s);
    c.rotate(-0.6);
    c.strokeRect(-0.28 * s, -0.13 * s, 0.56 * s, 0.26 * s);
    c.fillRect(-0.28 * s, -0.13 * s, 0.22 * s, 0.26 * s);
    c.restore();
    line(c, [[0.2, 0.82], [0.8, 0.82]], s);
  },
  select: (c, s) => {
    c.setLineDash([0.08 * s, 0.06 * s]);
    c.beginPath();
    c.ellipse(0.48 * s, 0.42 * s, 0.3 * s, 0.22 * s, -0.2, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    line(c, [[0.62, 0.62], [0.72, 0.84]], s);
  },
  undo: (c, s) => curvedArrow(c, s, -1),
  redo: (c, s) => curvedArrow(c, s, 1),
  trash: (c, s) => {
    line(c, [[0.22, 0.3], [0.78, 0.3]], s);
    line(c, [[0.4, 0.3], [0.42, 0.2], [0.58, 0.2], [0.6, 0.3]], s);
    line(c, [[0.28, 0.3], [0.33, 0.8], [0.67, 0.8], [0.72, 0.3]], s);
    line(c, [[0.44, 0.42], [0.45, 0.7]], s);
    line(c, [[0.56, 0.42], [0.55, 0.7]], s);
  },
  sculpt: (c, s) => {
    c.beginPath();
    c.arc(0.5 * s, 0.85 * s, 0.32 * s, Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
    line(c, [[0.5, 0.18], [0.5, 0.48]], s);
    arrowHead(c, 0.5, 0.5, Math.PI / 2, 0.1, s);
  },
  smooth: (c, s) => {
    for (const y of [0.34, 0.5, 0.66]) {
      c.beginPath();
      c.moveTo(0.2 * s, y * s);
      c.bezierCurveTo(0.35 * s, (y - 0.08) * s, 0.5 * s, (y + 0.08) * s, 0.8 * s, y * s);
      c.stroke();
    }
  },
  inflate: (c, s) => {
    circle(c, 0.5, 0.5, 0.3, s);
    line(c, [[0.5, 0.36], [0.5, 0.64]], s);
    line(c, [[0.36, 0.5], [0.64, 0.5]], s);
  },
  mirror: (c, s) => {
    c.setLineDash([0.06 * s, 0.05 * s]);
    line(c, [[0.5, 0.16], [0.5, 0.84]], s);
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(0.42 * s, 0.3 * s);
    c.lineTo(0.42 * s, 0.7 * s);
    c.lineTo(0.18 * s, 0.7 * s);
    c.closePath();
    c.fill();
    line(c, [[0.58, 0.3], [0.58, 0.7], [0.82, 0.7]], s, true);
  },
  reset: (c, s) => {
    c.beginPath();
    c.arc(0.5 * s, 0.52 * s, 0.26 * s, -Math.PI * 0.4, Math.PI * 1.5);
    c.stroke();
    arrowHead(c, 0.5 + Math.cos(-Math.PI * 0.4) * 0.26, 0.52 + Math.sin(-Math.PI * 0.4) * 0.26, Math.PI * 0.1, 0.1, s);
  },
  print: (c, s) => {
    for (const [y, w] of [[0.72, 0.5], [0.6, 0.42], [0.48, 0.34], [0.36, 0.24]] as const) c.fillRect((0.5 - w / 2) * s, y * s, w * s, 0.08 * s);
    line(c, [[0.2, 0.2], [0.8, 0.2]], s);
    line(c, [[0.5, 0.2], [0.5, 0.3]], s);
  },
  export: (c, s) => {
    line(c, [[0.5, 0.18], [0.5, 0.6]], s);
    arrowHead(c, 0.5, 0.62, Math.PI / 2, 0.13, s);
    line(c, [[0.22, 0.62], [0.22, 0.8], [0.78, 0.8], [0.78, 0.62]], s);
  },
  spin: (c, s) => {
    c.beginPath();
    c.ellipse(0.5 * s, 0.55 * s, 0.32 * s, 0.14 * s, 0, 0.2, Math.PI * 2 - 0.2);
    c.stroke();
    arrowHead(c, 0.5 + 0.32 * Math.cos(0.2), 0.55 + 0.14 * Math.sin(0.2), Math.PI / 2 + 0.6, 0.1, s);
    line(c, [[0.5, 0.2], [0.5, 0.55]], s);
  },
  duplicate: (c, s) => {
    c.strokeRect(0.2 * s, 0.32 * s, 0.38 * s, 0.38 * s);
    c.fillRect(0.42 * s, 0.18 * s, 0.38 * s, 0.38 * s);
  },
  brush: (c, s) => {
    circle(c, 0.5, 0.5, 0.28, s);
    circle(c, 0.5, 0.5, 0.1, s, true);
  },
  speak: (c, s) => {
    c.beginPath();
    c.roundRect?.(0.4 * s, 0.16 * s, 0.2 * s, 0.4 * s, 0.1 * s);
    c.fill();
    c.beginPath();
    c.arc(0.5 * s, 0.46 * s, 0.2 * s, 0.1, Math.PI - 0.1);
    c.stroke();
    line(c, [[0.5, 0.66], [0.5, 0.82]], s);
  },
  type: (c, s) => {
    c.strokeRect(0.14 * s, 0.3 * s, 0.72 * s, 0.42 * s);
    for (let i = 0; i < 4; i += 1) c.fillRect((0.22 + i * 0.15) * s, 0.4 * s, 0.08 * s, 0.07 * s);
    c.fillRect(0.3 * s, 0.56 * s, 0.4 * s, 0.07 * s);
  },
  deselect: (c, s) => {
    c.setLineDash([0.08 * s, 0.06 * s]);
    c.strokeRect(0.2 * s, 0.2 * s, 0.6 * s, 0.6 * s);
    c.setLineDash([]);
    line(c, [[0.35, 0.35], [0.65, 0.65]], s);
    line(c, [[0.65, 0.35], [0.35, 0.65]], s);
  },
  ai: (c, s) => {
    c.font = `800 ${s * 0.42}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('AI', s * 0.5, s * 0.54);
  },
  move: (c, s) => {
    line(c, [[0.5, 0.18], [0.5, 0.82]], s);
    line(c, [[0.18, 0.5], [0.82, 0.5]], s);
    arrowHead(c, 0.5, 0.14, -Math.PI / 2, 0.1, s);
    arrowHead(c, 0.5, 0.86, Math.PI / 2, 0.1, s);
    arrowHead(c, 0.14, 0.5, Math.PI, 0.1, s);
    arrowHead(c, 0.86, 0.5, 0, 0.1, s);
  },
  press: (c, s) => {
    circle(c, 0.5, 0.62, 0.2, s);
    line(c, [[0.5, 0.14], [0.5, 0.4]], s);
    arrowHead(c, 0.5, 0.42, Math.PI / 2, 0.09, s);
  },
  twist: (c, s) => {
    c.beginPath();
    c.arc(0.5 * s, 0.5 * s, 0.28 * s, -Math.PI * 0.9, Math.PI * 0.2);
    c.stroke();
    arrowHead(c, 0.5 + Math.cos(Math.PI * 0.2) * 0.28, 0.5 + Math.sin(Math.PI * 0.2) * 0.28, Math.PI * 0.7, 0.11, s);
    circle(c, 0.5, 0.5, 0.07, s, true);
  },
  sound: (c, s) => {
    c.beginPath();
    c.moveTo(0.16 * s, 0.4 * s);
    c.lineTo(0.3 * s, 0.4 * s);
    c.lineTo(0.48 * s, 0.24 * s);
    c.lineTo(0.48 * s, 0.76 * s);
    c.lineTo(0.3 * s, 0.6 * s);
    c.lineTo(0.16 * s, 0.6 * s);
    c.closePath();
    c.fill();
    c.beginPath();
    c.arc(0.5 * s, 0.5 * s, 0.16 * s, -0.7, 0.7);
    c.stroke();
    c.beginPath();
    c.arc(0.5 * s, 0.5 * s, 0.3 * s, -0.7, 0.7);
    c.stroke();
  },
  mute: (c, s) => {
    c.beginPath();
    c.moveTo(0.16 * s, 0.4 * s);
    c.lineTo(0.3 * s, 0.4 * s);
    c.lineTo(0.48 * s, 0.24 * s);
    c.lineTo(0.48 * s, 0.76 * s);
    c.lineTo(0.3 * s, 0.6 * s);
    c.lineTo(0.16 * s, 0.6 * s);
    c.closePath();
    c.fill();
    line(c, [[0.6, 0.38], [0.82, 0.62]], s);
    line(c, [[0.82, 0.38], [0.6, 0.62]], s);
  },
  eye: (c, s) => {
    c.beginPath();
    c.moveTo(0.12 * s, 0.5 * s);
    c.quadraticCurveTo(0.5 * s, 0.14 * s, 0.88 * s, 0.5 * s);
    c.quadraticCurveTo(0.5 * s, 0.86 * s, 0.12 * s, 0.5 * s);
    c.stroke();
    circle(c, 0.5, 0.5, 0.11, s, true);
  },
  room: (c, s) => {
    line(c, [[0.5, 0.18], [0.82, 0.34], [0.82, 0.7], [0.5, 0.86], [0.18, 0.7], [0.18, 0.34]], s, true);
    line(c, [[0.18, 0.34], [0.5, 0.5], [0.82, 0.34]], s);
    line(c, [[0.5, 0.5], [0.5, 0.86]], s);
  },
  home: (c, s) => {
    line(c, [[0.18, 0.5], [0.5, 0.2], [0.82, 0.5]], s);
    line(c, [[0.28, 0.42], [0.28, 0.8], [0.72, 0.8], [0.72, 0.42]], s);
    c.fillRect(0.43 * s, 0.58 * s, 0.14 * s, 0.22 * s);
  },
  help: (c, s) => {
    c.beginPath();
    c.arc(0.5 * s, 0.36 * s, 0.15 * s, Math.PI * 1.05, Math.PI * 0.45);
    c.stroke();
    line(c, [[0.5, 0.52], [0.5, 0.62]], s);
    circle(c, 0.5, 0.78, 0.05, s, true);
  },
  hand: (c, s) => {
    circle(c, 0.5, 0.62, 0.2, s);
    for (const x of [0.36, 0.47, 0.58, 0.68]) line(c, [[x, 0.45], [x, 0.18]], s);
    line(c, [[0.32, 0.62], [0.16, 0.48]], s);
  },
  plus: (c, s) => {
    line(c, [[0.5, 0.24], [0.5, 0.76]], s);
    line(c, [[0.24, 0.5], [0.76, 0.5]], s);
  },
  minus: (c, s) => line(c, [[0.24, 0.5], [0.76, 0.5]], s),
};

/** Draw a named icon centred in a square canvas of side `size`, white on transparent. */
export function drawIcon(c: CanvasRenderingContext2D, name: string, size: number, color = '#ffffff'): void {
  const draw = ICONS[name];
  if (!draw) return;
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = size * 0.075;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  draw(c, size);
  c.restore();
}
