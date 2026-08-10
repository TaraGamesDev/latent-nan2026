/**
 * Scripted player personas.
 *
 * Shared by the engine bench and the offline tuner so both measure the same
 * players. These stand in for the cohort the game has not met yet: a director
 * that adapts to individuals has a cold-start problem, and bots are how the
 * policy gets fitted before a single human has played.
 *
 * They are written to be plausible humans, not extremes. An earlier "uniform
 * random" bot spent sixteen hundred taps hammering wedged arrows, which is not
 * a person and produced tuning signal accordingly.
 */

import { CELLS, type Grid, legalMoves } from '../core/grid';
import type { Rng } from '../core/rng';
import { rankMoves } from './solver';

export type PersonaName = 'novice' | 'casual' | 'expert';

export interface Persona {
  name: PersonaName;
  /** Probability of tapping without checking whether the arrow can move. */
  misclick: number;
  /** Probability of taking an available exit rather than thinking. */
  greed: number;
  /** How deep into the solver's ranking they reliably see. 0 = blind. */
  insight: number;
  /** Typical deliberation, milliseconds. Feeds the tempo signal. */
  thinkMs: number;
}

export const PERSONAS: Record<PersonaName, Persona> = {
  novice: { name: 'novice', misclick: 0.22, greed: 0.85, insight: 0.15, thinkMs: 900 },
  casual: { name: 'casual', misclick: 0.06, greed: 0.8, insight: 0.5, thinkMs: 1600 },
  expert: { name: 'expert', misclick: 0.01, greed: 0.55, insight: 0.95, thinkMs: 2600 },
};

/**
 * Choose a cell to tap, or null when the board offers nothing.
 *
 * `insight` interpolates between picking uniformly among legal moves and
 * picking the solver's top choice, by sampling from a prefix of the ranking.
 */
export function chooseTap(g: Grid, p: Persona, rng: Rng): number | null {
  if (rng() < p.misclick) {
    const occupied: number[] = [];
    for (let i = 0; i < CELLS; i++) if (g[i] !== 0) occupied.push(i);
    if (occupied.length > 0) return rng.pick(occupied);
  }

  const moves = legalMoves(g);
  if (moves.length === 0) return null;

  const exits = moves.filter((m) => m.exits);
  if (exits.length > 0 && rng() < p.greed) {
    // Even the greedy instinct is not perfectly informed about which exit.
    return rng.pick(exits).from;
  }

  const ranked = rankMoves(g);
  if (ranked.length === 0) return null;
  // insight 1 -> always the top move; insight 0 -> anywhere in the ranking.
  const window = Math.max(1, Math.round(ranked.length * (1 - p.insight)));
  return ranked[rng.int(window)].move.from;
}

/** Deliberation time for the tempo channel, with a little spread. */
export const thinkTime = (p: Persona, rng: Rng): number =>
  Math.round(p.thinkMs * (0.6 + 0.8 * rng()));
