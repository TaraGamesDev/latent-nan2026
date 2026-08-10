/**
 * How much is skill worth in this ruleset?
 *
 * This exists because of a mistake worth keeping. The first Screwdom-shaped
 * build had the personas ordered backwards in the bench — beginners cleared more
 * walls than experts — and the obvious reading was that the director was
 * over-helping. It was not. Two separate things were wrong, and only measuring
 * them apart found either:
 *
 *   1. The position evaluation ignored whether a holder could still be
 *      finished, so following its top-ranked move scored *worse* than choosing
 *      at random. Every regret number computed against it was noise.
 *   2. Once that was fixed, the skill margin turned out to be small. Optimal
 *      play beats random by about ten percent. Any adaptation that raises a
 *      strong player's difficulty by more than that inverts the leaderboard, no
 *      matter how principled the adaptation is.
 *
 * So the margin is a *budget*, and the shipped policy has to fit inside it.
 * This tool measures the budget with the director frozen; `bench.ts` then checks
 * the shipped policy against it.
 */

import { createGame, tap } from '../game/game';
import { rankTurns } from '../ai/solver';
import { UNDECIDED, isReachable } from '../core/plates';
import { makeRng } from '../core/rng';
import { POLICY } from '../ai/policy';

// Freeze everything that depends on the skill estimate. Whatever difference is
// left is the game's own skill margin, not the director's doing.
Object.assign(POLICY, {
  challengeOffset: 0,
  frustrationRelief: 0,
  boredomPush: 0,
  envelopeLift: 0,
  coldStartEase: 1,
  reliefSkillWeight: 0,
});

const RUNS = 250;
const modes = ['best', 'random', 'worst'] as const;
const levels: Record<string, number> = {};

for (const mode of modes) {
  let total = 0;
  for (let r = 0; r < RUNS; r++) {
    const g = createGame(8800 + r);
    const rng = makeRng(3 + r);
    while (!g.over && g.taps < 3000) {
      const ranked = rankTurns(g.board);
      if (ranked.length === 0) break;
      const pick =
        mode === 'best' ? ranked[0] : mode === 'worst' ? ranked[ranked.length - 1] : rng.pick(ranked);
      tap(g, pick.screw.id, Date.now());
    }
    total += g.cleared;
  }
  levels[mode] = total / RUNS;
}

// How wide is a decision, in practice? A position offering seventeen legal moves
// is not offering a choice; this is the number that had to come down before any
// of the above meant anything.
let reach = 0;
let distinct = 0;
let hasComplete = 0;
let n = 0;
for (let r = 0; r < 40; r++) {
  const g = createGame(1500 + r);
  const rng = makeRng(70 + r);
  while (!g.over && g.taps < 400) {
    const ranked = rankTurns(g.board);
    if (ranked.length === 0) break;
    const live = g.board.screws.filter(
      (s) => !s.removed && s.colour !== UNDECIDED && isReachable(g.board, s),
    );
    reach += live.length;
    distinct += new Set(live.map((s) => s.colour)).size;
    hasComplete += ranked.some((t) => t.completes) ? 1 : 0;
    n++;
    tap(g, rng.pick(ranked).screw.id, Date.now());
  }
}

const margin = (levels.best / levels.random - 1) * 100;
console.log('SCREWDOM skill margin - director frozen\n');
console.log(`  optimal play      ${levels.best.toFixed(2)} walls`);
console.log(`  random legal play ${levels.random.toFixed(2)} walls`);
console.log(`  worst legal play  ${levels.worst.toFixed(2)} walls\n`);
console.log(`  skill margin (optimal over random)  ${margin.toFixed(0)}%`);
console.log(`  ranking spread (optimal over worst) ${(levels.best / levels.worst).toFixed(2)}x\n`);
console.log(`  screws reachable per turn   ${(reach / n).toFixed(1)}`);
console.log(`  distinct colours reachable  ${(distinct / n).toFixed(2)}`);
console.log(`  a completing move exists    ${((hasComplete / n) * 100).toFixed(0)}% of turns\n`);

if (margin <= 0) {
  console.log('FAIL  the ranking does not beat random: the evaluation is wrong, not the policy');
} else {
  console.log(`OK    adaptation must cost a strong player less than ${margin.toFixed(0)}% to stay ordered`);
}
