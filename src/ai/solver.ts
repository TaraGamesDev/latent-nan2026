/**
 * Position analysis.
 *
 * Three jobs, all of which the rest of the AI leans on:
 *   1. score a position, so we can rank the player's tap against the best tap
 *      available (the regret signal the skill estimator consumes),
 *   2. prove how much scoring is guaranteed to be reachable from a position
 *      (the survivability floor the director must never breach),
 *   3. explain itself well enough that the panel can draw the reasoning.
 */

import {
  CELLS,
  type Dir,
  type Grid,
  type Move,
  applyMove,
  arrowCount,
  cloneGrid,
  computeMove,
  distanceToEdge,
  gridKey,
  legalMoves,
  SIZE,
} from '../core/grid';

export interface PositionStats {
  arrows: number;
  /** Taps that would change something. */
  mobility: number;
  /** Arrows that would score right now. */
  immediateExits: number;
  /** Arrows wedged so tightly they cannot move at all. */
  jammed: number;
  /** Mean remaining distance to each arrow's target edge, normalised to 0..1. */
  avgEdgeDistance: number;
  /** Rows and columns that are completely empty - the lanes that keep a board alive. */
  openLanes: number;
}

export function stats(g: Grid): PositionStats {
  let arrows = 0;
  let mobility = 0;
  let immediateExits = 0;
  let jammed = 0;
  let edgeSum = 0;

  for (let i = 0; i < CELLS; i++) {
    const d = g[i];
    if (d === 0) continue;
    arrows++;
    edgeSum += distanceToEdge(i, d as Dir);
    const m = computeMove(g, i);
    if (m.jammed) jammed++;
    else {
      mobility++;
      if (m.exits) immediateExits++;
    }
  }

  let openLanes = 0;
  for (let y = 0; y < SIZE; y++) {
    let empty = true;
    for (let x = 0; x < SIZE; x++) {
      if (g[y * SIZE + x] !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) openLanes++;
  }
  for (let x = 0; x < SIZE; x++) {
    let empty = true;
    for (let y = 0; y < SIZE; y++) {
      if (g[y * SIZE + x] !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) openLanes++;
  }

  return {
    arrows,
    mobility,
    immediateExits,
    jammed,
    avgEdgeDistance: arrows === 0 ? 0 : edgeSum / arrows / (SIZE - 1),
    openLanes,
  };
}

/**
 * Player-facing value of a position: higher is a healthier board.
 *
 * Weights were set by hand against the intuition that a board is in trouble
 * long before it deadlocks - what actually kills a run is losing mobility - and
 * then checked against bot self-play in `src/tools/tune.ts`.
 */
export function evaluate(g: Grid): number {
  const s = stats(g);
  if (s.arrows === 0) return 100;
  return (
    6.0 * s.immediateExits +
    2.2 * s.mobility -
    5.0 * s.jammed -
    1.4 * s.arrows +
    1.8 * s.openLanes -
    3.0 * s.avgEdgeDistance * s.arrows
  );
}

/**
 * Exits reachable by only ever firing arrows that already have a clear path.
 *
 * Removing an arrow that exits can never block another arrow, so any arrow that
 * can exit now can still exit later. Greedily draining the exits is therefore
 * exactly optimal for this restricted question - no search required, and the
 * answer is a genuine lower bound on what the player can score without having
 * to reposition anything.
 *
 * The director uses this as its guarantee: never hand the player a board whose
 * exit closure is shallower than the promised depth.
 */
export function exitClosure(g: Grid): { count: number; sequence: Move[] } {
  const work = cloneGrid(g);
  const sequence: Move[] = [];
  for (;;) {
    let fired = false;
    for (let i = 0; i < CELLS; i++) {
      if (work[i] === 0) continue;
      const m = computeMove(work, i);
      if (m.exits) {
        applyMove(work, m);
        sequence.push(m);
        fired = true;
      }
    }
    if (!fired) break;
  }
  return { count: sequence.length, sequence };
}

export interface RankedMove {
  move: Move;
  /** Immediate points-worth plus the value of the position it leaves behind. */
  value: number;
  /** Position value after the move, before the reward term. */
  after: number;
}

/**
 * How much a move that scores is worth relative to board health.
 *
 * Tuned upward from 9: at that setting the solver-following bot repositioned
 * often enough to keep breaking its combo and finished *below* a bot that
 * simply always took the exit. If the ranking disagrees with what actually
 * scores, then regret measured against it is not measuring skill.
 */
const EXIT_REWARD = 14.0;

/** Every legal tap, best first. */
export function rankMoves(g: Grid): RankedMove[] {
  const out: RankedMove[] = [];
  const work = cloneGrid(g);
  for (const move of legalMoves(g)) {
    work.set(g);
    applyMove(work, move);
    const after = evaluate(work);
    out.push({ move, after, value: after + (move.exits ? EXIT_REWARD : 0) });
  }
  out.sort((a, b) => b.value - a.value);
  return out;
}

export function bestMove(g: Grid): RankedMove | null {
  const ranked = rankMoves(g);
  return ranked.length > 0 ? ranked[0] : null;
}

/**
 * Deeper look-ahead that also considers repositioning moves, not just exits.
 *
 * Beam-limited because the branching factor on an open board is large and this
 * runs between two taps. Used for the panel's "best line" readout and by the
 * offline tuner; the survivability guarantee deliberately relies on the exact
 * {@link exitClosure} instead.
 */
export function chainSearch(g: Grid, maxDepth = 4, beam = 6): { exits: number; line: Move[] } {
  interface Node {
    grid: Grid;
    exits: number;
    line: Move[];
    score: number;
  }
  let frontier: Node[] = [{ grid: cloneGrid(g), exits: 0, line: [], score: evaluate(g) }];
  let best: Node = frontier[0];
  const seen = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: Node[] = [];
    for (const node of frontier) {
      for (const rm of rankMoves(node.grid).slice(0, beam)) {
        const grid = cloneGrid(node.grid);
        applyMove(grid, rm.move);
        const key = gridKey(grid);
        if (seen.has(key)) continue;
        seen.add(key);
        const child: Node = {
          grid,
          exits: node.exits + (rm.move.exits ? 1 : 0),
          line: [...node.line, rm.move],
          score: rm.value,
        };
        next.push(child);
        if (
          child.exits > best.exits ||
          (child.exits === best.exits && child.score > best.score)
        ) {
          best = child;
        }
      }
    }
    if (next.length === 0) break;
    next.sort((a, b) => b.exits - a.exits || b.score - a.score);
    frontier = next.slice(0, beam * 2);
  }
  return { exits: best.exits, line: best.line };
}

/**
 * Fraction of short random continuations that end with the board unable to move.
 *
 * Cheap Monte-Carlo rather than exhaustive proof: the director only needs a
 * gradient to steer by, and it re-evaluates every single tap.
 */
export function deadlockRisk(g: Grid, plies = 3, samples = 12): number {
  if (arrowCount(g) === 0) return 0;
  let dead = 0;
  const work = cloneGrid(g);
  for (let s = 0; s < samples; s++) {
    work.set(g);
    let stuck = false;
    for (let p = 0; p < plies; p++) {
      const moves = legalMoves(work);
      if (moves.length === 0) {
        stuck = true;
        break;
      }
      // Weighted toward plausible-but-imperfect play, which is what a real
      // player produces and therefore what the risk estimate should reflect.
      const pick = moves[(Math.random() * moves.length) | 0];
      applyMove(work, pick);
    }
    if (stuck) dead++;
  }
  return dead / samples;
}
