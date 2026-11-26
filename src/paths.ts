import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Dish } from "./types.ts";
import { writeFileAtomic } from "./util/http.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const DATA_DIR = process.env.FOODBENCH_DATA_DIR ?? join(ROOT, "data");
export const RESULTS_DIR = process.env.FOODBENCH_RESULTS_DIR ?? join(ROOT, "results");

export const datasetDir = (name: string) => join(DATA_DIR, name);
export const manifestPath = (name: string) => join(datasetDir(name), "manifest.jsonl");
export const usdaDir = () => join(DATA_DIR, "usda");

/** Model ids can contain characters that are awkward in file names on Windows. */
export const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");

export async function writeManifest(name: string, dishes: Dish[]): Promise<string> {
  const path = manifestPath(name);
  await writeFileAtomic(path, dishes.map((d) => JSON.stringify(d)).join("\n") + "\n");
  return path;
}

export async function readManifest(name: string): Promise<Dish[]> {
  const path = manifestPath(name);
  if (!existsSync(path)) {
    throw new Error(`No manifest for dataset "${name}" at ${path}. Run "foodbench prepare ..." first.`);
  }
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Dish);
}
