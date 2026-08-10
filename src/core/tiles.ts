/**
 * Board state and rules.
 *
 * Tiles sit in overlapping layers. A tile can only be taken once nothing above
 * it remains, so the pile peels from the top down. Taken tiles go to a tray of
 * seven; three of a face clear together. A tray that fills without a match ends
 * the run.
 *
 * The one thing that is not conventional: **a covered tile has no face.** It is
 * not hidden — it genuinely has not been decided. Faces are assigned at the
 * moment a tile becomes visible, by `ai/assigner.ts`, in light of where the
 * player actually is. Nothing about the level exists before it is looked at.
 *
 * That is what makes the level free to produce. A hand-authored level has to be
 * checked for solvability afterwards, and that check is the expensive part; a
 * level assembled lazily under an invariant is winnable by construction, so
 * there is nothing to verify.
 */

export const TRAY_SLOTS = 7;
export const MATCH = 3;

/** Faces are small integers; the renderer maps them to shapes and colours. */
export type Face = number;
export const UNDECIDED: Face = -1;

export interface Tile {
  readonly id: number;
  /** Higher layers sit on top. */
  readonly layer: number;
  /** Footprint centre, in tile units. Half-steps let layers straddle. */
  readonly x: number;
  readonly y: number;
  /** Tiles resting on this one. All must be gone before it can be taken. */
  readonly above: number[];
  /** Tiles this one rests on — the only ones taking it can set free. */
  readonly unlocks: number[];
  face: Face;
  taken: boolean;
}

export interface Board {
  tiles: Tile[];
  tray: Face[];
  /** Tiles whose face has never been decided. */
  undecided: number;
}

/* ------------------------------- layout ---------------------------------- */

/**
 * A tidy stepped pile: each layer is smaller than the one below and offset by
 * half a tile, so upper tiles straddle four lower ones.
 *
 * Total is trimmed to a multiple of three. A pile that cannot be partitioned
 * into triples is unwinnable no matter how faces are assigned, and that is a
 * property of the geometry alone — so it is fixed here, once, for free.
 */
export function makeLayout(cols: number, rows: number, layers: number): Tile[] {
  const raw: { layer: number; x: number; y: number }[] = [];
  for (let l = 0; l < layers; l++) {
    const w = cols - l;
    const h = rows - l;
    if (w <= 0 || h <= 0) break;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        raw.push({ layer: l, x: c + l * 0.5, y: r + l * 0.5 });
      }
    }
  }

  // Trim from the bottom layer's corners so the silhouette stays symmetric.
  while (raw.length % MATCH !== 0) {
    let worst = 0;
    let worstScore = -Infinity;
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].layer !== 0) continue;
      const score = Math.abs(raw[i].x - cx) + Math.abs(raw[i].y - cy);
      if (score > worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    raw.splice(worst, 1);
  }

  const tiles: Tile[] = raw.map((p, id) => ({
    id,
    layer: p.layer,
    x: p.x,
    y: p.y,
    above: [],
    unlocks: [],
    face: UNDECIDED,
    taken: false,
  }));

  for (const t of tiles) {
    for (const other of tiles) {
      if (other.layer <= t.layer) continue;
      if (Math.abs(other.x - t.x) < 1 && Math.abs(other.y - t.y) < 1) {
        t.above.push(other.id);
        other.unlocks.push(t.id);
      }
    }
  }
  return tiles;
}

export function createBoard(cols = 6, rows = 5, layers = 4): Board {
  const tiles = makeLayout(cols, rows, layers);
  return { tiles, tray: [], undecided: tiles.length };
}

export function cloneBoard(b: Board): Board {
  return {
    tiles: b.tiles.map((t) => ({ ...t })),
    tray: [...b.tray],
    undecided: b.undecided,
  };
}

/* -------------------------------- rules ---------------------------------- */

/** Nothing rests on this tile any more. */
export const isFree = (b: Board, t: Tile): boolean =>
  !t.taken && t.above.every((id) => b.tiles[id].taken);

/** Free tiles whose face has been decided — what the player can actually tap. */
export function available(b: Board): Tile[] {
  return b.tiles.filter((t) => t.face !== UNDECIDED && isFree(b, t));
}

/** Free tiles still waiting for a face. The assigner's queue. */
export function pendingReveals(b: Board): Tile[] {
  return b.tiles.filter((t) => t.face === UNDECIDED && isFree(b, t));
}

export function faceCounts(tray: readonly Face[]): Map<Face, number> {
  const m = new Map<Face, number>();
  for (const f of tray) m.set(f, (m.get(f) ?? 0) + 1);
  return m;
}

export interface TakeResult {
  /** Faces cleared by this take, if it completed a set. */
  matched: Face | null;
  /** True when the tray overflowed and the run is over. */
  overflow: boolean;
}

/**
 * Move a tile into the tray and resolve.
 *
 * The tray is kept sorted by face so matching tiles sit together, which is what
 * every game in this shape does and what makes a near-miss readable at a glance.
 */
export function take(b: Board, tile: Tile): TakeResult {
  tile.taken = true;
  b.tray.push(tile.face);
  b.tray.sort((p, q) => p - q);

  const counts = faceCounts(b.tray);
  if ((counts.get(tile.face) ?? 0) >= MATCH) {
    let removed = 0;
    for (let i = b.tray.length - 1; i >= 0 && removed < MATCH; i--) {
      if (b.tray[i] === tile.face) {
        b.tray.splice(i, 1);
        removed++;
      }
    }
    return { matched: tile.face, overflow: false };
  }
  return { matched: null, overflow: b.tray.length >= TRAY_SLOTS };
}

export const isCleared = (b: Board): boolean => b.tiles.every((t) => t.taken);
export const remaining = (b: Board): number => b.tiles.filter((t) => !t.taken).length;

/** Slots left before the tray kills the run. */
export const headroom = (b: Board): number => TRAY_SLOTS - b.tray.length;

/**
 * Faces in the tray that are alone.
 *
 * The real danger measure. Six tiles that are three pairs is comfortable; four
 * tiles that are four different faces is nearly fatal, because each one holds a
 * slot hostage until two more of it turn up.
 */
export function singles(b: Board): number {
  let n = 0;
  for (const v of faceCounts(b.tray).values()) if (v === 1) n++;
  return n;
}
