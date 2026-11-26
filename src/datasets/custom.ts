import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "csv-parse/sync";
import type { Dish, TruthIngredient } from "../types.ts";
import { datasetDir, safeName, writeManifest } from "../paths.ts";
import { writeFileAtomic } from "../util/http.ts";
import { normalizeImage } from "../util/image.ts";

export interface CustomOptions {
  name: string;
  dir: string;
  maxSide: number;
}

interface RawMeal {
  image: string;
  total_calories: number | string;
  total_mass_g?: number | string;
  protein_g?: number | string;
  carbs_g?: number | string;
  fat_g?: number | string;
  ingredients?: string | Array<string | TruthIngredient>;
}

const optNum = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));

/**
 * CSV `ingredients` cells use `;` between items and optional `:grams`, e.g.
 * `white rice:180; chicken breast:120; broccoli`.
 */
export function parseIngredientCell(cell: RawMeal["ingredients"]): TruthIngredient[] {
  if (!cell) return [];
  const parts = typeof cell === "string" ? cell.split(";") : cell;
  return parts
    .map((p): TruthIngredient | null => {
      if (typeof p !== "string") return p.name ? { ...p } : null;
      const [name, grams] = p.split(":").map((s) => s.trim());
      return name ? { name, grams: optNum(grams) } : null;
    })
    .filter((x): x is TruthIngredient => x !== null);
}

export function mealToDish(m: RawMeal): Dish {
  const kcal = Number(m.total_calories);
  if (!m.image || !Number.isFinite(kcal)) throw new Error(`Invalid meal row: ${JSON.stringify(m)}`);
  const ingredients = parseIngredientCell(m.ingredients);
  const id = `custom_${safeName(basename(m.image).replace(/\.[^.]+$/, ""))}`;
  return {
    id,
    source: "custom",
    image: `images/${id}.jpg`,
    total_calories: kcal,
    total_mass_g: optNum(m.total_mass_g),
    protein_g: optNum(m.protein_g),
    carbs_g: optNum(m.carbs_g),
    fat_g: optNum(m.fat_g),
    ingredients,
    stratum: ingredients.length === 0 ? "items:?" : ingredients.length === 1 ? "items:1" : "items:2+",
  };
}

/** Imports `<dir>/meals.json` (array) or `<dir>/meals.csv` plus the referenced images. */
export async function prepareCustom(opts: CustomOptions, log: (s: string) => void = console.log): Promise<Dish[]> {
  const jsonPath = join(opts.dir, "meals.json");
  const csvPath = join(opts.dir, "meals.csv");
  let meals: RawMeal[];
  if (existsSync(jsonPath)) meals = JSON.parse(await readFile(jsonPath, "utf8")) as RawMeal[];
  else if (existsSync(csvPath)) meals = parse(await readFile(csvPath, "utf8"), { columns: true, skip_empty_lines: true, trim: true, bom: true }) as RawMeal[];
  else throw new Error(`Expected ${jsonPath} or ${csvPath}`);

  const outDir = datasetDir(opts.name);
  await mkdir(join(outDir, "images"), { recursive: true });
  const dishes: Dish[] = [];
  for (const m of meals) {
    const dish = mealToDish(m);
    const src = join(opts.dir, m.image);
    if (!existsSync(src)) {
      log(`WARNING: image not found, skipping: ${src}`);
      continue;
    }
    await writeFileAtomic(join(outDir, dish.image), await normalizeImage(src, opts.maxSide));
    dishes.push(dish);
  }
  log(`Wrote ${dishes.length} dishes to ${await writeManifest(opts.name, dishes)}`);
  return dishes;
}
