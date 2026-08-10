/**
 * The assigner — this project's AI.
 *
 * It runs once for every screw that becomes reachable, and decides what colour
 * that screw is. Not which screw to expose: *what the screw is*. A covered
 * screw has never been observed, so nothing is being hidden or swapped — the
 * level is being written one screw at a time, in front of the player, out of
 * their own situation.
 *
 * Two things are kept strictly apart:
 *
 *   intent       — a soft, heuristic read of the player, allowed to be wrong,
 *                  which produces a target difficulty
 *   construction — a hard check that the colour about to be committed still
 *                  leaves the wall clearable, which is not allowed to be wrong
 *
 * The invariant is the whole cost argument. Every colour ever assigned must end
 * up in a multiple of three, or the leftovers can never complete a holder.
 * Enforcing that at assignment time makes a finished level winnable *by
 * construction* — there is no solvability check to run afterwards, and that
 * check is precisely what makes hand-authored levels expensive.
 */

import {
  type Board,
  type Colour,
  HOLDERS,
  HOLDER_CAPACITY,
  type Screw,
  UNDECIDED,
  holderFor,
  isReachable,
} from '../core/plates';
import type { Rng } from '../core/rng';
import { POLICY, type Policy, rampOf } from './policy';
import { challengeOf, statsOf } from './solver';
import { clamp01, type MoodState, type SkillState } from './skill';

/** What a candidate colour would do for the player's holders. */
export type Relief = 'complete' | 'pair' | 'echo' | 'fresh';

const RELIEF_VALUE: Record<Relief, number> = {
  complete: 1,
  pair: 0.66,
  echo: 0.33,
  fresh: 0,
};

export const RELIEF_LABEL: Record<Relief, string> = {
  complete: '홀더 완성',
  pair: '홀더 채우기',
  echo: '벽과 같은 색',
  fresh: '새 색 (홀더 하나 소모)',
};

export interface Candidate {
  colour: Colour;
  relief: Relief;
  /** Screws that must still be assigned to close every open colour, after this. */
  debtAfter: number;
  /** True when the clearability invariant survives this choice. */
  feasible: boolean;
  /** True when this colour would put more colours in front of the player than
   *  the holders can hold. Yields to `feasible`. */
  crowds: boolean;
  score: number;
}

export interface RevealDecision {
  screwId: number;
  colour: Colour;
  relief: Relief;
  /** Where in the flow channel the assigner aimed, 0..1. */
  target: number;
  /** How far through the wall the player is, 0..1. */
  ramp: number;
  /** How close the holders are to ending the run, 0..1. */
  danger: number;
  /** Probability of choosing relief that the above produced. */
  reliefChance: number;
  candidates: Candidate[];
  rejected: number;
  rationale: string;
  tags: string[];
}

/**
 * Running ledger of every colour ever committed.
 *
 * Kept separately from the board because screws leave it — a completed holder
 * is gone, but it still counts toward that colour's total.
 */
export interface Ledger {
  assigned: Map<Colour, number>;
  nextColour: Colour;
}

export const createLedger = (): Ledger => ({ assigned: new Map(), nextColour: 0 });

/** Screws that must still be assigned to bring every colour to a multiple of three. */
export function debtOf(ledger: Ledger): number {
  let debt = 0;
  for (const n of ledger.assigned.values()) {
    debt += (HOLDER_CAPACITY - (n % HOLDER_CAPACITY)) % HOLDER_CAPACITY;
  }
  return debt;
}

/**
 * How close the holders are to ending the run.
 *
 * Not simply how many are occupied. Two holders each carrying two screws is
 * comfortable — either one completes on the next matching screw. Two holders
 * each carrying one is nearly fatal, because both are two screws away and only
 * one slot is left.
 */
export function dangerOf(b: Board): number {
  const s = statsOf(b);
  const fromRoom = Math.max(0, (2 - s.free) / 2);
  const fromLonely = s.lonely / HOLDERS;
  return clamp01(Math.max(fromRoom, fromLonely));
}

/**
 * Decide the colour for one newly reachable screw.
 *
 * Mutates `ledger`. The board is read but not written — the caller commits the
 * colour, so the decision record can be shown before anything changes.
 */
export function decideColour(
  b: Board,
  screw: Screw,
  ledger: Ledger,
  skill: SkillState,
  mood: MoodState,
  rng: Rng,
  policy: Policy = POLICY,
): RevealDecision {
  const total = b.screws.length;
  const removed = b.screws.filter((s) => s.removed).length;
  const ramp = rampOf(removed, total);

  const comfort = clamp01(
    skill.theta +
      policy.challengeOffset -
      policy.frustrationRelief * mood.frustration +
      policy.boredomPush * mood.boredom,
  );
  const ramped = clamp01(comfort + (1 - comfort) * policy.rampWeight * ramp);
  const envelope =
    policy.envelopeBase + policy.envelopeLift * skill.theta + policy.envelopeSlope * ramp;
  // Until there is evidence, assume nothing and go easy. Theta sits at the 0.5
  // prior before any observation, and "average" is far too hard for someone
  // still reading the rules.
  const confidence = skill.samples / (skill.samples + 12);
  const coldStart = policy.coldStartEase + (1 - policy.coldStartEase) * confidence;
  const target = Math.min(ramped, envelope) * coldStart;

  const danger = dangerOf(b);

  // Colours already on the wall: matching one of these lets the player line up
  // a set without a holder standing idle in the meantime.
  const onWall = new Set<Colour>();
  for (const s of b.screws) {
    if (s.id !== screw.id && !s.removed && s.colour !== UNDECIDED && isReachable(b, s)) {
      onWall.add(s.colour);
    }
  }

  const options: { colour: Colour; relief: Relief }[] = [];
  for (const h of b.holders) {
    if (h.colour === UNDECIDED) continue;
    options.push({
      colour: h.colour,
      relief: h.count >= HOLDER_CAPACITY - 1 ? 'complete' : 'pair',
    });
  }
  const holderColours = new Set(b.holders.map((h) => h.colour));
  for (const c of onWall) {
    if (!holderColours.has(c)) options.push({ colour: c, relief: 'echo' });
  }

  const palette = Math.round(
    policy.paletteBase + (policy.palettePeak - policy.paletteBase) * target,
  );
  const liveColours = new Set([...holderColours, ...onWall]);
  liveColours.delete(UNDECIDED);
  if (liveColours.size < palette) options.push({ colour: ledger.nextColour, relief: 'fresh' });
  if (options.length === 0) options.push({ colour: ledger.nextColour, relief: 'fresh' });

  const baseDebt = debtOf(ledger);
  const undecidedAfter = b.undecided - 1;

  /*
   * Second construction constraint: never put more distinct colours in front of
   * the player at once than there are holders.
   *
   * Four reachable screws in four colours against three holders is not hard, it
   * is impossible — whichever three the player commits to, the fourth has
   * nowhere to go and its plate can never come off. A run ended in three taps
   * this way, which is not a difficulty setting, it is a broken position. Like
   * the completability inequality, this is checked rather than aimed for.
   */
  const liveOnWall = new Set<Colour>();
  let liveCount = 1; // this screw
  for (const o of b.screws) {
    if (o.id !== screw.id && !o.removed && o.colour !== UNDECIDED && isReachable(b, o)) {
      liveOnWall.add(o.colour);
      liveCount++;
    }
  }
  // Room to breathe once there are duplicates to build triples from; strict when
  // the board is down to a handful of screws, which is where a colour with no
  // home is fatal rather than merely awkward.
  const maxSpread = liveCount <= HOLDERS + 1 ? HOLDERS : HOLDERS + 1;

  const candidates: Candidate[] = options.map((o) => {
    const n = ledger.assigned.get(o.colour) ?? 0;
    // Opening a group adds two to the debt; continuing one removes one.
    const delta = n % HOLDER_CAPACITY === 0 ? HOLDER_CAPACITY - 1 : -1;
    const debtAfter = baseDebt + delta;
    const spread = liveOnWall.has(o.colour) ? liveOnWall.size : liveOnWall.size + 1;
    return {
      colour: o.colour,
      relief: o.relief,
      debtAfter,
      feasible: undecidedAfter >= debtAfter,
      crowds: spread > maxSpread,
      score: 0,
    };
  });

  /*
   * How willing the assigner is to hand out an easy colour.
   *
   * Danger and target are *multiplied*, not added. Added, they saturate: with no
   * free holders `danger` pins to 1 and relief becomes certain no matter who is
   * playing, which is what made the run unloseable. Multiplied, danger sets how
   * much help is on the table and the target decides how much of it the player
   * has earned — so a beginner in trouble is rescued and an expert in the same
   * position is left in it.
   */
  const reliefChance = clamp01(
    (danger * policy.dangerOverride + policy.reliefBias) * (1 - policy.reliefSkillWeight * target),
  );

  /*
   * The two constraints are not equals, and treating them as equals broke the
   * one that matters — with a single combined filter, a turn where nothing
   * satisfied both fell through to a candidate that violated completability,
   * three hundred times in a bench run. Completability is the promise; the
   * colour-spread cap is a construction rule that yields to it.
   */
  const feasible = candidates.filter((c) => c.feasible);
  const clearable = feasible.length > 0 ? feasible : candidates;
  const roomy = clearable.filter((c) => !c.crowds);
  const pool = roomy.length > 0 ? roomy : clearable;
  for (const c of pool) c.score = 1 - Math.abs(RELIEF_VALUE[c.relief] - reliefChance);

  const complete = pool.filter((c) => c.relief === 'complete');
  const pair = pool.filter((c) => c.relief === 'pair');
  const soft = pool.filter((c) => c.relief === 'echo' || c.relief === 'fresh');

  const stats = statsOf(b);
  const tags: string[] = [];
  let picked: Candidate;

  // Hard gates. With one holder left and nothing that completes, a fresh colour
  // is a death sentence handed out by the game rather than earned by the player.
  /*
   * The survival floor.
   *
   * The only promise worth making is that the player always has *a* move at the
   * moment the assigner writes. That is much weaker than "you will not lose",
   * and deliberately so: a wall that is clearable is not a wall this particular
   * player will clear. If nothing else on the board is playable right now, this
   * screw has to be playable; otherwise the assigner would be handing out a
   * defeat the player never made a mistake to earn.
   *
   * Everything below it is comfort, and comfort is allowed to run out.
   */
  const othersPlayable = b.screws.some(
    (o) =>
      o.id !== screw.id &&
      !o.removed &&
      o.colour !== UNDECIDED &&
      isReachable(b, o) &&
      holderFor(b, o.colour) !== -1,
  );
  const homed = pool.filter((c) => c.relief === 'complete' || c.relief === 'pair');

  if (!othersPlayable && homed.length > 0) {
    picked = rng.pick(complete.length > 0 ? complete : homed);
    tags.push('생존');
  } else if (stats.free <= policy.gateSoft && (complete.length > 0 || pair.length > 0)) {
    picked = rng.pick(complete.length > 0 ? complete : pair);
    tags.push('완화');
  } else if (rng() < reliefChance) {
    picked = rng.pick(complete.length > 0 ? complete : pair.length > 0 ? pair : soft);
  } else {
    picked = rng.pick(soft.length > 0 ? soft : pair.length > 0 ? pair : complete);
  }

  if (picked.colour === ledger.nextColour) ledger.nextColour++;
  ledger.assigned.set(picked.colour, (ledger.assigned.get(picked.colour) ?? 0) + 1);

  if (danger > 0.6) tags.push('위험');
  if (target > 0.7) tags.push('압박');
  if (ramp > 0.75) tags.push('종반');

  return {
    screwId: screw.id,
    colour: picked.colour,
    relief: picked.relief,
    target,
    ramp,
    danger,
    reliefChance,
    candidates: candidates.sort((p, q) => q.score - p.score).slice(0, 5),
    rejected: candidates.length - feasible.length,
    rationale: explain(skill, mood, target, danger, picked.relief, reliefChance, stats.free),
    tags,
  };
}

function explain(
  skill: SkillState,
  mood: MoodState,
  target: number,
  danger: number,
  relief: Relief,
  reliefChance: number,
  free: number,
): string {
  const pct = (v: number): string => `${(v * 100) | 0}%`;
  const parts = [`숙련도 ${pct(skill.theta)} → 목표 난이도 ${pct(target)}`];

  if (free <= 1) parts.push(`빈 홀더 ${free}칸 — 안전한 색 쪽으로 기웁니다`);
  else if (danger > 0.6) parts.push(`위험 ${pct(danger)} — 숨통을 틔울지 여부는 숙련도가 정합니다`);
  else if (mood.frustration > 0.55) parts.push(`막힘 감지(${pct(mood.frustration)}) — 짝을 맞춰 줍니다`);
  else if (mood.boredom > 0.5) parts.push(`여유 감지(${pct(mood.boredom)}) — 새 색을 섞습니다`);
  else parts.push('현재 흐름을 유지합니다');

  parts.push(`구제 확률 ${pct(reliefChance)} → ${RELIEF_LABEL[relief]}`);
  return parts.join(' · ');
}

/** Assign colours to every screw that just became reachable. */
export function revealAll(
  b: Board,
  ledger: Ledger,
  skill: SkillState,
  mood: MoodState,
  rng: Rng,
  policy: Policy = POLICY,
): RevealDecision[] {
  const out: RevealDecision[] = [];
  for (;;) {
    const next = b.screws.find((s) => s.colour === UNDECIDED && isReachable(b, s));
    if (!next) break;
    const decision = decideColour(b, next, ledger, skill, mood, rng, policy);
    next.colour = decision.colour;
    b.undecided--;
    out.push(decision);
  }
  return out;
}

export { challengeOf };
