/**
 * Probe C — stacked tile match with *deferred* face assignment.
 *
 * The genre is the Sheep-a-Sheep shape: tiles stacked in layers, only
 * unobstructed ones are takeable, a seven-slot tray, three of a kind clears,
 * a full tray loses.
 *
 * The idea being tested is not the genre — it is this: **a covered tile has not
 * been observed, so its face does not have to exist yet.** Faces are assigned
 * at the moment a tile becomes visible, in light of where the player actually
 * is. Nothing is authored up front.
 *
 * If that works, the expensive half of level design disappears. A hand-authored
 * level has to be checked for solvability after the fact, which is the part that
 * costs money. A level assembled lazily under an invariant is solvable *by
 * construction* — there is nothing to verify, because an unwinnable state is
 * never constructed in the first place.
 *
 *   npx tsx src/probe/c-tiles.ts
 */

import { makeRng, type Rng } from '../core/rng';

const TRAY = 7;

/* ------------------------------- layout ---------------------------------- */

export interface Tile {
  id: number;
  layer: number;
  x: number;
  y: number;
  /** Tiles that sit on top of this one and must go first. */
  covered: number[];
  /** Assigned once the tile becomes visible. -1 until then. */
  face: number;
  taken: boolean;
}

/**
 * Layered stacks, upper layers offset so they straddle the ones below.
 *
 * Tile count is forced to a multiple of three: a level that cannot be perfectly
 * partitioned into triples is unwinnable no matter how faces are assigned.
 */
export function makeLayout(rng: Rng, layers: number, perLayer: number): Tile[] {
  const tiles: Tile[] = [];
  for (let l = 0; l < layers; l++) {
    const off = (l % 2) * 0.5;
    for (let k = 0; k < perLayer; k++) {
      tiles.push({
        id: tiles.length,
        layer: l,
        x: rng.int(4) + off,
        y: rng.int(4) + off,
        covered: [],
        face: -1,
        taken: false,
      });
    }
  }
  while (tiles.length % 3 !== 0) tiles.pop();

  for (const a of tiles) {
    for (const b of tiles) {
      if (b.layer <= a.layer) continue;
      if (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1) a.covered.push(b.id);
    }
  }
  return tiles;
}

const isFree = (t: Tile, tiles: Tile[]): boolean =>
  !t.taken && t.covered.every((c) => tiles[c].taken);

/* ------------------------------ the assigner ----------------------------- */

/**
 * The assigner reads the *actual tray*, not its own bookkeeping.
 *
 * The first version tracked only the triples it had opened, and a careless
 * player lost every single run at every pressure setting — because faces are
 * committed when a tile becomes visible, and the player is free to take those
 * tiles in whatever order they like. The assigner's ledger and the real tray
 * drift apart immediately.
 *
 * It also cannot be made unloseable, and should not be. With k distinct faces
 * on offer a player can stack two of each before anything completes, so a tray
 * of seven dies once k reaches four. Holding k at three would make the game
 * meaningless. Losing has to be possible; what the assigner owes the player is
 * that a winning line always still exists.
 */
interface Assigner {
  /** Tiles whose face is still undecided. */
  undecided: number;
  nextFace: number;
}

/** Faces in the tray, and how many of each. */
type Tray = number[];

const countFaces = (tray: Tray): Map<number, number> => {
  const m = new Map<number, number>();
  for (const f of tray) m.set(f, (m.get(f) ?? 0) + 1);
  return m;
};

/**
 * Danger is not tray length — it is how many separate groups the player is
 * carrying. Six tiles that are three pairs is comfortable; four tiles that are
 * four different faces is nearly fatal.
 */
function danger(tray: Tray): number {
  const counts = countFaces(tray);
  const singles = [...counts.values()].filter((v) => v === 1).length;
  const capacity = TRAY - tray.length;
  // Singles are what kill: each one occupies a slot and needs two more tiles.
  // Capacity below three is where a run stops being recoverable in one move.
  const fromSingles = singles / 4;
  const fromRoom = Math.max(0, (4 - capacity) / 3);
  return Math.min(1, Math.max(fromSingles, fromRoom));
}

/**
 * Choose the face for a tile that just became visible.
 *
 * `pressure` is the difficulty dial; the tray is the situation. High danger
 * overrides the dial — a lifeline gets laid out whatever the target says, which
 * is the entire point of deciding content this late.
 */
function assignFace(
  a: Assigner,
  tray: Tray,
  visibleFaces: number[],
  pressure: number,
  rng: Rng,
): number {
  const counts = countFaces(tray);
  const risk = danger(tray);

  interface Option {
    face: number;
    /** 2 = taking it completes a triple outright, 1 = makes a pair, 0 = new group. */
    relief: number;
  }
  // Relief is about the *tray*. An earlier version counted faces sitting
  // elsewhere on the board as relief, which they are not — a matching tile the
  // player has not taken does nothing for a tray about to overflow.
  const options: Option[] = [];
  for (const [face, n] of counts) options.push({ face, relief: n >= 2 ? 2 : 1 });
  // Pairing with something already visible is still better than a brand new
  // face, because the player can reach both.
  for (const f of new Set(visibleFaces)) {
    if (!counts.has(f)) options.push({ face: f, relief: 0.5 });
  }
  options.push({ face: a.nextFace, relief: 0 });

  // Every open group still needs closing, and only undecided tiles can close it.
  const need = [...counts.values()].reduce((s, v) => s + ((3 - (v % 3)) % 3), 0);
  const legal = options.filter((o) => a.undecided - 1 >= need + (o.relief === 0 ? 2 : 0));
  const pool = legal.length > 0 ? legal : options;

  // Relief only comes in three grades, so choosing the nearest one to a target
  // produced a cliff rather than a dial: every pressure below 0.35 was trivially
  // winnable and everything above it was unsurvivable. Choose *probabilistically*
  // instead, and let danger raise that probability continuously.
  const pRelief = Math.min(1, risk * 1.15 + (1 - pressure) * 0.55);

  const completing = pool.filter((o) => o.relief === 2);
  const pairing = pool.filter((o) => o.relief === 1);
  const fresh = pool.filter((o) => o.relief <= 0.5);

  // Hard gates. Below them the dial does not get a vote — a tray this close to
  // full is handed a way out regardless of what difficulty asked for.
  let candidates: Option[];
  if (tray.length >= TRAY - 1 && completing.length > 0) candidates = completing;
  else if (tray.length >= TRAY - 2 && (completing.length > 0 || pairing.length > 0))
    candidates = completing.length > 0 ? completing : pairing;
  else if (rng() < pRelief)
    candidates = completing.length > 0 ? completing : pairing.length > 0 ? pairing : fresh;
  else candidates = fresh.length > 0 ? fresh : pairing.length > 0 ? pairing : completing;

  const pick = candidates[rng.int(candidates.length)];

  if (pick.face === a.nextFace) a.nextFace++;
  a.undecided--;
  return pick.face;
}

/* ------------------------------ simulation ------------------------------- */

export interface RunResult {
  won: boolean;
  taps: number;
  maxOccupancy: number;
  meanOccupancy: number;
  /** Taps taken while the tray held six — one step from death. */
  brinkTaps: number;
  decisions: number;
}

/** `insight` 0..1 — how reliably the player takes a tile that progresses a triple. */
export function playRun(tiles: Tile[], pressure: number, insight: number, rng: Rng): RunResult {
  for (const t of tiles) {
    t.face = -1;
    t.taken = false;
  }
  const a: Assigner = { nextFace: 0, undecided: tiles.length };
  const tray: number[] = [];
  let taps = 0;
  let maxOcc = 0;
  let occSum = 0;
  let brink = 0;
  let decisions = 0;

  const revealNew = (): void => {
    for (const t of tiles) {
      if (t.face === -1 && isFree(t, tiles)) {
        const visible = tiles.filter((v) => v.face !== -1 && !v.taken).map((v) => v.face);
        t.face = assignFace(a, tray, visible, pressure, rng);
        decisions++;
      }
    }
  };
  revealNew();

  for (let step = 0; step < tiles.length * 4; step++) {
    const options = tiles.filter((t) => isFree(t, tiles) && t.face !== -1);
    if (options.length === 0) break;

    // A player with insight prefers a tile that advances something already in
    // the tray; without it, they take whatever is on top.
    const counts = new Map<number, number>();
    for (const f of tray) counts.set(f, (counts.get(f) ?? 0) + 1);
    const helpful = options.filter((t) => (counts.get(t.face) ?? 0) > 0);
    const chosen =
      helpful.length > 0 && rng() < insight ? rng.pick(helpful) : rng.pick(options);

    chosen.taken = true;
    tray.push(chosen.face);
    taps++;

    const same = tray.filter((f) => f === chosen.face);
    if (same.length >= 3) {
      let removed = 0;
      for (let i = tray.length - 1; i >= 0 && removed < 3; i--) {
        if (tray[i] === chosen.face) {
          tray.splice(i, 1);
          removed++;
        }
      }
    }

    occSum += tray.length;
    if (tray.length > maxOcc) maxOcc = tray.length;
    if (tray.length >= TRAY - 1) brink++;
    if (tray.length >= TRAY) {
      return {
        won: false,
        taps,
        maxOccupancy: maxOcc,
        meanOccupancy: occSum / taps,
        brinkTaps: brink,
        decisions,
      };
    }
    revealNew();
  }

  return {
    won: tiles.every((t) => t.taken),
    taps,
    maxOccupancy: maxOcc,
    meanOccupancy: taps === 0 ? 0 : occSum / taps,
    brinkTaps: brink,
    decisions,
  };
}

/* ------------------------------ measurement ------------------------------ */

const rng = makeRng(4242);
const LAYOUTS = 60;
const RUNS_PER = 12;

console.log('probe C — stacked tile match, faces assigned on reveal\n');

const layouts = Array.from({ length: LAYOUTS }, () => makeLayout(rng, 7, 9));
const exposed = layouts[0].filter((t) => t.covered.length === 0).length;
console.log(`layout size  ${layouts[0].length} tiles, 7 layers, ${exposed} exposed at start, tray ${TRAY}\n`);

console.log(
  ['pressure', 'insight', 'win%', 'mean tray', 'max tray', 'brink%', 'decisions/s']
    .map((h) => h.padStart(12))
    .join(''),
);

let anyLoss = 0;
for (const pressure of [0, 0.35, 0.7, 1]) {
  for (const insight of [0.15, 0.85]) {
    const t0 = performance.now();
    const results: RunResult[] = [];
    for (const layout of layouts) {
      for (let r = 0; r < RUNS_PER; r++) results.push(playRun(layout, pressure, insight, rng));
    }
    const dt = (performance.now() - t0) / 1000;
    const decisions = results.reduce((s, r) => s + r.decisions, 0);
    const wins = results.filter((r) => r.won).length;
    anyLoss += results.length - wins;

    console.log(
      [
        pressure.toFixed(2),
        insight.toFixed(2),
        ((wins / results.length) * 100).toFixed(0) + '%',
        (results.reduce((s, r) => s + r.meanOccupancy, 0) / results.length).toFixed(2),
        (results.reduce((s, r) => s + r.maxOccupancy, 0) / results.length).toFixed(2),
        ((results.reduce((s, r) => s + r.brinkTaps, 0) / results.reduce((s, r) => s + r.taps, 0)) * 100).toFixed(0) + '%',
        Math.round(decisions / dt).toLocaleString(),
      ]
        .map((c) => String(c).padStart(12))
        .join(''),
    );
  }
}

console.log(
  `\nlost runs: ${anyLoss}. Losing is meant to be possible — the guarantee is that a\n` +
    'winning line always still exists, not that the player cannot throw it away.',
);
