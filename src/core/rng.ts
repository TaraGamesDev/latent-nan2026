/**
 * Small seeded PRNG (mulberry32).
 *
 * Every stochastic decision in the engine draws from one of these rather than
 * Math.random, so a run can be replayed exactly from its seed. That is what
 * makes the offline tuning results in the tech write-up reproducible, and it
 * means a judge can be handed a seed and see the identical sequence.
 */
export interface Rng {
  (): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.int = (maxExclusive: number) => (next() * maxExclusive) | 0;
  rng.pick = <T,>(items: readonly T[]): T => items[(next() * items.length) | 0];
  rng.shuffle = <T,>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = (next() * (i + 1)) | 0;
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  return rng;
}

/** Seed derived from the clock, for a fresh run the player did not choose. */
export const randomSeed = (): number => (Math.random() * 0xffffffff) >>> 0;
