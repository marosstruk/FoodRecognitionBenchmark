import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";
import { ROOT } from "../paths.ts";
import { SYSTEM_PROMPT, USER_PROMPT } from "../prompt.ts";
import type { Usage } from "../types.ts";
import { type AnalyzeResult, BackendError, type VisionBackend, classifyError } from "./backend.ts";

export interface CopilotBackendOptions {
  timeoutMs: number;
  reasoningEffort?: Record<string, string>;
  /** "auto" | "bundled" | path to a copilot executable. */
  runtime?: string;
  log?: (s: string) => void;
}

/**
 * The npm SDK bundles a fixed runtime build, but the GitHub Copilot app keeps a newer one in
 * %LOCALAPPDATA%\copilot-sdk\cli\<version>\ (or ~/.cache/copilot-sdk/cli on Linux/macOS), and newer
 * runtimes can expose models the bundled one doesn't (e.g. gemini-3.8-flash). Picks the newest installed.
 */
export function findInstalledRuntime(): string | undefined {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "copilot-sdk", "cli"),
    join(homedir(), ".cache", "copilot-sdk", "cli"),
    join(homedir(), "Library", "Caches", "copilot-sdk", "cli"),
  ].filter((p): p is string => !!p && existsSync(p));
  const exe = process.platform === "win32" ? "copilot.exe" : "copilot";
  const candidates = roots
    .flatMap((root) => readdirSync(root).map((v) => join(root, v, exe)))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return candidates[0]?.p;
}

export function resolveRuntimePath(setting = "auto"): string | undefined {
  if (process.env.COPILOT_CLI_PATH) return process.env.COPILOT_CLI_PATH;
  if (setting === "bundled") return undefined;
  if (setting === "auto") return findInstalledRuntime();
  return setting;
}

/**
 * Resolves a GitHub token for Copilot. Order: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN,
 * then `gh auth token`. If none is found the runtime falls back to a logged-in Copilot CLI user.
 */
export async function resolveGitHubToken(): Promise<{ token?: string; source: string }> {
  for (const k of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (process.env[k]) return { token: process.env[k], source: k };
  }
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 15_000, windowsHide: true });
    const token = stdout.trim();
    if (token) return { token, source: "gh auth token" };
  } catch {
    // gh not installed or not logged in
  }
  return { source: "Copilot CLI logged-in user" };
}

/** Calls GitHub Copilot models through the official Copilot SDK (same models/billing as Copilot Chat/CLI). */
export class CopilotBackend implements VisionBackend {
  client?: CopilotClient;
  private opts: CopilotBackendOptions;
  constructor(opts: CopilotBackendOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const { token, source } = await resolveGitHubToken();
    this.opts.log?.(`Copilot auth: ${source}`);
    const runtimePath = resolveRuntimePath(this.opts.runtime);
    this.opts.log?.(`Copilot runtime: ${runtimePath ?? "bundled with @microsoft/copilot-sdk"}`);
    this.client = new CopilotClient({
      mode: "empty",
      // stdio keeps the runtime in a child process; sessions live in a private folder, not ~/.copilot.
      runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: join(ROOT, ".copilot-runtime"), ...(runtimePath ? { path: runtimePath } : {}) }),
      ...(token ? { github: { token } } : {}),
    });
    await this.client.start();
    const auth = await this.client.getAuthStatus();
    if (!auth.isAuthenticated) {
      throw new BackendError(`Not authenticated with GitHub Copilot (${auth.statusMessage ?? "unknown"}). See README "Authentication".`, "auth");
    }
    this.opts.log?.(`Signed in as ${auth.login ?? "?"}`);
  }

  async listModels() {
    if (!this.client) throw new Error("backend not started");
    return this.client.listModels();
  }

  async analyze(model: string, image: Buffer, mimeType: string): Promise<AnalyzeResult> {
    const client = this.client;
    if (!client) throw new Error("backend not started");
    const effort = this.opts.reasoningEffort?.[model] ?? this.opts.reasoningEffort?.["*"];
    const t0 = performance.now();
    let session;
    try {
      session = await client.createSession({
        model,
        systemMessage: { mode: "replace", content: SYSTEM_PROMPT },
        tools: { availableTools: [] },
        ...(effort ? { inference: { reasoningEffort: effort } } : {}),
      });
    } catch (err) {
      throw classifyError(`createSession failed: ${(err as Error).message ?? err}`);
    }
    const usage: Usage = {};
    let sessionError: { message: string; statusCode?: number; errorCode?: string } | undefined;
    const off = session.on((e) => {
      if (e.type === "assistant.usage") {
        const d = e.data;
        usage.input_tokens = (usage.input_tokens ?? 0) + (d.inputTokens ?? 0);
        usage.output_tokens = (usage.output_tokens ?? 0) + (d.outputTokens ?? 0);
        usage.reasoning_tokens = (usage.reasoning_tokens ?? 0) + (d.reasoningTokens ?? 0);
        usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + (d.cacheReadTokens ?? 0);
        usage.cache_write_tokens = (usage.cache_write_tokens ?? 0) + (d.cacheWriteTokens ?? 0);
        usage.premium_requests = (usage.premium_requests ?? 0) + (d.cost ?? 0);
        usage.model_duration_ms = (usage.model_duration_ms ?? 0) + (d.duration ?? 0);
      } else if (e.type === "session.usage_checkpoint") {
        const nano = (e.data as { totalNanoAiu?: number }).totalNanoAiu;
        if (typeof nano === "number") usage.ai_credits = nano / 1e9;
      } else if (e.type === "session.error") {
        sessionError = { message: e.data.message, statusCode: e.data.statusCode, errorCode: e.data.errorCode };
      }
    });
    try {
      const reply = await session.sendAndWait(
        { prompt: USER_PROMPT, attachments: [{ type: "blob", data: image.toString("base64"), mimeType, displayName: "meal.jpg" }] },
        this.opts.timeoutMs,
      );
      const latencyMs = performance.now() - t0;
      if (sessionError) throw classifyError(sessionError.message, sessionError.statusCode, sessionError.errorCode);
      const text = reply?.data.content ?? "";
      if (!text) throw new BackendError("empty reply", "transient");
      return { text, usage, latencyMs };
    } catch (err) {
      const se = sessionError;
      const e = err instanceof BackendError ? err : classifyError(se?.message ?? (err as Error).message ?? String(err), se?.statusCode, se?.errorCode);
      e.usage = usage;
      throw e;
    } finally {
      off();
      const id = session.sessionId;
      await session.disconnect().catch(() => {});
      await client.deleteSession(id).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    const errors = await this.client.stop().catch((e) => [e]);
    if (errors.length) await this.client.forceStop().catch(() => {});
  }
}
