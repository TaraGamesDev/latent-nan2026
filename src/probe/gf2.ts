/**
 * Dense linear algebra over GF(2).
 *
 * Exists because it is the cheapest exact difficulty oracle available to a
 * puzzle. For any toggle-style level, one Gaussian elimination answers three
 * questions that every other genre can only estimate:
 *
 *   - is this level solvable at all?          (consistency of the system)
 *   - how many distinct solutions exist?      (2^nullity, exactly)
 *   - what is the shortest solution?          (min-weight vector in the coset)
 *
 * Sokoban level generation is a research problem because it is PSPACE-complete
 * and none of the above can be answered cheaply. Here it is O(n^3) bit ops.
 */

export interface GF2System {
  /** One bitmask of variable indices per equation. */
  rows: number[];
  /** Right-hand side bit per equation. */
  rhs: number[];
  vars: number;
}

export interface GF2Solution {
  solvable: boolean;
  rank: number;
  /** Dimension of the solution space. Solution count is 2^nullity. */
  nullity: number;
  /** One solution, as a bitmask of variables set. Null when unsolvable. */
  particular: number | null;
  /** Basis of the null space, each a bitmask. */
  nullBasis: number[];
}

export function solveGF2(sys: GF2System): GF2Solution {
  const { vars } = sys;
  const rows = [...sys.rows];
  const rhs = [...sys.rhs];
  const n = rows.length;

  const pivotOfCol = new Int32Array(vars).fill(-1);
  let rank = 0;

  for (let col = 0; col < vars && rank < n; col++) {
    let pivot = -1;
    for (let r = rank; r < n; r++) {
      if ((rows[r] >>> col) & 1) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) continue;

    [rows[rank], rows[pivot]] = [rows[pivot], rows[rank]];
    [rhs[rank], rhs[pivot]] = [rhs[pivot], rhs[rank]];

    for (let r = 0; r < n; r++) {
      if (r !== rank && ((rows[r] >>> col) & 1)) {
        rows[r] ^= rows[rank];
        rhs[r] ^= rhs[rank];
      }
    }
    pivotOfCol[col] = rank;
    rank++;
  }

  // Any all-zero row with a 1 on the right is a contradiction.
  for (let r = rank; r < n; r++) {
    if (rows[r] === 0 && rhs[r] === 1) {
      return { solvable: false, rank, nullity: 0, particular: null, nullBasis: [] };
    }
  }

  // Free variables set to zero gives one particular solution.
  let particular = 0;
  for (let col = 0; col < vars; col++) {
    const p = pivotOfCol[col];
    if (p !== -1 && rhs[p] === 1) particular |= 1 << col;
  }

  // Each free column contributes one null-space basis vector.
  const nullBasis: number[] = [];
  for (let free = 0; free < vars; free++) {
    if (pivotOfCol[free] !== -1) continue;
    let vec = 1 << free;
    for (let col = 0; col < vars; col++) {
      const p = pivotOfCol[col];
      if (p !== -1 && ((rows[p] >>> free) & 1)) vec |= 1 << col;
    }
    nullBasis.push(vec);
  }

  return { solvable: true, rank, nullity: nullBasis.length, particular, nullBasis };
}

const popcount = (v: number): number => {
  let n = 0;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
};

/**
 * Fewest taps that solve the level.
 *
 * Walks the whole coset when the null space is small enough to enumerate; the
 * shortest solution is the natural difficulty axis, and knowing it exactly is
 * the thing hand-authored levels never get for free.
 */
export function minWeight(sol: GF2Solution, cap = 1 << 16): { weight: number; exact: boolean } {
  if (!sol.solvable || sol.particular === null) return { weight: -1, exact: true };
  const combos = 1 << sol.nullity;
  if (combos > cap) {
    return { weight: popcount(sol.particular), exact: false };
  }
  let best = popcount(sol.particular);
  for (let mask = 1; mask < combos; mask++) {
    let v = sol.particular;
    for (let b = 0; b < sol.nullity; b++) if ((mask >>> b) & 1) v ^= sol.nullBasis[b];
    const w = popcount(v);
    if (w < best) best = w;
  }
  return { weight: best, exact: true };
}

export { popcount };
