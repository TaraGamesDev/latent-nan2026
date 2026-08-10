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

import type { Board } from '../core/plates';
import type { Rng } from '../core/rng';
import { rankTurns } from './solver';

export type PersonaName = 'novice' | 'casual' | 'expert';

export interface Persona {
  name: PersonaName;
  /** Probability of tapping without weighing anything. */
  impulsive: number;
  /**
   * Probability of grabbing a screw that completes a holder, when one exists.
   *
   * Note this is a *virtue* here, not a vice. Completing frees the only resource
   * the game has, so a player who passes it up is usually wrong. Defining the
   * expert by low greed — as a hoarding-punishes-you tray game would — made the
   * expert the worst player in the bench, which took a control run to notice.
   */
  greed: number;
  /** How far into the solver's ranking they reliably see. 0 = blind. */
  insight: number;
  /** Typical deliberation, milliseconds. Feeds the tempo channel. */
  thinkMs: number;
}

export const PERSONAS: Record<PersonaName, Persona> = {
  novice: { name: 'novice', impulsive: 0.45, greed: 0.55, insight: 0.05, thinkMs: 900 },
  casual: { name: 'casual', impulsive: 0.15, greed: 0.8, insight: 0.5, thinkMs: 1600 },
  expert: { name: 'expert', impulsive: 0.01, greed: 0.95, insight: 0.9, thinkMs: 2600 },
};

/** Which screw this persona turns, or null when nothing is reachable. */
export function chooseTap(b: Board, p: Persona, rng: Rng): number | null {
  const ranked = rankTurns(b);
  if (ranked.length === 0) return null;

  if (rng() < p.impulsive) return rng.pick(ranked).screw.id;

  const finishing = ranked.filter((r) => r.completes);
  if (finishing.length > 0 && rng() < p.greed) {
    // Wanting to finish a holder is not the same as knowing which one to
    // finish, so insight applies here too.
    const window = Math.max(1, Math.round(finishing.length * (1 - p.insight)));
    return finishing[rng.int(window)].screw.id;
  }

  const window = Math.max(1, Math.round(ranked.length * (1 - p.insight)));
  return ranked[rng.int(window)].screw.id;
}

export const thinkTime = (p: Persona, rng: Rng): number =>
  Math.round(p.thinkMs * (0.6 + 0.8 * rng()));
