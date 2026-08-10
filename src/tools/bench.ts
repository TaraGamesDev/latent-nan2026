/**
 * Headless smoke test and engine benchmark.
 *
 * Runs full games through the real `tap()` path with scripted players, so a
 * regression in the rules, the solver or the director shows up here before it
 * shows up in someone's hands. Three things are asserted, not just reported:
 *
 *   1. the playability invariant holds on every tap of every run,
 *   2. every run terminates - a competent player must not be immortal,
 *   3. theta ranks the scripted players in the order they deserve.
 *
 *   npm run bench
 */

import { legalMoves } from '../core/grid';
import { makeRng } from '../core/rng';
import { PERSONAS, type PersonaName, chooseTap, thinkTime } from '../ai/bots';
import { createGame, tap } from '../game/game';

type PlayerKind = PersonaName;
const KINDS: PlayerKind[] = ['novice', 'casual', 'expert'];

interface RunResult {
  score: number;
  taps: number;
  exits: number;
  jams: number;
  bestCombo: number;
  theta: number;
  invariantBreaches: number;
  reducedBudgets: number;
  terminated: boolean;
  maxTapMs: number;
  totalTapMs: number;
}

const STEP_CAP = 3000;

function playOne(kind: PlayerKind, seed: number): RunResult {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const g = createGame(seed, 0);
  let invariantBreaches = 0;
  let reducedBudgets = 0;
  let maxTapMs = 0;
  let totalTapMs = 0;
  let clock = 0;
  let terminated = false;

  for (let step = 0; step < STEP_CAP; step++) {
    if (g.over) {
      terminated = true;
      break;
    }
    const persona = PERSONAS[kind];
    const cell = chooseTap(g.grid, persona, rng);
    if (cell === null) {
      terminated = true;
      break;
    }

    // Scripted players "think" for a plausible amount of time so the tempo
    // component of the skill estimate is exercised rather than sitting at zero.
    clock += thinkTime(persona, rng);

    const t0 = performance.now();
    const res = tap(g, cell, clock);
    const dt = performance.now() - t0;
    totalTapMs += dt;
    if (dt > maxTapMs) maxTapMs = dt;

    if (res.decision) {
      if (res.decision.reducedBudget) reducedBudgets++;
      // The invariant: whenever the director reports the board playable, it
      // must actually be playable.
      if (res.decision.playable && legalMoves(g.grid).length < 1) invariantBreaches++;
    }
  }

  return {
    score: g.score,
    taps: g.taps,
    exits: g.exits,
    jams: g.jams,
    bestCombo: g.bestCombo,
    theta: g.skill.theta,
    invariantBreaches,
    reducedBudgets,
    terminated,
    maxTapMs,
    totalTapMs,
  };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (xs: number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const RUNS = 60;

console.log(`CADENCE engine bench - ${RUNS} runs per player\n`);
console.log(
  ['player', 'score', 'taps', 'p10', 'p90', 'exits', 'jams', 'combo', 'theta', 'shrink', 'ms/tap', 'maxms']
    .map((h) => h.padStart(8))
    .join(''),
);

let breaches = 0;
let immortal = 0;
const thetaByKind: Record<string, number> = {};

for (const kind of KINDS) {
  const runs = Array.from({ length: RUNS }, (_, i) => playOne(kind, 1000 + i * 7919));
  breaches += runs.reduce((a, r) => a + r.invariantBreaches, 0);
  immortal += runs.filter((r) => !r.terminated).length;
  const taps = runs.map((r) => r.taps);
  thetaByKind[kind] = mean(runs.map((r) => r.theta));

  console.log(
    [
      kind,
      mean(runs.map((r) => r.score)).toFixed(0),
      mean(taps).toFixed(1),
      pct(taps, 0.1).toFixed(0),
      pct(taps, 0.9).toFixed(0),
      mean(runs.map((r) => r.exits)).toFixed(1),
      mean(runs.map((r) => r.jams)).toFixed(1),
      mean(runs.map((r) => r.bestCombo)).toFixed(1),
      thetaByKind[kind].toFixed(3),
      mean(runs.map((r) => r.reducedBudgets)).toFixed(1),
      (mean(runs.map((r) => r.totalTapMs)) / Math.max(1, mean(taps))).toFixed(2),
      Math.max(...runs.map((r) => r.maxTapMs)).toFixed(1),
    ]
      .map((c) => String(c).padStart(8))
      .join(''),
  );
}

const ordered = thetaByKind.novice < thetaByKind.casual && thetaByKind.casual < thetaByKind.expert;

console.log('');
console.log(breaches === 0 ? 'OK    playability invariant held on every tap' : `FAIL  invariant breached ${breaches}x`);
console.log(immortal === 0 ? `OK    every run terminated within ${STEP_CAP} taps` : `FAIL  ${immortal} runs never ended`);
console.log(
  `${ordered ? 'OK  ' : 'FAIL'}  theta ranks players: ` +
    KINDS.map((k) => `${k}=${thetaByKind[k].toFixed(3)}`).join(' < '),
);

if (breaches !== 0 || immortal !== 0 || !ordered) process.exitCode = 1;
