/**
 * The AI director.
 *
 * Runs once per tap. It never places an arrow itself - it decides *what the
 * next moment should feel like* and emits that as constraints. A separate
 * generator then samples concrete spawn batches and the solver checks which of
 * them actually satisfy those constraints. Intent and construction stay apart
 * on purpose: the part that judges the player is allowed to be soft and
 * heuristic, and the part that touches the board is not allowed to be wrong.
 *
 * Exactly one promise is made, and it is enforced on every candidate:
 *
 *     after the director spawns, at least one legal move exists.
 *
 * That is deliberately modest. An earlier version promised a guaranteed exit
 * chain of up to four moves; the engine bench showed that is not always
 * constructible from one or two spawns, so it was demoted to a preference the
 * generator optimises toward. What is left is small, provable, and the thing
 * that actually matters: the player can always still act. They can be beaten by
 * their own choices, never by ours.
 */

import {
  CELLS,
  DIRS,
  DIR_NAME,
  type Dir,
  type Grid,
  SIZE,
  cloneGrid,
  emptyCells,
  idx,
  legalMoves,
  xOf,
  yOf,
} from '../core/grid';
import type { Rng } from '../core/rng';
import { POLICY, type Policy, intensityAt } from './policy';
import { exitClosure, stats } from './solver';
import { clamp01, type MoodState, type SkillState } from './skill';

export interface Constraints {
  /** Where in the flow channel we are aiming this moment, 0..1. */
  targetChallenge: number;
  /** Global pressure ramp for this point in the run, 0..1. */
  intensity: number;
  /** Exit-chain depth we would like to leave available. A preference. */
  preferredExits: number;
  /** Fractional arrows-per-tap the policy asked for. */
  spawnRate: number;
  /** Arrows actually being added this tap. */
  spawnBudget: number;
  /** Preference for the crowded middle over the forgiving edges, 0..1. */
  centerBias: number;
  /** Preference for direction diversity, 0..1. */
  variety: number;
  /** Plain-language reason, surfaced in the panel. */
  rationale: string;
  tags: string[];
}

export interface SpawnPlacement {
  cell: number;
  dir: Dir;
}

export interface SpawnCandidate {
  placements: SpawnPlacement[];
  /** Realised challenge of the board this batch would produce, 0..1. */
  challenge: number;
  /** Exit chain provably available afterwards. */
  closure: number;
  /** Legal taps afterwards. Must be at least 1 to be eligible. */
  mobility: number;
  score: number;
}

export interface SpawnDecision {
  constraints: Constraints;
  chosen: SpawnCandidate | null;
  /** Best few candidates, so the panel can show the road not taken. */
  considered: SpawnCandidate[];
  evaluated: number;
  /** Candidates thrown out for leaving the player unable to move. */
  rejectedForMobility: number;
  /** True when the batch had to be shrunk to keep the player alive. */
  reducedBudget: boolean;
  /** The invariant: a legal move exists after this spawn. */
  playable: boolean;
  /** The board filled up: an arrow was due and there was nowhere to put it. */
  overflow: boolean;
}

/**
 * Ability plus mood plus ramp becomes a target point in the flow channel.
 *
 * Ability moves slowly and sets the baseline; mood moves fast and displaces it;
 * the ramp drags everything upward as the run goes on. Keeping ability and mood
 * separate is what stops the system from mistaking a bad thirty seconds for a
 * bad player, which is the failure mode naive difficulty adjustment falls into.
 */
export function decideConstraints(
  skill: SkillState,
  mood: MoodState,
  grid: Grid,
  taps: number,
  rng: Rng,
  policy: Policy = POLICY,
): Constraints {
  const s = stats(grid);
  const crowding = s.arrows / CELLS;
  const intensity = intensityAt(taps, policy);

  const comfort = clamp01(
    skill.theta +
      policy.challengeOffset -
      policy.frustrationRelief * mood.frustration +
      policy.boredomPush * mood.boredom,
  );
  // Late in a run the ramp pulls the target toward the ceiling regardless of
  // how comfortable the player is. This is what makes the run finite.
  const ramped = clamp01(comfort + (1 - comfort) * policy.rampWeight * intensity);
  // ...but never past the envelope, so the opening stays gentle even for a
  // player the estimator is provisionally impressed by.
  const envelope = policy.envelopeBase + policy.envelopeSlope * intensity;
  const target = Math.min(ramped, envelope);

  const preferredExits = Math.max(
    0,
    Math.round(policy.preferExitsAtEase + (policy.preferExitsAtPeak - policy.preferExitsAtEase) * target),
  );

  const ceiling =
    policy.crowdingCeilingBase +
    (policy.crowdingCeilingPeak - policy.crowdingCeilingBase) * intensity;

  let rate = policy.spawnRateBase + (policy.spawnRatePeak - policy.spawnRateBase) * intensity;
  // Mercy is an early-run privilege. Scaling relief by the remaining headroom
  // means a struggling player gets real help at the start and none at the end,
  // which is what keeps the ramp in charge of when the run finishes.
  rate -= 0.5 * mood.frustration * (1 - intensity);
  rate += 0.3 * mood.boredom;
  if (crowding > ceiling) rate = 0;
  rate = Math.max(0, rate);

  // Stochastic rounding so pressure climbs smoothly instead of stepping from
  // one arrow per tap to two on a single tap boundary.
  const floor = Math.floor(rate);
  let spawnBudget = floor + (rng() < rate - floor ? 1 : 0);
  // An empty board has nothing to tap, so it always gets at least one arrow.
  if (s.arrows === 0) spawnBudget = Math.max(1, spawnBudget);
  spawnBudget = Math.min(spawnBudget, 3, emptyCells(grid).length);

  const tags: string[] = [];
  if (mood.frustration > 0.55) tags.push('구제');
  if (mood.boredom > 0.5) tags.push('가속');
  if (crowding > ceiling) tags.push('과밀');
  if (intensity > 0.8) tags.push('종반');
  if (target > 0.75) tags.push('압박');
  if (target < 0.35) tags.push('완화');
  if (s.jammed > 0) tags.push(`잼${s.jammed}`);

  return {
    targetChallenge: target,
    intensity,
    preferredExits,
    spawnRate: rate,
    spawnBudget,
    centerBias: target,
    variety: clamp01(0.35 + 0.5 * target),
    rationale: explain(skill, mood, target, intensity, spawnBudget, preferredExits, crowding, ceiling),
    tags,
  };
}

function explain(
  skill: SkillState,
  mood: MoodState,
  target: number,
  intensity: number,
  spawnBudget: number,
  preferredExits: number,
  crowding: number,
  ceiling: number,
): string {
  const pct = (v: number): string => `${(v * 100) | 0}%`;
  const parts: string[] = [`숙련도 ${pct(skill.theta)} · 압력 ${pct(intensity)} → 목표 ${pct(target)}`];

  if (mood.frustration > 0.55) parts.push(`막힘 감지(${pct(mood.frustration)}) — 난이도를 내리고 탈출로를 엽니다`);
  else if (mood.boredom > 0.5) parts.push(`여유 감지(${pct(mood.boredom)}) — 조여 봅니다`);
  else if (target > 0.75) parts.push('여력이 보여 중앙을 막습니다');
  else if (target < 0.35) parts.push('안정될 때까지 가장자리로 흘립니다');
  else parts.push('현재 흐름을 유지합니다');

  if (crowding > ceiling) parts.push('보드 과밀 — 스폰 중단');
  parts.push(`스폰 ${spawnBudget}개 · 탈출로 ${preferredExits}수 선호`);
  return parts.join(' · ');
}

/**
 * Search concrete spawn batches for one that satisfies the constraints.
 *
 * Candidates are sampled rather than enumerated - the space is
 * (empty cells choose budget) x 4^budget, far too large to walk on every tap -
 * but the playability invariant is checked exactly on every candidate that
 * survives, so sampling costs quality, never correctness. If no batch at the
 * requested size can keep the board playable, the budget is reduced rather than
 * the invariant broken.
 */
export function planSpawn(
  grid: Grid,
  constraints: Constraints,
  rng: Rng,
  policy: Policy = POLICY,
): SpawnDecision {
  const empties = emptyCells(grid);
  let rejectedForMobility = 0;
  let evaluated = 0;

  // Overflow. An arrow was due and the board is full - the conventional and
  // most legible way for a puzzle of this shape to end. Without it a full board
  // is survivable forever: arrows on the border facing outwards still exit, so
  // a mashing bot held 49/49 with four legal moves for three thousand taps.
  if (empties.length === 0 && constraints.spawnRate > 0) {
    return {
      constraints,
      chosen: null,
      considered: [],
      evaluated: 0,
      rejectedForMobility: 0,
      reducedBudget: false,
      playable: false,
      overflow: true,
    };
  }

  for (let budget = Math.min(constraints.spawnBudget, empties.length); budget >= 0; budget--) {
    const scored: SpawnCandidate[] = [];
    const seen = new Set<string>();
    const work = cloneGrid(grid);

    const tries = budget === 0 ? 1 : policy.candidates;
    for (let n = 0; n < tries; n++) {
      const placements = budget === 0 ? [] : samplePlacements(empties, budget, rng);
      const key = placements.map((p) => `${p.cell}:${p.dir}`).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      evaluated++;

      work.set(grid);
      for (const p of placements) work[p.cell] = p.dir;

      // The invariant. Everything else about this candidate is negotiable.
      const mobility = legalMoves(work).length;
      if (mobility < 1) {
        rejectedForMobility++;
        continue;
      }

      const closure = exitClosure(work).count;
      const challenge = challengeOf(work);
      const score = scoreCandidate(work, placements, challenge, closure, constraints, policy);
      scored.push({ placements, challenge, closure, mobility, score });
    }

    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      return {
        constraints,
        chosen: scored[0],
        considered: scored.slice(0, 4),
        evaluated,
        rejectedForMobility,
        reducedBudget: budget < constraints.spawnBudget,
        playable: true,
        overflow: false,
      };
    }
  }

  // Even spawning nothing leaves no legal move: the player has genuinely run
  // the board into a wall. That is a loss, and it is theirs, not the director's.
  return {
    constraints,
    chosen: null,
    considered: [],
    evaluated,
    rejectedForMobility,
    reducedBudget: true,
    playable: false,
    overflow: false,
  };
}

function samplePlacements(empties: number[], budget: number, rng: Rng): SpawnPlacement[] {
  const out: SpawnPlacement[] = [];
  const used = new Set<number>();
  const n = Math.min(budget, empties.length);
  let guard = 0;
  while (out.length < n && guard++ < 64) {
    const cell = rng.pick(empties);
    if (used.has(cell)) continue;
    used.add(cell);
    out.push({ cell, dir: rng.pick(DIRS) });
  }
  return out;
}

/** How hard the position reads, 0 (trivial) to 1 (about to die). */
export function challengeOf(g: Grid): number {
  const s = stats(g);
  if (s.arrows === 0) return 0;
  const closureNorm = Math.min(1, exitClosure(g).count / 5);
  const mobilityNorm = s.mobility / s.arrows;
  const crowding = s.arrows / CELLS;
  return clamp01(0.4 * (1 - closureNorm) + 0.3 * (1 - mobilityNorm) + 0.3 * crowding);
}

function scoreCandidate(
  after: Grid,
  placements: SpawnPlacement[],
  challenge: number,
  closure: number,
  c: Constraints,
  policy: Policy,
): number {
  const s = stats(after);

  // Dominant term: land the moment where the flow channel wants it.
  let score = -policy.wChallengeMatch * Math.abs(challenge - c.targetChallenge);

  // Leaving a scoring line available is what "ease off" cashes out as. At peak
  // pressure preferredExits is 0 and this term simply switches itself off.
  if (c.preferredExits > 0) {
    score += policy.wExitChain * (Math.min(closure, c.preferredExits) / c.preferredExits);
  }

  // Crowding the middle is the cheapest honest way to raise difficulty; easing
  // means letting arrows sit near the edge they are already pointing at.
  const centrality =
    placements.length === 0
      ? 0.5
      : placements.reduce((acc, p) => acc + 1 - edgeProximity(p.cell), 0) / placements.length;
  score += policy.wCenterBias * (c.centerBias * centrality + (1 - c.centerBias) * (1 - centrality));

  const dirs = new Set(placements.map((p) => p.dir));
  score += policy.wVariety * c.variety * (dirs.size / Math.max(1, placements.length));

  // Never trade away the player's ability to act, whatever the target says.
  score += policy.wMobility * (s.arrows === 0 ? 1 : s.mobility / s.arrows);

  return score;
}

/** 1 at the border, 0 at the centre. */
function edgeProximity(cell: number): number {
  const mid = (SIZE - 1) / 2;
  const d = Math.max(Math.abs(xOf(cell) - mid), Math.abs(yOf(cell) - mid));
  return d / mid;
}

/** Opening position: a handful of arrows, guaranteed to be playable. */
export function seedGrid(rng: Rng, count = 6): Grid {
  const g = new Uint8Array(CELLS) as Grid;
  const cells = rng.shuffle(Array.from({ length: CELLS }, (_, i) => i));
  for (let k = 0; k < Math.min(count, cells.length); k++) g[cells[k]] = rng.pick(DIRS);
  // Never open on a dead board.
  if (legalMoves(g).length === 0) g[idx(0, 0)] = DIRS[3];
  return g;
}

export { DIR_NAME };
