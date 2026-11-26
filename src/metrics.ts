import { singular } from "./usda/usda.ts";
import { makeRng } from "./util/random.ts";

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const median = (xs: number[]) => percentile(xs, 0.5);

/** Lin's concordance correlation coefficient between predictions and truth. */
export function ccc(pred: number[], truth: number[]): number {
  const n = pred.length;
  if (n < 2) return NaN;
  const mx = mean(pred);
  const my = mean(truth);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (pred[i] - mx) ** 2;
    syy += (truth[i] - my) ** 2;
    sxy += (pred[i] - mx) * (truth[i] - my);
  }
  sxx /= n;
  syy /= n;
  sxy /= n;
  const denom = sxx + syy + (mx - my) ** 2;
  return denom === 0 ? NaN : (2 * sxy) / denom;
}

/** Percentile bootstrap 95% CI of the mean. */
export function bootstrapMeanCI(xs: number[], iters = 2000, seed = 1): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  const rng = makeRng(seed);
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rng() * xs.length)];
    means.push(s / xs.length);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

/** Preparation/qualifier words ignored when comparing food names. */
const NAME_NOISE = new Set(
  (
    "a an and or of with without in on the to from for raw cooked fresh grilled roasted baked fried steamed boiled sauteed sautéed " +
    "sliced chopped diced shredded mixed plain whole small large medium piece pieces slice slices serving portion side style homemade nfs ns " +
    "made prepared lean regular"
  ).split(" "),
);
/** Cuts/forms dropped only when another word remains ("chicken breast" -> chicken, but "steak" stays). */
const CUT_WORDS = new Set("breast thigh leg wing fillet filet steak loin chop cutlet strip strips skin peel floret florets".split(" ").map(singular));

export interface NameInfo {
  tokens: Set<string>;
  /** Head noun: last content word of the main phrase ("white rice" -> rice, "Rice, white" -> rice, "apple with skin" -> apple). */
  head: string;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !NAME_NOISE.has(t) && !/^\d+$/.test(t))
    .map(singular);
}

export function nameInfo(name: string): NameInfo {
  const main = name.toLowerCase().split(/,|\(| with | in | on /)[0];
  let all = words(name);
  let mainWords = words(main);
  if (all.some((t) => !CUT_WORDS.has(t))) all = all.filter((t) => !CUT_WORDS.has(t));
  if (mainWords.some((t) => !CUT_WORDS.has(t))) mainWords = mainWords.filter((t) => !CUT_WORDS.has(t));
  const head = mainWords.at(-1) ?? all.at(-1) ?? "";
  return { tokens: new Set(all), head };
}

export function nameTokens(name: string): Set<string> {
  return nameInfo(name).tokens;
}

/**
 * Two names can only match when each one's head noun appears in the other ("white rice" ~ "rice",
 * but not "olive oil" ~ "olives" or "chicken apple sausage" ~ "chicken"). Score is token Jaccard,
 * raised to 0.5 when one name's words are fully contained in the other's.
 */
export function nameSimilarity(a: NameInfo, b: NameInfo): number {
  if (!a.tokens.size || !b.tokens.size) return 0;
  if (!b.tokens.has(a.head) || !a.tokens.has(b.head)) return 0;
  let inter = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) inter++;
  const jac = inter / (a.tokens.size + b.tokens.size - inter);
  if (inter === a.tokens.size || inter === b.tokens.size) return Math.max(0.5, jac);
  return jac;
}

/**
 * Soft Jaccard between predicted and true food names: names are normalised, deduplicated and
 * matched 1:1 (maximum matching) when similarity >= threshold; J = matches / (|P| + |T| - matches).
 */
export function softJaccard(predNames: string[], truthNames: string[], threshold = 0.5): number {
  const dedupe = (names: string[]) => {
    const seen = new Map<string, NameInfo>();
    for (const n of names) {
      const info = nameInfo(n);
      if (info.tokens.size) seen.set([...info.tokens].sort().join(" "), info);
    }
    return [...seen.values()];
  };
  const P = dedupe(predNames);
  const T = dedupe(truthNames);
  if (!P.length && !T.length) return 1;
  if (!P.length || !T.length) return 0;
  const adj = P.map((p) => T.map((t, j) => (nameSimilarity(p, t) >= threshold ? j : -1)).filter((j) => j >= 0));
  // Maximum-cardinality bipartite matching (Kuhn's augmenting paths), so the result doesn't depend on list order.
  const matchOfT = new Array<number>(T.length).fill(-1);
  const tryAssign = (i: number, seen: boolean[]): boolean => {
    for (const j of adj[i]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (matchOfT[j] < 0 || tryAssign(matchOfT[j], seen)) {
        matchOfT[j] = i;
        return true;
      }
    }
    return false;
  };
  let matches = 0;
  for (let i = 0; i < P.length; i++) if (tryAssign(i, new Array<boolean>(T.length).fill(false))) matches++;
  return matches / (P.length + T.length - matches);
}
