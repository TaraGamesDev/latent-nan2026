/**
 * Single-run tracer. Prints why a run ended and how the board evolved.
 *
 *   npx tsx src/tools/diag.ts [kind] [seed]
 */

import { CELLS, SIZE, type Grid, arrowCount, legalMoves } from '../core/grid';
import { makeRng } from '../core/rng';
import { rankMoves } from '../ai/solver';
import { createGame, tap } from '../game/game';

const kind = (process.argv[2] ?? 'greedy') as 'random' | 'greedy' | 'optimal';
const seed = Number(process.argv[3] ?? 1000);

function choose(grid: Grid, k: string, rng: () => number): number | null {
  if (k === 'random') {
    const occ: number[] = [];
    for (let i = 0; i < CELLS; i++) if (grid[i] !== 0) occ.push(i);
    return occ.length === 0 ? null : occ[(rng() * occ.length) | 0];
  }
  const moves = legalMoves(grid);
  if (moves.length === 0) return null;
  if (k === 'greedy') return (moves.find((m) => m.exits) ?? moves[(rng() * moves.length) | 0]).from;
  const r = rankMoves(grid);
  return r.length > 0 ? r[0].move.from : null;
}

const draw = (g: Grid): string => {
  const ch = ['·', '^', '>', 'v', '<'];
  let out = '';
  for (let y = 0; y < SIZE; y++) {
    out += '  ';
    for (let x = 0; x < SIZE; x++) out += ch[g[y * SIZE + x]] + ' ';
    out += '\n';
  }
  return out;
};

const rng = makeRng(seed ^ 0x9e3779b9);
const g = createGame(seed, 0);
let clock = 0;
let reason = 'step cap';

console.log(`kind=${kind} seed=${seed}\nopening:\n${draw(g.grid)}`);

for (let step = 0; step < 3000; step++) {
  if (g.over) {
    reason = 'game.over';
    break;
  }
  const cell = choose(g.grid, kind, rng);
  if (cell === null) {
    reason = `bot had no move (arrows=${arrowCount(g.grid)}, legal=${legalMoves(g.grid).length})`;
    break;
  }
  clock += 1500;
  const res = tap(g, cell, clock);

  if (step < 6 || step % 25 === 0) {
    const c = res.decision?.constraints;
    console.log(
      `t${String(g.taps).padStart(4)} ${res.kind.padEnd(6)} ` +
        `arrows=${String(arrowCount(g.grid)).padStart(2)} ` +
        `legal=${String(legalMoves(g.grid).length).padStart(2)} ` +
        `score=${String(g.score).padStart(5)} ` +
        `theta=${g.skill.theta.toFixed(2)} ` +
        `intens=${(c?.intensity ?? 0).toFixed(2)} ` +
        `target=${(c?.targetChallenge ?? 0).toFixed(2)} ` +
        `rate=${(c?.spawnRate ?? 0).toFixed(2)} ` +
        `budget=${c?.spawnBudget ?? 0} ` +
        `frust=${g.mood.frustration.toFixed(2)} ` +
        `playable=${res.decision?.playable}`,
    );
  }
  if (res.gameOver) {
    reason = `gameOver (playable=${res.decision?.playable}, arrows=${arrowCount(g.grid)}, legal=${legalMoves(g.grid).length})`;
    break;
  }
}

console.log(`\nended after ${g.taps} taps - ${reason}`);
console.log(`score=${g.score} exits=${g.exits} jams=${g.jams} arrows=${arrowCount(g.grid)}`);
console.log(draw(g.grid));
