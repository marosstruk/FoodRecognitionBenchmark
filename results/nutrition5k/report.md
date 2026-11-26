# Food recognition benchmark — nutrition5k

Generated 2026-11-26T01:43:33.440Z · 400 images · prompt version `caef63b085f0`

## Pipeline A — model estimates calories directly

| Rank | Model | Scored | Fail % | Repaired JSON % | MAE kcal | MAPE % (95% CI) | MedAPE % | Bias kcal | CCC | ±20 % | ±20 % of all | Mass MAPE % | Jaccard | p50 latency s | AI credits / img | $ / 1k img |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | gemini-3.8-flash | 400/400 | 0.0 | 0.0 | 81 | 35.5 (31.8–39.8) | 25.3 | -36 | 0.776 | 40.0 | 40.0 | 26.0 | 0.55 | 9.8 | 0.448 | 4.48 |
| 2 | gpt-6-luna | 400/400 | 0.0 | 0.0 | 95 | 46.7 (41.3–52.5) | 31.0 | 12 | 0.781 | 33.0 | 33.0 | 35.1 | 0.44 | 8.8 | 0.044 | 0.44 |
| 3 | claude-haiku-5.5 | 396/400 | 1.0 | 2.3 | 124 | 75.6 (63.5–90.1) | 40.3 | 60 | 0.703 | 27.0 | 26.8 | 58.7 | 0.47 | 5.5 | 0.058 | 0.58 |
| 4 | mai-code-2-flash | 400/400 | 0.0 | 0.0 | 206 | 154.0 (124.7–189.9) | 71.1 | 147 | 0.483 | 21.0 | 21.0 | 78.8 | 0.27 | 13.0 | 0.029 | 0.29 |

## Pipeline B — model estimates grams, calories looked up in USDA FoodData Central

| Rank | Model | Scored | Fail % | Repaired JSON % | MAE kcal | MAPE % (95% CI) | MedAPE % | Bias kcal | CCC | ±20 % | ±20 % of all | Mass MAPE % | Jaccard | USDA match % | p50 latency s | AI credits / img | $ / 1k img |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | gemini-3.8-flash | 400/400 | 0.0 | 0.0 | 91 | 41.3 (36.5–47.1) | 29.9 | -19 | 0.746 | 33.3 | 33.3 | 26.0 | 0.55 | 95.0 | 9.8 | 0.448 | 4.48 |
| 2 | gpt-6-luna | 400/400 | 0.0 | 0.0 | 104 | 53.1 (46.1–60.9) | 34.4 | 7 | 0.741 | 29.8 | 29.8 | 35.1 | 0.44 | 98.0 | 8.8 | 0.044 | 0.44 |
| 3 | claude-haiku-5.5 | 396/400 | 1.0 | 2.3 | 127 | 77.0 (63.0–94.5) | 42.8 | 62 | 0.682 | 27.0 | 26.8 | 58.7 | 0.47 | 94.2 | 5.5 | 0.058 | 0.58 |
| 4 | mai-code-2-flash | 400/400 | 0.0 | 0.0 | 206 | 148.2 (121.1–182.2) | 66.9 | 148 | 0.483 | 19.0 | 19.0 | 78.8 | 0.27 | 94.7 | 13.0 | 0.029 | 0.29 |

## By number of ingredients on the plate

MAPE % / ±20 % / Jaccard per stratum (successful answers).

**Pipeline A (direct)**

| Model | items:1 (n) | items:2-3 (n) | items:4-6 (n) | items:7+ (n) |
| --- | --- | --- | --- | --- |
| gemini-3.8-flash | 43.8 / 34 / 0.70 (100) | 31.2 / 49 / 0.63 (100) | 38.2 / 39 / 0.59 (100) | 28.8 / 38 / 0.25 (100) |
| gpt-6-luna | 54.2 / 30 / 0.56 (100) | 45.6 / 37 / 0.54 (100) | 54.0 / 26 / 0.47 (100) | 32.8 / 39 / 0.20 (100) |
| claude-haiku-5.5 | 82.1 / 28 / 0.63 (100) | 89.2 / 23 / 0.56 (100) | 73.7 / 27 / 0.50 (97) | 57.0 / 30 / 0.20 (99) |
| mai-code-2-flash | 218.1 / 17 / 0.42 (100) | 147.1 / 16 / 0.32 (100) | 171.1 / 23 / 0.22 (100) | 79.9 / 28 / 0.12 (100) |

**Pipeline B (USDA)**

| Model | items:1 (n) | items:2-3 (n) | items:4-6 (n) | items:7+ (n) |
| --- | --- | --- | --- | --- |
| gemini-3.8-flash | 46.7 / 28 / 0.70 (100) | 31.2 / 37 / 0.63 (100) | 47.1 / 27 / 0.59 (100) | 40.3 / 41 / 0.25 (100) |
| gpt-6-luna | 67.1 / 28 / 0.56 (100) | 48.5 / 38 / 0.54 (100) | 58.4 / 23 / 0.47 (100) | 38.5 / 30 / 0.20 (100) |
| claude-haiku-5.5 | 79.2 / 28 / 0.63 (100) | 91.8 / 24 / 0.56 (100) | 78.9 / 27 / 0.50 (97) | 58.0 / 29 / 0.20 (99) |
| mai-code-2-flash | 211.3 / 14 / 0.42 (100) | 133.0 / 17 / 0.32 (100) | 153.4 / 24 / 0.22 (100) | 95.2 / 21 / 0.12 (100) |

## Direct vs USDA lookup (MAPE %, lower is better)

| Model | Direct | USDA lookup | Better |
| --- | --- | --- | --- |
| gemini-3.8-flash | 35.5 | 41.3 | direct |
| gpt-6-luna | 46.7 | 53.1 | direct |
| claude-haiku-5.5 | 75.6 | 77.0 | direct |
| mai-code-2-flash | 154.0 | 148.2 | USDA |

## Metric definitions

- **MAE kcal** / **MAPE %**: mean absolute calorie error, absolute and relative to the true calories; **MedAPE** is the median relative error. 95% CI is a bootstrap over images.
- **Bias**: mean signed error (positive = overestimates). **CCC**: Lin's concordance correlation (1 = perfect agreement).
- **±20 %**: share of successfully answered meals whose estimate is within 20% of the truth. **±20 % of all**: same, but over every attempted image, counting failures as misses.
- **Jaccard**: soft overlap between predicted and true food names (names match when they share the head noun, e.g. 'grilled chicken breast' ~ 'chicken' but not 'olive oil' ~ 'olives'; maximum 1:1 matching; true ingredients < 3 g ignored).
- **Scored**: successful answers / attempted images. **Fail %**: calls that errored, were refused or returned unusable JSON (over all attempted images); they are excluded from the error metrics. **Repaired JSON %**: answers that were not valid JSON as returned (trailing comma, unclosed bracket) but were fixed by a syntax-only repair and scored.
- **Latency**: wall time of successful calls including session setup.
- **AI credits**: GitHub AI Credits reported by the Copilot runtime, summed over all attempts for an image (1 credit = $0.01). Included plan allowances cover some usage.
