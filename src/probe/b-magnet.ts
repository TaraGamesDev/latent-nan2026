/**
 * Probe B — MAGNET.
 *
 * Tap a tile and everything in its row and column is pulled toward it until
 * something blocks. Any group of three or more matching colours that ends up
 * connected clears. Empty the board.
 *
 * Measured on the same axis as the other two probes: what does *exact*
 * verification cost? Difficulty here means the length of the shortest solution,
 * which needs real search — there is no closed form the way there is for the
 * toggle family, and no construction-time guarantee the way there is for
 * deferred assignment.
 *
 *   npx tsx src/probe/b-magnet.ts
 */

import { makeRng, type Rng } from '../core/rng';

const N = 5;
const CELLS = N * N;
const EMPTY = 0;

type Board = Uint8Array;

const xOf = (i: number): number => i % N;
const yOf = (i: number): number => (i / N) | 0;
const at = (x: number, y: number): number => y * N + x;

/** Slide every tile on one ray toward the anchor, packing them against it. */
function pullRay(b: Board, ax: number, ay: number, dx: number, dy: number): void {
  const line: number[] = [];
  let x = ax + dx;
  let y = ay + dy;
  while (x >= 0 && x < N && y >= 0 && y < N) {
    if (b[at(x, y)] !== EMPTY) line.push(b[at(x, y)]);
    b[at(x, y)] = EMPTY;
    x += dx;
    y += dy;
  }
  x = ax + dx;
  y = ay + dy;
  for (const v of line) {
    b[at(x, y)] = v;
    x += dx;
    y += dy;
  }
}

/** Remove every orthogonally connected group of three or more of one colour. */
function clearGroups(b: Board): number {
  const seen = new Uint8Array(CELLS);
  let removed = 0;
  for (let i = 0; i < CELLS; i++) {
    if (b[i] === EMPTY || seen[i]) continue;
    const colour = b[i];
    const stack = [i];
    const group: number[] = [];
    seen[i] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      group.push(c);
      const cx = xOf(c);
      const cy = yOf(c);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
        const n = at(nx, ny);
        if (!seen[n] && b[n] === colour) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (group.length >= 3) {
      for (const c of group) b[c] = EMPTY;
      removed += group.length;
    }
  }
  return removed;
}

function applyTap(b: Board, cell: number): Board {
  const next = Uint8Array.from(b);
  const ax = xOf(cell);
  const ay = yOf(cell);
  pullRay(next, ax, ay, 1, 0);
  pullRay(next, ax, ay, -1, 0);
  pullRay(next, ax, ay, 0, 1);
  pullRay(next, ax, ay, 0, -1);
  let total = 0;
  for (;;) {
    const r = clearGroups(next);
    if (r === 0) break;
    total += r;
  }
  return next;
}

const key = (b: Board): string => String.fromCharCode(...b);
const isEmpty = (b: Board): boolean => b.every((v) => v === EMPTY);

/**
 * Shortest solution, or -1 if none within `maxDepth`.
 *
 * Iterative deepening with a visited set per depth. Branching is the number of
 * occupied cells, so this is exponential — which is the finding, not a flaw.
 */
function minMoves(start: Board, maxDepth: number): { moves: number; nodes: number } {
  let nodes = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const seen = new Set<string>();
    const found = (b: Board, left: number): boolean => {
      if (isEmpty(b)) return true;
      if (left === 0) return false;
      const k = key(b) + left;
      if (seen.has(k)) return false;
      seen.add(k);
      for (let i = 0; i < CELLS; i++) {
        if (b[i] === EMPTY) continue;
        nodes++;
        if (found(applyTap(b, i), left - 1)) return true;
      }
      return false;
    };
    if (found(start, depth)) return { moves: depth, nodes };
  }
  return { moves: -1, nodes };
}

function randomBoard(rng: Rng, colours: number, fill: number): Board {
  const b = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) if (rng() < fill) b[i] = 1 + rng.int(colours);
  clearGroups(b);
  return b;
}

/* ------------------------------ measurement ------------------------------ */

const rng = makeRng(31337);
const SAMPLES = 300;
const MAX_DEPTH = 6;

console.log(`probe B — MAGNET  (${N}x${N}, depth cap ${MAX_DEPTH})\n`);

const t0 = performance.now();
let solved = 0;
let totalNodes = 0;
const hist = new Map<number, number>();
for (let s = 0; s < SAMPLES; s++) {
  const b = randomBoard(rng, 3, 0.45);
  const r = minMoves(b, MAX_DEPTH);
  totalNodes += r.nodes;
  if (r.moves > 0) {
    solved++;
    hist.set(r.moves, (hist.get(r.moves) ?? 0) + 1);
  }
}
const elapsed = performance.now() - t0;

console.log(`generated + verified         ${SAMPLES} levels in ${elapsed.toFixed(0)} ms`);
console.log(`throughput                   ${Math.round(SAMPLES / (elapsed / 1000)).toLocaleString()} levels/sec (1 core)`);
console.log(`search nodes per level       ${Math.round(totalNodes / SAMPLES).toLocaleString()}`);
console.log(`solvable within ${MAX_DEPTH} moves     ${((solved / SAMPLES) * 100).toFixed(1)}%`);
console.log(`\nNOTE  levels not solved within the cap are simply *unknown* — depth cap`);
console.log(`      reached, not a proof of unsolvability. That is the difference from`);
console.log(`      probe A, where every answer is exact.`);

console.log(`\nminimum-moves distribution`);
for (const k of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(k) as number;
  console.log(`  ${k} moves  ${String(n).padStart(4)}  ${'█'.repeat(Math.max(1, Math.round((n / solved) * 90)))}`);
}
