import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError } from "../src/backends/backend.ts";
import { parseIngredientCell } from "../src/datasets/custom.ts";
import { parseDishRow } from "../src/datasets/nutrition5k.ts";
import { dishesFromLinkfile } from "../src/datasets/snapme.ts";
import { ccc, softJaccard } from "../src/metrics.ts";
import { directTotals, parsePrediction, toNumber } from "../src/prompt.ts";
import { usdaTotals, visibleTruthNames } from "../src/report.ts";
import { addUsage, isReusable, resultsKey } from "../src/runner.ts";
import { PROMPT_VERSION } from "../src/prompt.ts";
import { UsdaMatcher, type UsdaFood } from "../src/usda/usda.ts";
import { stratifiedSample } from "../src/util/random.ts";

test("parseDishRow reads 7-field ingredient groups and recomputes zero cafe2 totals", () => {
  const d = parseDishRow(
    "dish_1572974428,0.000000,74.000000,0.000000,0.000000,0.000000,ingr_0000000032,tomatoes,15.5,5.3,0.1,1.0,0.1,ingr_0000000442,hummus,56.0,93.0,5.4,7.8,4.4",
  )!;
  assert.equal(d.ingredients.length, 2);
  assert.equal(d.ingredients[1].name, "hummus");
  assert.equal(d.total_mass_g, 74);
  assert.ok(Math.abs(d.total_calories - 98.3) < 1e-9);
  assert.ok(Math.abs(d.protein_g! - 4.5) < 1e-9);
});

test("SNAPMe link file groups non-packaged lines by photo", () => {
  const csv = [
    '"subject_id","filename","packaged_food","Food_Description","FoodAmt","KCAL","PROT","TFAT","CARB"',
    '"S1","a.jpeg",0,"Cheese, cottage",169.5,137.3,17.7,3.8,8.1',
    '"S1","a.jpeg",0,"Blueberries, raw",37,21.1,0.3,0.1,5.4',
    '"S1","b.jpeg",1,"Granola bar",30,120,2,4,20',
    '"S1","NA",0,"Water",240,0,0,0,0',
  ].join("\n");
  const out = dishesFromLinkfile(csv);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "a.jpeg");
  assert.equal(out[0].dish.id, "snapme_a");
  assert.ok(Math.abs(out[0].dish.total_calories - 158.4) < 1e-9);
  assert.equal(out[0].dish.stratum, "items:2-3");
});

test("custom ingredient cells accept name:grams lists", () => {
  assert.deepEqual(parseIngredientCell("white rice:180; chicken breast:120 ; broccoli"), [
    { name: "white rice", grams: 180 },
    { name: "chicken breast", grams: 120 },
    { name: "broccoli", grams: undefined },
  ]);
});

test("parsePrediction tolerates fences, preamble and string numbers", () => {
  const p = parsePrediction(
    'Sure! ```json\n{"items":[{"name":"Rice","grams":"150 g","calories":195},{"name":"Chicken","grams":100,"calories":"150-170"}],"total_calories":355}\n```',
  );
  assert.equal(p.items.length, 2);
  assert.equal(p.items[0].grams, 150);
  assert.equal(p.items[1].calories, 160);
  assert.equal(directTotals(p).calories, 355);
  assert.equal(directTotals(p).mass_g, 250);
  assert.equal(toNumber("abc"), null);
});

test("parsePrediction rejects non-JSON and wrong shapes", () => {
  assert.throws(() => parsePrediction("I see a salad with about 300 calories."));
  assert.throws(() => parsePrediction('{"foods": []}'));
  assert.deepEqual(parsePrediction('{"items": [], "total_calories": 0}').items, []);
});

test("ccc is 1 for identical series and penalizes bias", () => {
  assert.equal(ccc([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  const biased = ccc([11, 12, 13, 14], [1, 2, 3, 4]);
  assert.ok(biased < 0.1 && biased > 0);
});

test("softJaccard matches names despite preparation words and plurals", () => {
  assert.equal(softJaccard(["Grilled chicken breast", "steamed broccoli"], ["chicken", "broccoli"]), 1);
  assert.equal(softJaccard(["olives"], ["olive"]), 1);
  assert.ok(Math.abs(softJaccard(["rice", "salmon"], ["rice", "beef", "corn"]) - 0.25) < 1e-9);
  assert.equal(softJaccard([], ["rice"]), 0);
});

test("softJaccard requires matching head nouns, so different foods sharing a word don't match", () => {
  assert.equal(softJaccard(["olive oil"], ["olives"]), 0);
  assert.equal(softJaccard(["chicken apple sausage"], ["chicken"]), 0);
  assert.equal(softJaccard(["rice noodles"], ["rice"]), 0);
  assert.equal(softJaccard(["brown rice"], ["white rice"]), 0);
  assert.equal(softJaccard(["apple with skin", "Rice, white"], ["apple", "white rice"]), 1);
});

test("visibleTruthNames ignores tiny ingredients like salt", () => {
  const names = visibleTruthNames({
    id: "x",
    source: "t",
    image: "",
    total_calories: 1,
    ingredients: [{ name: "rice", grams: 150 }, { name: "salt", grams: 0.5 }, { name: "sauce" }],
  });
  assert.deepEqual(names, ["rice", "sauce"]);
});

const foods: UsdaFood[] = [
  { id: 1, description: "Rice, white, long-grain, regular, enriched, cooked", source: "sr", kcal: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3 },
  { id: 2, description: "Rice, white, long-grain, regular, raw, enriched", source: "sr", kcal: 365, protein_g: 7, carbs_g: 80, fat_g: 0.7 },
  { id: 3, description: "Chicken, broilers or fryers, breast, meat only, cooked, roasted", source: "sr", kcal: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  { id: 4, description: "Babyfood, rice and chicken", source: "sr", kcal: 60, protein_g: 3, carbs_g: 8, fat_g: 1 },
  { id: 5, description: "Broccoli, cooked, boiled, drained, without salt", source: "sr", kcal: 35, protein_g: 2.4, carbs_g: 7, fat_g: 0.4 },
  { id: 6, description: "Zucchini, pickled", source: "sr", kcal: 35, protein_g: 1, carbs_g: 7, fat_g: 0.1 },
  { id: 7, description: "Squash, summer, zucchini, includes skin, cooked, boiled, drained, without salt", source: "sr", kcal: 15, protein_g: 1, carbs_g: 3, fat_g: 0.1 },
];

test("UsdaMatcher finds the right generic food and rejects unknown foods", () => {
  const m = new UsdaMatcher(foods);
  assert.equal(m.match("rice white cooked")?.food.id, 1);
  assert.equal(m.match("chicken breast roasted")?.food.id, 3);
  assert.equal(m.match("steamed broccoli")?.food.id, 5);
  assert.equal(m.match("zucchini cooked")?.food.id, 7);
  assert.equal(m.match("pickled zucchini")?.food.id, 6);
  assert.equal(m.match("dragonfruit smoothie"), null);
});

test("usdaTotals uses grams x USDA kcal and falls back to model calories when unmatched", () => {
  const m = new UsdaMatcher(foods);
  const t = usdaTotals(
    {
      items: [
        { name: "rice", usda_query: "rice white cooked", grams: 200, calories: 999, protein_g: null, carbs_g: null, fat_g: null },
        { name: "mystery sauce", grams: 30, calories: 50, protein_g: 0, carbs_g: 5, fat_g: 3 },
      ],
      total_calories: null,
    },
    m,
  );
  assert.equal(t.calories, 260 + 50);
  assert.equal(t.matched, 1);
});

test("stratifiedSample balances strata, is deterministic and capped by availability", () => {
  const items = [...Array.from({ length: 100 }, (_, i) => ({ i, s: "common" })), ...Array.from({ length: 5 }, (_, i) => ({ i, s: "rare" }))];
  const a = stratifiedSample(items, (x) => x.s, 40, 7);
  const b = stratifiedSample(items, (x) => x.s, 40, 7);
  assert.deepEqual(a, b);
  assert.equal(a.length, 40);
  assert.equal(a.filter((x) => x.s === "rare").length, 5);
});

test("runner cache reuse rules include prompt version, image hash and reasoning effort", () => {
  const id = { prompt_version: PROMPT_VERSION, image_sha256: "abc" };
  const base = { dataset: "d", dish_id: "x", model: "m", attempts: 1, timestamp: "", ...id };
  assert.equal(isReusable({ ...base, status: "ok" }, id, false), true);
  assert.equal(isReusable({ ...base, status: "error" }, id, false), false);
  assert.equal(isReusable({ ...base, status: "invalid_json" }, id, false), true);
  assert.equal(isReusable({ ...base, status: "invalid_json" }, id, true), false);
  assert.equal(isReusable({ ...base, status: "ok", prompt_version: "old" }, id, false), false);
  assert.equal(isReusable({ ...base, status: "ok", image_sha256: "other" }, id, false), false);
  assert.equal(isReusable({ ...base, status: "ok" }, { ...id, reasoning_effort: "low" }, false), false);
  assert.equal(resultsKey("n5k", "mock"), "n5k__mock");
  assert.equal(resultsKey("n5k"), "n5k");
});

test("usage is summed across attempts", () => {
  assert.deepEqual(addUsage({ ai_credits: 0.5, input_tokens: 10 }, { ai_credits: 0.25, output_tokens: 3 }), { ai_credits: 0.75, input_tokens: 10, output_tokens: 3 });
});

test("classifyError separates rate limits, transient, rejected input and model errors", () => {
  assert.equal(classifyError("Too Many Requests", 429).kind, "rate_limit");
  assert.equal(classifyError("rate limited, retry after 12 seconds").retryAfterMs, 12000);
  assert.equal(classifyError("upstream error", 503).kind, "transient");
  assert.equal(classifyError('Execution failed: Model "foo" is not available.').kind, "fatal_model");
  assert.equal(classifyError("image rejected by content policy", 400).kind, "rejected");
  assert.equal(classifyError("Bad credentials", 401).kind, "auth");
});

test("directTotals never turns missing values into a silent partial sum", () => {
  const p = parsePrediction('{"items":[{"name":"rice","grams":150,"calories":200},{"name":"chicken","grams":100}],"total_calories":500}');
  assert.equal(directTotals(p).calories, 500);
  assert.equal(directTotals(p).mass_g, 250);
  assert.equal(directTotals(p).protein_g, null);
  assert.equal(directTotals(parsePrediction('{"items":[],"total_calories":0}')).calories, 0);
});

test("parsePrediction repairs trailing commas and an unclosed items array, and flags it", () => {
  const a = parsePrediction('{"items":[{"name":"tofu","grams":120,"calories":180},{"name":"sauce","grams":15,"calories":15},],"total_calories":195}');
  assert.equal(a.items.length, 2);
  assert.equal(a.json_repaired, true);
  const b = parsePrediction('{"items":[{"name":"bread","grams":35,"calories":93},{"name":"herbs","grams":3,"calories":1},"total_calories":94}');
  assert.equal(b.items.length, 2);
  assert.equal(b.total_calories, 94);
  assert.equal(parsePrediction('{"items":[{"name":"a, ] b","calories":1}],"total_calories":1}').json_repaired, undefined);
});

test("parsePrediction rejects malformed items and negative numbers", () => {
  assert.throws(() => parsePrediction('{"items":[null,42,{}]}'));
  assert.throws(() => parsePrediction('{"items":[{"name":"rice","calories":-5}]}'));
});

test("softJaccard uses maximum matching, independent of order", () => {
  const pred = ["white rice", "brown rice"];
  assert.equal(softJaccard(pred, ["rice", "white long grain rice"]), 1);
  assert.equal(softJaccard(pred, ["white long grain rice", "rice"]), 1);
  assert.equal(softJaccard(["broccoli florets"], ["broccoli"]), 1);
});
