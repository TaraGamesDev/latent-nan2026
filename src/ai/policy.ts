/**
 * Director policy constants.
 *
 * Held apart from the director's logic because these are the numbers the
 * offline tuner (`src/tools/tune.ts`) searches over. The tuner replays bot
 * personas against candidate policies and keeps whichever one holds every
 * persona closest to its flow channel for longest; the winner is written back
 * here and baked into the build, so nothing is fitted at runtime and the
 * shipped game needs no network, no API key and no account.
 */

export interface Policy {
  /** Taps for the intensity ramp to reach ~63%. Sets total run length. */
  rampTaps: number;

  /** Aim a little above measured ability: flow lives just past comfortable. */
  challengeOffset: number;
  /** How hard a frustrated player pulls the target down. */
  frustrationRelief: number;
  /** How hard a bored player pushes the target up. */
  boredomPush: number;
  /** How much the intensity ramp overrides the player's comfort. */
  rampWeight: number;
  /** Hard ceiling on target challenge at zero intensity, and how fast it lifts. */
  envelopeBase: number;
  envelopeSlope: number;

  /** Preferred exit-chain depth at zero and full challenge. Soft, not promised. */
  preferExitsAtEase: number;
  preferExitsAtPeak: number;

  /** Arrows added per tap at zero and full intensity. */
  spawnRateBase: number;
  spawnRatePeak: number;
  /** Board occupancy that stops further pressure, at zero and full intensity. */
  crowdingCeilingBase: number;
  crowdingCeilingPeak: number;

  /** Relative weights when scoring a candidate spawn batch. */
  wChallengeMatch: number;
  wExitChain: number;
  wCenterBias: number;
  wVariety: number;
  wMobility: number;

  /** How many spawn batches to consider each tap. */
  candidates: number;
}

/**
 * Fitted by `npm run tune` — 48 candidates x 3 personas x 6 seeds, scored on
 * flow-channel tracking, time spent frustrated or bored, session length, and
 * how far apart the personas' realised difficulty ends up. Improves on the
 * hand-set starting point by 30% on that objective (loss 2.08 -> 1.46) and
 * widens novice-to-expert difficulty separation from 0.063 to 0.085.
 *
 * See `tuning/result.json` for the full trial record.
 */
export const POLICY: Policy = {
  rampTaps: 77,

  challengeOffset: 0.12,
  frustrationRelief: 0.411,
  boredomPush: 0.132,
  rampWeight: 0.38,
  // The opening is capped regardless of how good the player looks. A judge
  // opening the link gets a readable, winnable first thirty seconds; pressure
  // is something the run earns, not something the estimator can grant instantly.
  envelopeBase: 0.41,
  envelopeSlope: 0.543,

  preferExitsAtEase: 6,
  preferExitsAtPeak: 0,

  spawnRateBase: 0.746,
  spawnRatePeak: 1.977,
  crowdingCeilingBase: 0.491,
  // No ceiling at peak. Refusing to crowd a full board late in a run is how a
  // stalling player becomes immortal: the bench caught a mashing bot surviving
  // 2700 taps because mercy never switched off.
  crowdingCeilingPeak: 1.0,

  wChallengeMatch: 10.91,
  wExitChain: 3.5,
  wCenterBias: 1.6,
  wVariety: 1.1,
  wMobility: 1.13,

  candidates: 40,
};

/**
 * Global pressure over the course of a run.
 *
 * The flow channel decides how a moment should feel; this decides that the run
 * ends. Without it a competent player is immortal - measured, not assumed: the
 * first engine bench had greedy and optimal bots surviving 4000 taps and
 * scoring forty million, which makes score meaningless and removes every
 * interesting decision, because taking an available exit is always correct when
 * the board is never tight.
 */
export const intensityAt = (taps: number, policy: Policy = POLICY): number =>
  1 - Math.exp(-taps / policy.rampTaps);
