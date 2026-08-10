/**
 * Assigner policy constants.
 *
 * Held apart from the logic because these are the numbers an offline tuner
 * searches over. The winner is baked in here, so nothing is fitted at runtime
 * and the shipped game needs no network, no API key and no account.
 */

export interface Policy {
  /** Aim a little above measured ability: flow lives just past comfortable. */
  challengeOffset: number;
  /** How hard a struggling player pulls the target down. */
  frustrationRelief: number;
  /** How hard a coasting player pushes it up. */
  boredomPush: number;
  /** How much the wall's own progress ramp overrides the player's comfort. */
  rampWeight: number;
  /** Ceiling on target challenge at the start of a wall, and how fast it lifts. */
  envelopeBase: number;
  envelopeSlope: number;
  /** How much a strong player raises that ceiling from the first screw. */
  envelopeLift: number;
  /**
   * How far the target is held down while the player is still unmeasured.
   * At zero observations the target is scaled by this; it relaxes to 1 as
   * evidence accumulates.
   */
  coldStartEase: number;

  /** How strongly dangerous holders override the difficulty target. */
  dangerOverride: number;
  /** Baseline willingness to hand out relief, before danger and target apply. */
  reliefBias: number;
  /**
   * How much of the relief decision the skill estimate is allowed to own.
   *
   * At 1 the band is so wide it inverts the leaderboard: a beginner is helped so
   * much more than an expert that the beginner survives longer, and skill stops
   * paying. Difficulty adaptation is supposed to narrow the spread of outcomes,
   * not reverse their order.
   */
  reliefSkillWeight: number;

  /**
   * Free holders at or below which the assigner leans on a safe colour.
   *
   * Deliberately *not* a function of the skill estimate. An earlier version
   * relaxed this gate once the target passed a threshold, which turned skill
   * into a cliff: an expert crossed it, lost the safety net in one step, and
   * ended up clearing fewer walls than a beginner. Adaptation belongs in the
   * smooth relief term, never in a step function.
   */
  gateSoft: number;

  /** How many colours may be live at once. More colours means more lonely holders. */
  paletteBase: number;
  palettePeak: number;
}

export const POLICY: Policy = {
  challengeOffset: 0.04,
  frustrationRelief: 0.4,
  boredomPush: 0.22,
  rampWeight: 0.45,
  envelopeBase: 0.42,
  envelopeSlope: 0.42,
  envelopeLift: 0.05,
  coldStartEase: 0.58,

  dangerOverride: 0.82,
  reliefBias: 0.4,
  reliefSkillWeight: 0.12,

  gateSoft: 1,

  // Four live colours against three holders is the smallest palette that can
  // actually strand a player; at three, every colour always has a home and the
  // run never ends. It is also where a measured skill margin exists — past five
  // colours the one-ply ranking starts losing to random play, because
  // committing a holder well needs lookahead this solver does not do.
  paletteBase: 4,
  palettePeak: 4,
};

/**
 * A wall's own pressure curve.
 *
 * A wall is finite, so the ramp is simply how far through it the player has
 * got. Walls build toward a climax instead of running flat, and it resets when
 * the next one starts.
 */
export const rampOf = (removed: number, total: number): number =>
  total === 0 ? 0 : Math.min(1, removed / total);
