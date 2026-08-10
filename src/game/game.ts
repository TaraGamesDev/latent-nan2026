/**
 * Run orchestration: one tap in, one fully-resolved turn out.
 *
 * Pure with respect to rendering, so the same `tap()` drives the browser build
 * and the headless playtest bots — the numbers in the write-up come from the
 * code a judge is playing, not a simulation that resembles it.
 */

import {
  type Board,
  type Face,
  MATCH,
  TRAY_SLOTS,
  type Tile,
  cloneBoard,
  createBoard,
  isCleared,
  isFree,
  remaining,
  take,
} from '../core/tiles';
import { makeRng, randomSeed, type Rng } from '../core/rng';
import {
  type Ledger,
  type RevealDecision,
  createLedger,
  dangerOf,
  revealAll,
} from '../ai/assigner';
import { challengeOf } from '../ai/solver';
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
}

export interface GameState {
  board: Board;
  ledger: Ledger;
  seed: number;
  rng: Rng;

  level: number;
  score: number;
  combo: number;
  taps: number;
  matches: number;
  /** Levels finished this run. */
  cleared: number;
  over: boolean;
  won: boolean;

  skill: SkillState;
  mood: MoodState;
  /** Decisions made on the most recent reveal batch. */
  lastReveals: RevealDecision[];
  /** The most recent decision that actually happened. A tap that uncovers
   *  nothing produces an empty batch, and the panel should still have the last
   *  real one to show rather than falling back to its empty state. */
  lastDecision: RevealDecision | null;
  /** Every decision this level, for the panel's counters. */
  revealCount: number;
  history: HistoryPoint[];

  readyAt: number;
}

export interface TapResult {
  kind: 'ignored' | 'take' | 'match';
  tile?: Tile;
  matched: Face | null;
  points: number;
  reveals: RevealDecision[];
  levelCleared: boolean;
  gameOver: boolean;
}

/** Levels grow a little as the run goes on. */
function boardFor(level: number): Board {
  const cols = Math.min(7, 5 + Math.floor(level / 3));
  const rows = Math.min(6, 4 + Math.floor(level / 4));
  const layers = Math.min(5, 3 + Math.floor(level / 2));
  return createBoard(cols, rows, layers);
}

export function createGame(seed: number = randomSeed(), now = Date.now()): GameState {
  const rng = makeRng(seed);
  const state: GameState = {
    board: boardFor(1),
    ledger: createLedger(),
    seed,
    rng,
    level: 1,
    score: 0,
    combo: 0,
    taps: 0,
    matches: 0,
    cleared: 0,
    over: false,
    won: false,
    skill: createSkillState(),
    mood: createMoodState(),
    lastReveals: [],
    lastDecision: null,
    revealCount: 0,
    history: [],
    readyAt: now,
  };
  state.lastReveals = revealAll(state.board, state.ledger, state.skill, state.mood, rng);
  state.lastDecision = state.lastReveals.at(-1) ?? null;
  state.revealCount = state.lastReveals.length;
  return state;
}

/** Start the next level, carrying the player model across. */
function advance(s: GameState): void {
  s.level++;
  s.cleared++;
  s.board = boardFor(s.level);
  s.ledger = createLedger();
  s.lastReveals = revealAll(s.board, s.ledger, s.skill, s.mood, s.rng);
  s.lastDecision = s.lastReveals.at(-1) ?? s.lastDecision;
  s.revealCount = s.lastReveals.length;
}

/**
 * Resolve a tap on a tile.
 *
 * Order matters: the position is graded *before* the tile moves, because regret
 * is only meaningful against the alternatives that existed at the moment of the
 * decision.
 */
export function tap(s: GameState, tileId: number, now = Date.now()): TapResult {
  const tile = s.board.tiles[tileId];
  if (s.over || !tile || tile.taken || tile.face < 0 || !isFree(s.board, tile)) {
    return {
      kind: 'ignored',
      matched: null,
      points: 0,
      reveals: [],
      levelCleared: false,
      gameOver: false,
    };
  }

  const before = cloneBoard(s.board);
  const obs = observeTap(before, tileId, Math.max(0, now - s.readyAt));

  s.taps++;
  const result = take(s.board, tile);

  let points = 0;
  let kind: TapResult['kind'] = 'take';
  if (result.matched !== null) {
    kind = 'match';
    s.matches++;
    s.combo++;
    // Clearing while the tray is tight is worth more: it is the harder play and
    // the one the game is trying to teach.
    const pressure = 1 + (TRAY_SLOTS - s.board.tray.length - MATCH) * 0.12;
    points = Math.round(30 * Math.max(0.6, pressure) * (1 + s.combo * 0.15));
    s.score += points;
  } else {
    s.combo = 0;
  }

  if (obs) {
    s.skill = updateSkill(s.skill, obs);
    s.mood = updateMood(s.mood, obs, s.skill);
  }

  // Anything the tap uncovered gets written now, in light of where the player
  // just landed.
  const reveals = revealAll(s.board, s.ledger, s.skill, s.mood, s.rng);
  s.lastReveals = reveals;
  if (reveals.length > 0) s.lastDecision = reveals[reveals.length - 1];
  s.revealCount += reveals.length;

  s.history.push({
    tap: s.taps,
    theta: s.skill.theta,
    target: reveals.at(-1)?.target ?? s.history.at(-1)?.target ?? 0.4,
    challenge: challengeOf(s.board),
  });
  if (s.history.length > 400) s.history.shift();

  const levelCleared = isCleared(s.board);
  if (levelCleared) {
    s.score += 200 + s.level * 50;
    advance(s);
  }

  const gameOver = !levelCleared && result.overflow;
  if (gameOver) s.over = true;
  s.readyAt = now;

  return { kind, tile, matched: result.matched, points, reveals, levelCleared, gameOver };
}

/** How close the tray is to ending the run, for the HUD. */
export const dangerOfGame = (s: GameState): number => dangerOf(s.board);
export const tilesLeft = (s: GameState): number => remaining(s.board);
export { challengeOf };
