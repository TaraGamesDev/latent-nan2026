/**
 * Offline director-policy tuner.
 *
 * The director has a cold-start problem: it adapts to an individual, but the
 * game has never met anyone. Bot personas stand in for that missing cohort.
 * Each candidate policy is scored by replaying full games — through the real
 * `tap()` path, not a re-implementation — and measuring whether the director
 * actually delivered the experience it intended for each persona.
 *
 * Two searches run over the same budget and the same objective:
 *
 *   random  - uniform sampling of the policy box
 *   llm     - Claude proposes each round's candidates given every result so far
 *
 * Reporting both is the point. A tuner that only ran the LLM search could not
 * say whether the LLM helped; running them head-to-head at equal budget can.
 *
 *   npx tsx src/tools/tune.ts [--rounds N] [--batch N] [--seeds N] [--no-llm]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { makeRng } from '../core/rng';
import { PERSONAS, type PersonaName, chooseTap, thinkTime } from '../ai/bots';
import { challengeOf, decideConstraints, planSpawn } from '../ai/director';
import { POLICY, type Policy } from '../ai/policy';
import { createSkillState, createMoodState, observeTap, updateMood, updateSkill } from '../ai/skill';
import { isDeadlocked, legalMoves } from '../core/grid';
import { seedGrid } from '../ai/director';
import { applyMove, cloneGrid, computeMove } from '../core/grid';

/* ------------------------------------------------------------------ *
 * Search space
 * ------------------------------------------------------------------ */

interface Bound {
  min: number;
  max: number;
  int?: boolean;
}

const SPACE: Record<string, Bound> = {
  rampTaps: { min: 35, max: 85, int: true },
  challengeOffset: { min: 0, max: 0.15 },
  frustrationRelief: { min: 0.15, max: 0.5 },
  boredomPush: { min: 0.1, max: 0.4 },
  rampWeight: { min: 0.35, max: 0.75 },
  envelopeBase: { min: 0.25, max: 0.45 },
  envelopeSlope: { min: 0.5, max: 0.75 },
  preferExitsAtEase: { min: 2, max: 6, int: true },
  spawnRateBase: { min: 0.4, max: 0.9 },
  spawnRatePeak: { min: 1.6, max: 2.4 },
  crowdingCeilingBase: { min: 0.4, max: 0.65 },
  wChallengeMatch: { min: 6, max: 14 },
  wExitChain: { min: 1, max: 5 },
  wMobility: { min: 1, max: 4 },
};

const KEYS = Object.keys(SPACE) as (keyof Policy & string)[];

const clampToSpace = (raw: Record<string, number>): Policy => {
  const p: Policy = { ...POLICY };
  for (const k of KEYS) {
    const b = SPACE[k];
    let v = Number(raw[k]);
    if (!Number.isFinite(v)) v = (POLICY as unknown as Record<string, number>)[k];
    v = Math.min(b.max, Math.max(b.min, v));
    if (b.int) v = Math.round(v);
    (p as unknown as Record<string, number>)[k] = v;
  }
  return p;
};

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

interface PersonaMetrics {
  taps: number;
  score: number;
  /** |realised challenge - the challenge the director was aiming for|. */
  trackingError: number;
  /** Mean realised challenge - how hard this persona's game actually was. */
  meanChallenge: number;
  frustratedFraction: number;
  boredFraction: number;
  invariantBreaches: number;
}

const TARGET_MIN_TAPS = 60;
// A judge plays for a few minutes, not ten. The first tuning run happily
// accepted a 239-tap expert session because the length penalty was too weak
// against the separation reward.
const TARGET_MAX_TAPS = 130;

/**
 * Play one game under a candidate policy.
 *
 * Reimplements the tap loop rather than calling `game.tap()` only because the
 * policy has to be threaded through; every rule, solver call and director
 * decision is the shipped implementation.
 */
function playOne(persona: PersonaName, seed: number, policy: Policy): PersonaMetrics {
  const rng = makeRng(seed);
  const botRng = makeRng(seed ^ 0x9e3779b9);
  const p = PERSONAS[persona];

  let grid = seedGrid(rng);
  let skill = createSkillState();
  let mood = createMoodState();
  let score = 0;
  let combo = 0;
  let taps = 0;
  let clock = 0;
  let trackingSum = 0;
  let challengeSum = 0;
  let frustrated = 0;
  let bored = 0;
  let invariantBreaches = 0;

  for (let step = 0; step < 600; step++) {
    const cell = chooseTap(grid, p, botRng);
    if (cell === null) break;

    const before = cloneGrid(grid);
    const move = computeMove(grid, cell);
    clock += thinkTime(p, botRng);
    const obs = observeTap(before, cell, thinkTime(p, botRng));
    taps++;

    if (!move.jammed) {
      applyMove(grid, move);
      if (move.exits) {
        score += 10 + 2 * move.distance + 5 * combo;
        combo++;
      } else combo = Math.max(0, combo - 1);
    } else combo = 0;

    if (obs) {
      skill = updateSkill(skill, obs);
      mood = updateMood(mood, obs, skill);
    }

    const constraints = decideConstraints(skill, mood, grid, taps, rng, policy);
    const decision = planSpawn(grid, constraints, rng, policy);
    if (decision.chosen) for (const pl of decision.chosen.placements) grid[pl.cell] = pl.dir;
    if (decision.playable && legalMoves(grid).length < 1) invariantBreaches++;

    const realised = challengeOf(grid);
    trackingSum += Math.abs(realised - constraints.targetChallenge);
    challengeSum += realised;
    if (mood.frustration > 0.7) frustrated++;
    if (mood.boredom > 0.6) bored++;

    if (!decision.playable || isDeadlocked(grid)) break;
  }

  return {
    taps,
    score,
    trackingError: taps === 0 ? 1 : trackingSum / taps,
    meanChallenge: taps === 0 ? 0 : challengeSum / taps,
    frustratedFraction: taps === 0 ? 1 : frustrated / taps,
    boredFraction: taps === 0 ? 0 : bored / taps,
    invariantBreaches,
  };
}

export interface Evaluation {
  loss: number;
  byPersona: Record<PersonaName, PersonaMetrics>;
  /** Expert's realised difficulty minus novice's. Positive is the whole point. */
  separation: number;
  invariantBreaches: number;
}

const PERSONA_LIST: PersonaName[] = ['novice', 'casual', 'expert'];

function evaluatePolicy(policy: Policy, seeds: number): Evaluation {
  const byPersona = {} as Record<PersonaName, PersonaMetrics>;

  for (const persona of PERSONA_LIST) {
    const runs = Array.from({ length: seeds }, (_, i) => playOne(persona, 4242 + i * 7919, policy));
    const mean = (f: (m: PersonaMetrics) => number): number =>
      runs.reduce((a, m) => a + f(m), 0) / runs.length;
    byPersona[persona] = {
      taps: mean((m) => m.taps),
      score: mean((m) => m.score),
      trackingError: mean((m) => m.trackingError),
      meanChallenge: mean((m) => m.meanChallenge),
      frustratedFraction: mean((m) => m.frustratedFraction),
      boredFraction: mean((m) => m.boredFraction),
      invariantBreaches: runs.reduce((a, m) => a + m.invariantBreaches, 0),
    };
  }

  const separation = byPersona.expert.meanChallenge - byPersona.novice.meanChallenge;
  const invariantBreaches = PERSONA_LIST.reduce((a, k) => a + byPersona[k].invariantBreaches, 0);

  let loss = 0;
  for (const k of PERSONA_LIST) {
    const m = byPersona[k];
    loss += 3.0 * m.trackingError;
    loss += 2.0 * m.frustratedFraction;
    loss += 1.2 * m.boredFraction;
    // Session length is a product constraint, not a taste: too short and the
    // director never gets to demonstrate anything, too long and it drags.
    const under = Math.max(0, TARGET_MIN_TAPS - m.taps) / TARGET_MIN_TAPS;
    const over = Math.max(0, m.taps - TARGET_MAX_TAPS) / TARGET_MAX_TAPS;
    loss += 3.0 * (under + over);
  }
  // A director that treats everyone identically has failed at its one job.
  loss -= 4.0 * separation;
  // Never trade the invariant for a better score.
  loss += 50 * invariantBreaches;

  return { loss, byPersona, separation, invariantBreaches };
}

/* ------------------------------------------------------------------ *
 * Searches
 * ------------------------------------------------------------------ */

interface Trial {
  policy: Policy;
  evaluation: Evaluation;
  source: 'baseline' | 'random' | 'llm';
  round: number;
}

const summarise = (t: Trial): Record<string, unknown> => ({
  loss: +t.evaluation.loss.toFixed(4),
  separation: +t.evaluation.separation.toFixed(4),
  params: Object.fromEntries(KEYS.map((k) => [k, (t.policy as unknown as Record<string, number>)[k]])),
  perPersona: Object.fromEntries(
    PERSONA_LIST.map((k) => [
      k,
      {
        taps: +t.evaluation.byPersona[k].taps.toFixed(1),
        trackingError: +t.evaluation.byPersona[k].trackingError.toFixed(4),
        meanChallenge: +t.evaluation.byPersona[k].meanChallenge.toFixed(4),
        frustrated: +t.evaluation.byPersona[k].frustratedFraction.toFixed(3),
        bored: +t.evaluation.byPersona[k].boredFraction.toFixed(3),
      },
    ]),
  ),
});

function randomCandidates(n: number, rng: () => number): Policy[] {
  return Array.from({ length: n }, () => {
    const raw: Record<string, number> = {};
    for (const k of KEYS) {
      const b = SPACE[k];
      raw[k] = b.min + rng() * (b.max - b.min);
    }
    return clampToSpace(raw);
  });
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Brief analysis of the trials so far and what you are varying and why.',
    },
    candidates: {
      type: 'array',
      description: 'Policy parameter sets to evaluate next.',
      items: {
        type: 'object',
        properties: Object.fromEntries(
          KEYS.map((k) => [k, { type: 'number', description: `range ${SPACE[k].min}..${SPACE[k].max}` }]),
        ),
        required: KEYS,
        additionalProperties: false,
      },
    },
  },
  required: ['reasoning', 'candidates'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are tuning the policy constants of a dynamic difficulty director for a real-time arrow puzzle game.

The director runs once per player tap. It estimates the player's skill from per-tap regret against a solver, derives a target challenge level, and then a generator samples candidate arrow spawns and picks whichever best matches that target. Your job is to choose the constants that govern the derivation.

Objective (lower loss is better). Loss combines, over three bot personas (novice, casual, expert):
- trackingError: |realised challenge - the director's own target|. The generator failing to deliver the director's intent.
- frustratedFraction / boredFraction: time spent outside the flow channel.
- session length outside 60..160 taps, penalised proportionally.
- MINUS 4x separation, where separation = expert's mean realised challenge - novice's. A director that gives everyone the same difficulty has failed.

Propose diverse candidates. Exploit what the trials show, but keep exploring - identical-looking candidates waste the budget. Respect every stated range.`;

async function llmCandidates(
  client: Anthropic,
  history: Trial[],
  batch: number,
  round: number,
): Promise<{ policies: Policy[]; reasoning: string }> {
  const best = [...history].sort((a, b) => a.evaluation.loss - b.evaluation.loss).slice(0, 8);
  const recent = history.slice(-8);
  const shown = [...new Set([...best, ...recent])];

  const message = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: CANDIDATE_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Round ${round}. ${history.length} trials evaluated so far.

Parameter ranges:
${KEYS.map((k) => `  ${k}: ${SPACE[k].min}..${SPACE[k].max}${SPACE[k].int ? ' (integer)' : ''}`).join('\n')}

Trials (best-so-far plus most recent):
${JSON.stringify(shown.map(summarise), null, 1)}

Propose exactly ${batch} new candidate parameter sets.`,
      },
    ],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = JSON.parse(text) as {
    reasoning: string;
    candidates: Record<string, number>[];
  };
  return {
    policies: parsed.candidates.slice(0, batch).map(clampToSpace),
    reasoning: parsed.reasoning,
  };
}

/* ------------------------------------------------------------------ *
 * Driver
 * ------------------------------------------------------------------ */

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const ROUNDS = arg('rounds', 4);
const BATCH = arg('batch', 6);
const SEEDS = arg('seeds', 6);
const USE_LLM = !process.argv.includes('--no-llm');

async function main(): Promise<void> {
  const budget = ROUNDS * BATCH;
  console.log(`CADENCE policy tuner - ${budget} candidates per search, ${SEEDS} seeds each\n`);

  const baselineEval = evaluatePolicy(POLICY, SEEDS);
  const baseline: Trial = { policy: POLICY, evaluation: baselineEval, source: 'baseline', round: 0 };
  console.log(`baseline (hand-set)   loss ${baselineEval.loss.toFixed(4)}   separation ${baselineEval.separation.toFixed(4)}`);

  // --- random search -------------------------------------------------
  const rng = makeRng(20260810);
  const randomTrials: Trial[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (const policy of randomCandidates(BATCH, rng)) {
      randomTrials.push({ policy, evaluation: evaluatePolicy(policy, SEEDS), source: 'random', round });
    }
    const best = Math.min(...randomTrials.map((t) => t.evaluation.loss));
    console.log(`random  round ${round}/${ROUNDS}   best ${best.toFixed(4)}   (${randomTrials.length} evaluated)`);
  }

  // --- llm-guided search ---------------------------------------------
  const llmTrials: Trial[] = [];
  const reasonings: string[] = [];
  if (USE_LLM) {
    const client = new Anthropic();
    // Seed the LLM with the same starting information the random search had.
    const seedTrials = randomCandidates(BATCH, makeRng(1337)).map<Trial>((policy) => ({
      policy,
      evaluation: evaluatePolicy(policy, SEEDS),
      source: 'llm',
      round: 0,
    }));
    llmTrials.push(...seedTrials);

    for (let round = 1; round <= ROUNDS - 1; round++) {
      try {
        const { policies, reasoning } = await llmCandidates(client, [baseline, ...llmTrials], BATCH, round);
        reasonings.push(`round ${round}: ${reasoning}`);
        for (const policy of policies) {
          llmTrials.push({ policy, evaluation: evaluatePolicy(policy, SEEDS), source: 'llm', round });
        }
        const best = Math.min(...llmTrials.map((t) => t.evaluation.loss));
        console.log(`llm     round ${round}/${ROUNDS - 1}   best ${best.toFixed(4)}   (${llmTrials.length} evaluated)`);
      } catch (error) {
        console.error(`llm     round ${round} failed:`, error instanceof Error ? error.message : error);
        break;
      }
    }
  }

  // --- report ---------------------------------------------------------
  const pick = (ts: Trial[]): Trial | null =>
    ts.length === 0 ? null : ts.reduce((a, b) => (a.evaluation.loss <= b.evaluation.loss ? a : b));

  const bestRandom = pick(randomTrials);
  const bestLlm = pick(llmTrials);
  const overall = pick([baseline, ...randomTrials, ...llmTrials])!;

  console.log('\n--- results ---------------------------------------------');
  console.log(`baseline      loss ${baselineEval.loss.toFixed(4)}`);
  if (bestRandom) console.log(`random search loss ${bestRandom.evaluation.loss.toFixed(4)}  (${randomTrials.length} evals)`);
  if (bestLlm) console.log(`llm search    loss ${bestLlm.evaluation.loss.toFixed(4)}  (${llmTrials.length} evals)`);
  console.log(`\nwinner: ${overall.source}`);
  console.log(JSON.stringify(summarise(overall), null, 2));

  mkdirSync('tuning', { recursive: true });
  writeFileSync(
    'tuning/result.json',
    JSON.stringify(
      {
        budget: { rounds: ROUNDS, batch: BATCH, seeds: SEEDS },
        baseline: summarise(baseline),
        bestRandom: bestRandom ? summarise(bestRandom) : null,
        bestLlm: bestLlm ? summarise(bestLlm) : null,
        winner: { source: overall.source, ...summarise(overall) },
        llmReasoning: reasonings,
        allTrials: [baseline, ...randomTrials, ...llmTrials].map((t) => ({
          source: t.source,
          round: t.round,
          ...summarise(t),
        })),
      },
      null,
      2,
    ),
  );
  console.log('\nwrote tuning/result.json');

  console.log('\nPaste into src/ai/policy.ts:');
  for (const k of KEYS) {
    console.log(`  ${k}: ${(overall.policy as unknown as Record<string, number>)[k]},`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
