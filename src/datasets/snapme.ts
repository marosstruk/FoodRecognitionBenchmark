import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse/sync";
import tar from "tar-stream";
import type { Dish, TruthIngredient } from "../types.ts";
import { datasetDir, writeManifest } from "../paths.ts";
import { fetchWithRetry, writeFileAtomic } from "../util/http.ts";
import { normalizeImage } from "../util/image.ts";
import { stratifiedSample } from "../util/random.ts";

/** SNAPMe DB v1.0 on USDA Ag Data Commons (figshare article 24856449), ~2 GB tar.gz. */
export const SNAPME_URL = "https://ndownloader.figshare.com/files/44532971";

export interface SnapmeOptions {
  name: string;
  n: number;
  seed: number;
  maxSide: number;
  minKcal: number;
  maxKcal: number;
  /** Local snapme_db_*.tar.gz; if omitted the archive is streamed from figshare. */
  tarball?: string;
  /** Already-extracted `snapme_cs_db` directory. */
  dir?: string;
}

/** A dish plus the SNAPMe photo file name it came from. */
export interface SnapmeCandidate {
  file: string;
  dish: Dish;
}

type Row = Record<string, string>;

const stratum = (n: number) => (n <= 1 ? "items:1" : n <= 3 ? "items:2-3" : "items:4+");

/** Groups ASA24 food-record lines by non-packaged "before" photo; each photo becomes one dish. */
export function dishesFromLinkfile(csvText: string): SnapmeCandidate[] {
  const rows = parse(csvText, { columns: true, skip_empty_lines: true }) as Row[];
  const byFile = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.packaged_food !== "0" || !r.filename || r.filename === "NA") continue;
    let g = byFile.get(r.filename);
    if (!g) byFile.set(r.filename, (g = []));
    g.push(r);
  }
  const num = (s: string | undefined) => (s && s !== "NA" ? Number(s) : 0);
  const out: SnapmeCandidate[] = [];
  for (const [file, lines] of byFile) {
    const ingredients: TruthIngredient[] = lines.map((r) => ({
      name: r.Food_Description,
      grams: num(r.FoodAmt),
      calories: num(r.KCAL),
      protein_g: num(r.PROT),
      fat_g: num(r.TFAT),
      carbs_g: num(r.CARB),
    }));
    const sum = (k: keyof TruthIngredient) => ingredients.reduce((a, x) => a + ((x[k] as number) || 0), 0);
    const id = `snapme_${basename(file).replace(/\.[^.]+$/, "")}`;
    out.push({
      file,
      dish: {
        id,
        source: "snapme",
        image: `images/${id}.jpg`,
        total_calories: sum("calories"),
        total_mass_g: sum("grams"),
        protein_g: sum("protein_g"),
        fat_g: sum("fat_g"),
        carbs_g: sum("carbs_g"),
        ingredients,
        stratum: stratum(ingredients.length),
      },
    });
  }
  return out;
}

function selectSample(csvText: string, opts: SnapmeOptions, log: (s: string) => void): SnapmeCandidate[] {
  const all = dishesFromLinkfile(csvText);
  const eligible = all.filter((c) => c.dish.total_calories >= opts.minKcal && c.dish.total_calories <= opts.maxKcal);
  const sample = stratifiedSample(eligible, (c) => c.dish.stratum!, opts.n, opts.seed);
  log(`SNAPMe: ${all.length} before-photos with food records, ${eligible.length} eligible, sampled ${sample.length} (seed ${opts.seed}).`);
  return sample;
}

/** Maps file name -> full path for every non-empty file under `root` (empty map if missing). */
async function indexFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const rel of await readdir(root, { recursive: true })) {
    const full = join(root, rel);
    const st = statSync(full);
    if (st.isFile() && st.size > 0) out.set(basename(full), full);
  }
  return out;
}

export async function prepareSnapme(opts: SnapmeOptions, log: (s: string) => void = console.log): Promise<Dish[]> {
  const outDir = datasetDir(opts.name);
  await mkdir(join(outDir, "images"), { recursive: true });

  if (opts.dir) {
    const csv = await readFile(join(opts.dir, "master_SNAPME_linkfile.csv"), "utf8");
    const dishes: Dish[] = [];
    let nutIndex: Map<string, string> | undefined;
    for (const { file, dish } of selectSample(csv, opts, log)) {
      let src: string | undefined = join(opts.dir, "before_photos", file);
      // before_photos holds symlinks that often don't survive extraction on Windows; fall back to snapme_nut_db.
      if (!existsSync(src) || statSync(src).size === 0) {
        nutIndex ??= await indexFiles(join(opts.dir, "..", "snapme_nut_db"));
        src = nutIndex.get(file);
      }
      if (!src) {
        log(`WARNING: photo not found: ${file}`);
        continue;
      }
      const dest = join(outDir, dish.image);
      if (!existsSync(dest)) await writeFileAtomic(dest, await normalizeImage(src, opts.maxSide));
      dishes.push(dish);
    }
    log(`Wrote ${dishes.length} dishes to ${await writeManifest(opts.name, dishes)}`);
    return dishes;
  }

  // Stream the archive once: the link file comes first, then only the sampled photos are kept.
  let source: Readable;
  if (opts.tarball) {
    source = createReadStream(opts.tarball);
  } else {
    log(`Streaming SNAPMe archive (~2 GB) from ${SNAPME_URL}; only sampled photos are written to disk...`);
    const res = await fetchWithRetry(SNAPME_URL);
    source = Readable.fromWeb(res.body as WebReadableStream);
  }

  let wanted: Map<string, Dish> | undefined;
  const dishes: Dish[] = [];
  let bytes = 0;
  let lastReport = 0;
  source.on("data", (c: Buffer | string) => {
    bytes += c.length;
    if (bytes - lastReport > 200 * 1024 * 1024) {
      lastReport = bytes;
      log(`  streamed ${(bytes / 1024 / 1024).toFixed(0)} MB, extracted ${dishes.length}/${wanted?.size ?? "?"} photos`);
    }
  });

  const extract = tar.extract();
  const EARLY_EXIT = new Error("all sampled photos extracted");
  extract.on("entry", (header, stream, next) => {
    const isLinkfile = /snapme_cs_db\/master_SNAPME_linkfile\.csv$/.test(header.name);
    // cs_db/before_photos entries are symlinks into snapme_nut_db/<participant>/<day>/, where the
    // real JPEG has the same (unique, hash-like) file name, so match regular files by name.
    const isPhotoFile = header.type === "file" && (header.size ?? 0) > 0;
    const photo = isPhotoFile ? header.name.split("/").pop() : undefined;
    const dish = photo ? wanted?.get(photo) : undefined;
    if (dish && dishes.some((d) => d.id === dish.id)) {
      stream.on("end", () => next());
      stream.resume();
      return;
    }
    if (!isLinkfile && !dish) {
      stream.on("end", () => next());
      stream.resume();
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("end", async () => {
      try {
        const buf = Buffer.concat(chunks);
        if (isLinkfile) {
          wanted = new Map(selectSample(buf.toString("utf8"), opts, log).map((c) => [c.file, c.dish]));
        } else if (dish) {
          const dest = join(outDir, dish.image);
          if (!existsSync(dest)) await writeFileAtomic(dest, await normalizeImage(buf, opts.maxSide));
          dishes.push(dish);
          if (wanted && dishes.length === wanted.size) return next(EARLY_EXIT);
        }
        next();
      } catch (err) {
        next(err as Error);
      }
    });
  });

  try {
    await pipeline(source, createGunzip(), extract);
  } catch (err) {
    if (err !== EARLY_EXIT) throw err;
  } finally {
    source.destroy();
  }
  if (!wanted) throw new Error("master_SNAPME_linkfile.csv not found in archive; extract it and use --dir <snapme_cs_db>.");
  log(`Wrote ${dishes.length} dishes to ${await writeManifest(opts.name, dishes)}`);
  return dishes;
}
