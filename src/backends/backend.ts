import type { Usage } from "../types.ts";

export interface AnalyzeResult {
  text: string;
  usage: Usage;
  latencyMs: number;
}

export interface VisionBackend {
  start(): Promise<void>;
  analyze(model: string, image: Buffer, mimeType: string): Promise<AnalyzeResult>;
  stop(): Promise<void>;
}

/**
 * - rate_limit / transient: retried with backoff
 * - rejected: this request/image was refused (content filter, bad input); recorded as a failure, not retried
 * - auth: credentials problem; repeated occurrences disable the model
 * - fatal_model: the model itself is unavailable; disables the model for the run
 */
export type ErrorKind = "rate_limit" | "transient" | "rejected" | "auth" | "fatal_model";

/** Error with a retry classification so the runner knows whether/how long to back off. */
export class BackendError extends Error {
  kind: ErrorKind;
  statusCode?: number;
  retryAfterMs?: number;
  /** Usage already incurred by the failed attempt, so it is still accounted for. */
  usage?: Usage;
  constructor(message: string, kind: ErrorKind, statusCode?: number, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Classifies SDK/runtime failures from their status code and message text. */
export function classifyError(message: string, statusCode?: number, errorCode?: string): BackendError {
  const m = message.toLowerCase();
  const retryAfter = /retry[- ]after[^0-9]*(\d+)/i.exec(message)?.[1] ?? /try again in (\d+)\s*s/i.exec(message)?.[1];
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
  if (statusCode === 429 || errorCode === "rate_limited" || /rate.?limit|too many requests|\b429\b/.test(m)) {
    return new BackendError(message, "rate_limit", statusCode ?? 429, retryAfterMs);
  }
  if (/content.?(filter|policy|management)|responsible ai|safety|blocked|refus/.test(m)) {
    return new BackendError(message, "rejected", statusCode);
  }
  if (
    (statusCode !== undefined && statusCode >= 500) ||
    /timeout|timed out|econnreset|etimedout|socket hang up|network|fetch failed|overloaded|unavailable|\b50[234]\b/.test(m)
  ) {
    // "Model X is not available" is model-wide, not a transient outage.
    if (/model\b.*\bnot available/.test(m)) return new BackendError(message, "fatal_model", statusCode);
    return new BackendError(message, "transient", statusCode, retryAfterMs);
  }
  if (/model\b.*\b(not (found|available|supported|enabled)|unknown)|unsupported model|model.*disabled by|not enabled for/.test(m)) {
    return new BackendError(message, "fatal_model", statusCode);
  }
  if (statusCode === 401 || statusCode === 403 || /not authenticated|unauthori[sz]ed|forbidden|bad credentials/.test(m)) {
    return new BackendError(message, "auth", statusCode);
  }
  if (statusCode !== undefined && statusCode >= 400) return new BackendError(message, "rejected", statusCode);
  return new BackendError(message, "transient", statusCode);
}
