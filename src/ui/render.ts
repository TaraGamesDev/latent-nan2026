/**
 * Canvas board renderer.
 *
 * Keeps its own short-lived effect list rather than tweening game state. The
 * logical grid is updated the instant a tap resolves - the animation is purely
 * a story told afterwards about what already happened - so a dropped frame or a
 * backgrounded tab can never desynchronise the board from the engine.
 */

import { DIR_VEC, type Dir, type Grid, type Move, SIZE, xOf, yOf } from '../core/grid';

type FxKind = 'slide' | 'spawn' | 'jam' | 'float';

interface Fx {
  kind: FxKind;
  t0: number;
  dur: number;
  cell: number;
  to?: number;
  dir?: Dir;
  exits?: boolean;
  text?: string;
}

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number): number => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private fx: Fx[] = [];
  private palette!: { bg: string; line: string; text: string; muted: string; accent: string; dirs: string[] };
  private chain: Move[] = [];
  private size = 0;
  private pad = 0;
  private cell = 0;
  private pressed: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.readPalette();
    this.resize();
  }

  private readPalette(): void {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string): string => s.getPropertyValue(n).trim();
    this.palette = {
      bg: v('--surface') || '#141824',
      line: v('--line') || '#232a3c',
      text: v('--text') || '#e9edf7',
      muted: v('--muted') || '#7d879e',
      accent: v('--accent') || '#56e1ff',
      // Index by Dir (1..4); slot 0 is unused.
      dirs: ['', v('--dir-up'), v('--dir-right'), v('--dir-down'), v('--dir-left')],
    };
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = this.canvas.getBoundingClientRect();
    const px = Math.max(1, Math.round(rect.width * dpr));
    if (this.canvas.width !== px || this.canvas.height !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    this.size = px;
    this.pad = Math.round(px * 0.035);
    this.cell = (px - this.pad * 2) / SIZE;
  }

  /** Cell under a pointer event, or null when the tap missed the grid. */
  cellFromPoint(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.size / rect.width;
    const px = (clientX - rect.left) * scale;
    const py = (clientY - rect.top) * scale;
    const x = Math.floor((px - this.pad) / this.cell);
    const y = Math.floor((py - this.pad) / this.cell);
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
    return y * SIZE + x;
  }

  setPressed(cell: number | null): void {
    this.pressed = cell;
  }

  /** Highlight the solver's guaranteed scoring line. */
  setChain(chain: Move[]): void {
    this.chain = chain;
  }

  addSlide(move: Move, now: number): void {
    this.fx.push({
      kind: 'slide',
      t0: now,
      dur: 90 + Math.min(move.distance, 7) * 26,
      cell: move.from,
      to: move.exits ? -1 : move.to,
      dir: move.dir,
      exits: move.exits,
    });
  }

  addSpawns(cells: number[], now: number): void {
    for (const cell of cells) this.fx.push({ kind: 'spawn', t0: now + 60, dur: 260, cell });
  }

  addJam(cell: number, now: number): void {
    this.fx.push({ kind: 'jam', t0: now, dur: 300, cell });
  }

  addFloat(cell: number, text: string, now: number): void {
    this.fx.push({ kind: 'float', t0: now, dur: 850, cell, text });
  }

  /** True while something is still moving, so the loop knows to keep drawing. */
  get busy(): boolean {
    return this.fx.length > 0;
  }

  /** Drop all in-flight effects. Used by capture mode, where a whole run is
   *  played inside one synchronous loop and every effect would otherwise be
   *  drawn on top of the others at the same timestamp. */
  clearEffects(): void {
    this.fx.length = 0;
  }

  private center(cell: number): [number, number] {
    return [
      this.pad + (xOf(cell) + 0.5) * this.cell,
      this.pad + (yOf(cell) + 0.5) * this.cell,
    ];
  }

  render(grid: Grid, now: number): void {
    const { ctx } = this;
    this.fx = this.fx.filter((f) => now < f.t0 + f.dur);

    ctx.clearRect(0, 0, this.size, this.size);

    // Board plate.
    ctx.fillStyle = this.palette.bg;
    roundRect(ctx, 0, 0, this.size, this.size, this.size * 0.055);
    ctx.fill();

    // Grid guides.
    ctx.strokeStyle = this.palette.line;
    ctx.lineWidth = Math.max(1, this.size * 0.0016);
    for (let i = 0; i <= SIZE; i++) {
      const p = this.pad + i * this.cell;
      ctx.beginPath();
      ctx.moveTo(p, this.pad);
      ctx.lineTo(p, this.pad + this.cell * SIZE);
      ctx.moveTo(this.pad, p);
      ctx.lineTo(this.pad + this.cell * SIZE, p);
      ctx.stroke();
    }

    // Cells whose tile is being drawn by a slide effect instead.
    const hidden = new Set<number>();
    for (const f of this.fx) {
      if (f.kind === 'slide' && f.to !== undefined && f.to >= 0) hidden.add(f.to);
    }

    const spawning = new Map<number, number>();
    for (const f of this.fx) {
      if (f.kind === 'spawn') spawning.set(f.cell, clamp01((now - f.t0) / f.dur));
    }
    const jamming = new Map<number, number>();
    for (const f of this.fx) {
      if (f.kind === 'jam') jamming.set(f.cell, clamp01((now - f.t0) / f.dur));
    }

    this.drawChainHint(grid, now);

    for (let i = 0; i < SIZE * SIZE; i++) {
      const dir = grid[i];
      if (dir === 0 || hidden.has(i)) continue;

      let scale = 1;
      const sp = spawning.get(i);
      if (sp !== undefined) scale = sp < 0 ? 0 : easeOutBack(sp);

      let dx = 0;
      const jm = jamming.get(i);
      if (jm !== undefined) {
        // Short, decaying wobble: unmistakable but not punishing to look at.
        dx = Math.sin(jm * Math.PI * 6) * this.cell * 0.09 * (1 - jm);
      }

      const [cx, cy] = this.center(i);
      this.drawTile(cx + dx, cy, dir as Dir, scale, i === this.pressed ? 1.06 : 1, 1);
    }

    // Sliding tiles, drawn above the settled board.
    for (const f of this.fx) {
      if (f.kind !== 'slide') continue;
      const t = clamp01((now - f.t0) / f.dur);
      const e = easeOut(t);
      const [sx, sy] = this.center(f.cell);
      let ex: number;
      let ey: number;
      if (f.exits) {
        const [vx, vy] = DIR_VEC[f.dir as Dir];
        ex = sx + vx * (this.size + this.cell);
        ey = sy + vy * (this.size + this.cell);
      } else {
        [ex, ey] = this.center(f.to as number);
      }
      const alpha = f.exits ? 1 - Math.pow(t, 2) : 1;
      this.drawTile(sx + (ex - sx) * e, sy + (ey - sy) * e, f.dir as Dir, 1, 1, alpha);
    }

    // Floating score text.
    for (const f of this.fx) {
      if (f.kind !== 'float') continue;
      const t = clamp01((now - f.t0) / f.dur);
      const [cx, cy] = this.center(f.cell);
      ctx.globalAlpha = 1 - t * t;
      ctx.fillStyle = this.palette.accent;
      ctx.font = `800 ${this.cell * 0.42}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.text ?? '', cx, cy - this.cell * 0.9 * easeOut(t));
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Draw the exit chain the solver proved is available.
   *
   * Only shown while the director panel is open. It is the clearest single
   * picture of what the guarantee means: these arrows, in this order, score no
   * matter what else happens.
   */
  private drawChainHint(grid: Grid, now: number): void {
    if (this.chain.length === 0) return;
    const { ctx } = this;
    const pulse = 0.35 + 0.15 * Math.sin(now / 420);

    this.chain.slice(0, 6).forEach((m, n) => {
      if (grid[m.from] === 0) return;
      const [cx, cy] = this.center(m.from);
      const r = this.cell * 0.46;

      ctx.strokeStyle = this.palette.accent;
      ctx.globalAlpha = pulse;
      ctx.lineWidth = Math.max(1.5, this.cell * 0.045);
      ctx.setLineDash([this.cell * 0.12, this.cell * 0.1]);
      roundRect(ctx, cx - r, cy - r, r * 2, r * 2, r * 0.42);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.95;
      ctx.fillStyle = this.palette.accent;
      ctx.beginPath();
      ctx.arc(cx - r * 0.82, cy - r * 0.82, this.cell * 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#04222b';
      ctx.font = `800 ${this.cell * 0.2}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n + 1), cx - r * 0.82, cy - r * 0.8);
      ctx.globalAlpha = 1;
    });
  }

  private drawTile(cx: number, cy: number, dir: Dir, scale: number, press: number, alpha: number): void {
    const { ctx } = this;
    const color = this.palette.dirs[dir] || this.palette.accent;
    const s = this.cell * 0.86 * scale * press;
    if (s <= 0) return;

    ctx.globalAlpha = alpha;

    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.lineWidth = Math.max(1, this.cell * 0.035);
    roundRect(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.26);
    ctx.fill();
    ctx.stroke();

    // Glyph: a solid head with a short stem, rotated to face `dir`.
    const [vx, vy] = DIR_VEC[dir];
    const a = Math.atan2(vy, vx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = color;
    const h = s * 0.3;
    ctx.beginPath();
    ctx.moveTo(h * 0.95, 0);
    ctx.lineTo(-h * 0.35, -h * 0.8);
    ctx.lineTo(-h * 0.35, h * 0.8);
    ctx.closePath();
    ctx.fill();
    roundRect(ctx, -h * 1.25, -h * 0.26, h * 1.0, h * 0.52, h * 0.26);
    ctx.fill();
    ctx.restore();

    ctx.globalAlpha = 1;
  }
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

/** Accepts the hex values the stylesheet actually contains. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
