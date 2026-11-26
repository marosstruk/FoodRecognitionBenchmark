import { createHash } from "node:crypto";
import type { ParsedPrediction, PredictedItem } from "./types.ts";

/**
 * The single fixed prompt used for every model. Changing it changes PROMPT_VERSION,
 * which invalidates cached results so old and new answers are never mixed.
 */
export const SYSTEM_PROMPT =
  "You are a precise nutrition analysis assistant for a calorie-tracking app. " +
  "You analyse meal photos and reply with a single JSON object only: no markdown, no code fences, no commentary.";

export const USER_PROMPT = `Analyse the food in this photo.

Identify every distinct food that is visible. List separable components individually (for example "white rice", "grilled chicken breast", "steamed broccoli") rather than one dish name; use a dish name only when it cannot be separated (for example "pepperoni pizza", "lentil soup"). Include visible sauces, dressings and toppings that contribute calories.

For each item estimate the edible weight in grams as served, and the nutrition for that weight.

Reply with exactly this JSON structure:
{
  "items": [
    {
      "name": "short common food name",
      "usda_query": "generic description for looking the food up in the USDA FoodData Central database, e.g. 'chicken breast roasted' or 'rice white cooked'",
      "grams": 0,
      "calories": 0,
      "protein_g": 0,
      "carbs_g": 0,
      "fat_g": 0
    }
  ],
  "total_calories": 0
}

Rules: all numbers are plain numbers (no units, no ranges, no strings). total_calories equals the sum of the item calories. If no food is visible, reply {"items": [], "total_calories": 0}.`;

export const PROMPT_VERSION = createHash("sha256").update(SYSTEM_PROMPT + "\n" + USER_PROMPT).digest("hex").slice(0, 12);

/** Accepts numbers, numeric strings ("150", "150 g", "~150") and ranges ("100-150" -> midpoint). */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const range = /(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/.exec(v);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const m = /-?\d+(?:\.\d+)?/.exec(v.replace(/,/g, ""));
  return m ? Number(m[0]) : null;
}

/**
 * Conservative syntax repair for common LLM JSON slips: trailing commas, an array left open before the
 * next object key (`[{...},{...},"total":1}`), and unclosed brackets at the end. Never alters string contents.
 */
export function repairJson(src: string): string {
  let out = "";
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      // A key ("...":) directly inside an array means the array should have been closed.
      if (stack.at(-1) === "[") {
        const end = src.indexOf('"', i + 1);
        if (end > 0 && /^\s*:/.test(src.slice(end + 1))) {
          out = out.replace(/,\s*$/, "") + "],";
          stack.pop();
        }
      }
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      stack.push(c);
      out += c;
    } else if (c === "}" || c === "]") {
      out = out.replace(/,\s*$/, "");
      while (stack.length && stack.at(-1) !== (c === "}" ? "{" : "[")) out += stack.pop() === "{" ? "}" : "]";
      stack.pop();
      out += c;
    } else out += c;
  }
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return out;
}

/** Extracts the first top-level JSON object from a model reply (tolerating fences/preamble). */
export function extractJson(text: string): { value: unknown; repaired: boolean } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inString = false;
  let end = body.length;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const candidate = body.slice(start, end);
  try {
    return { value: JSON.parse(candidate), repaired: false };
  } catch (err) {
    try {
      return { value: JSON.parse(repairJson(candidate)), repaired: true };
    } catch {
      throw err;
    }
  }
}

/** Parses and validates a reply. Throws if it is not usable JSON in the requested shape. */
export function parsePrediction(text: string): ParsedPrediction {
  const { value, repaired } = extractJson(text);
  const obj = value as Record<string, unknown>;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.items)) throw new Error('reply JSON has no "items" array');
  const items: PredictedItem[] = obj.items.map((it, i) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw new Error(`items[${i}] is not an object`);
    const r = it as Record<string, unknown>;
    const item: PredictedItem = {
      name: String(r.name ?? r.food ?? "").trim(),
      usda_query: typeof r.usda_query === "string" ? r.usda_query.trim() : undefined,
      grams: toNumber(r.grams ?? r.weight_g ?? r.weight),
      calories: toNumber(r.calories ?? r.kcal),
      protein_g: toNumber(r.protein_g ?? r.protein),
      carbs_g: toNumber(r.carbs_g ?? r.carbs ?? r.carbohydrates_g),
      fat_g: toNumber(r.fat_g ?? r.fat),
    };
    if (!item.name) throw new Error(`items[${i}] has no name`);
    for (const k of ["grams", "calories", "protein_g", "carbs_g", "fat_g"] as const) {
      if (item[k] !== null && item[k]! < 0) throw new Error(`items[${i}].${k} is negative`);
    }
    return item;
  });
  const total = toNumber(obj.total_calories);
  if (total !== null && total < 0) throw new Error("total_calories is negative");
  if (items.length > 0 && items.every((it) => it.calories === null) && total === null) {
    throw new Error("reply has items but no calorie numbers");
  }
  return { items, total_calories: total, ...(repaired ? { json_repaired: true } : {}) };
}

/** Sum of a field over items, or null unless every item has it (a partial sum would silently under-count). */
export function completeSum(p: ParsedPrediction, k: "grams" | "calories" | "protein_g" | "carbs_g" | "fat_g"): number | null {
  if (p.items.length === 0 || p.items.some((it) => it[k] === null)) return null;
  return p.items.reduce((a, it) => a + it[k]!, 0);
}

/**
 * Direct-estimate pipeline: the model's own calories. Uses the item sum when every item has calories,
 * otherwise the model's stated total; an explicit empty plate counts as 0 kcal.
 */
export function directTotals(p: ParsedPrediction) {
  const itemKcal = completeSum(p, "calories");
  const partial = p.items.reduce((a, it) => a + (it.calories ?? 0), 0);
  return {
    calories: itemKcal ?? p.total_calories ?? partial,
    mass_g: completeSum(p, "grams"),
    protein_g: completeSum(p, "protein_g"),
    carbs_g: completeSum(p, "carbs_g"),
    fat_g: completeSum(p, "fat_g"),
  };
}
