/**
 * Per-tap skill estimation.
 *
 * The signal that makes this project work: every single tap is graded against
 * what the solver would have done from the identical position. That is a dense,
 * position-controlled measurement - unlike "did the player clear the level",
 * which arrives once every few minutes and is confounded by how hard the level
 * happened to be.
 *
 *   regret = value(solver's best tap) - value(the tap the player made)
 *
 * normalised by the spread of options that were actually on offer, so a
 * position where every tap is equally good contributes no evidence either way.
 */

import type { Grid } from '../core/grid';
import { rankMoves } from './solver';

export interface SkillState {
  /** Overall ability, 0..1. What the director steers against. */
  theta: number;
  /** Picks moves that leave a healthy board, not just moves that score now. */
  foresight: number;
  /** Converts taps into exits. */
  efficiency: number;
  /** Decides quickly. */
  tempo: number;

  samples: number;
  regretEwma: number;
  jamEwma: number;
  exitEwma: number;
  latencyEwma: number;
}

export interface TapObservation {
  /** 0 = matched the solver, 1 = worst available tap. */
  regret: number;
  /** How much better the best option was than the median - low means the
   *  position carried little information about skill. */
  informativeness: number;
  exited: boolean;
  jammed: boolean;
  latencyMs: number;
}

export const createSkillState = (): SkillState => ({
  theta: 0.5,
  foresight: 0.5,
  efficiency: 0.5,
  tempo: 0.5,
  samples: 0,
  regretEwma: 0.35,
  jamEwma: 0.05,
  exitEwma: 0.35,
  latencyEwma: 1400,
});

/** Grade a tap against the position it was made from. */
export function observeTap(
  gridBefore: Grid,
  chosenFrom: number,
  latencyMs: number,
): TapObservation | null {
  const ranked = rankMoves(gridBefore);
  if (ranked.length === 0) return null;

  const chosen = ranked.find((r) => r.move.from === chosenFrom);
  if (!chosen) {
    // The tap did not correspond to a legal move: the player tried to fire a
    // wedged arrow. That is the strongest single piece of negative evidence.
    return { regret: 1, informativeness: 1, exited: false, jammed: true, latencyMs };
  }

  const best = ranked[0].value;
  const worst = ranked[ranked.length - 1].value;
  const spread = best - worst;
  const median = ranked[(ranked.length / 2) | 0].value;

  // A position where everything is equivalent should not move the estimate.
  const informativeness = spread < 1e-6 ? 0 : Math.min(1, spread / 12);
  const regret = spread < 1e-6 ? 0 : Math.min(1, Math.max(0, (best - chosen.value) / spread));

  return {
    regret,
    informativeness: informativeness * (best - median > 0.5 ? 1 : 0.4),
    exited: chosen.move.exits,
    jammed: false,
    latencyMs,
  };
}

/** Taps of evidence needed before the estimate is trusted as much as the prior. */
const PRIOR_WEIGHT = 10;

const mix = (prev: number, next: number, alpha: number): number =>
  prev + (next - prev) * alpha;

export function updateSkill(s: SkillState, obs: TapObservation): SkillState {
  const samples = s.samples + 1;
  // Fast early, stable later: the first dozen taps should move the estimate a
  // long way, because the whole point is to be right about a stranger quickly.
  const base = Math.max(0.05, 1 / (samples + 2));
  const alpha = base * (0.35 + 0.65 * obs.informativeness);

  const regretEwma = mix(s.regretEwma, obs.regret, alpha);
  const jamEwma = mix(s.jamEwma, obs.jammed ? 1 : 0, Math.max(0.08, base));
  const exitEwma = mix(s.exitEwma, obs.exited ? 1 : 0, Math.max(0.08, base));
  const latencyEwma = mix(s.latencyEwma, Math.min(obs.latencyMs, 8000), Math.max(0.1, base));

  const foresight = clamp01(1 - regretEwma);
  const efficiency = clamp01(exitEwma * 1.5 - jamEwma * 1.2);
  // 600ms reads as fluent, 4s as deliberating.
  const tempo = clamp01(1 - (latencyEwma - 600) / 3400);

  // Foresight dominates on purpose. Tempo is kept small because it measures
  // how fast someone taps, not how well they play: an early weighting of 0.15
  // was enough to rank a greedy bot above an optimal one that thought longer.
  const raw = 0.62 * foresight + 0.30 * efficiency + 0.08 * tempo;

  // Shrink toward the population prior until there is enough evidence to leave
  // it. Without this, one good opening tap drove theta to 0.78 and the director
  // opened at maximum pressure - competent runs were dying inside eight taps.
  const confidence = samples / (samples + PRIOR_WEIGHT);
  const theta = clamp01(0.5 + (raw - 0.5) * confidence);

  return { theta, foresight, efficiency, tempo, samples, regretEwma, jamEwma, exitEwma, latencyEwma };
}

/**
 * Short-horizon affect, separate from long-horizon ability.
 *
 * Skill moves slowly and should; how the last handful of taps went moves fast
 * and is what the director reacts to when it decides to relieve or apply
 * pressure. Keeping them apart is what stops the system from mistaking a bad
 * thirty seconds for a bad player.
 */
export interface MoodState {
  /** 0..1, rises on jams and dry spells. */
  frustration: number;
  /** 0..1, rises when the player is cruising with near-zero regret. */
  boredom: number;
}

export const createMoodState = (): MoodState => ({ frustration: 0, boredom: 0 });

export function updateMood(m: MoodState, obs: TapObservation, s: SkillState): MoodState {
  const badBeat = obs.jammed ? 1 : obs.exited ? 0 : 0.45;
  const frustration = clamp01(mix(m.frustration, badBeat, obs.jammed ? 0.5 : 0.18));

  // Cruising: consistently near-optimal play with steady scoring.
  const cruising = s.regretEwma < 0.18 && s.exitEwma > 0.55 ? 1 : 0;
  const boredom = clamp01(mix(m.boredom, cruising, 0.12));

  return { frustration, boredom };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export { clamp01 };
