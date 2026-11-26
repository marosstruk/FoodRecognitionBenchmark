import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

export interface Config {
  /** Copilot model ids to benchmark (see `foodbench models`). */
  models: string[];
  /** Max concurrent model calls across all models. */
  concurrency: number;
  /** Retries per call for rate limits / transient errors. */
  maxRetries: number;
  /** Per-call timeout. */
  timeoutMs: number;
  /** Longest image side when preparing datasets. */
  maxImageSide: number;
  /** Optional reasoning effort per model id ("*" = all models that support it). */
  reasoningEffort: Record<string, string>;
  /**
   * Copilot runtime to drive: "auto" (newest runtime installed by the GitHub Copilot app, else the
   * SDK's bundled one), "bundled", or a path to a copilot executable. COPILOT_CLI_PATH overrides this.
   */
  runtime: string;
}

export const DEFAULT_CONFIG: Config = {
  models: ["mai-code-2-flash", "gpt-6-luna", "claude-haiku-5.5", "gemini-3.8-flash"],
  concurrency: 4,
  maxRetries: 6,
  timeoutMs: 180_000,
  maxImageSide: 1024,
  reasoningEffort: {},
  runtime: "auto",
};

export async function loadConfig(path = process.env.FOODBENCH_CONFIG ?? join(ROOT, "foodbench.config.json")): Promise<Config> {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...(JSON.parse(await readFile(path, "utf8")) as Partial<Config>) };
}
