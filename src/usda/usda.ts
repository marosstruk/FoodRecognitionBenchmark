import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { usdaDir } from "../paths.ts";
import { fetchBuffer, writeFileAtomic } from "../util/http.ts";

/** Nutrients per 100 g. */
export interface UsdaFood {
  id: number;
  description: string;
  source: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

const FDC = "https://fdc.nal.usda.gov/fdc-datasets/";
/** Generic (non-branded) FoodData Central datasets. FNDDS ("survey") covers mixed/prepared dishes. */
export const USDA_SOURCES = [
  { source: "sr_legacy", zip: "FoodData_Central_sr_legacy_food_csv_2018-04.zip", dataType: "sr_legacy_food" },
  { source: "fndds", zip: "FoodData_Central_survey_food_csv_2024-10-31.zip", dataType: "survey_fndds_food" },
  { source: "foundation", zip: "FoodData_Central_foundation_food_csv_2025-12-18.zip", dataType: "foundation_food" },
];

/** FDC nutrient ids, plus legacy SR nutrient numbers (208, 203, ...) that the FNDDS survey export uses. */
const NUTRIENTS = { kcal: [1008, 2047, 2048, 208], protein_g: [1003, 203], fat_g: [1004, 204], carbs_g: [1005, 205] } as const;

export const indexPath = () => join(usdaDir(), "foods.json");

function zipEntry(zip: AdmZip, file: string): string {
  const e = zip.getEntries().find((x) => x.entryName.replace(/\\/g, "/").endsWith(`/${file}`) || x.entryName === file);
  if (!e) throw new Error(`${file} not found in zip`);
  return e.getData().toString("utf8");
}

/** Fast splitter for FDC numeric CSVs (fields never contain commas). */
function splitSimple(line: string): string[] {
  return line.split(",").map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
}

export async function buildUsdaIndex(log: (s: string) => void = console.log): Promise<UsdaFood[]> {
  const foods: UsdaFood[] = [];
  for (const src of USDA_SOURCES) {
    const zipPath = join(usdaDir(), src.zip);
    if (!existsSync(zipPath)) {
      log(`Downloading ${src.zip} ...`);
      await writeFileAtomic(zipPath, await fetchBuffer(FDC + src.zip));
    }
    const zip = new AdmZip(zipPath);
    if (!zip.getEntries().some((e) => e.entryName.endsWith("food_nutrient.csv"))) {
      log(`  WARNING: ${src.zip} has no food/food_nutrient tables; skipping ${src.source}.`);
      continue;
    }
    const foodRows = parse(zipEntry(zip, "food.csv"), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    const meta = new Map<number, string>();
    for (const r of foodRows) if (r.data_type === src.dataType) meta.set(Number(r.fdc_id), r.description);

    const lines = zipEntry(zip, "food_nutrient.csv").split(/\r?\n/);
    const header = splitSimple(lines[0]);
    const iFdc = header.indexOf("fdc_id");
    const iNut = header.indexOf("nutrient_id");
    const iAmt = header.indexOf("amount");
    const values = new Map<number, Map<number, number>>();
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const f = splitSimple(lines[i]);
      const fdc = Number(f[iFdc]);
      if (!meta.has(fdc)) continue;
      let m = values.get(fdc);
      if (!m) values.set(fdc, (m = new Map()));
      m.set(Number(f[iNut]), Number(f[iAmt]));
    }
    let added = 0;
    for (const [id, description] of meta) {
      const m = values.get(id);
      const pick = (ids: readonly number[]) => ids.map((n) => m?.get(n)).find((v) => v !== undefined && Number.isFinite(v));
      const kcal = pick(NUTRIENTS.kcal);
      if (kcal === undefined) continue;
      foods.push({ id, description, source: src.source, kcal, protein_g: pick(NUTRIENTS.protein_g) ?? 0, carbs_g: pick(NUTRIENTS.carbs_g) ?? 0, fat_g: pick(NUTRIENTS.fat_g) ?? 0 });
      added++;
    }
    log(`  ${src.source}: ${added} foods`);
  }
  await writeFileAtomic(indexPath(), JSON.stringify(foods));
  log(`USDA index: ${foods.length} foods -> ${indexPath()}`);
  return foods;
}

export async function loadUsdaIndex(): Promise<UsdaFood[]> {
  if (!existsSync(indexPath())) throw new Error(`USDA index missing at ${indexPath()}. Run "foodbench prepare usda" first.`);
  return JSON.parse(await readFile(indexPath(), "utf8")) as UsdaFood[];
}

const STOP = new Set(
  "a an and or of with in on the to from for as nfs ns type made prepared added plain style piece pieces slice slices fresh homemade".split(" "),
);
/** Foods for special populations: never the intended match unless asked for. */
const PENALIZED = ["babyfood", "infant", "formula", "toddler"];
/** Processed forms that differ hugely in energy density from the plain food (dried banana ~4x fresh). */
const PROCESSED = ["dried", "dehydrated", "powder", "dry", "concentrate", "mix", "souffle", "flour", "candied", "freeze", "pickled", "roll", "loaf", "sprouted", "ring"];
/**
 * Preparation / form words. All *other* query words name the food itself and must appear in the
 * matched description ("mung bean sprouts" must not become "mung beans"); these may be missing.
 */
const PREP = new Set(
  (
    "raw cooked boiled steamed baked roasted grilled fried stir fry sauteed braised broiled poached toasted smoked mashed " +
    "chopped sliced diced shredded whole fillet filet piece cut boneless skinless lean fat free low reduced unsalted salted " +
    "salt without drained canned frozen ripe large small medium mixed assorted cubed seasoned"
  )
    .split(" ")
    .map((t) => singular(t)),
);

export function singular(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && /(ches|shes|xes|sses|oes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t))
    .map(singular);
}

export interface UsdaMatch {
  food: UsdaFood;
  score: number;
  coverage: number;
}

/**
 * BM25 matcher over FDC descriptions, tuned for short food names:
 * the head segment (before the first comma, e.g. "Bananas" in "Bananas, raw") is weighted double
 * and must overlap the query for a bonus; unrequested processed forms and extra words are penalized.
 */
export class UsdaMatcher {
  private docs: { food: UsdaFood; tf: Map<string, number>; len: number; head: Set<string> }[];
  private df = new Map<string, number>();
  private avgLen: number;
  private cache = new Map<string, UsdaMatch | null>();
  private minCoverage: number;

  constructor(foods: UsdaFood[], minCoverage = 0.5) {
    this.minCoverage = minCoverage;
    this.docs = foods.map((food) => {
      const [head, ...rest] = food.description.split(",");
      const headToks = tokenize(head);
      const toks = [...headToks, ...headToks, ...tokenize(rest.join(" "))];
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { food, tf, len: toks.length, head: new Set(headToks) };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  private idf(t: string): number {
    const n = this.docs.length;
    const df = this.df.get(t) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  match(query: string): UsdaMatch | null {
    const key = query.toLowerCase().trim();
    if (this.cache.has(key)) return this.cache.get(key)!;
    const q = [...new Set(tokenize(query))].filter((t) => this.df.has(t));
    const qAll = new Set(tokenize(query));
    let best: UsdaMatch | null = null;
    if (q.length > 0) {
      const k1 = 1.2;
      const b = 0.4; // weak length normalisation: long USDA descriptions are usually the precise ones
      // Words absent from the whole database (e.g. "steamed") still count against coverage, at half weight.
      const knownIdf = q.reduce((a, t) => a + this.idf(t), 0);
      const unknownTokens = [...qAll].filter((t) => !this.df.has(t)).length;
      const idfSum = knownIdf + unknownTokens * 0.5 * (knownIdf / q.length);
      const required = q.filter((t) => !PREP.has(t));
      for (const d of this.docs) {
        if (required.some((t) => !d.tf.has(t))) continue;
        let score = 0;
        let hitIdf = 0;
        for (const t of q) {
          const tf = d.tf.get(t);
          if (!tf) continue;
          const idf = this.idf(t);
          hitIdf += idf;
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / this.avgLen));
        }
        if (score === 0) continue;
        const coverage = hitIdf / idfSum;
        let headHits = 0;
        for (const t of d.head) if (qAll.has(t)) headHits++;
        const headMatched = d.head.size > 0 && headHits === d.head.size;
        // A rare modifier ("steamed") must not veto the food itself ("Broccoli, ..."), so a full head match lowers the bar.
        if (coverage < this.minCoverage && !(headMatched && coverage >= 0.25)) continue;
        score += 3 * coverage;
        score += d.head.size ? 3 * (headHits / d.head.size) : 0;
        let extra = 0;
        for (const t of d.tf.keys()) if (!qAll.has(t)) extra++;
        score -= 0.15 * extra;
        let missing = 0;
        for (const t of qAll) if (!d.tf.has(t)) missing++;
        score -= 0.5 * missing;
        const cand = { food: d.food, score, coverage };
        // Baby foods and unrequested processed forms (dried, pickled, powder...) are never substituted.
        if (PENALIZED.some((p) => d.tf.has(p) && !qAll.has(p)) || PROCESSED.some((p) => d.tf.has(p) && !qAll.has(p))) continue;
        if (!best || score > best.score) best = cand;
      }
    }
    this.cache.set(key, best);
    return best;
  }
}
