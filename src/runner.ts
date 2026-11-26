import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { VisionBackend } from "./backends/backend.ts";
import { BackendError } from "./backends/backend.ts";
import { RESULTS_DIR, datasetDir, readManifest, safeName } from "./paths.ts";
import { PROMPT_VERSION, directTotals, parsePrediction } from "./prompt.ts";
import type { CallRecord, Dish, Usage } from "./types.ts";
import { mapPool, writeFileAtomic } from "./util/http.ts";

/** Mock results live in a separate tree so they can never be mixed with (or reused as) real model answers. */
export const resultsKey = (dataset: string, backend = "copilot") => (backend === "copilot" ? dataset : `${dataset}__${backend}`);
export const callsDir = (key: string) => join(RESULTS_DIR, key, "calls");
export const callPath = (key: string, model: string, dishId: string) => join(callsDir(key), safeName(model), `${safeName(dishId)}.json`);

export async function readCall(key: string, model: string, dishId: string): Promise<CallRecord | undefined> {
  const p = callPath(key, model, dishId);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(await readFile(p, "utf8")) as CallRecord;
  } catch {
    return undefined; // corrupt/partial file: treat as not done
  }
}

/** Models that have at least one cached call (folder names are safeName(model)). */
export async function cachedModels(key: string): Promise<string[]> {
  if (!existsSync(callsDir(key))) return [];
  const out: string[] = [];
  for (const dir of await readdir(callsDir(key))) {
    const files = (await readdir(join(callsDir(key), dir))).filter((f) => f.endsWith(".json"));
    if (files.length === 0) continue;
    const rec = JSON.parse(await readFile(join(callsDir(key), dir, files[0]), "utf8")) as CallRecord;
    out.push(rec.model);
  }
  return out.sort();
}

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

export interface CacheIdentity {
  prompt_version: string;
  image_sha256: string;
  reasoning_effort?: string;
}

/** True when a cached record was produced with exactly this prompt, image and inference setting. */
export function sameIdentity(rec: CallRecord, id: CacheIdentity): boolean {
  return rec.prompt_version === id.prompt_version && rec.image_sha256 === id.image_sha256 && (rec.reasoning_effort ?? "") === (id.reasoning_effort ?? "");
}

/** A cached record is reused unless its identity differs, it is an error, or (optionally) invalid JSON. */
export function isReusable(rec: CallRecord | undefined, id: CacheIdentity, retryInvalid: boolean): boolean {
  if (!rec || !sameIdentity(rec, id)) return false;
  if (rec.status === "ok") return true;
  if (rec.status === "invalid_json") return !retryInvalid;
  return false;
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return a;
  const out: Usage = { ...a };
  for (const k of Object.keys(b) as (keyof Usage)[]) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

export interface RunOptions {
  dataset: string;
  models: string[];
  backend: VisionBackend;
  /** "copilot" or "mock"; selects the results tree. */
  backendName?: string;
  concurrency: number;
  maxRetries: number;
  limit?: number;
  retryInvalid?: boolean;
  reasoningEffort?: Record<string, string>;
  /** Stop starting new calls once this many AI credits have been spent in this run. */
  maxCredits?: number;
  log?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface ModelState {
  nextAllowedAt: number;
  consecutiveAuthErrors: number;
  disabled?: string;
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

export async function runBenchmark(opts: RunOptions): Promise<{ called: number; cached: number; failed: number; credits: number; stoppedForBudget: boolean }> {
  const log = opts.log ?? console.log;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const key = resultsKey(opts.dataset, opts.backendName);
  let dishes: Dish[] = await readManifest(opts.dataset);
  if (opts.limit !== undefined) dishes = dishes.slice(0, opts.limit);
  const effortOf = (model: string) => opts.reasoningEffort?.[model] ?? opts.reasoningEffort?.["*"];

  const images = new Map<string, { buf: Buffer; sha: string }>();
  for (const d of dishes) {
    const buf = await readFile(join(datasetDir(opts.dataset), d.image));
    images.set(d.id, { buf, sha: sha256(buf) });
  }
  const identity = (dish: Dish, model: string): CacheIdentity => ({ prompt_version: PROMPT_VERSION, image_sha256: images.get(dish.id)!.sha, reasoning_effort: effortOf(model) });

  // Interleave models (dish-major order) so one model's rate limit doesn't stall the whole run.
  const tasks = dishes.flatMap((dish) => opts.models.map((model) => ({ dish, model })));
  const todo: (typeof tasks[number] & { previous?: CallRecord })[] = [];
  for (const t of tasks) {
    const prev = await readCall(key, t.model, t.dish.id);
    if (!isReusable(prev, identity(t.dish, t.model), !!opts.retryInvalid)) {
      // Keep spend from a superseded attempt with the same identity (e.g. --retry-invalid) in the new record.
      todo.push({ ...t, previous: prev && sameIdentity(prev, identity(t.dish, t.model)) ? prev : undefined });
    }
  }
  const cached = tasks.length - todo.length;
  log(`${dishes.length} images x ${opts.models.length} models = ${tasks.length} calls; ${cached} cached, ${todo.length} to run (prompt ${PROMPT_VERSION}).`);

  const state = new Map<string, ModelState>(opts.models.map((m) => [m, { nextAllowedAt: 0, consecutiveAuthErrors: 0 }]));
  let done = 0;
  let failed = 0;
  let called = 0;
  let credits = 0;
  let stoppedForBudget = false;

  await mapPool(todo, opts.concurrency, async ({ dish, model, previous }) => {
    const st = state.get(model)!;
    if (st.disabled || stoppedForBudget) return;
    if (opts.maxCredits !== undefined && credits >= opts.maxCredits) {
      if (!stoppedForBudget) log(`!! Credit budget of ${opts.maxCredits} reached (${credits.toFixed(2)} spent); not starting further calls.`);
      stoppedForBudget = true;
      return;
    }
    const { buf: image } = images.get(dish.id)!;
    const id = identity(dish, model);
    const mime = MIME[extname(dish.image).toLowerCase()] ?? "image/jpeg";
    const rec: CallRecord = { dataset: opts.dataset, dish_id: dish.id, model, ...id, status: "error", attempts: previous?.attempts ?? 0, usage: previous?.usage, timestamp: "" };

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      // Re-check: another worker may have extended this model's cooldown while we slept.
      while (st.nextAllowedAt > Date.now()) await sleep(st.nextAllowedAt - Date.now());
      if (st.disabled) return;
      rec.attempts++;
      called++;
      try {
        const res = await opts.backend.analyze(model, image, mime);
        st.consecutiveAuthErrors = 0;
        credits += res.usage.ai_credits ?? 0;
        rec.raw_text = res.text;
        rec.latency_ms = Math.round(res.latencyMs);
        rec.usage = addUsage(rec.usage, res.usage);
        try {
          rec.parsed = parsePrediction(res.text);
          rec.status = "ok";
          delete rec.error;
        } catch (err) {
          delete rec.parsed;
          rec.status = "invalid_json";
          rec.error = (err as Error).message;
        }
        break;
      } catch (err) {
        const e = err instanceof BackendError ? err : new BackendError(String((err as Error)?.message ?? err), "transient");
        credits += e.usage?.ai_credits ?? 0;
        rec.usage = addUsage(rec.usage, e.usage);
        rec.status = "error";
        rec.error = `[${e.kind}${e.statusCode ? ` ${e.statusCode}` : ""}] ${e.message}`;
        if (e.kind === "fatal_model") {
          st.disabled = e.message;
          log(`!! ${model}: disabled (${e.message})`);
          break;
        }
        if (e.kind === "auth") {
          if (++st.consecutiveAuthErrors >= 3) {
            st.disabled = e.message;
            log(`!! ${model}: disabled after repeated authentication errors (${e.message})`);
          }
          break;
        }
        if (e.kind === "rejected") break; // this image/request was refused; recorded as a failure for this model
        const jitter = Math.random() * 1000;
        const delay =
          e.kind === "rate_limit" ? (e.retryAfterMs ?? Math.min(120_000, 10_000 * 2 ** attempt)) + jitter : Math.min(60_000, 2000 * 2 ** attempt) + jitter;
        if (e.kind === "rate_limit") st.nextAllowedAt = Math.max(st.nextAllowedAt, Date.now() + delay);
        if (attempt < opts.maxRetries) {
          log(`   ${model} ${dish.id}: ${e.kind}, retry ${attempt + 1}/${opts.maxRetries} in ${(delay / 1000).toFixed(0)}s`);
          if (e.kind !== "rate_limit") await sleep(delay);
        }
      }
    }
    rec.timestamp = new Date().toISOString();
    await writeFileAtomic(callPath(key, model, dish.id), JSON.stringify(rec, null, 2));
    done++;
    if (rec.status !== "ok") failed++;
    const kcal = rec.parsed ? Math.round(directTotals(rec.parsed).calories) : "-";
    log(
      `[${done}/${todo.length}] ${model.padEnd(18)} ${dish.id.padEnd(22)} ${rec.status.padEnd(12)} pred=${String(kcal).padStart(5)} true=${String(Math.round(dish.total_calories)).padStart(5)} kcal  ${rec.latency_ms ?? "-"} ms  run credits ${credits.toFixed(2)}${rec.error ? `  ${rec.error.slice(0, 120)}` : ""}`,
    );
  });

  for (const [m, s] of state) if (s.disabled) log(`Model ${m} was disabled: ${s.disabled}`);
  return { called, cached, failed, credits, stoppedForBudget };
}
