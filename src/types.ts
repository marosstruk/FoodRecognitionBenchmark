/** One ground-truth ingredient / food line of a dish. */
export interface TruthIngredient {
  name: string;
  grams?: number;
  calories?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
}

/** One benchmark image with its ground truth, as stored in a dataset manifest (JSONL). */
export interface Dish {
  id: string;
  source: string;
  /** Image path relative to the dataset directory. */
  image: string;
  total_calories: number;
  total_mass_g?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  ingredients: TruthIngredient[];
  /** Stratum label used for sampling (e.g. "items:2-3"). */
  stratum?: string;
}

export interface PredictedItem {
  name: string;
  usda_query?: string;
  grams: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

export interface ParsedPrediction {
  items: PredictedItem[];
  total_calories: number | null;
  /** The reply was not valid JSON as returned and needed a syntax repair (trailing comma, unclosed bracket). */
  json_repaired?: boolean;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** `cost` reported by the runtime on assistant.usage (premium-request count). */
  premium_requests?: number;
  /** GitHub AI Credits consumed (session.usage_checkpoint totalNanoAiu / 1e9). 1 credit = $0.01. */
  ai_credits?: number;
  /** Model-side duration reported by the runtime. */
  model_duration_ms?: number;
}

export type CallStatus = "ok" | "invalid_json" | "error";

/** Cached result of one model call on one image. */
export interface CallRecord {
  dataset: string;
  dish_id: string;
  model: string;
  prompt_version: string;
  /** Hash of the exact image bytes sent; part of the cache identity. */
  image_sha256?: string;
  reasoning_effort?: string;
  status: CallStatus;
  error?: string;
  raw_text?: string;
  parsed?: ParsedPrediction;
  /** Wall time of the successful attempt, including session setup. */
  latency_ms?: number;
  attempts: number;
  /** Usage summed over every attempt for this image (including failed/retried ones). */
  usage?: Usage;
  timestamp: string;
}
