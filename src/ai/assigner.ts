/**
 * The assigner — this project's AI.
 *
 * It runs once for every tile that becomes visible, and decides what face that
 * tile has. Not which tile to reveal: *what the tile is*. A covered tile has
 * never been observed, so nothing is being hidden or swapped — the level is
 * being written one tile at a time, in front of the player, out of their own
 * situation.
 *
 * Two things are kept strictly apart:
 *
 *   intent      — a soft, heuristic read of the player, which is allowed to be
 *                 wrong, and produces a target difficulty
 *   construction— a hard check that the face about to be committed still leaves
 *                 the pile completable, which is not allowed to be wrong
 *
 * The invariant is the whole cost argument. Every face ever assigned must end
 * up in a multiple of three, or the leftovers can never clear. Enforcing that
 * at assignment time means a finished level is winnable *by construction* —
 * there is no solvability check to run afterwards, and that check is precisely
 * what makes hand-authored levels expensive.
 */

import {
  type Board,
  type Face,
  MATCH,
  TRAY_SLOTS,
  type Tile,
  UNDECIDED,
  faceCounts,
  isFree,
} from '../core/tiles';
import type { Rng } from '../core/rng';
import { POLICY, type Policy, rampOf } from './policy';
import { challengeOf, statsOf } from './solver';
import { clamp01, type MoodState, type SkillState } from './skill';

/** What a candidate face would do for the player's tray. */
export type Relief = 'complete' | 'pair' | 'echo' | 'fresh';

const RELIEF_VALUE: Record<Relief, number> = {
  complete: 1,
  pair: 0.66,
  echo: 0.33,
  fresh: 0,
};

const RELIEF_LABEL: Record<Relief, string> = {
  complete: '즉시 완성',
  pair: '짝 만들기',
  echo: '보드와 짝',
  fresh: '새 무늬',
};

export interface Candidate {
  face: Face;
  relief: Relief;
  /** Tiles that must still be assigned to close every open face, after this. */
  debtAfter: number;
  /** True when the completability invariant survives this choice. */
  feasible: boolean;
  /** How well this matches what the director wanted. Higher is better. */
  score: number;
}

export interface RevealDecision {
  tileId: number;
  face: Face;
  relief: Relief;
  /** Where in the flow channel the director aimed, 0..1. */
  target: number;
  /** The level's own progress ramp, 0..1. */
  ramp: number;
  /** How close the tray is to killing the run, 0..1. */
  danger: number;
  /** Probability of choosing relief that the above produced. */
  reliefChance: number;
  candidates: Candidate[];
  rejected: number;
  /** Plain-language reason, surfaced in the panel. */
  rationale: string;
  tags: string[];
}

/**
 * Running ledger of every face ever committed.
 *
 * Kept separately from the board because tiles leave it — a cleared triple is
 * gone, but it still counts toward that face's total.
 */
export interface Ledger {
  assigned: Map<Face, number>;
  nextFace: Face;
}

export const createLedger = (): Ledger => ({ assigned: new Map(), nextFace: 0 });

/** Tiles that must still be assigned to bring every open face to a multiple of three. */
export function debtOf(ledger: Ledger): number {
  let debt = 0;
  for (const n of ledger.assigned.values()) debt += (MATCH - (n % MATCH)) % MATCH;
  return debt;
}

/**
 * How close the tray is to ending the run.
 *
 * Not tray length. Six tiles that are three pairs is comfortable; four tiles
 * that are four different faces is nearly fatal, because each single holds a
 * slot until two more of it appear.
 */
export function dangerOf(b: Board): number {
  const s = statsOf(b);
  const fromSingles = s.singles / 4;
  const fromRoom = Math.max(0, (4 - s.headroom) / 3);
  return clamp01(Math.max(fromSingles, fromRoom));
}

/**
 * Decide the face for one newly visible tile.
 *
 * Mutates `ledger`. The board is read but not written — the caller commits the
 * face, so the decision record can be shown before anything changes.
 */
export function decideFace(
  b: Board,
  tile: Tile,
  ledger: Ledger,
  skill: SkillState,
  mood: MoodState,
  rng: Rng,
  policy: Policy = POLICY,
): RevealDecision {
  const total = b.tiles.length;
  const cleared = total - b.tiles.filter((t) => !t.taken).length;
  const ramp = rampOf(cleared, total);

  const comfort = clamp01(
    skill.theta +
      policy.challengeOffset -
      policy.frustrationRelief * mood.frustration +
      policy.boredomPush * mood.boredom,
  );
  const ramped = clamp01(comfort + (1 - comfort) * policy.rampWeight * ramp);
  // The opening of a level is capped however good the player looks, so the first
  // twenty seconds are always readable — but the cap itself rises with the
  // player. Without that term a strong player got a soft restart every level and
  // simply never stopped: the bench had the expert bot clearing 28 of them.
  const envelope =
    policy.envelopeBase + policy.envelopeLift * skill.theta + policy.envelopeSlope * ramp;
  const target = Math.min(ramped, envelope);

  const danger = dangerOf(b);
  const counts = faceCounts(b.tray);

  // Faces sitting on other visible tiles: pairing with one of these lets the
  // player set up a match without spending a tray slot on a lone face.
  const onBoard = new Set<Face>();
  for (const t of b.tiles) {
    if (t.id !== tile.id && !t.taken && t.face !== UNDECIDED && isFree(b, t)) onBoard.add(t.face);
  }

  const facePool = Math.round(
    policy.facePoolBase + (policy.facePoolPeak - policy.facePoolBase) * target,
  );

  const options: { face: Face; relief: Relief }[] = [];
  for (const [face, n] of counts) {
    options.push({ face, relief: n >= MATCH - 1 ? 'complete' : 'pair' });
  }
  for (const face of onBoard) {
    if (!counts.has(face)) options.push({ face, relief: 'echo' });
  }
  // A fresh face is only offered while the pool has room for another one.
  const openFaces = new Set([...counts.keys(), ...onBoard]).size;
  if (openFaces < facePool) options.push({ face: ledger.nextFace, relief: 'fresh' });

  // Nothing to continue and no room for anything new: take the new face anyway
  // rather than leave the tile undecidable.
  if (options.length === 0) options.push({ face: ledger.nextFace, relief: 'fresh' });

  const baseDebt = debtOf(ledger);
  const undecidedAfter = b.undecided - 1;

  const candidates: Candidate[] = options.map((o) => {
    const n = ledger.assigned.get(o.face) ?? 0;
    // Opening a group adds two to the debt; continuing one removes one.
    const delta = n % MATCH === 0 ? MATCH - 1 : -1;
    const debtAfter = baseDebt + delta;
    return {
      face: o.face,
      relief: o.relief,
      debtAfter,
      feasible: undecidedAfter >= debtAfter,
      score: 0,
    };
  });

  // The chance of reaching for relief. Danger overrides the difficulty target:
  // a tray one tile from death gets helped whatever the dial asked for.
  const reliefChance = clamp01(
    danger * policy.dangerOverride + (1 - target) * policy.reliefBias,
  );

  const feasible = candidates.filter((c) => c.feasible);
  const pool = feasible.length > 0 ? feasible : candidates;

  const complete = pool.filter((c) => c.relief === 'complete');
  const pair = pool.filter((c) => c.relief === 'pair');
  const soft = pool.filter((c) => c.relief === 'echo' || c.relief === 'fresh');

  const headroom = TRAY_SLOTS - b.tray.length;
  let picked: Candidate;
  const tags: string[] = [];

  if (headroom <= policy.gateHard && complete.length > 0) {
    picked = rng.pick(complete);
    tags.push('구제');
  } else if (headroom <= policy.gateSoft && (complete.length > 0 || pair.length > 0)) {
    picked = rng.pick(complete.length > 0 ? complete : pair);
    tags.push('완화');
  } else if (rng() < reliefChance) {
    picked = rng.pick(complete.length > 0 ? complete : pair.length > 0 ? pair : soft);
  } else {
    picked = rng.pick(soft.length > 0 ? soft : pair.length > 0 ? pair : complete);
  }

  for (const c of pool) {
    c.score = 1 - Math.abs(RELIEF_VALUE[c.relief] - reliefChance);
  }

  if (picked.face === ledger.nextFace) ledger.nextFace++;
  ledger.assigned.set(picked.face, (ledger.assigned.get(picked.face) ?? 0) + 1);

  if (danger > 0.6) tags.push('위험');
  if (target > 0.7) tags.push('압박');
  if (ramp > 0.75) tags.push('종반');
  if (openFaces >= facePool) tags.push(`무늬${openFaces}`);

  return {
    tileId: tile.id,
    face: picked.face,
    relief: picked.relief,
    target,
    ramp,
    danger,
    reliefChance,
    candidates: candidates.sort((p, q) => q.score - p.score).slice(0, 5),
    rejected: candidates.length - feasible.length,
    rationale: explain(skill, mood, target, danger, picked.relief, reliefChance, headroom),
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
  headroom: number,
): string {
  const pct = (v: number): string => `${(v * 100) | 0}%`;
  const parts = [`숙련도 ${pct(skill.theta)} → 목표 난이도 ${pct(target)}`];

  if (headroom <= 1) parts.push(`슬롯 ${headroom}칸 — 무조건 완성패를 내려놓습니다`);
  else if (danger > 0.6) parts.push(`위험 ${pct(danger)} — 난이도와 무관하게 숨통을 틔웁니다`);
  else if (mood.frustration > 0.55) parts.push(`막힘 감지(${pct(mood.frustration)}) — 짝을 맞춰 줍니다`);
  else if (mood.boredom > 0.5) parts.push(`여유 감지(${pct(mood.boredom)}) — 새 무늬를 섞습니다`);
  else parts.push('현재 흐름을 유지합니다');

  parts.push(`구제 확률 ${pct(reliefChance)} → ${RELIEF_LABEL[relief]}`);
  return parts.join(' · ');
}

/** Assign faces to every tile that just became visible. */
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
    const next = b.tiles.find((t) => t.face === UNDECIDED && isFree(b, t));
    if (!next) break;
    const decision = decideFace(b, next, ledger, skill, mood, rng, policy);
    next.face = decision.face;
    b.undecided--;
    out.push(decision);
  }
  return out;
}

export { challengeOf, RELIEF_LABEL };
