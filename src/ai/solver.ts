/**
 * Position analysis.
 *
 * Two jobs. It scores a board so the player's tap can be ranked against the
 * best tap available from the identical position — that comparison is the
 * regret signal the skill estimator runs on — and it gives the assigner a way
 * to score the board each candidate face would produce.
 *
 * Everything here avoids cloning the board. A take only changes the tray and
 * can only free the tiles directly underneath it, so the resulting position is
 * computed analytically. That keeps a full ranking under a tenth of a
 * millisecond, which is what lets the assigner run on every reveal.
 */

import {
  type Board,
  type Face,
  MATCH,
  TRAY_SLOTS,
  type Tile,
  UNDECIDED,
  faceCounts,
  isFree,
} from '../core/tiles';

export interface PositionStats {
  /** Slots left before the tray ends the run. */
  headroom: number;
  /** Tray faces sitting alone. Each holds a slot hostage. */
  singles: number;
  /** Tray faces with two of three. One tile away from clearing. */
  pairs: number;
  /** Tiles the player could tap right now. */
  choices: number;
  /** Tiles still on the pile. */
  remaining: number;
}

export function statsOf(b: Board): PositionStats {
  let singles = 0;
  let pairs = 0;
  for (const v of faceCounts(b.tray).values()) {
    if (v === 1) singles++;
    else if (v === MATCH - 1) pairs++;
  }
  let choices = 0;
  let remaining = 0;
  for (const t of b.tiles) {
    if (t.taken) continue;
    remaining++;
    if (isFree(b, t)) choices++;
  }
  return { headroom: TRAY_SLOTS - b.tray.length, singles, pairs, choices, remaining };
}

/**
 * How healthy a board is for the player.
 *
 * Headroom dominates because the tray is the only thing that ends a run, and
 * singles are penalised harder than tray length alone would suggest: a tray of
 * three pairs is one tile from clearing three times over, while a tray of three
 * singles is three tiles from clearing anything.
 */
export function evaluate(s: PositionStats): number {
  return (
    7.0 * s.headroom -
    4.5 * s.singles +
    2.0 * s.pairs +
    0.5 * Math.min(s.choices, 12) -
    0.08 * s.remaining
  );
}

/** The tray after taking `face`, and whether that completed a set. */
function trayAfter(tray: readonly Face[], face: Face): { tray: Face[]; matched: boolean } {
  const next = [...tray, face];
  const counts = faceCounts(next);
  if ((counts.get(face) ?? 0) >= MATCH) {
    let removed = 0;
    for (let i = next.length - 1; i >= 0 && removed < MATCH; i--) {
      if (next[i] === face) {
        next.splice(i, 1);
        removed++;
      }
    }
    return { tray: next, matched: true };
  }
  return { tray: next, matched: false };
}

export interface RankedTake {
  tile: Tile;
  /** Board value left behind, plus the reward for clearing. */
  value: number;
  matched: boolean;
  /** Tiles this take would set free. */
  opens: number;
}

const MATCH_REWARD = 9;

/**
 * Every tap available, best first.
 *
 * Computed without cloning: the tray change is local, and the only tiles whose
 * freedom can change are the ones directly beneath the tile being taken.
 */
export function rankTakes(b: Board): RankedTake[] {
  const out: RankedTake[] = [];
  const base = statsOf(b);

  for (const tile of b.tiles) {
    if (tile.face === UNDECIDED || tile.taken || !isFree(b, tile)) continue;

    const { tray, matched } = trayAfter(b.tray, tile.face);

    let singles = 0;
    let pairs = 0;
    for (const v of faceCounts(tray).values()) {
      if (v === 1) singles++;
      else if (v === MATCH - 1) pairs++;
    }

    // Only tiles resting under this one can become free.
    let opens = 0;
    for (const id of tile.unlocks) {
      const under = b.tiles[id];
      if (under.taken) continue;
      if (under.above.every((a) => a === tile.id || b.tiles[a].taken)) opens++;
    }

    const after: PositionStats = {
      headroom: TRAY_SLOTS - tray.length,
      singles,
      pairs,
      choices: base.choices - 1 + opens,
      remaining: base.remaining - 1,
    };

    out.push({
      tile,
      matched,
      opens,
      value: evaluate(after) + (matched ? MATCH_REWARD : 0),
    });
  }

  out.sort((p, q) => q.value - p.value);
  return out;
}

export function bestTake(b: Board): RankedTake | null {
  const r = rankTakes(b);
  return r.length > 0 ? r[0] : null;
}

/**
 * How hard the position reads, 0 (comfortable) to 1 (about to die).
 *
 * The number the director steers by, and the one drawn on the flow-channel
 * graph as "realised difficulty".
 */
export function challengeOf(b: Board): number {
  const s = statsOf(b);
  const fromRoom = 1 - s.headroom / TRAY_SLOTS;
  const fromSingles = Math.min(1, s.singles / 4);
  const fromChoice = 1 - Math.min(1, s.choices / 10);
  const v = 0.42 * fromRoom + 0.4 * fromSingles + 0.18 * fromChoice;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
