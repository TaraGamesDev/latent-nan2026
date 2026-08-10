/**
 * Per-tap skill estimation.
 *
 * Every tap is graded against what the solver would have played from the
 * identical position:
 *
 *   regret = value(best tap available) − value(the tap taken)
 *
 * normalised by the spread of what was actually on offer, so a position where
 * every tile is equally good contributes no evidence either way.
 *
 * This is a position-controlled measurement, which is what makes it different
 * from the usual difficulty-adjustment signals. "Did they clear the level" or
 * "how long did it take" are confounded by how hard the level happened to be;
 * comparing a choice to the alternatives that existed at the moment it was made
 * is not.
 */

import type { Board } from '../core/plates';
import { rankTurns, statsOf } from './solver';

export interface SkillState {
  /** Overall ability, 0..1. What the assigner steers against. */
  theta: number;
  /** Picks taps that leave a workable tray, not just taps that clear now. */
  foresight: number;
  /** Keeps holders moving rather than hoarding half-filled ones. */
  efficiency: number;
  /** Decides quickly. */
  tempo: number;

  samples: number;
  regretEwma: number;
  lonelyEwma: number;
  latencyEwma: number;
}

export interface TapObservation {
  /** 0 = matched the solver, 1 = the worst tile available. */
  regret: number;
  /** How much the choice mattered. Near zero when everything was equivalent. */
  informativeness: number;
  /** Holders carrying a single screw at the moment of the decision. */
  lonely: number;
  matched: boolean;
  latencyMs: number;
}

export const createSkillState = (): SkillState => ({
  theta: 0.5,
  foresight: 0.5,
  efficiency: 0.5,
  tempo: 0.5,
  samples: 0,
  regretEwma: 0.35,
  lonelyEwma: 1.0,
  latencyEwma: 1400,
});

/** Grade a tap against the position it was made from. */
export function observeTap(before: Board, screwId: number, latencyMs: number): TapObservation | null {
  const ranked = rankTurns(before);
  if (ranked.length === 0) return null;

  const chosen = ranked.find((r) => r.screw.id === screwId);
  if (!chosen) return null;

  const best = ranked[0].value;
  const worst = ranked[ranked.length - 1].value;
  const spread = best - worst;
  const median = ranked[(ranked.length / 2) | 0].value;

  const informativeness = spread < 1e-6 ? 0 : Math.min(1, spread / 16);
  const regret = spread < 1e-6 ? 0 : Math.min(1, Math.max(0, (best - chosen.value) / spread));

  return {
    regret,
    informativeness: informativeness * (best - median > 0.5 ? 1 : 0.4),
    lonely: statsOf(before).lonely,
    matched: chosen.completes,
    latencyMs,
  };
}

const mix = (prev: number, next: number, alpha: number): number => prev + (next - prev) * alpha;

/** Taps of evidence before the estimate is trusted as much as the prior. */
const PRIOR_WEIGHT = 10;

export function updateSkill(s: SkillState, obs: TapObservation): SkillState {
  const samples = s.samples + 1;
  // Fast early, stable later: the point is to be roughly right about a stranger
  // inside the first twenty seconds.
  const base = Math.max(0.05, 1 / (samples + 2));
  const alpha = base * (0.35 + 0.65 * obs.informativeness);

  const regretEwma = mix(s.regretEwma, obs.regret, alpha);
  const lonelyEwma = mix(s.lonelyEwma, obs.lonely, Math.max(0.08, base));
  const latencyEwma = mix(s.latencyEwma, Math.min(obs.latencyMs, 8000), Math.max(0.1, base));

  const foresight = clamp01(1 - regretEwma);
  // Deliberately not "completions per tap": every screw is eventually turned and
  // every third of a colour completes a holder, so that rate lands near a third
  // for everybody. How many half-filled holders a player is willing to carry
  // does separate them.
  const efficiency = clamp01(1 - lonelyEwma / 2.2);
  const tempo = clamp01(1 - (latencyEwma - 600) / 3400);

  // Foresight dominates: it is the only channel derived from a position-
  // controlled comparison, so it is the only one a play style cannot inflate.
  const raw = 0.72 * foresight + 0.2 * efficiency + 0.08 * tempo;

  const confidence = samples / (samples + PRIOR_WEIGHT);
  const theta = clamp01(0.5 + (raw - 0.5) * confidence);

  return { theta, foresight, efficiency, tempo, samples, regretEwma, lonelyEwma, latencyEwma };
}

/**
 * Short-horizon affect, kept separate from long-horizon ability.
 *
 * Skill moves slowly and should. How the last handful of taps went moves fast,
 * and that is what the assigner reacts to when it decides to relieve or press.
 * Keeping them apart stops the system mistaking a bad thirty seconds for a bad
 * player.
 */
export interface MoodState {
  frustration: number;
  boredom: number;
}

export const createMoodState = (): MoodState => ({ frustration: 0, boredom: 0 });

export function updateMood(m: MoodState, obs: TapObservation, s: SkillState): MoodState {
  // A tap that does not clear is normal here, so frustration tracks regret and
  // a clogged tray rather than simply "that did not score".
  const bad = Math.min(1, obs.regret * 0.7 + Math.min(1, obs.lonely / 2) * 0.6);
  const frustration = clamp01(mix(m.frustration, bad, 0.16));

  const cruising = s.regretEwma < 0.2 && s.lonelyEwma < 0.7 ? 1 : 0;
  const boredom = clamp01(mix(m.boredom, cruising, 0.12));

  return { frustration, boredom };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
