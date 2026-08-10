/**
 * Board state and movement rules.
 *
 * A cell is either empty or holds an arrow facing one of four directions.
 * Tapping an arrow slides it until it leaves the board (an exit, which scores)
 * or until it runs into an occupied cell and stops there.
 *
 * That "stops there" is the whole game. If arrows simply vanished when their
 * path was clear, removing tiles could only ever open paths, so any firing
 * order would work and there would be no puzzle. Because a blocked arrow stays
 * on the board in a new place, moving one arrow can block or unblock others,
 * and order becomes the thing the player is actually reasoning about.
 */

export const SIZE = 7;
export const CELLS = SIZE * SIZE;

export const UP = 1;
export const RIGHT = 2;
export const DOWN = 3;
export const LEFT = 4;

export type Dir = 1 | 2 | 3 | 4;
export const DIRS: readonly Dir[] = [UP, RIGHT, DOWN, LEFT];

export const DIR_NAME: Record<Dir, string> = { 1: '↑', 2: '→', 3: '↓', 4: '←' };
export const DIR_VEC: Record<Dir, readonly [number, number]> = {
  1: [0, -1],
  2: [1, 0],
  3: [0, 1],
  4: [-1, 0],
};

/** 0 = empty, otherwise a {@link Dir}. Length {@link CELLS}. */
export type Grid = Uint8Array;

export const createGrid = (): Grid => new Uint8Array(CELLS);
export const cloneGrid = (g: Grid): Grid => Uint8Array.from(g);

export const idx = (x: number, y: number): number => y * SIZE + x;
export const xOf = (i: number): number => i % SIZE;
export const yOf = (i: number): number => (i / SIZE) | 0;

/** Result of sliding the arrow at a cell. */
export interface Move {
  /** Cell index the arrow starts in. */
  readonly from: number;
  readonly dir: Dir;
  /** Destination cell index, or -1 when the arrow leaves the board. */
  readonly to: number;
  /** True when the arrow exits and scores. */
  readonly exits: boolean;
  /** True when the arrow cannot move at all - a wasted tap. */
  readonly jammed: boolean;
  /** Cells travelled. Longer slides read as more decisive on screen. */
  readonly distance: number;
}

/**
 * Where does the arrow at `i` end up?
 *
 * Walks one cell at a time. The board is 7x7, so the clarity of a direct scan
 * is worth more here than the bit tricks a larger board would justify.
 */
export function computeMove(g: Grid, i: number): Move {
  const raw = g[i];
  if (raw === 0) return { from: i, dir: UP, to: i, exits: false, jammed: true, distance: 0 };
  const dir = raw as Dir;

  const [dx, dy] = DIR_VEC[dir];
  let x = xOf(i);
  let y = yOf(i);
  let distance = 0;

  for (;;) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) {
      // Ran off the edge with nothing in the way: the arrow exits.
      return { from: i, dir, to: -1, exits: true, jammed: false, distance: distance + 1 };
    }
    if (g[idx(nx, ny)] !== 0) {
      const to = idx(x, y);
      return { from: i, dir, to, exits: false, jammed: to === i, distance };
    }
    x = nx;
    y = ny;
    distance++;
  }
}

/** Mutates `g` in place. Jammed moves are no-ops by construction. */
export function applyMove(g: Grid, m: Move): void {
  if (m.jammed) return;
  const dir = g[m.from];
  g[m.from] = 0;
  if (!m.exits) g[m.to] = dir;
}

/** Every tap that would actually change the board. */
export function legalMoves(g: Grid): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (g[i] === 0) continue;
    const m = computeMove(g, i);
    if (!m.jammed) out.push(m);
  }
  return out;
}

/** Moves that score immediately. */
export function exitMoves(g: Grid): Move[] {
  return legalMoves(g).filter((m) => m.exits);
}

export function arrowCount(g: Grid): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (g[i] !== 0) n++;
  return n;
}

export function emptyCells(g: Grid): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) if (g[i] === 0) out.push(i);
  return out;
}

/**
 * Every remaining arrow is wedged: the run is over.
 *
 * A board with nothing on it is emphatically not this. Clearing the board is
 * the best thing that can happen to a player, and an earlier version that
 * folded the two cases together ended competent runs after five taps.
 */
export function isDeadlocked(g: Grid): boolean {
  let any = false;
  for (let i = 0; i < CELLS; i++) {
    if (g[i] === 0) continue;
    any = true;
    if (!computeMove(g, i).jammed) return false;
  }
  return any;
}

/** Compact memo key for the search. */
export function gridKey(g: Grid): string {
  let s = '';
  for (let i = 0; i < CELLS; i++) s += String.fromCharCode(48 + g[i]);
  return s;
}

/** How far an arrow sits from the edge it is pointing at. */
export function distanceToEdge(i: number, dir: Dir): number {
  const x = xOf(i);
  const y = yOf(i);
  switch (dir) {
    case UP:
      return y;
    case DOWN:
      return SIZE - 1 - y;
    case LEFT:
      return x;
    case RIGHT:
      return SIZE - 1 - x;
  }
}
