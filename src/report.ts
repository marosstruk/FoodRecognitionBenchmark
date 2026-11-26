import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RESULTS_DIR, datasetDir, readManifest } from "./paths.ts";
import { PROMPT_VERSION, directTotals, parsePrediction } from "./prompt.ts";
import { bootstrapMeanCI, ccc, mean, median, percentile, softJaccard } from "./metrics.ts";
import { type CacheIdentity, cachedModels, readCall, resultsKey, sameIdentity, sha256 } from "./runner.ts";
import type { CallRecord, Dish, ParsedPrediction } from "./types.ts";
import { UsdaMatcher, indexPath, loadUsdaIndex } from "./usda/usda.ts";
import { writeFileAtomic } from "./util/http.ts";

export type Pipeline = "direct" | "usda";

export interface ImageRow {
  dish_id: string;
  stratum: string;
  model: string;
  pipeline: Pipeline;
  status: string;
  true_kcal: number;
  pred_kcal: number | null;
  abs_err_kcal: number | null;
  pct_err: number | null;
  true_mass_g: number | null;
  pred_mass_g: number | null;
  true_protein_g: number | null;
  pred_protein_g: number | null;
  true_carbs_g: number | null;
  pred_carbs_g: number | null;
  true_fat_g: number | null;
  pred_fat_g: number | null;
  jaccard: number | null;
  n_pred_items: number | null;
  n_true_items: number;
  usda_matched_items: number | null;
  json_repaired: boolean | null;
  latency_ms: number | null;
  ai_credits: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  pred_items: string;
  true_items: string;
  error: string;
}

export interface SummaryRow {
  model: string;
  pipeline: Pipeline;
  n_images: number;
  n_attempted: number;
  n_scored: number;
  failure_rate_pct: number;
  /** Share of attempted calls whose reply needed a JSON syntax repair before it could be parsed. */
  json_repaired_pct: number;
  mae_kcal: number;
  mape_pct: number;
  mape_ci95_low: number;
  mape_ci95_high: number;
  median_ape_pct: number;
  bias_kcal: number;
  ccc: number;
  within_20pct: number;
  /** Share of all attempted images answered successfully AND within ±20 % (failures count as misses). */
  within_20pct_all: number;
  mass_mape_pct: number;
  protein_mae_g: number;
  carbs_mae_g: number;
  fat_mae_g: number;
  ingredient_jaccard: number;
  usda_item_match_pct: number;
  latency_mean_ms: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  ai_credits_per_image: number;
  usd_per_1000_images: number;
  premium_requests: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
}

/** Ground-truth names used for ingredient overlap. Tiny amounts (salt, pepper, a drizzle of oil) are invisible, so ignore < 3 g. */
export function visibleTruthNames(d: Dish): string[] {
  return d.ingredients.filter((i) => i.grams === undefined || !Number.isFinite(i.grams) || i.grams >= 3).map((i) => i.name);
}

/**
 * USDA pipeline: model-estimated grams x USDA kcal per 100 g; items without a confident match (or without grams)
 * keep the model's own numbers. If such an item has no calorie estimate either, the plate total falls back
 * to the direct pipeline's value; macros that can't be completed are null rather than under-counted.
 */
export function usdaTotals(p: ParsedPrediction, matcher: UsdaMatcher) {
  let calories = 0;
  const macros = { protein_g: 0 as number | null, carbs_g: 0 as number | null, fat_g: 0 as number | null };
  let kcalComplete = true;
  let matched = 0;
  for (const it of p.items) {
    const m = it.grams !== null ? (matcher.match(it.usda_query || it.name) ?? (it.usda_query ? matcher.match(it.name) : null)) : null;
    if (m && it.grams !== null) {
      const f = it.grams / 100;
      calories += m.food.kcal * f;
      for (const k of ["protein_g", "carbs_g", "fat_g"] as const) if (macros[k] !== null) macros[k]! += m.food[k] * f;
      matched++;
    } else {
      if (it.calories === null) kcalComplete = false;
      calories += it.calories ?? 0;
      for (const k of ["protein_g", "carbs_g", "fat_g"] as const) macros[k] = macros[k] === null || it[k] === null ? null : macros[k]! + it[k]!;
    }
  }
  if (p.items.length === 0 || !kcalComplete) calories = directTotals(p).calories;
  if (p.items.length === 0) macros.protein_g = macros.carbs_g = macros.fat_g = null;
  return { calories, ...macros, matched };
}

const num = (v: number | null | undefined) => (v === undefined || v === null || !Number.isFinite(v) ? null : v);

export function buildRows(dishes: Dish[], models: string[], calls: Map<string, CallRecord | undefined>, matcher?: UsdaMatcher): ImageRow[] {
  const rows: ImageRow[] = [];
  for (const model of models) {
    for (const d of dishes) {
      const rec = calls.get(`${model}\u0000${d.id}`);
      const pipelines: Pipeline[] = matcher ? ["direct", "usda"] : ["direct"];
      for (const pipeline of pipelines) {
        const base: ImageRow = {
          dish_id: d.id,
          stratum: d.stratum ?? "",
          model,
          pipeline,
          status: rec ? rec.status : "not_run",
          true_kcal: d.total_calories,
          pred_kcal: null,
          abs_err_kcal: null,
          pct_err: null,
          true_mass_g: num(d.total_mass_g),
          pred_mass_g: null,
          true_protein_g: num(d.protein_g),
          pred_protein_g: null,
          true_carbs_g: num(d.carbs_g),
          pred_carbs_g: null,
          true_fat_g: num(d.fat_g),
          pred_fat_g: null,
          jaccard: null,
          n_pred_items: null,
          n_true_items: d.ingredients.length,
          usda_matched_items: null,
          json_repaired: null,
          latency_ms: num(rec?.latency_ms),
          ai_credits: num(rec?.usage?.ai_credits),
          input_tokens: num(rec?.usage?.input_tokens),
          output_tokens: num(rec?.usage?.output_tokens),
          pred_items: "",
          true_items: d.ingredients.map((i) => (i.grams !== undefined ? `${i.name} (${Math.round(i.grams)}g)` : i.name)).join("; "),
          error: rec?.error ?? "",
        };
        if (rec?.status === "ok" && rec.parsed) {
          const p = rec.parsed;
          const direct = directTotals(p);
          const t = pipeline === "direct" ? { ...direct, matched: null } : { ...usdaTotals(p, matcher!), mass_g: direct.mass_g };
          base.pred_kcal = t.calories;
          base.abs_err_kcal = Math.abs(t.calories - d.total_calories);
          base.pct_err = d.total_calories > 0 ? ((t.calories - d.total_calories) / d.total_calories) * 100 : null;
          base.pred_mass_g = t.mass_g;
          base.pred_protein_g = t.protein_g;
          base.pred_carbs_g = t.carbs_g;
          base.pred_fat_g = t.fat_g;
          base.usda_matched_items = t.matched;
          base.json_repaired = !!p.json_repaired;
          base.n_pred_items = p.items.length;
          base.jaccard = softJaccard(p.items.map((i) => i.name), visibleTruthNames(d));
          base.pred_items = p.items.map((i) => `${i.name} (${i.grams ?? "?"}g, ${i.calories ?? "?"} kcal)`).join("; ");
        }
        rows.push(base);
      }
    }
  }
  return rows;
}

/**
 * Reliability, cost and latency are computed over every attempted image. Accuracy metrics use the
 * successfully parsed answers, optionally restricted to `accuracyDishes` (e.g. images every model answered).
 * `within_20pct_all` counts failures as misses, so a model can't look better by failing on hard images.
 */
export function summarize(rows: ImageRow[], accuracyDishes?: Set<string>): SummaryRow[] {
  const groups = new Map<string, ImageRow[]>();
  for (const r of rows) {
    const k = `${r.model}\u0000${r.pipeline}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const out: SummaryRow[] = [];
  for (const g of groups.values()) {
    const attempted = g.filter((r) => r.status !== "not_run");
    const okAll = attempted.filter((r) => r.status === "ok" && r.pred_kcal !== null);
    const ok = accuracyDishes ? okAll.filter((r) => accuracyDishes.has(r.dish_id)) : okAll;
    const okWithin20 = okAll.filter((r) => r.pct_err !== null && Math.abs(r.pct_err) <= 20).length;
    const ape = ok.filter((r) => r.pct_err !== null).map((r) => Math.abs(r.pct_err!));
    const [lo, hi] = bootstrapMeanCI(ape);
    const pairs = (t: keyof ImageRow, p: keyof ImageRow) =>
      ok.filter((r) => r[t] !== null && r[p] !== null).map((r) => [r[t] as number, r[p] as number] as const);
    const mae = (t: keyof ImageRow, p: keyof ImageRow) => mean(pairs(t, p).map(([a, b]) => Math.abs(a - b)));
    const mass = pairs("true_mass_g", "pred_mass_g").filter(([t]) => t > 0);
    const credits = attempted.map((r) => r.ai_credits).filter((x): x is number => x !== null);
    const lat = okAll.map((r) => r.latency_ms).filter((x): x is number => x !== null);
    const usdaItems = ok.reduce((a, r) => a + (r.n_pred_items ?? 0), 0);
    const usdaMatched = ok.reduce((a, r) => a + (r.usda_matched_items ?? 0), 0);
    const creditsPerImage = credits.length ? mean(credits) : NaN;
    out.push({
      model: g[0].model,
      pipeline: g[0].pipeline,
      n_images: g.length,
      n_attempted: attempted.length,
      n_scored: ok.length,
      failure_rate_pct: attempted.length ? ((attempted.length - okAll.length) / attempted.length) * 100 : NaN,
      json_repaired_pct: attempted.length ? (okAll.filter((r) => r.json_repaired).length / attempted.length) * 100 : NaN,
      mae_kcal: mean(ok.map((r) => r.abs_err_kcal!)),
      mape_pct: mean(ape),
      mape_ci95_low: lo,
      mape_ci95_high: hi,
      median_ape_pct: median(ape),
      bias_kcal: mean(ok.map((r) => r.pred_kcal! - r.true_kcal)),
      ccc: ccc(ok.map((r) => r.pred_kcal!), ok.map((r) => r.true_kcal)),
      within_20pct: ape.length ? (ape.filter((x) => x <= 20).length / ape.length) * 100 : NaN,
      within_20pct_all: attempted.length ? (okWithin20 / attempted.length) * 100 : NaN,
      mass_mape_pct: mean(mass.map(([t, p]) => (Math.abs(p - t) / t) * 100)),
      protein_mae_g: mae("true_protein_g", "pred_protein_g"),
      carbs_mae_g: mae("true_carbs_g", "pred_carbs_g"),
      fat_mae_g: mae("true_fat_g", "pred_fat_g"),
      ingredient_jaccard: mean(ok.map((r) => r.jaccard!).filter((x) => x !== null)),
      usda_item_match_pct: g[0].pipeline === "usda" && usdaItems ? (usdaMatched / usdaItems) * 100 : NaN,
      latency_mean_ms: mean(lat),
      latency_p50_ms: percentile(lat, 0.5),
      latency_p95_ms: percentile(lat, 0.95),
      ai_credits_per_image: creditsPerImage,
      usd_per_1000_images: creditsPerImage * 0.01 * 1000,
      premium_requests: 0,
      avg_input_tokens: mean(attempted.map((r) => r.input_tokens).filter((x): x is number => x !== null)),
      avg_output_tokens: mean(attempted.map((r) => r.output_tokens).filter((x): x is number => x !== null)),
    });
  }
  return out.sort((a, b) => (a.pipeline === b.pipeline ? (a.mape_pct || Infinity) - (b.mape_pct || Infinity) : a.pipeline.localeCompare(b.pipeline)));
}

function toCsv<T extends object>(rows: T[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]) as (keyof T)[];
  const esc = (v: unknown) => {
    if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
    const s = typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const f = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "–");

export function markdownReport(dataset: string, nDishes: number, summary: SummaryRow[], notes: string[], strata: (SummaryRow & { stratum: string })[] = []): string {
  const lines: string[] = [];
  lines.push(`# Food recognition benchmark — ${dataset}`, "");
  lines.push(`Generated ${new Date().toISOString()} · ${nDishes} images · prompt version \`${PROMPT_VERSION}\``, "");
  for (const pipeline of ["direct", "usda"] as const) {
    const rows = summary.filter((s) => s.pipeline === pipeline);
    if (!rows.length) continue;
    lines.push(
      pipeline === "direct"
        ? "## Pipeline A — model estimates calories directly"
        : "## Pipeline B — model estimates grams, calories looked up in USDA FoodData Central",
      "",
    );
    lines.push(
      "| Rank | Model | Scored | Fail % | Repaired JSON % | MAE kcal | MAPE % (95% CI) | MedAPE % | Bias kcal | CCC | ±20 % | ±20 % of all | Mass MAPE % | Jaccard | " +
        (pipeline === "usda" ? "USDA match % | " : "") +
        "p50 latency s | AI credits / img | $ / 1k img |",
    );
    lines.push("|" + " --- |".repeat(pipeline === "usda" ? 18 : 17));
    rows.forEach((s, i) => {
      lines.push(
        `| ${i + 1} | ${s.model} | ${s.n_scored}/${s.n_attempted} | ${f(s.failure_rate_pct)} | ${f(s.json_repaired_pct)} | ${f(s.mae_kcal, 0)} |` +
          ` ${f(s.mape_pct)} (${f(s.mape_ci95_low)}–${f(s.mape_ci95_high)}) | ${f(s.median_ape_pct)} | ${f(s.bias_kcal, 0)} | ${f(s.ccc, 3)} | ${f(s.within_20pct)} | ${f(s.within_20pct_all)} | ${f(s.mass_mape_pct)} | ${f(s.ingredient_jaccard, 2)} | ` +
          (pipeline === "usda" ? `${f(s.usda_item_match_pct)} | ` : "") +
          `${f(s.latency_p50_ms / 1000, 1)} | ${f(s.ai_credits_per_image, 3)} | ${f(s.usd_per_1000_images, 2)} |`,
      );
    });
    lines.push("");
  }
  if (strata.length) {
    lines.push("## By number of ingredients on the plate", "", "MAPE % / ±20 % / Jaccard per stratum (successful answers).", "");
    const names = [...new Set(strata.map((s) => s.stratum))].sort();
    for (const pipeline of ["direct", "usda"] as const) {
      const rows = strata.filter((s) => s.pipeline === pipeline);
      if (!rows.length) continue;
      lines.push(`**${pipeline === "direct" ? "Pipeline A (direct)" : "Pipeline B (USDA)"}**`, "");
      lines.push(`| Model | ${names.map((n) => `${n} (n)`).join(" | ")} |`, "|" + " --- |".repeat(names.length + 1));
      for (const m of [...new Set(rows.map((r) => r.model))]) {
        const cells = names.map((n) => {
          const s = rows.find((r) => r.model === m && r.stratum === n);
          return s ? `${f(s.mape_pct)} / ${f(s.within_20pct, 0)} / ${f(s.ingredient_jaccard, 2)} (${s.n_scored})` : "–";
        });
        lines.push(`| ${m} | ${cells.join(" | ")} |`);
      }
      lines.push("");
    }
  }
  const models = [...new Set(summary.map((s) => s.model))];
  if (summary.some((s) => s.pipeline === "usda")) {
    lines.push("## Direct vs USDA lookup (MAPE %, lower is better)", "", "| Model | Direct | USDA lookup | Better |", "| --- | --- | --- | --- |");
    for (const m of models) {
      const a = summary.find((s) => s.model === m && s.pipeline === "direct");
      const b = summary.find((s) => s.model === m && s.pipeline === "usda");
      if (!a || !b) continue;
      const better = !Number.isFinite(a.mape_pct) || !Number.isFinite(b.mape_pct) ? "–" : a.mape_pct <= b.mape_pct ? "direct" : "USDA";
      lines.push(`| ${m} | ${f(a.mape_pct)} | ${f(b.mape_pct)} | ${better} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Metric definitions",
    "",
    "- **MAE kcal** / **MAPE %**: mean absolute calorie error, absolute and relative to the true calories; **MedAPE** is the median relative error. 95% CI is a bootstrap over images.",
    "- **Bias**: mean signed error (positive = overestimates). **CCC**: Lin's concordance correlation (1 = perfect agreement).",
    "- **±20 %**: share of successfully answered meals whose estimate is within 20% of the truth. **±20 % of all**: same, but over every attempted image, counting failures as misses.",
    "- **Jaccard**: soft overlap between predicted and true food names (names match when they share the head noun, e.g. 'grilled chicken breast' ~ 'chicken' but not 'olive oil' ~ 'olives'; maximum 1:1 matching; true ingredients < 3 g ignored).",
    "- **Scored**: successful answers / attempted images. **Fail %**: calls that errored, were refused or returned unusable JSON (over all attempted images); they are excluded from the error metrics. **Repaired JSON %**: answers that were not valid JSON as returned (trailing comma, unclosed bracket) but were fixed by a syntax-only repair and scored.",
    "- **Latency**: wall time of successful calls including session setup.",
    "- **AI credits**: GitHub AI Credits reported by the Copilot runtime, summed over all attempts for an image (1 credit = $0.01). Included plan allowances cover some usage.",
    "",
  );
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

export interface ReportOptions {
  dataset: string;
  models?: string[];
  commonOnly?: boolean;
  /** "copilot" (default) or "mock". */
  backend?: string;
  reasoningEffort?: Record<string, string>;
  log?: (s: string) => void;
}

/**
 * Re-validates a cached record against the current prompt/image and re-parses its raw reply with the
 * current parser, so parser fixes apply without re-calling models and stale answers are never scored.
 */
export function currentRecord(rec: CallRecord | undefined, id: CacheIdentity): CallRecord | undefined {
  if (!rec || !sameIdentity(rec, id)) return undefined;
  if (rec.status === "error" || rec.raw_text === undefined) return rec;
  try {
    return { ...rec, status: "ok", parsed: parsePrediction(rec.raw_text), error: undefined };
  } catch (err) {
    return { ...rec, status: "invalid_json", parsed: undefined, error: (err as Error).message };
  }
}

export async function generateReport(opts: ReportOptions): Promise<{ summary: SummaryRow[]; dir: string; strata: (SummaryRow & { stratum: string })[] }> {
  const log = opts.log ?? console.log;
  const key = resultsKey(opts.dataset, opts.backend);
  let dishes = await readManifest(opts.dataset);
  const models = opts.models?.length ? opts.models : await cachedModels(key);
  if (!models.length) throw new Error(`No results for dataset "${opts.dataset}". Run "foodbench run" first.`);
  const shas = new Map<string, string>();
  for (const d of dishes) shas.set(d.id, sha256(await readFile(join(datasetDir(opts.dataset), d.image))));
  const calls = new Map<string, CallRecord | undefined>();
  let stale = 0;
  for (const m of models) {
    const effort = opts.reasoningEffort?.[m] ?? opts.reasoningEffort?.["*"];
    for (const d of dishes) {
      const raw = await readCall(key, m, d.id);
      const rec = currentRecord(raw, { prompt_version: PROMPT_VERSION, image_sha256: shas.get(d.id)!, reasoning_effort: effort });
      if (raw && !rec) stale++;
      calls.set(`${m}\u0000${d.id}`, rec);
    }
  }

  // Only evaluate images that at least one model has been run on (supports partial runs via --limit).
  dishes = dishes.filter((d) => models.some((m) => calls.get(`${m}\u0000${d.id}`)));
  const notes: string[] = [];
  let accuracyDishes: Set<string> | undefined;
  if (opts.commonOnly) {
    accuracyDishes = new Set(dishes.filter((d) => models.every((m) => calls.get(`${m}\u0000${d.id}`)?.status === "ok")).map((d) => d.id));
    notes.push(
      `Accuracy metrics restricted to the ${accuracyDishes.size}/${dishes.length} images every model answered successfully (--common); failure rate, cost and latency still cover all attempted images.`,
    );
  }
  const notRun = models.map((m) => [m, dishes.filter((d) => !calls.get(`${m}\u0000${d.id}`)).length] as const).filter(([, n]) => n > 0);
  if (notRun.length) notes.push(`Not every model was run on every image: ${notRun.map(([m, n]) => `${m} missing ${n}`).join(", ")}. Use --common for a like-for-like comparison.`);
  if (stale) notes.push(`${stale} cached results were ignored because they came from a different prompt version, image or reasoning setting; re-run to refresh them.`);

  let matcher: UsdaMatcher | undefined;
  if (existsSync(indexPath())) matcher = new UsdaMatcher(await loadUsdaIndex());
  else notes.push('USDA lookup pipeline skipped: run "foodbench prepare usda" to build the FoodData Central index.');

  const rows = buildRows(dishes, models, calls, matcher);
  const summary = summarize(rows, accuracyDishes);
  for (const s of summary) {
    s.premium_requests = dishes.reduce((a, d) => a + (calls.get(`${s.model}\u0000${d.id}`)?.usage?.premium_requests ?? 0), 0);
  }
  const strata = [...new Set(rows.map((r) => r.stratum))].sort().flatMap((stratum) =>
    summarize(rows.filter((r) => r.stratum === stratum), accuracyDishes).map((s) => ({ stratum, ...s })),
  );
  const dir = join(RESULTS_DIR, key);
  const suffix = opts.commonOnly ? "_common" : "";
  await writeFileAtomic(join(dir, "per_image.csv"), toCsv(rows));
  await writeFileAtomic(join(dir, `summary${suffix}.csv`), toCsv(summary));
  await writeFileAtomic(join(dir, `summary${suffix}.json`), JSON.stringify(summary, null, 2));
  await writeFileAtomic(join(dir, `by_stratum${suffix}.csv`), toCsv(strata));
  await writeFileAtomic(join(dir, `report${suffix}.md`), markdownReport(opts.dataset, dishes.length, summary, notes, strata));
  log(`Report written to ${join(dir, `report${suffix}.md`)} (+ summary${suffix}.csv/json, by_stratum${suffix}.csv, per_image.csv)`);
  return { summary, dir, strata };
}
