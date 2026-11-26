/** Deterministic PRNG (mulberry32) so dataset sampling is reproducible for a given seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Draws `n` items spread as evenly as possible across strata (so rare strata such as
 * single-item plates are not swamped by the common ones). Strata smaller than their
 * share contribute everything they have; the remainder is redistributed.
 * The returned list is shuffled so that any prefix (`--limit`) is itself a mixed sample.
 */
export function stratifiedSample<T>(items: readonly T[], stratumOf: (item: T) => string, n: number, seed: number): T[] {
  const rng = makeRng(seed);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = stratumOf(item);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(item);
  }
  const keys = [...groups.keys()].sort();
  const pools = new Map(keys.map((k) => [k, shuffle(groups.get(k)!, rng)]));
  const quota = new Map(keys.map((k) => [k, 0]));
  let remaining = Math.min(n, items.length);
  while (remaining > 0) {
    const open = keys.filter((k) => quota.get(k)! < pools.get(k)!.length);
    if (open.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const k of open) {
      if (remaining === 0) break;
      const take = Math.min(share, pools.get(k)!.length - quota.get(k)!, remaining);
      quota.set(k, quota.get(k)! + take);
      remaining -= take;
    }
  }
  const picked = keys.flatMap((k) => pools.get(k)!.slice(0, quota.get(k)!));
  return shuffle(picked, rng);
}
