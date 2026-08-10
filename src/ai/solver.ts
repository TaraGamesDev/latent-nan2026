/**
 * Position analysis.
 *
 * Two jobs. It scores a board so the player's tap can be ranked against the
 * best tap available from the identical position — that comparison is the
 * regret signal the skill estimator runs on — and it gives the assigner a way
 * to judge the board each candidate colour would produce.
 *
 * Nothing here clones the board. Turning a screw only touches the holders and
 * can only free the screws under the plate it was holding, so the resulting
 * position is computed analytically. A full ranking stays well under a tenth of
 * a millisecond, which is what lets the assigner run on every reveal.
 */

import {
  type Board,
  type Colour,
  HOLDER_CAPACITY,
  HOLDERS,
  type Screw,
  UNDECIDED,
  holderFor,
  isReachable,
} from '../core/plates';

export interface PositionStats {
  /** Holders standing empty. The only thing between the player and the end. */
  free: number;
  /** Holders carrying a single screw — each holds a slot until two more arrive. */
  lonely: number;
  /** Holders one screw from completing. */
  ready: number;
  /** Screws the player could turn right now. */
  choices: number;
  /** Screws still on the wall. */
  remaining: number;
}

export function statsOf(b: Board): PositionStats {
  let free = 0;
  let lonely = 0;
  let ready = 0;
  for (const h of b.holders) {
    if (h.colour === UNDECIDED) free++;
    else if (h.count === 1) lonely++;
    else if (h.count === HOLDER_CAPACITY - 1) ready++;
  }
  let choices = 0;
  let remaining = 0;
  for (const s of b.screws) {
    if (s.removed) continue;
    remaining++;
    if (s.colour !== UNDECIDED && isReachable(b, s)) choices++;
  }
  return { free, lonely, ready, choices, remaining };
}

/**
 * How healthy a board is for the player.
 *
 * Free holders dominate because running out of them is the only way to lose,
 * and lonely holders are penalised harder than occupancy alone would suggest: a
 * holder with two in it is one screw from giving a slot back, while a holder
 * with one is two screws away.
 */
export function evaluate(s: PositionStats): number {
  return (
    9.0 * s.free -
    5.0 * s.lonely +
    3.0 * s.ready +
    0.5 * Math.min(s.choices, 12) -
    0.06 * s.remaining
  );
}

/** Reward for a screw that drops its plate: new screws, and a fresh assignment. */
const DROP_REWARD = 3.5;
/** Per screw of support a committed holder still has on the wall. */
const SUPPORT_REWARD = 3.0;
/** Per screw of support a committed holder is missing. */
const ORPHAN_PENALTY = 4.5;

export interface RankedTurn {
  screw: Screw;
  /** Board value left behind, plus the reward for completing a holder. */
  value: number;
  completes: boolean;
  /** Whether this opens a holder that was standing empty. */
  opensHolder: boolean;
  /** Plates this would drop, exposing more of the wall. */
  drops: number;
}

const COMPLETE_REWARD = 10;

/** Every screw the player could turn, best first. */
export function rankTurns(b: Board): RankedTurn[] {
  const out: RankedTurn[] = [];
  const base = statsOf(b);

  for (const screw of b.screws) {
    if (screw.removed || screw.colour === UNDECIDED || !isReachable(b, screw)) continue;

    const idx = holderFor(b, screw.colour);
    if (idx === -1) continue; // Would end the run; never the best play.

    const target = b.holders[idx];
    const wasEmpty = target.colour === UNDECIDED;
    const after = target.count + 1;
    const completes = after >= HOLDER_CAPACITY;

    let free = base.free;
    let lonely = base.lonely;
    let ready = base.ready;
    if (wasEmpty) {
      free--;
      lonely++;
    } else if (target.count === 1) {
      lonely--;
      if (HOLDER_CAPACITY === 3) ready++;
    } else if (target.count === HOLDER_CAPACITY - 1) {
      ready--;
    }
    if (completes) free++;

    // Only the plate this screw was holding can drop, and only if it was the
    // last one in it.
    let drops = 0;
    let opened = 0;
    const plate = b.plates[screw.plate];
    if (plate.screws.every((id) => id === screw.id || b.screws[id].removed)) {
      drops = 1;
      // Anything directly beneath that plate becomes reachable.
      for (const s2 of b.screws) {
        if (s2.removed || s2.id === screw.id) continue;
        const own = b.plates[s2.plate];
        if (own.fallen || own.layer >= plate.layer) continue;
        if (
          s2.x >= plate.x &&
          s2.x <= plate.x + plate.w &&
          s2.y >= plate.y &&
          s2.y <= plate.y + plate.h
        ) {
          opened++;
        }
      }
    }

    /*
     * Can this holder actually be finished?
     *
     * This is the decision the game is really about, and leaving it out was a
     * measurable mistake: with only board-shape terms, following this ranking
     * scored *worse* than choosing at random, because it happily committed a
     * holder to a colour with nothing left on the wall to finish it. A holder at
     * two screws with no third in sight is not progress, it is a slot gone for
     * the rest of the wall.
     */
    let support = 0;
    for (const o of b.screws) {
      if (o.removed || o.id === screw.id || o.colour !== screw.colour) continue;
      if (isReachable(b, o)) support++;
    }
    const needed = completes ? 0 : HOLDER_CAPACITY - after;
    const covered = Math.min(support, needed);

    const value =
      evaluate({
        free,
        lonely,
        ready,
        choices: base.choices - 1 + opened,
        remaining: base.remaining - 1,
      }) +
      (completes ? COMPLETE_REWARD : 0) +
      SUPPORT_REWARD * covered -
      ORPHAN_PENALTY * (needed - covered) +
      DROP_REWARD * drops;

    out.push({ screw, value, completes, opensHolder: wasEmpty, drops });
  }

  out.sort((p, q) => q.value - p.value);
  return out;
}

export function bestTurn(b: Board): RankedTurn | null {
  const r = rankTurns(b);
  return r.length > 0 ? r[0] : null;
}

/**
 * How hard the position reads, 0 (comfortable) to 1 (about to end).
 *
 * The number the assigner steers by, and the one drawn on the flow-channel
 * graph as "realised difficulty".
 */
export function challengeOf(b: Board): number {
  const s = statsOf(b);
  const fromRoom = 1 - s.free / HOLDERS;
  const fromLonely = Math.min(1, s.lonely / HOLDERS);
  const fromChoice = 1 - Math.min(1, s.choices / 8);
  const v = 0.44 * fromRoom + 0.38 * fromLonely + 0.18 * fromChoice;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export type { Colour };
