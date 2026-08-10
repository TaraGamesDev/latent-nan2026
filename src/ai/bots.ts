/**
 * Scripted player personas.
 *
 * Shared by the engine bench and the offline tuner so both measure the same
 * players. They stand in for the cohort the game has not met yet: an assigner
 * that adapts to individuals has a cold-start problem, and bots are how the
 * policy gets fitted before a single human has played.
 *
 * Written to be plausible humans, not extremes.
 */

import type { Board } from '../core/tiles';
import type { Rng } from '../core/rng';
import { rankTakes } from './solver';

export type PersonaName = 'novice' | 'casual' | 'expert';

export interface Persona {
  name: PersonaName;
  /** Probability of tapping without weighing anything. */
  impulsive: number;
  /** Probability of grabbing a tile that clears immediately, when one exists. */
  greed: number;
  /** How far into the solver's ranking they reliably see. 0 = blind. */
  insight: number;
  /** Typical deliberation, milliseconds. Feeds the tempo channel. */
  thinkMs: number;
}

export const PERSONAS: Record<PersonaName, Persona> = {
  novice: { name: 'novice', impulsive: 0.4, greed: 0.9, insight: 0.1, thinkMs: 900 },
  casual: { name: 'casual', impulsive: 0.12, greed: 0.75, insight: 0.5, thinkMs: 1600 },
  expert: { name: 'expert', impulsive: 0.01, greed: 0.5, insight: 0.95, thinkMs: 2600 },
};

/** Which tile this persona taps, or null when nothing is available. */
export function chooseTap(b: Board, p: Persona, rng: Rng): number | null {
  const ranked = rankTakes(b);
  if (ranked.length === 0) return null;

  if (rng() < p.impulsive) return rng.pick(ranked).tile.id;

  const clearing = ranked.filter((r) => r.matched);
  if (clearing.length > 0 && rng() < p.greed) {
    // Wanting to clear is not the same as knowing which clear is best, so
    // insight applies here too.
    const window = Math.max(1, Math.round(clearing.length * (1 - p.insight)));
    return clearing[rng.int(window)].tile.id;
  }

  const window = Math.max(1, Math.round(ranked.length * (1 - p.insight)));
  return ranked[rng.int(window)].tile.id;
}

export const thinkTime = (p: Persona, rng: Rng): number =>
  Math.round(p.thinkMs * (0.6 + 0.8 * rng()));
