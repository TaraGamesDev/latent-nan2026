/**
 * Canvas renderer: the pile on top, the tray underneath.
 *
 * The one thing worth pointing at is how a covered tile is drawn. It is not
 * shown face-down — it is shown *undecided*: a dim, slowly breathing blank,
 * because at that instant the tile genuinely has no face. When it comes free
 * the assigner writes one and the tile resolves in place. The central idea of
 * the project is visible without opening anything.
 */

import { type Board, type Face, TRAY_SLOTS, type Tile, UNDECIDED, isFree } from '../core/tiles';

type FxKind = 'resolve' | 'lift' | 'clear' | 'shake';

interface Fx {
  kind: FxKind;
  t0: number;
  dur: number;
  tileId?: number;
  face?: Face;
  slot?: number;
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number): number => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Eight faces, each a distinct shape *and* a distinct hue — colour alone is
 *  not enough to tell them apart at thumb size, or for colour-blind players. */
const FACE_COLOURS = [
  '#ff6b8a',
  '#ffb23e',
  '#46e0a0',
  '#56e1ff',
  '#b388ff',
  '#ff8f5e',
  '#7de07d',
  '#ff5edc',
];

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private fx: Fx[] = [];
  private w = 0;
  private h = 0;
  private tile = 0;
  private originX = 0;
  private originY = 0;
  private trayY = 0;
  private trayTile = 0;
  private pressed: number | null = null;
  private hintIds = new Set<number>();
  private palette = { surface: '#141824', line: '#232a3c', muted: '#7d879e', accent: '#56e1ff' };

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    const s = getComputedStyle(document.documentElement);
    const v = (n: string, d: string): string => s.getPropertyValue(n).trim() || d;
    this.palette = {
      surface: v('--surface', '#141824'),
      line: v('--line', '#232a3c'),
      muted: v('--muted', '#7d879e'),
      accent: v('--accent', '#56e1ff'),
    };
  }

  private lastBox = '';

  /** Re-measure only when the element actually changed size. */
  layoutIfNeeded(board: Board): void {
    const r = this.canvas.getBoundingClientRect();
    const box = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (box === this.lastBox) return;
    this.lastBox = box;
    this.layout(board);
  }

  /** Recompute geometry for the current board and canvas size. */
  layout(board: Board): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.w = w;
    this.h = h;

    let maxX = 0;
    let maxY = 0;
    for (const t of board.tiles) {
      if (t.x > maxX) maxX = t.x;
      if (t.y > maxY) maxY = t.y;
    }
    const cols = maxX + 1;
    const rows = maxY + 1;

    // Reserve the bottom strip for the tray.
    const trayH = h * 0.17;
    const boardH = h - trayH - h * 0.04;
    this.tile = Math.min((w * 0.94) / cols, (boardH * 0.94) / rows);
    this.originX = (w - this.tile * cols) / 2;
    this.originY = (boardH - this.tile * rows) / 2;
    this.trayY = boardH + h * 0.02;
    this.trayTile = Math.min(trayH * 0.82, (w * 0.92) / TRAY_SLOTS);
  }

  /** Depth offset so upper layers visibly sit on top. */
  private lift(layer: number): number {
    return layer * this.tile * 0.13;
  }

  private tileRect(t: Tile): [number, number, number] {
    const s = this.tile * 0.92;
    const x = this.originX + t.x * this.tile + (this.tile - s) / 2;
    const y = this.originY + t.y * this.tile + (this.tile - s) / 2 - this.lift(t.layer);
    return [x, y, s];
  }

  /** Topmost tile whose rectangle contains the point. */
  hitTest(board: Board, clientX: number, clientY: number): Tile | null {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.w / rect.width;
    const px = (clientX - rect.left) * scale;
    const py = (clientY - rect.top) * scale;
    let best: Tile | null = null;
    for (const t of board.tiles) {
      if (t.taken) continue;
      const [x, y, s] = this.tileRect(t);
      if (px >= x && px <= x + s && py >= y && py <= y + s) {
        if (!best || t.layer > best.layer) best = t;
      }
    }
    return best;
  }

  setPressed(id: number | null): void {
    this.pressed = id;
  }

  /** Tiles the panel wants outlined — the assigner's most recent writes. */
  setHint(ids: number[]): void {
    this.hintIds = new Set(ids);
  }

  addResolve(tileId: number, now: number): void {
    this.fx.push({ kind: 'resolve', t0: now, dur: 380, tileId });
  }
  addLift(tileId: number, now: number): void {
    this.fx.push({ kind: 'lift', t0: now, dur: 220, tileId });
  }
  addClear(face: Face, now: number): void {
    this.fx.push({ kind: 'clear', t0: now, dur: 320, face });
  }
  addShake(now: number): void {
    this.fx.push({ kind: 'shake', t0: now, dur: 340 });
  }
  clearEffects(): void {
    this.fx.length = 0;
  }

  render(board: Board, now: number): void {
    const { ctx } = this;
    this.fx = this.fx.filter((f) => now < f.t0 + f.dur);
    ctx.clearRect(0, 0, this.w, this.h);

    const resolving = new Map<number, number>();
    for (const f of this.fx) {
      if (f.kind === 'resolve') resolving.set(f.tileId as number, clamp01((now - f.t0) / f.dur));
    }
    const lifting = new Map<number, number>();
    for (const f of this.fx) {
      if (f.kind === 'lift') lifting.set(f.tileId as number, clamp01((now - f.t0) / f.dur));
    }

    // Bottom layers first so upper tiles overlap them.
    const order = [...board.tiles].sort((a, b) => a.layer - b.layer || a.y - b.y || a.x - b.x);
    for (const t of order) {
      if (t.taken) continue;
      const free = isFree(board, t);
      const decided = t.face !== UNDECIDED;
      const [x, y, s] = this.tileRect(t);

      let scale = 1;
      const lf = lifting.get(t.id);
      if (lf !== undefined) scale = 1 - 0.25 * easeOut(lf);
      if (t.id === this.pressed) scale *= 1.06;

      const r = resolving.get(t.id);
      if (decided && r !== undefined && r < 1) {
        // Cross-fade from the undecided blank into the written face.
        this.drawTile(x, y, s, scale, null, 1 - easeOut(r), false);
        this.drawTile(x, y, s, scale * easeOutBack(Math.min(1, r * 1.2)), t.face, easeOut(r), free);
      } else {
        this.drawTile(x, y, s, scale, decided ? t.face : null, lf !== undefined ? 1 - lf : 1, free);
      }

      if (this.hintIds.has(t.id) && decided) {
        const pulse = 0.35 + 0.25 * Math.sin(now / 320);
        ctx.strokeStyle = this.palette.accent;
        ctx.globalAlpha = pulse;
        ctx.lineWidth = Math.max(2, s * 0.06);
        roundRect(ctx, x - 2, y - 2, s + 4, s + 4, s * 0.24);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    this.drawTray(board, now);
  }

  /**
   * An undecided tile is drawn as a slow breathing blank rather than a
   * face-down card. Nothing is being concealed — there is nothing there yet.
   */
  private drawTile(
    x: number,
    y: number,
    s: number,
    scale: number,
    face: Face | null,
    alpha: number,
    free: boolean,
  ): void {
    const { ctx } = this;
    const size = s * scale;
    const dx = x + (s - size) / 2;
    const dy = y + (s - size) / 2;
    if (size <= 0 || alpha <= 0) return;

    ctx.globalAlpha = alpha;

    if (face === null) {
      const breathe = 0.5 + 0.5 * Math.sin(performance.now() / 900 + (x + y) * 0.01);
      ctx.fillStyle = `rgba(120, 132, 160, ${0.1 + 0.06 * breathe})`;
      ctx.strokeStyle = `rgba(140, 152, 180, ${0.22 + 0.1 * breathe})`;
      ctx.lineWidth = Math.max(1, size * 0.03);
      ctx.setLineDash([size * 0.14, size * 0.1]);
      roundRect(ctx, dx, dy, size, size, size * 0.22);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      return;
    }

    const colour = FACE_COLOURS[face % FACE_COLOURS.length];
    // A cast shadow is what makes the pile read as stacked rather than scattered.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = size * 0.16;
    ctx.shadowOffsetY = size * 0.09;
    ctx.fillStyle = '#0b0e15';
    roundRect(ctx, dx, dy, size, size, size * 0.22);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = free ? withAlpha(colour, 0.2) : withAlpha(colour, 0.09);
    ctx.strokeStyle = withAlpha(colour, free ? 0.75 : 0.28);
    ctx.lineWidth = Math.max(1, size * 0.045);
    roundRect(ctx, dx, dy, size, size, size * 0.22);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = free ? colour : withAlpha(colour, 0.4);
    drawGlyph(ctx, dx + size / 2, dy + size / 2, size * 0.3, face);

    ctx.globalAlpha = 1;
  }

  private drawTray(board: Board, now: number): void {
    const { ctx } = this;
    const gap = this.trayTile * 0.14;
    const totalW = TRAY_SLOTS * this.trayTile + (TRAY_SLOTS - 1) * gap;
    const startX = (this.w - totalW) / 2;

    let shake = 0;
    for (const f of this.fx) {
      if (f.kind === 'shake') {
        const t = clamp01((now - f.t0) / f.dur);
        shake = Math.sin(t * Math.PI * 7) * this.trayTile * 0.12 * (1 - t);
      }
    }

    for (let i = 0; i < TRAY_SLOTS; i++) {
      const x = startX + i * (this.trayTile + gap) + shake;
      const y = this.trayY;
      const danger = i >= TRAY_SLOTS - 2;

      ctx.strokeStyle = danger ? 'rgba(255,107,138,0.45)' : this.palette.line;
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.lineWidth = Math.max(1, this.trayTile * 0.035);
      roundRect(ctx, x, y, this.trayTile, this.trayTile, this.trayTile * 0.22);
      ctx.fill();
      ctx.stroke();

      const face = board.tray[i];
      if (face === undefined) continue;
      const colour = FACE_COLOURS[face % FACE_COLOURS.length];
      ctx.fillStyle = withAlpha(colour, 0.24);
      ctx.strokeStyle = withAlpha(colour, 0.8);
      roundRect(ctx, x, y, this.trayTile, this.trayTile, this.trayTile * 0.22);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = colour;
      drawGlyph(ctx, x + this.trayTile / 2, y + this.trayTile / 2, this.trayTile * 0.3, face);
    }
  }
}

/* --------------------------- drawing helpers ---------------------------- */

/** Eight glyphs, distinguishable by silhouette so colour is never load-bearing. */
function drawGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, face: Face): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  switch (face % 8) {
    case 0:
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      break;
    case 1:
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.92, r * 0.7);
      ctx.lineTo(-r * 0.92, r * 0.7);
      break;
    case 2:
      ctx.rect(-r * 0.82, -r * 0.82, r * 1.64, r * 1.64);
      break;
    case 3:
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      break;
    case 4: {
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const b = a + Math.PI / 5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.lineTo(Math.cos(b) * r * 0.45, Math.sin(b) * r * 0.45);
      }
      break;
    }
    case 5: {
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      break;
    }
    case 6: {
      const t = r * 0.36;
      ctx.rect(-t, -r, t * 2, r * 2);
      ctx.rect(-r, -t, r * 2, t * 2);
      break;
    }
    default: {
      ctx.moveTo(-r, r * 0.8);
      ctx.quadraticCurveTo(0, -r * 1.3, r, r * 0.8);
      break;
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

export { FACE_COLOURS };
