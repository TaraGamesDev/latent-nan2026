/**
 * Run orchestration: one tap in, one fully-resolved turn out.
 *
 * Deliberately pure with respect to rendering. The same `tap()` drives the
 * browser build and the headless playtest bots, so the difficulty numbers in
 * the write-up come from the exact code a judge is playing rather than from a
 * simulation that merely resembles it.
 *
 * There is one way to lose: the board reaches a state with no legal move. Jams
 * do not cost a life. They cost a turn - and because the director spawns on
 * jammed taps too, a wasted tap is nearly free on an open board and expensive
 * on a crowded one, which is exactly how much it should hurt in each case.
 */

import {
  type Grid,
  type Move,
  applyMove,
  cloneGrid,
  computeMove,
  isDeadlocked,
} from '../core/grid';
import { makeRng, randomSeed, type Rng } from '../core/rng';
import {
  type SpawnDecision,
  challengeOf,
  decideConstraints,
  planSpawn,
  seedGrid,
} from '../ai/director';
import { intensityAt } from '../ai/policy';
import {
  type MoodState,
  type SkillState,
  createMoodState,
  createSkillState,
  observeTap,
  updateMood,
  updateSkill,
} from '../ai/skill';

export interface HistoryPoint {
  tap: number;
  theta: number;
  target: number;
  challenge: number;
  intensity: number;
}

export interface GameState {
  grid: Grid;
  seed: number;
  rng: Rng;

  score: number;
  combo: number;
  bestCombo: number;
  taps: number;
  exits: number;
  jams: number;
  over: boolean;

  skill: SkillState;
  mood: MoodState;
  lastDecision: SpawnDecision | null;
  history: HistoryPoint[];

  /** When the board last became ready for input, for the latency signal. */
  readyAt: number;
}

export interface TapResult {
  kind: 'ignored' | 'jam' | 'move' | 'exit';
  move?: Move;
  points: number;
  decision: SpawnDecision | null;
  /** Cells the director just filled, so the view can animate them in. */
  spawned: number[];
  gameOver: boolean;
}

export function createGame(seed: number = randomSeed(), now = Date.now()): GameState {
  const rng = makeRng(seed);
  return {
    grid: seedGrid(rng),
    seed,
    rng,
    score: 0,
    combo: 0,
    bestCombo: 0,
    taps: 0,
    exits: 0,
    jams: 0,
    over: false,
    skill: createSkillState(),
    mood: createMoodState(),
    lastDecision: null,
    history: [],
    readyAt: now,
  };
}

/**
 * Resolve a tap on `cell`.
 *
 * Order matters: the position is graded *before* the move is applied, because
 * regret is only meaningful against the alternatives that existed at the moment
 * of the decision.
 */
export function tap(s: GameState, cell: number, now = Date.now()): TapResult {
  if (s.over || s.grid[cell] === 0) {
    return { kind: 'ignored', points: 0, decision: null, spawned: [], gameOver: false };
  }

  const before = cloneGrid(s.grid);
  const move = computeMove(s.grid, cell);
  const obs = observeTap(before, cell, Math.max(0, now - s.readyAt));

  s.taps++;

  let points = 0;
  let kind: TapResult['kind'];

  if (move.jammed) {
    kind = 'jam';
    s.jams++;
    s.combo = 0;
  } else {
    applyMove(s.grid, move);
    if (move.exits) {
      kind = 'exit';
      points = 10 + 2 * move.distance + 5 * s.combo;
      s.score += points;
      s.exits++;
      s.combo++;
      if (s.combo > s.bestCombo) s.bestCombo = s.combo;
    } else {
      kind = 'move';
      // Repositioning is legitimate and often necessary, so it costs momentum
      // rather than destroying it. Jams are what wipe the streak.
      s.combo = Math.max(0, s.combo - 1);
    }
  }

  if (obs) {
    s.skill = updateSkill(s.skill, obs);
    s.mood = updateMood(s.mood, obs, s.skill);
  }

  // The director takes its turn on every tap, including the ones that went badly.
  const constraints = decideConstraints(s.skill, s.mood, s.grid, s.taps, s.rng);
  const decision = planSpawn(s.grid, constraints, s.rng);
  const spawned: number[] = [];
  if (decision.chosen) {
    for (const p of decision.chosen.placements) {
      s.grid[p.cell] = p.dir;
      spawned.push(p.cell);
    }
  }
  s.lastDecision = decision;

  s.history.push({
    tap: s.taps,
    theta: s.skill.theta,
    target: constraints.targetChallenge,
    challenge: challengeOf(s.grid),
    intensity: constraints.intensity,
  });
  if (s.history.length > 400) s.history.shift();

  const gameOver = !decision.playable || isDeadlocked(s.grid);
  if (gameOver) s.over = true;
  s.readyAt = now;

  return { kind, move, points, decision, spawned, gameOver };
}

/** Current global pressure, for the HUD. */
export const intensityOf = (s: GameState): number => intensityAt(s.taps);

/** Grid state a bot or replay can inspect without mutating the run. */
export const snapshot = (s: GameState): Grid => cloneGrid(s.grid);
