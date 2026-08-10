/**
 * Headless smoke test and engine benchmark.
 *
 * Runs full games through the real `tap()` path with scripted players, so a
 * regression in the rules, the solver or the assigner shows up here before it
 * shows up in someone's hands. Three things are asserted, not just reported:
 *
 *   1. the completability invariant holds — every face ever assigned can still
 *      be brought to a multiple of three,
 *   2. runs end, and better players get further,
 *   3. theta ranks the scripted players in the order they deserve.
 *
 *   npm run bench
 */

import { HOLDER_CAPACITY } from '../core/plates';
import { makeRng } from '../core/rng';
import { PERSONAS, type PersonaName, chooseTap, thinkTime } from '../ai/bots';
import { debtOf } from '../ai/assigner';
import { statsOf } from '../ai/solver';
import { createGame, tap } from '../game/game';

const KINDS: PersonaName[] = ['novice', 'casual', 'expert'];
const STEP_CAP = 12000;

interface RunResult {
  levels: number;
  score: number;
  taps: number;
  matches: number;
  theta: number;
  meanSingles: number;
  maxTray: number;
  breaches: number;
  terminated: boolean;
  totalMs: number;
}

function playOne(kind: PersonaName, seed: number): RunResult {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const g = createGame(seed, 0);
  const persona = PERSONAS[kind];
  let clock = 0;
  let breaches = 0;
  let singlesSum = 0;
  let maxTray = 0;
  let terminated = false;
  let totalMs = 0;

  for (let step = 0; step < STEP_CAP; step++) {
    if (g.over) {
      terminated = true;
      break;
    }
    const id = chooseTap(g.board, persona, rng);
    if (id === null) {
      terminated = true;
      break;
    }
    clock += thinkTime(persona, rng);

    const t0 = performance.now();
    tap(g, id, clock);
    totalMs += performance.now() - t0;

    // The invariant: enough undecided tiles remain to close every open face.
    if (g.board.undecided < debtOf(g.ledger)) breaches++;

    const s = statsOf(g.board);
    singlesSum += s.lonely;
    if (3 - s.free > maxTray) maxTray = 3 - s.free;
  }

  return {
    levels: g.cleared,
    score: g.score,
    taps: g.taps,
    matches: g.completions,
    theta: g.skill.theta,
    meanSingles: g.taps === 0 ? 0 : singlesSum / g.taps,
    maxTray,
    breaches,
    terminated,
    totalMs,
  };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const RUNS = 300;
console.log(`SCREWDOM engine bench - ${RUNS} runs per player\n`);
console.log(
  ['player', 'levels', 'p10', 'p90', 'score', 'taps', 'matches', 'singles', 'maxTray', 'theta', 'ms/tap']
    .map((h) => h.padStart(8))
    .join(''),
);

let breaches = 0;
let immortal = 0;
const endedByKind: Record<string, number> = {};
const theta: Record<string, number> = {};
const levels: Record<string, number> = {};

for (const kind of KINDS) {
  const runs = Array.from({ length: RUNS }, (_, i) => playOne(kind, 1000 + i * 7919));
  breaches += runs.reduce((a, r) => a + r.breaches, 0);
  immortal += runs.filter((r) => !r.terminated).length;
  endedByKind[kind] = runs.filter((r) => r.terminated).length;
  theta[kind] = mean(runs.map((r) => r.theta));
  levels[kind] = mean(runs.map((r) => r.levels));
  const lv = runs.map((r) => r.levels);

  console.log(
    [
      kind,
      levels[kind].toFixed(2),
      pct(lv, 0.1).toFixed(0),
      pct(lv, 0.9).toFixed(0),
      mean(runs.map((r) => r.score)).toFixed(0),
      mean(runs.map((r) => r.taps)).toFixed(0),
      mean(runs.map((r) => r.matches)).toFixed(1),
      mean(runs.map((r) => r.meanSingles)).toFixed(2),
      mean(runs.map((r) => r.maxTray)).toFixed(1),
      theta[kind].toFixed(3),
      (mean(runs.map((r) => r.totalMs)) / Math.max(1, mean(runs.map((r) => r.taps)))).toFixed(3),
    ]
      .map((c) => String(c).padStart(8))
      .join(''),
  );
}

const thetaOrdered = theta.novice < theta.casual && theta.casual < theta.expert;
const skillPays = levels.novice < levels.expert;

console.log('');
console.log(breaches === 0 ? 'OK    completability invariant held on every tap' : `FAIL  invariant breached ${breaches}x`);
// The game is level-based and endless by design, so a strong player running
// long is the intended outcome, not a bug. What must not happen is a *weak*
// player surviving forever — that would mean the tray never bites.
// A lucky casual run can outlast the step cap, which is a cap artefact rather
// than a design failure, so the bar is "novices always lose, casuals nearly
// always" instead of an exact count.
const weakEnded = endedByKind.novice === RUNS && endedByKind.casual >= RUNS * 0.9;
console.log(
  weakEnded
    ? `OK    weak play loses (novice ${endedByKind.novice}/${RUNS}, casual ${endedByKind.casual}/${RUNS}); only strong play runs long`
    : `FAIL  weak players did not lose (novice ${endedByKind.novice}/${RUNS}, casual ${endedByKind.casual}/${RUNS})`,
);
console.log(`      expert reached ${levels.expert.toFixed(1)} levels on average (cap ${STEP_CAP} taps, ${immortal} runs hit it)`);
console.log(
  `${skillPays ? 'OK  ' : 'FAIL'}  skill pays: novice ${levels.novice.toFixed(2)} levels < expert ${levels.expert.toFixed(2)}`,
);
console.log(
  `${thetaOrdered ? 'OK  ' : 'FAIL'}  theta ranks players: ` +
    KINDS.map((k) => `${k}=${theta[k].toFixed(3)}`).join(' < '),
);
void HOLDER_CAPACITY;

if (breaches !== 0 || !weakEnded || !thetaOrdered || !skillPays) process.exitCode = 1;
