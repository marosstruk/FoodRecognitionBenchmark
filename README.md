# Food Recognition Benchmark

A test harness that benchmarks the **vision models in your GitHub Copilot subscription** on recognising food and estimating calories from meal photos, so you can pick the best model for a calorie-tracking app.

- **Datasets:** [Nutrition5k](https://github.com/google-research-datasets/Nutrition5k) (weighed cafeteria plates; only overhead photos + metadata are downloaded), [SNAPMe](https://agdatacommons.nal.usda.gov/articles/dataset/SNAPMe_A_Benchmark_Dataset_of_Food_Photos_with_Food_Records_for_Evaluation_of_Computer_Vision_Algorithms_in_the_Context_of_Dietary_Assessment/24856449) (real-world phone photos with food records), or **your own weighed meals**.
- **Models:** any Copilot model with vision (Gemini, GPT, Claude, Grok, MAI …), called through the official [GitHub Copilot SDK](https://www.npmjs.com/package/@microsoft/copilot-sdk) with your Copilot login.
- **Two pipelines** from one model call: **A** the model estimates calories directly; **B** the model estimates grams and calories are looked up in **USDA FoodData Central**.
- **Metrics:** calorie MAE (kcal) and MAPE (%) with bootstrap CI, median APE, bias, Lin's CCC, share within ±20 %, mass and macro errors, ingredient overlap (soft Jaccard), failure/invalid-JSON rate, latency, and exact AI-credit cost per image.
- **Resumable:** every model answer is cached on disk; re-running never re-calls a model for an image already done. Rate limits (HTTP 429) and transient errors are retried with backoff.

## Results: Nutrition5k, 400 dishes (run 2026-11-25)

Full report: **[results/nutrition5k/report.md](results/nutrition5k/report.md)** · same-image comparison: [report_common.md](results/nutrition5k/report_common.md) · per ingredient count: [by_stratum.csv](results/nutrition5k/by_stratum.csv) · every prediction: [per_image.csv](results/nutrition5k/per_image.csv).

Setup: 400 Nutrition5k overhead photos, a stratified sample (seed 42) with 100 dishes each of 1, 2–3, 4–6 and 7+ ingredients, 12–1,324 kcal. One fixed prompt, a fresh tool-less session per image, model default reasoning effort. Models (Copilot model IDs): `gemini-3.8-flash`, `gpt-6-luna`, `claude-haiku-5.5`, `mai-code-2-flash`, via `@microsoft/copilot-sdk` 2.0.2 driving Copilot runtime `1.0.115-7`. 1,600 calls, 0 transport errors, **231.8 AI credits (≈ $2.32) in total**.

**Pipeline A: model estimates calories directly**

| Model | MAE kcal | MAPE % | Median APE % | CCC | Within ±20 % | Ingredient Jaccard | Fail % | p50 latency | AI credits / image |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-3.8-flash | **81** | **35.5** | **25.3** | 0.776 | **40.0** | **0.55** | 0.0 | 9.8 s | 0.448 |
| gpt-6-luna | 95 | 46.7 | 31.0 | **0.781** | 33.0 | 0.44 | 0.0 | 8.8 s | 0.044 |
| claude-haiku-5.5 | 124 | 75.6 | 40.3 | 0.703 | 27.0 | 0.47 | 1.0 | **5.5 s** | 0.058 |
| mai-code-2-flash | 206 | 154.0 | 71.1 | 0.483 | 21.0 | 0.27 | 0.0 | 13.0 s | **0.029** |

**Pipeline B: model estimates grams, calories from USDA FoodData Central**

| Model | MAE kcal | MAPE % | Median APE % | CCC | Within ±20 % | USDA item match % |
| --- | --- | --- | --- | --- | --- | --- |
| gemini-3.8-flash | 91 | 41.3 | 29.9 | 0.746 | 33.3 | 95.0 |
| gpt-6-luna | 104 | 53.1 | 34.4 | 0.741 | 29.8 | 98.0 |
| claude-haiku-5.5 | 127 | 77.0 | 42.8 | 0.682 | 27.0 | 94.3 |
| mai-code-2-flash | 206 | 148.2 | 66.9 | 0.483 | 19.0 | 94.7 |

Takeaways:

- **Gemini 3.8 Flash is the most accurate** (lowest error, most meals within ±20 %, best food identification), but costs ~10× more per image than the others.
- **GPT-6 Luna is the best value.** Its calorie agreement (CCC) matches Gemini's at a tenth of the cost.
- **Claude Haiku 5.5 overestimates** (+57 kcal bias, 58 % mass error) and is the fastest. 2.3 % of its replies needed a JSON syntax repair and 1 % were unusable.
- **MAI Code 2 Flash is not usable** for this task: it overestimates portions by ~80 %.
- **Asking the model for calories directly beat the USDA lookup** for 3 of 4 models. The error comes mostly from portion size, not from per-gram energy.
- Even the best model is within ±20 % on only ~40 % of plates. MAPE is inflated by very small portions, so median APE and CCC are the steadier comparisons. Nutrition5k is top-down cafeteria food from California; validate on photos like your users'.

## Why the Copilot SDK (and not GitHub Models)

GitHub Models (the `models.github.ai` inference API) was retired on 30 July 2026, so it can no longer be used. The Copilot SDK drives the same runtime as Copilot CLI and uses your Copilot subscription and billing. The harness verifies this end-to-end: `listModels()` reports a `vision` capability, image limits and token prices per model, images are sent as base64 attachments, and each call reports token usage and exact **GitHub AI Credits** (1 credit = $0.01; your plan's included allowance applies first).

Each image runs in a fresh, tool-less session with the system prompt fully replaced, so models see only the fixed benchmark prompt and the photo.

## Requirements

- Windows, macOS or Linux with **Node.js ≥ 22.18** (TypeScript runs natively; no build step). No Python needed.
- A GitHub account with an active **Copilot** subscription.

```powershell
npm install
```

## Authentication

The harness looks for a GitHub token in this order:

1. `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` environment variables
2. `gh auth token` (if the [GitHub CLI](https://cli.github.com/) is installed and you ran `gh auth login`)
3. the user logged in to Copilot CLI (`copilot` → `/login`)

The simplest setup on Windows is:

```powershell
winget install GitHub.cli   # if you don't have gh yet
gh auth login               # sign in with the account that has Copilot
node src/cli.ts models      # should print "Signed in as <you>" and the model list
```

Or set a token for the current PowerShell session only: `$env:GH_TOKEN = (gh auth token)`. A fine-grained personal access token with the **Copilot Requests** permission also works. Never commit tokens; `.env` is git-ignored and the harness never writes tokens to disk.

## Quick start

```powershell
# 1. Download a stratified sample of 400 Nutrition5k dishes (seed 42) — ~30 MB
node src/cli.ts prepare nutrition5k --n 400 --seed 42

# 2. Build the offline USDA FoodData Central index for pipeline B (~60 MB download, once)
node src/cli.ts prepare usda

# 3. See which vision models your account can use and what they cost
node src/cli.ts models

# 4. Smoke test: 5 images on 2 models
node src/cli.ts run --dataset nutrition5k --models gpt-6-luna,claude-haiku-5.5 --limit 5

# 5. Full run with the models in foodbench.config.json (resumable; Ctrl+C is safe)
node src/cli.ts run --dataset nutrition5k

# 6. Re-generate the report at any time (optionally only on images all models answered)
node src/cli.ts report --dataset nutrition5k --common
```

`npm run foodbench -- <args>` is equivalent to `node src/cli.ts <args>`.

Results go to `results/<dataset>/`:

| File | Contents |
| --- | --- |
| `report.md` | Ranked summary tables for both pipelines, per-ingredient-count breakdown, direct-vs-USDA comparison, metric definitions |
| `summary.csv` / `summary.json` | One row per model × pipeline with every metric |
| `by_stratum.csv` | The same metrics per model × pipeline × ingredient-count stratum |
| `per_image.csv` | One row per image × model × pipeline: truth, prediction, errors, items, latency, credits |
| `calls/<model>/<dish>.json` | Cached raw model reply, parsed JSON, usage, latency (the resume cache) |

## Commands

```text
node src/cli.ts prepare nutrition5k [--n 400] [--seed 42] [--split all|train|test] [--name nutrition5k]
node src/cli.ts prepare snapme      [--n 300] [--seed 42] [--tarball file.tar.gz | --dir snapme_cs_db] [--name snapme]
node src/cli.ts prepare custom      --dir <folder> [--name custom]
node src/cli.ts prepare usda
node src/cli.ts models [--all]
node src/cli.ts run    --dataset <name> [--models a,b] [--limit N] [--concurrency N] [--max-credits N] [--retry-invalid] [--backend copilot|mock] [--no-report]
node src/cli.ts report --dataset <name> [--models a,b] [--common] [--backend copilot|mock]
```

Prepare options: `--max-side 1024` (images are normalised to JPEG with this longest side), `--min-kcal 10`, `--max-kcal 2500`.

- `--limit N` runs the first N images of the manifest. The manifest is stored in shuffled, stratified order, so any prefix is itself a mixed sample; increasing the limit later only calls the new images.
- `--retry-invalid` re-asks models whose earlier reply was not valid JSON (by default those count as failures and are kept). Transport errors are always retried on the next run.
- `--backend mock` exercises the whole pipeline offline without spending credits (results go to `results/<dataset>__mock/`).

## Configuration (`foodbench.config.json`)

```json
{
  "models": ["mai-code-2-flash", "gpt-6-luna", "claude-haiku-5.5", "gemini-3.8-flash"],
  "concurrency": 4,
  "maxRetries": 6,
  "timeoutMs": 180000,
  "maxImageSide": 1024,
  "reasoningEffort": {},
  "runtime": "auto"
}
```

- **models** — Copilot model ids; run `node src/cli.ts models` to see what your account offers. The default is the cheapest model from each family (see [Cost](#cost)). A model that is unavailable or disabled by policy is detected and skipped for the rest of the run.
- **concurrency** — calls in flight across all models. Models are interleaved per image so one model's rate limit doesn't stall the rest.
- **reasoningEffort** — optional per-model effort, e.g. `{"gpt-6-luna": "low", "*": "medium"}` (only for models that support it). Leave empty to use each model's default.
- **runtime** — which Copilot runtime the SDK drives. `"auto"` (default) uses the newest runtime the GitHub Copilot app has installed (`%LOCALAPPDATA%\copilot-sdk\cli\<version>\copilot.exe`) and falls back to the one bundled with the npm package; `"bundled"` forces the npm one; or give a path. The `COPILOT_CLI_PATH` environment variable overrides it. The chosen runtime is printed at start-up. This matters because the model catalog depends on the runtime version: with the bundled `1.0.115` runtime `gemini-3.8-flash` is missing ("Model is not available"), with the app's `1.0.115-7` it works.

### Cost

Cost is measured, not estimated: each record stores the AI credits reported by the runtime (1 credit = $0.01; your plan's included allowance applies first). Measured on Nutrition5k images (~640×480, 2–5 images per model):

| Model | AI credits / image | Token price in/out (credits per 1M) | In default list |
| --- | --- | --- | --- |
| mai-code-2-flash | 0.040 | 10 / 50, 50 % promo until 2027-05-18 (~0.08 after) | yes |
| gpt-6-luna | 0.056 | 10 / 50 | yes |
| claude-haiku-5.5 | 0.079 | 10 / 50 | yes |
| gpt-5.6-luna | 0.131 | 20 / 120 | no |
| mai-code-1.1-flash | 0.244 | 20 / 120 (long reasoning, slow) | no |
| gemini-3.8-flash | 0.564 | ~75 / 375 (derived from measured usage) | yes — cheapest Gemini |
| gemini-4-hydrogen | 1.061 | 150 / 750 | no |

Other vision models cost more again (e.g. `gpt-6.1-terra`, `claude-haiku-4.5` 100/500; `gemini-4-argon`, `claude-sonnet-5.5` 200/1000). With the four default models a **400-image run costs about 0.74 credits/image × 400 ≈ 295 credits (~$2.95)**; Gemini 3.8 Flash is ~75 % of that. Without it (`--models mai-code-2-flash,gpt-6-luna,claude-haiku-5.5`) the run is ≈ 70 credits (~$0.70).

> **Gemini:** every Gemini model costs much more per image than the cheapest GPT/Claude/MAI models (Gemini models use more image tokens and reason longer). Gemini 3.8 Flash is the cheapest one and needs a recent runtime (see `runtime` above); if `node src/cli.ts models` doesn't list it for you, it's not available to your account or runtime and will be skipped.

## Datasets

### Nutrition5k (default)

`prepare nutrition5k` downloads only `metadata/dish_metadata_cafe{1,2}.csv` and the overhead `rgb.png` of the sampled dishes from the public Google Cloud bucket (no `gsutil` needed). Of 5,006 dishes, 3,490 have an overhead photo. Dishes are filtered to 10–2,500 kcal and ≤ 9.5 kcal/g (removes known label errors), then sampled **evenly across ingredient-count strata** (`1`, `2-3`, `4-6`, `7+` ingredients) with a fixed seed, so single items and complex plates are equally represented. Use `--split test` to sample only from the official test split. Totals for cafe2 dishes (which are 0 in the CSV) are recomputed from the ingredients. License: CC BY 4.0.

### SNAPMe (optional)

Real-world phone photos with ASA24 food records (portion sizes are self-reported, so truth is noisier than Nutrition5k). The data is a single ~2 GB `tar.gz`. `prepare snapme` **streams** it from figshare and writes only the sampled non-packaged "before" photos to disk, stopping as soon as all are found. If you already downloaded it, use `--tarball <file>` or `--dir <extracted snapme_cs_db>`. Each photo's truth is the sum of all food-record lines linked to it.

### Your own weighed meals

Put photos in a folder with `meals.csv` (or `meals.json` with the same fields):

```csv
image,total_calories,total_mass_g,protein_g,carbs_g,fat_g,ingredients
lunch1.jpg,640,420,38,72,18,white rice:180; chicken breast:150; broccoli:90
breakfast.jpg,350,,,,,oatmeal; banana; peanut butter
```

Only `image` and `total_calories` are required. `ingredients` is `;`-separated, with optional `:grams`. Then run `node src/cli.ts prepare custom --dir C:\path\to\folder --name mymeals` and `run --dataset mymeals`. Photos are auto-rotated (EXIF) and downscaled.

## The fixed prompt

Every model gets the same system prompt and user prompt (see `src/prompt.ts`) and must return:

```json
{"items": [{"name": "...", "usda_query": "...", "grams": 0, "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}], "total_calories": 0}
```

Replies are parsed leniently (code fences, preamble, `"150 g"`, ranges → midpoint), but a reply without a JSON `items` array, with a malformed item (not an object, no name) or with negative numbers counts as **invalid JSON**. An explicit empty plate (`{"items": [], "total_calories": 0}`) is a valid answer of 0 kcal. If some items lack calories, the model's stated `total_calories` is used instead of a partial sum. Cached replies are re-parsed by the current parser whenever a report is generated.

## Pipeline B: USDA FoodData Central lookup

`prepare usda` downloads three generic FoodData Central datasets — **SR Legacy** (7,793 foods), **FNDDS/Survey** (5,431 foods, covers prepared/mixed dishes) and **Foundation** (377 foods) — and builds a local index (`data/usda/foods.json`, kcal and macros per 100 g). Branded foods are excluded. For each predicted item, the model's `usda_query` (or name) is matched with a BM25 ranker tuned for short food names, then `kcal = grams × kcal per 100 g / 100`. Matching is deliberately conservative:

- every *food* word of the query must appear in the USDA description (preparation words like *cooked*, *grilled*, *sliced* may be missing), so "mung bean sprouts" never becomes "mung beans";
- unrequested processed forms (*dried*, *powder*, *pickled*, *sprouted*, *onion rings*, …) and baby foods are never substituted;
- items without a confident match keep the model's own calories; the report shows the **USDA match %**.

Matcher sanity check: on Nutrition5k's own 555 ingredient names (whose kcal/g came from USDA), it matches 94 % with a median 10 % kcal/g difference.

## Metrics

| Metric | Definition |
| --- | --- |
| MAE kcal | mean \|predicted − true\| calories |
| MAPE % (95 % CI) | mean \|predicted − true\| / true × 100, bootstrap CI over images |
| MedAPE % | median absolute percentage error (robust to outliers) |
| Bias kcal | mean signed error (positive = overestimates) |
| CCC | Lin's concordance correlation coefficient (population moments; agreement, 1 = perfect) |
| ±20 % | share of successfully answered meals within 20 % of true calories |
| ±20 % of all | share of *all attempted* meals answered successfully and within 20 % — failures count as misses, so a model can't gain by failing on hard images |
| Mass MAPE % | error of total grams (model's item grams vs weighed mass) |
| Protein / carbs / fat MAE | grams, in `summary.csv` |
| Jaccard | soft overlap of predicted vs true food names. Names match only when each one's head noun occurs in the other ("grilled chicken breast" ~ "chicken", "white rice" ~ "rice", but not "olive oil" ~ "olives" or "rice noodles" ~ "rice"); preparation words and plurals are ignored; maximum 1:1 matching; true ingredients < 3 g (salt, oil drizzles) ignored |
| Fail % | calls that errored, were refused or returned invalid JSON, over all attempted images (excluded from the error metrics) |
| Latency | wall time of successful calls including session setup (mean, p50, p95) |
| AI credits / img, $ / 1k img | usage reported by Copilot summed over all attempts per image, including retries (1 credit = $0.01) |

`report.md` also breaks MAPE, ±20 % and Jaccard down by ingredient-count stratum (`by_stratum.csv`). `report --common` computes the accuracy metrics on exactly the images every model answered (written to `report_common.md`), while failure rate, cost and latency still cover all attempted images.

## Rate limits, resuming and cost control

- Each finished call is written atomically to `results/<dataset>/calls/…`, so you can stop at any time (Ctrl+C) and re-run the same command to continue.
- The cache key is model + image content hash + prompt version + reasoning effort; changing any of them re-runs that call, and reports ignore stale records. `--backend mock` writes to `results/<dataset>__mock/` so test data can never mix with real answers.
- HTTP 429 / "rate limited" pauses that model for all workers (honouring `retry-after` when given) with exponential backoff up to 2 min; 5xx/timeouts back off up to 1 min; up to `maxRetries` attempts.
- An image the model refuses (content filter, rejected input) is recorded as a failure for that model only. A model that is not available is skipped for the rest of the run; other models continue.
- `--max-credits N` stops starting new calls once N AI credits have been spent in this run (re-run to continue).

## Development

```powershell
npm test            # unit tests (node:test)
npm run typecheck   # tsc --noEmit
```

Source layout: `src/cli.ts` (commands), `src/datasets/*` (Nutrition5k, SNAPMe, custom), `src/backends/copilot.ts` (Copilot SDK), `src/prompt.ts` (fixed prompt + parsing), `src/runner.ts` (cache, concurrency, retries), `src/usda/usda.ts` (FDC index + matcher), `src/metrics.ts`, `src/report.ts`.

## Caveats

- Nutrition5k photos are top-down cafeteria plates from California; SNAPMe portion "truth" is self-reported. Validate the winner on photos that look like your app's users' photos (the custom dataset format exists for this).
- Model names and availability change; the `models` command shows what your account can call today.
- Ingredient Jaccard relies on token matching, so synonyms (e.g. *garbanzo* vs *chickpea*) count as misses for every model alike. A few Nutrition5k dishes have unnamed ingredients; those can't be matched by any model.
- The bootstrap CI resamples images independently and ignores the balanced stratified design, so it is slightly conservative.

## Reproducing the published run

The sample manifest (`data/nutrition5k/manifest.jsonl`: dish IDs, ground truth, strata) and the text-only cached model replies (`results/nutrition5k/calls/`) are committed. Images, USDA files and SNAPMe are not.

```powershell
npm install
node src/cli.ts prepare nutrition5k --n 400 --seed 42   # re-downloads the same 400 photos
node src/cli.ts prepare usda
node src/cli.ts report --dataset nutrition5k            # rebuilds the report from the cached replies, no model calls
```

Running `run --dataset nutrition5k` afterwards reuses every cached answer whose prompt and image hash still match.

## Data sources and attribution

- **Nutrition5k** by Thames et al., Google Research, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: <https://github.com/google-research-datasets/Nutrition5k>. Cite: *Thames, Q. et al. "Nutrition5k: Towards Automatic Nutritional Understanding of Generic Food." CVPR 2021.* The committed manifest contains dish IDs and nutrition labels derived from the dataset's metadata; no images are redistributed.
- **USDA FoodData Central** (SR Legacy, FNDDS, Foundation Foods), U.S. Department of Agriculture, Agricultural Research Service, public domain (CC0). Source: <https://fdc.nal.usda.gov/>.
- **SNAPMe** (optional dataset), USDA Agricultural Research Service, Ag Data Commons. Not included in this repository.

## License

Code is released under the [MIT License](LICENSE). Dataset-derived files keep their original licenses (see above).
