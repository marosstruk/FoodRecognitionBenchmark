# Food recognition benchmark — nutrition5k

Generated 2026-11-26T01:43:35.418Z · 400 images · prompt version `caef63b085f0`

## Pipeline A — model estimates calories directly

| Rank | Model | Scored | Fail % | Repaired JSON % | MAE kcal | MAPE % (95% CI) | MedAPE % | Bias kcal | CCC | ±20 % | ±20 % of all | Mass MAPE % | Jaccard | p50 latency s | AI credits / img | $ / 1k img |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | gemini-3.8-flash | 396/400 | 0.0 | 0.0 | 81 | 35.6 (32.0–39.9) | 25.3 | -35 | 0.777 | 39.6 | 40.0 | 26.0 | 0.54 | 9.8 | 0.448 | 4.48 |
| 2 | gpt-6-luna | 396/400 | 0.0 | 0.0 | 95 | 46.4 (41.1–52.4) | 30.7 | 12 | 0.783 | 33.1 | 33.0 | 35.3 | 0.44 | 8.8 | 0.044 | 0.44 |
| 3 | claude-haiku-5.5 | 396/400 | 1.0 | 2.3 | 124 | 75.6 (63.5–90.1) | 40.3 | 60 | 0.703 | 27.0 | 26.8 | 58.7 | 0.47 | 5.5 | 0.058 | 0.58 |
| 4 | mai-code-2-flash | 396/400 | 0.0 | 0.0 | 207 | 155.1 (125.7–188.1) | 71.1 | 148 | 0.482 | 20.7 | 21.0 | 79.3 | 0.27 | 13.0 | 0.029 | 0.29 |

## Pipeline B — model estimates grams, calories looked up in USDA FoodData Central

| Rank | Model | Scored | Fail % | Repaired JSON % | MAE kcal | MAPE % (95% CI) | MedAPE % | Bias kcal | CCC | ±20 % | ±20 % of all | Mass MAPE % | Jaccard | USDA match % | p50 latency s | AI credits / img | $ / 1k img |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | gemini-3.8-flash | 396/400 | 0.0 | 0.0 | 91 | 41.6 (36.5–47.6) | 30.1 | -19 | 0.746 | 33.1 | 33.3 | 26.0 | 0.54 | 95.0 | 9.8 | 0.448 | 4.48 |
| 2 | gpt-6-luna | 396/400 | 0.0 | 0.0 | 103 | 52.9 (46.1–60.8) | 34.3 | 8 | 0.743 | 29.8 | 29.8 | 35.3 | 0.44 | 98.0 | 8.8 | 0.044 | 0.44 |
| 3 | claude-haiku-5.5 | 396/400 | 1.0 | 2.3 | 127 | 77.0 (63.0–94.5) | 42.8 | 62 | 0.682 | 27.0 | 26.8 | 58.7 | 0.47 | 94.2 | 5.5 | 0.058 | 0.58 |
| 4 | mai-code-2-flash | 396/400 | 0.0 | 0.0 | 207 | 149.3 (122.0–181.3) | 67.5 | 148 | 0.482 | 18.9 | 19.0 | 79.3 | 0.27 | 94.8 | 13.0 | 0.029 | 0.29 |

## By number of ingredients on the plate

MAPE % / ±20 % / Jaccard per stratum (successful answers).

**Pipeline A (direct)**

| Model | items:1 (n) | items:2-3 (n) | items:4-6 (n) | items:7+ (n) |
| --- | --- | --- | --- | --- |
| gemini-3.8-flash | 43.8 / 34 / 0.70 (100) | 31.2 / 49 / 0.63 (100) | 38.6 / 38 / 0.59 (97) | 29.0 / 37 / 0.25 (99) |
| gpt-6-luna | 54.2 / 30 / 0.56 (100) | 45.6 / 37 / 0.54 (100) | 53.2 / 26 / 0.47 (97) | 32.6 / 39 / 0.19 (99) |
| claude-haiku-5.5 | 82.1 / 28 / 0.63 (100) | 89.2 / 23 / 0.56 (100) | 73.7 / 27 / 0.50 (97) | 57.0 / 30 / 0.20 (99) |
| mai-code-2-flash | 218.1 / 17 / 0.42 (100) | 147.1 / 16 / 0.32 (100) | 175.2 / 22 / 0.22 (97) | 79.9 / 28 / 0.12 (99) |

**Pipeline B (USDA)**

| Model | items:1 (n) | items:2-3 (n) | items:4-6 (n) | items:7+ (n) |
| --- | --- | --- | --- | --- |
| gemini-3.8-flash | 46.7 / 28 / 0.70 (100) | 31.2 / 37 / 0.63 (100) | 47.8 / 27 / 0.59 (97) | 40.7 / 40 / 0.25 (99) |
| gpt-6-luna | 67.1 / 28 / 0.56 (100) | 48.5 / 38 / 0.54 (100) | 57.6 / 23 / 0.47 (97) | 38.6 / 30 / 0.19 (99) |
| claude-haiku-5.5 | 79.2 / 28 / 0.63 (100) | 91.8 / 24 / 0.56 (100) | 78.9 / 27 / 0.50 (97) | 58.0 / 29 / 0.20 (99) |
| mai-code-2-flash | 211.3 / 14 / 0.42 (100) | 133.0 / 17 / 0.32 (100) | 157.4 / 24 / 0.22 (97) | 95.3 / 21 / 0.12 (99) |

## Direct vs USDA lookup (MAPE %, lower is better)

| Model | Direct | USDA lookup | Better |
| --- | --- | --- | --- |
| gemini-3.8-flash | 35.6 | 41.6 | direct |
| gpt-6-luna | 46.4 | 52.9 | direct |
| claude-haiku-5.5 | 75.6 | 77.0 | direct |
| mai-code-2-flash | 155.1 | 149.3 | USDA |

## Metric definitions

- **MAE kcal** / **MAPE %**: mean absolute calorie error, absolute and relative to the true calories; **MedAPE** is the median relative error. 95% CI is a bootstrap over images.
- **Bias**: mean signed error (positive = overestimates). **CCC**: Lin's concordance correlation (1 = perfect agreement).
- **±20 %**: share of successfully answered meals whose estimate is within 20% of the truth. **±20 % of all**: same, but over every attempted image, counting failures as misses.
- **Jaccard**: soft overlap between predicted and true food names (names match when they share the head noun, e.g. 'grilled chicken breast' ~ 'chicken' but not 'olive oil' ~ 'olives'; maximum 1:1 matching; true ingredients < 3 g ignored).
- **Scored**: successful answers / attempted images. **Fail %**: calls that errored, were refused or returned unusable JSON (over all attempted images); they are excluded from the error metrics. **Repaired JSON %**: answers that were not valid JSON as returned (trailing comma, unclosed bracket) but were fixed by a syntax-only repair and scored.
- **Latency**: wall time of successful calls including session setup.
- **AI credits**: GitHub AI Credits reported by the Copilot runtime, summed over all attempts for an image (1 credit = $0.01). Included plan allowances cover some usage.

## Notes

- Accuracy metrics restricted to the 396/400 images every model answered successfully (--common); failure rate, cost and latency still cover all attempted images.
