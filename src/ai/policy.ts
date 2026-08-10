/**
 * Assigner policy constants.
 *
 * Held apart from the logic because these are the numbers the offline tuner
 * (`src/tools/tune.ts`) searches over. The tuner replays bot personas against
 * candidate policies and keeps whichever holds every persona closest to its
 * flow channel; the winner is baked in here, so nothing is fitted at runtime
 * and the shipped game needs no network, no API key and no account.
 */

export interface Policy {
  /** Aim a little above measured ability: flow lives just past comfortable. */
  challengeOffset: number;
  /** How hard a struggling player pulls the target down. */
  frustrationRelief: number;
  /** How hard a coasting player pushes it up. */
  boredomPush: number;
  /** How much a level's own progress ramp overrides the player's comfort. */
  rampWeight: number;
  /** Ceiling on target challenge at the start of a level, and how fast it lifts. */
  envelopeBase: number;
  envelopeSlope: number;
  /** How much a strong player raises that ceiling from the first tile. */
  envelopeLift: number;

  /** How strongly a dangerous tray overrides the difficulty target. */
  dangerOverride: number;
  /** Baseline willingness to hand out relief, before danger and target apply. */
  reliefBias: number;

  /** Headroom at or below which relief is forced outright. */
  gateHard: number;
  gateSoft: number;

  /** How many faces may be in play at once. More faces means more singles. */
  facePoolBase: number;
  facePoolPeak: number;
}

export const POLICY: Policy = {
  challengeOffset: 0.07,
  frustrationRelief: 0.4,
  boredomPush: 0.22,
  rampWeight: 0.45,
  envelopeBase: 0.42,
  envelopeSlope: 0.42,
  envelopeLift: 0.34,

  dangerOverride: 1.15,
  reliefBias: 0.55,

  gateHard: 1,
  gateSoft: 2,

  facePoolBase: 4,
  facePoolPeak: 7,
};

/**
 * A level's own pressure curve.
 *
 * Unlike a survival game a level here is finite, so the ramp is simply how far
 * through the pile the player has got. Levels build toward a climax instead of
 * running flat, and it resets when the next one starts.
 */
export const rampOf = (cleared: number, total: number): number =>
  total === 0 ? 0 : Math.min(1, cleared / total);
