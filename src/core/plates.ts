/**
 * Board state and rules — metal plates bolted to a wall.
 *
 * Plates overlap in layers. Each plate is held by a few screws, and a screw can
 * only be turned when no plate above it covers that spot. Take the last screw
 * out of a plate and the plate falls away, exposing whatever was underneath.
 * Loosened screws go into holders; a holder locks to the first colour that
 * lands in it and completes at three. Run out of holder room and the run ends.
 *
 * The one thing that is not conventional: **a covered screw has no colour.** It
 * is not hidden — it genuinely has not been decided. Colours are written at the
 * moment a screw becomes reachable, by `ai/assigner.ts`, in light of the
 * holders the player is actually carrying.
 *
 * That is what makes a level free to produce. A hand-authored level has to be
 * checked for solvability afterwards, and that check is the expensive part; a
 * level assembled lazily under an invariant is winnable by construction, so
 * there is nothing to verify.
 */

export const HOLDERS = 3;
export const HOLDER_CAPACITY = 3;

/** Colours are small integers; the renderer maps them to hues. */
export type Colour = number;
export const UNDECIDED: Colour = -1;

export interface Screw {
  readonly id: number;
  /** The plate this screw holds down. */
  readonly plate: number;
  /** Position in board units. */
  readonly x: number;
  readonly y: number;
  colour: Colour;
  removed: boolean;
}

export interface Plate {
  readonly id: number;
  /** Higher plates sit on top and block the screws beneath them. */
  readonly layer: number;
  /** Axis-aligned footprint in board units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  screws: number[];
  /** True once every one of its screws is out and it has dropped away. */
  fallen: boolean;
}

export interface Holder {
  /** The colour this holder locked onto, or UNDECIDED while empty. */
  colour: Colour;
  count: number;
}

export interface Board {
  plates: Plate[];
  screws: Screw[];
  holders: Holder[];
  /** Screws whose colour has never been decided. */
  undecided: number;
}

/* ------------------------------- layout ---------------------------------- */

const overlaps = (p: Plate, x: number, y: number): boolean =>
  x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h;

/**
 * Build a stepped stack of plates.
 *
 * Total screw count is forced to a multiple of three: a wall that cannot be
 * partitioned into triples is unwinnable however colours are assigned, and that
 * is a property of the geometry alone — so it is fixed here, once, for free.
 */
export function makeWall(cols: number, rows: number, layers: number): {
  plates: Plate[];
  screws: Screw[];
} {
  const plates: Plate[] = [];
  const screws: Screw[] = [];

  // Layer sizes first, so the loop below knows which layer is the top one.
  const dims: { inset: number; w: number; h: number }[] = [];
  for (let l = 0; l < layers; l++) {
    const inset = l * 0.6;
    const w = cols - l * 1.2;
    const h = rows - l * 1.2;
    if (w < 1.3 || h < 1.3) break;
    dims.push({ inset, w, h });
  }
  const top = dims.length - 1;

  for (let l = 0; l < dims.length; l++) {
    const { inset, w, h } = dims[l];

    // Alternate the split direction by layer. Two side-by-side plates covered by
    // two stacked ones interlock, so a plate coming off exposes screws that
    // belonged to *different* plates below — which is where the interesting
    // decisions live. Splitting the same way every layer just makes columns.
    const pieces: { x: number; y: number; w: number; h: number }[] = [];
    if (l % 2 === 0 && w >= 3) {
      const a = w * 0.46;
      pieces.push({ x: inset, y: inset, w: a, h });
      pieces.push({ x: inset + a, y: inset, w: w - a, h });
    } else if (l % 2 === 1 && h >= 2) {
      const a = h * 0.55;
      pieces.push({ x: inset, y: inset, w, h: a });
      pieces.push({ x: inset, y: inset + a, w, h: h - a });
    } else {
      pieces.push({ x: inset, y: inset, w, h });
    }

    for (const piece of pieces) {
      const plate: Plate = {
        id: plates.length,
        layer: l,
        x: piece.x,
        y: piece.y,
        w: piece.w,
        h: piece.h,
        screws: [],
        fallen: false,
      };

      /*
       * How far a screw sits inside its plate's edge.
       *
       * This is the single most important number in the layout. Bolt a lower
       * plate near its corners and those corners stick out past everything
       * stacked on it, so they stay reachable for the whole wall — which is how
       * a board ends up offering seventeen legal moves at once, and a choice
       * between seventeen things is not a choice. Pulling them inside the
       * footprint of the layer above means a plate is genuinely buried until
       * the one on top of it comes off.
       */
      const target = l === top ? 0.36 : dims[l + 1].inset - inset + 0.2;
      const m = Math.min(target, Math.min(piece.w, piece.h) * 0.34);

      const spots: [number, number][] = [
        [piece.x + m, piece.y + m],
        [piece.x + piece.w - m, piece.y + m],
        [piece.x + m, piece.y + piece.h - m],
        [piece.x + piece.w - m, piece.y + piece.h - m],
      ];
      for (const [sx, sy] of spots) {
        const screw: Screw = {
          id: screws.length,
          plate: plate.id,
          x: sx,
          y: sy,
          colour: UNDECIDED,
          removed: false,
        };
        screws.push(screw);
        plate.screws.push(screw.id);
      }
      plates.push(plate);
    }
  }

  // A wall that cannot be partitioned into triples is unwinnable however
  // colours are assigned, so drop a screw or two from the outermost plates
  // until the total divides evenly. Every plate keeps at least two.
  let guard = 0;
  while (screws.length % HOLDER_CAPACITY !== 0 && guard++ < 8) {
    const donor = plates
      .filter((p) => p.layer === 0 && p.screws.length > 2)
      .sort((a, b) => b.screws.length - a.screws.length)[0];
    if (!donor) break;
    const victim = donor.screws.pop() as number;
    screws.splice(
      screws.findIndex((s) => s.id === victim),
      1,
    );
  }

  // Ids have to stay aligned with array positions after any trimming.
  const remap = new Map<number, number>();
  screws.forEach((s, i) => {
    remap.set(s.id, i);
    Object.assign(s, { id: i });
  });
  for (const p of plates) p.screws = p.screws.map((id) => remap.get(id) as number);

  return { plates, screws };
}

export function createBoard(cols = 5, rows = 4, layers = 3): Board {
  const { plates, screws } = makeWall(cols, rows, layers);
  return {
    plates,
    screws,
    holders: Array.from({ length: HOLDERS }, () => ({ colour: UNDECIDED, count: 0 })),
    undecided: screws.length,
  };
}

export function cloneBoard(b: Board): Board {
  return {
    plates: b.plates.map((p) => ({ ...p })),
    screws: b.screws.map((s) => ({ ...s })),
    holders: b.holders.map((h) => ({ ...h })),
    undecided: b.undecided,
  };
}

/* -------------------------------- rules ---------------------------------- */

/** Nothing above this spot, so a driver can reach the screw. */
export function isReachable(b: Board, s: Screw): boolean {
  if (s.removed) return false;
  const own = b.plates[s.plate];
  if (own.fallen) return false;
  for (const p of b.plates) {
    if (p.fallen || p.layer <= own.layer) continue;
    if (overlaps(p, s.x, s.y)) return false;
  }
  return true;
}

/** Screws whose colour is decided and which can be turned right now. */
export function available(b: Board): Screw[] {
  return b.screws.filter((s) => s.colour !== UNDECIDED && isReachable(b, s));
}

/** Reachable screws still waiting for a colour. The assigner's queue. */
export function pendingReveals(b: Board): Screw[] {
  return b.screws.filter((s) => s.colour === UNDECIDED && isReachable(b, s));
}

export interface TurnResult {
  /** The holder the screw went into, or -1 when there was nowhere to put it. */
  holder: number;
  /** True when a holder filled up and cleared. */
  completed: boolean;
  /** Plates that lost their last screw and fell away. */
  fallen: number[];
  /** No holder could take it: the run is over. */
  overflow: boolean;
}

/** Where a screw of this colour would go, or -1 if nowhere. */
export function holderFor(b: Board, colour: Colour): number {
  for (let i = 0; i < b.holders.length; i++) {
    const h = b.holders[i];
    if (h.colour === colour && h.count < HOLDER_CAPACITY) return i;
  }
  for (let i = 0; i < b.holders.length; i++) {
    if (b.holders[i].colour === UNDECIDED) return i;
  }
  return -1;
}

/** Turn a screw out and resolve everything that follows. */
export function turn(b: Board, screw: Screw): TurnResult {
  const idx = holderFor(b, screw.colour);
  if (idx === -1) {
    return { holder: -1, completed: false, fallen: [], overflow: true };
  }

  screw.removed = true;
  const holder = b.holders[idx];
  holder.colour = screw.colour;
  holder.count++;

  let completed = false;
  if (holder.count >= HOLDER_CAPACITY) {
    holder.colour = UNDECIDED;
    holder.count = 0;
    completed = true;
  }

  // A plate with no screws left has nothing holding it up.
  const fallen: number[] = [];
  for (const p of b.plates) {
    if (p.fallen) continue;
    if (p.screws.every((id) => b.screws[id].removed)) {
      p.fallen = true;
      fallen.push(p.id);
    }
  }

  return { holder: idx, completed, fallen, overflow: false };
}

export const isCleared = (b: Board): boolean => b.screws.every((s) => s.removed);
export const screwsLeft = (b: Board): number => b.screws.filter((s) => !s.removed).length;

/** Holders in use but not yet complete. Each one is a slot held hostage. */
export function openHolders(b: Board): number {
  return b.holders.filter((h) => h.colour !== UNDECIDED).length;
}

/** Holders with a single screw in them — the most expensive kind to carry. */
export function lonelyHolders(b: Board): number {
  return b.holders.filter((h) => h.colour !== UNDECIDED && h.count === 1).length;
}

export const freeHolders = (b: Board): number =>
  b.holders.filter((h) => h.colour === UNDECIDED).length;

/** Colours the player can still put somewhere without opening a new holder. */
export function openColours(b: Board): Colour[] {
  return b.holders.filter((h) => h.colour !== UNDECIDED).map((h) => h.colour);
}
