/**
 * Probe A — STAMP (toggle family, Lights Out lineage).
 *
 * Every cell carries a printed stamp. Tapping it flips the cells in that
 * pattern. Clear the board.
 *
 * The question this probe answers is not "is it fun" — it is "how cheap is
 * exact verification", because that is where the cost of level design actually
 * sits. Tapping twice is the identity, so a solution is a *subset* of cells and
 * the whole level is a linear system over GF(2).
 *
 *   npx tsx src/probe/a-stamp.ts
 */

import { makeRng, type Rng } from '../core/rng';
import { minWeight, popcount, solveGF2, type GF2System } from './gf2';

const N = 5;
const CELLS = N * N;

const xOf = (i: number): number => i % N;
const yOf = (i: number): number => (i / N) | 0;

/** Stamp shapes, as offsets from the tapped cell. Printed on the tile. */
const SHAPES: readonly (readonly [number, number][])[] = [
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]], // plus
  [[0, 0], [1, 0], [-1, 0]], // horizontal bar
  [[0, 0], [0, 1], [0, -1]], // vertical bar
  [[0, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]], // diagonal cross
  [[0, 0], [1, 0], [0, 1], [1, 1]], // square
  [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]], // wide plus
];

export interface Level {
  /** Shape index per cell. */
  stamps: number[];
  /** Which cells start lit, as a bitmask. */
  lit: number;
}

function stampMask(cell: number, shape: number): number {
  let mask = 0;
  for (const [dx, dy] of SHAPES[shape]) {
    const x = xOf(cell) + dx;
    const y = yOf(cell) + dy;
    if (x >= 0 && x < N && y >= 0 && y < N) mask |= 1 << (y * N + x);
  }
  return mask;
}

function buildSystem(level: Level): GF2System {
  // Column i = tapping cell i. Row j = the parity requirement for cell j.
  const columns = level.stamps.map((shape, cell) => stampMask(cell, shape));
  const rows: number[] = [];
  const rhs: number[] = [];
  for (let j = 0; j < CELLS; j++) {
    let row = 0;
    for (let i = 0; i < CELLS; i++) if ((columns[i] >>> j) & 1) row |= 1 << i;
    rows.push(row);
    rhs.push((level.lit >>> j) & 1);
  }
  return { rows, rhs, vars: CELLS };
}

function randomLevel(rng: Rng, litDensity: number): Level {
  const stamps = Array.from({ length: CELLS }, () => rng.int(SHAPES.length));
  let lit = 0;
  for (let i = 0; i < CELLS; i++) if (rng() < litDensity) lit |= 1 << i;
  return { stamps, lit };
}

export interface Analysis {
  solvable: boolean;
  /** Fewest taps. -1 when unsolvable. */
  minTaps: number;
  exact: boolean;
  /** log2 of the number of distinct solutions. 0 means a unique solution. */
  log2Solutions: number;
}

export function analyse(level: Level): Analysis {
  const sol = solveGF2(buildSystem(level));
  if (!sol.solvable) return { solvable: false, minTaps: -1, exact: true, log2Solutions: 0 };
  const mw = minWeight(sol);
  return { solvable: true, minTaps: mw.weight, exact: mw.exact, log2Solutions: sol.nullity };
}

/* ------------------------------ measurement ------------------------------ */

const rng = makeRng(20260810);
const SAMPLES = 20000;

console.log(`probe A — STAMP  (${N}x${N}, ${SHAPES.length} stamp shapes)\n`);

const t0 = performance.now();
const results: Analysis[] = [];
for (let i = 0; i < SAMPLES; i++) {
  results.push(analyse(randomLevel(rng, 0.2 + rng() * 0.6)));
}
const elapsed = performance.now() - t0;

const solvable = results.filter((r) => r.solvable);
const unique = solvable.filter((r) => r.log2Solutions === 0);
const inexact = results.filter((r) => !r.exact).length;

console.log(`generated + fully verified   ${SAMPLES} levels in ${elapsed.toFixed(0)} ms`);
console.log(`throughput                   ${Math.round(SAMPLES / (elapsed / 1000)).toLocaleString()} levels/sec (1 core)`);
console.log(`solvable                     ${((solvable.length / SAMPLES) * 100).toFixed(1)}%`);
console.log(`unique solution              ${((unique.length / solvable.length) * 100).toFixed(1)}% of solvable`);
console.log(`min-taps known exactly       ${(((SAMPLES - inexact) / SAMPLES) * 100).toFixed(1)}%`);

const hist = new Map<number, number>();
for (const r of solvable) hist.set(r.minTaps, (hist.get(r.minTaps) ?? 0) + 1);
const keys = [...hist.keys()].sort((a, b) => a - b);
console.log(`\nminimum-taps distribution (the difficulty axis)`);
for (const k of keys) {
  const n = hist.get(k) as number;
  const bar = '█'.repeat(Math.max(1, Math.round((n / solvable.length) * 120)));
  console.log(`  ${String(k).padStart(2)} taps  ${String(n).padStart(5)}  ${bar}`);
}

// A difficulty axis is only useful if you can order levels along it and hit a
// requested band. Check that a target band can actually be filled.
const bands: [number, number][] = [
  [3, 5],
  [6, 8],
  [9, 11],
  [12, 25],
];
console.log(`\nsupply per requested difficulty band`);
for (const [lo, hi] of bands) {
  const n = solvable.filter((r) => r.minTaps >= lo && r.minTaps <= hi).length;
  console.log(`  ${String(lo).padStart(2)}-${String(hi).padStart(2)} taps  ${String(n).padStart(5)}  (${((n / SAMPLES) * 100).toFixed(1)}% of random draws)`);
}

console.log(`\nunique-solution levels are the 'aha' ones: ${unique.length} found (${popcount(0)} — sanity)`);
