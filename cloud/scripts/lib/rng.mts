/* A seeded PRNG, so the generated catalogue is byte-identical every run.
 *
 * This matters more than it looks. The seed is a *committed artifact*: with
 * Math.random() every regeneration would produce a 7,000-line git diff and
 * nobody could tell a real change from churn. mulberry32 is 4 lines, has a
 * period of 2^32, and passes well enough for fixture data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function int(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** Weighted choice over {key: weight}. Weights need not sum to 1. */
export function weighted(rng: Rng, weights: Record<string, number>): string {
  let total = 0;
  for (const w of Object.values(weights)) total += w;
  let r = rng() * total;
  for (const [k, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(weights)[Object.keys(weights).length - 1];
}

/** n distinct picks, or fewer if the pool is small. */
export function sample<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** A Zipf-ish index into a ranked list: index 0 is far likelier than index n.
 *  Used for keywords, so document frequency has a real long tail and IDF has
 *  range. Without a tail every similarity is the same number and the k-NN step
 *  picks neighbours arbitrarily. */
export function zipf(rng: Rng, n: number, alpha = 1.1): number {
  const r = rng();
  const idx = Math.floor(Math.pow(r, alpha) * n);
  return Math.min(idx, n - 1);
}
