import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dish, TruthIngredient } from "../types.ts";
import { datasetDir, writeManifest } from "../paths.ts";
import { fetchBuffer, fetchText, mapPool, writeFileAtomic } from "../util/http.ts";
import { normalizeImage } from "../util/image.ts";
import { stratifiedSample } from "../util/random.ts";

const BUCKET = "nutrition5k_dataset";
const PREFIX = "nutrition5k_dataset";
const OBJ = (path: string) => `https://storage.googleapis.com/${BUCKET}/${PREFIX}/${path}`;
const METADATA_FILES = ["metadata/dish_metadata_cafe1.csv", "metadata/dish_metadata_cafe2.csv"];

export interface Nutrition5kOptions {
  name: string;
  n: number;
  seed: number;
  split: "all" | "train" | "test";
  maxSide: number;
  minKcal: number;
  maxKcal: number;
}

/**
 * Parses one row of dish_metadata_cafe{1,2}.csv:
 * dish_id, total_calories, total_mass, total_fat, total_carb, total_protein,
 * then 7 fields per ingredient: id, name, grams, calories, fat, carb, protein.
 * Ingredient names never contain commas, so a plain split is safe.
 */
export function parseDishRow(line: string): Omit<Dish, "source" | "image"> | null {
  const f = line.trim().split(",");
  if (f.length < 6 || !f[0].startsWith("dish_")) return null;
  const num = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));
  const ingredients: TruthIngredient[] = [];
  for (let i = 6; i + 6 < f.length; i += 7) {
    ingredients.push({
      name: f[i + 1].trim(),
      grams: num(f[i + 2]),
      calories: num(f[i + 3]),
      fat_g: num(f[i + 4]),
      carbs_g: num(f[i + 5]),
      protein_g: num(f[i + 6]),
    });
  }
  const sum = (k: keyof TruthIngredient) => ingredients.reduce((a, x) => a + ((x[k] as number) || 0), 0);
  // cafe2 rows carry zeros in the dish-level totals, so fall back to summing ingredients.
  const pick = (headerVal: number, k: keyof TruthIngredient) => (headerVal > 0 ? headerVal : sum(k));
  return {
    id: f[0],
    total_calories: pick(num(f[1]), "calories"),
    total_mass_g: pick(num(f[2]), "grams"),
    fat_g: pick(num(f[3]), "fat_g"),
    carbs_g: pick(num(f[4]), "carbs_g"),
    protein_g: pick(num(f[5]), "protein_g"),
    ingredients,
  };
}

export function ingredientStratum(nIngredients: number): string {
  if (nIngredients <= 1) return "items:1";
  if (nIngredients <= 3) return "items:2-3";
  if (nIngredients <= 6) return "items:4-6";
  return "items:7+";
}

async function listOverheadDishIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`);
    url.searchParams.set("prefix", `${PREFIX}/imagery/realsense_overhead/`);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("fields", "prefixes,nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = JSON.parse(await fetchText(url.toString())) as { prefixes?: string[]; nextPageToken?: string };
    for (const p of page.prefixes ?? []) {
      const m = /(dish_\d+)\/$/.exec(p);
      if (m) ids.add(m[1]);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

async function cachedText(dir: string, file: string, url: string): Promise<string> {
  const path = join(dir, "raw", file.replace(/\//g, "_"));
  if (existsSync(path)) return readFile(path, "utf8");
  const text = await fetchText(url);
  await writeFileAtomic(path, text);
  return text;
}

export async function prepareNutrition5k(opts: Nutrition5kOptions, log: (s: string) => void = console.log): Promise<Dish[]> {
  const dir = datasetDir(opts.name);
  await mkdir(join(dir, "images"), { recursive: true });

  log("Downloading Nutrition5k dish metadata (~2.3 MB)...");
  const all: Omit<Dish, "source" | "image">[] = [];
  for (const f of METADATA_FILES) {
    for (const line of (await cachedText(dir, f, OBJ(f))).split(/\r?\n/)) {
      const d = parseDishRow(line);
      if (d) all.push(d);
    }
  }

  let splitIds: Set<string> | undefined;
  if (opts.split !== "all") {
    const f = `dish_ids/splits/rgb_${opts.split}_ids.txt`;
    splitIds = new Set((await cachedText(dir, f, OBJ(f))).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  }

  log("Listing dishes that have an overhead RGB photo...");
  const overhead = await listOverheadDishIds();

  const eligible = all.filter(
    (d) =>
      overhead.has(d.id) &&
      (!splitIds || splitIds.has(d.id)) &&
      d.ingredients.length > 0 &&
      d.total_calories >= opts.minKcal &&
      d.total_calories <= opts.maxKcal &&
      (d.total_mass_g ?? 0) > 0 &&
      d.total_calories / (d.total_mass_g ?? 1) <= 9.5, // > 9 kcal/g is physically implausible (label error)
  );
  log(`${all.length} dishes in metadata, ${overhead.size} with overhead photos, ${eligible.length} eligible after filters.`);

  const sample = stratifiedSample(eligible, (d) => ingredientStratum(d.ingredients.length), opts.n, opts.seed);
  const counts = new Map<string, number>();
  for (const d of sample) {
    const s = ingredientStratum(d.ingredients.length);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  log(`Sampled ${sample.length} dishes (seed ${opts.seed}): ${[...counts].sort().map(([k, v]) => `${k}=${v}`).join(", ")}`);

  let done = 0;
  const failed: string[] = [];
  const dishes = await mapPool(sample, 8, async (d): Promise<Dish | null> => {
    const rel = `images/${d.id}.jpg`;
    const path = join(dir, rel);
    try {
      if (!existsSync(path)) {
        const png = await fetchBuffer(OBJ(`imagery/realsense_overhead/${d.id}/rgb.png`));
        await writeFileAtomic(path, await normalizeImage(png, opts.maxSide));
      }
    } catch (err) {
      failed.push(`${d.id}: ${err}`);
      return null;
    }
    if (++done % 50 === 0) log(`  images: ${done}/${sample.length}`);
    return { ...d, source: "nutrition5k", image: rel, stratum: ingredientStratum(d.ingredients.length) };
  });
  if (failed.length) log(`WARNING: ${failed.length} image downloads failed:\n  ${failed.slice(0, 10).join("\n  ")}`);
  const ok = dishes.filter((d): d is Dish => d !== null);
  const path = await writeManifest(opts.name, ok);
  log(`Wrote ${ok.length} dishes to ${path}`);
  return ok;
}
