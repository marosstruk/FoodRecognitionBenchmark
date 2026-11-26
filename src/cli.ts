#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { VisionBackend } from "./backends/backend.ts";
import { CopilotBackend } from "./backends/copilot.ts";
import { MockBackend } from "./backends/mock.ts";
import { loadConfig } from "./config.ts";
import { prepareCustom } from "./datasets/custom.ts";
import { prepareNutrition5k } from "./datasets/nutrition5k.ts";
import { prepareSnapme } from "./datasets/snapme.ts";
import { generateReport } from "./report.ts";
import { runBenchmark } from "./runner.ts";
import { buildUsdaIndex } from "./usda/usda.ts";

const HELP = `foodbench — benchmark GitHub Copilot vision models on meal photos

Usage:
  node src/cli.ts prepare nutrition5k [--n 400] [--seed 42] [--split all|train|test] [--name nutrition5k]
  node src/cli.ts prepare snapme      [--n 300] [--seed 42] [--tarball file.tar.gz | --dir snapme_cs_db] [--name snapme]
  node src/cli.ts prepare custom      --dir <folder with meals.csv|meals.json> [--name custom]
  node src/cli.ts prepare usda        (downloads USDA FoodData Central generic foods, ~60 MB)
  node src/cli.ts models [--all]      list Copilot models available to you (vision, pricing)
  node src/cli.ts run    --dataset <name> [--models a,b] [--limit N] [--concurrency N] [--max-credits N] [--retry-invalid] [--backend copilot|mock] [--no-report]
  node src/cli.ts report --dataset <name> [--models a,b] [--common] [--backend copilot|mock]

Common prepare options: --max-side 1024 --min-kcal 10 --max-kcal 2500
Config: foodbench.config.json (models, concurrency, retries, timeout, reasoningEffort).`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      n: { type: "string" },
      seed: { type: "string", default: "42" },
      split: { type: "string", default: "all" },
      name: { type: "string" },
      dir: { type: "string" },
      tarball: { type: "string" },
      "max-side": { type: "string" },
      "min-kcal": { type: "string", default: "10" },
      "max-kcal": { type: "string", default: "2500" },
      dataset: { type: "string" },
      models: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      "retry-invalid": { type: "boolean", default: false },
      backend: { type: "string", default: "copilot" },
      "max-credits": { type: "string" },
      "no-report": { type: "boolean", default: false },
      common: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, sub] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }
  const cfg = await loadConfig();
  const int = (s: string | undefined, d: number) => (s === undefined ? d : Number.parseInt(s, 10));
  const maxSide = int(values["max-side"], cfg.maxImageSide);
  const common = { seed: int(values.seed, 42), maxSide, minKcal: Number(values["min-kcal"]), maxKcal: Number(values["max-kcal"]) };

  if (cmd === "prepare") {
    if (sub === "nutrition5k") {
      const split = values.split as "all" | "train" | "test";
      if (!["all", "train", "test"].includes(split)) throw new Error("--split must be all, train or test");
      await prepareNutrition5k({ ...common, name: values.name ?? "nutrition5k", n: int(values.n, 400), split });
    } else if (sub === "snapme") {
      await prepareSnapme({ ...common, name: values.name ?? "snapme", n: int(values.n, 300), tarball: values.tarball, dir: values.dir });
    } else if (sub === "custom") {
      if (!values.dir) throw new Error("prepare custom requires --dir");
      await prepareCustom({ name: values.name ?? "custom", dir: values.dir, maxSide });
    } else if (sub === "usda") {
      await buildUsdaIndex();
    } else throw new Error(`Unknown dataset "${sub}". Use nutrition5k, snapme, custom or usda.`);
    return;
  }

  if (cmd === "models") {
    const backend = new CopilotBackend({ timeoutMs: cfg.timeoutMs, runtime: cfg.runtime, log: console.log });
    await backend.start();
    try {
      const models = await backend.listModels();
      const configured = new Set(cfg.models);
      console.log("\nmodel id               vision  max img  in/out credits per 1M tok  policy     in config");
      for (const m of models) {
        const vision = m.capabilities?.supports?.vision ?? false;
        if (!vision && !values.all && !configured.has(m.id)) continue;
        const lim = m.capabilities?.limits?.vision;
        const p = m.billing?.tokenPrices;
        console.log(
          `${m.id.padEnd(22)} ${String(vision).padEnd(7)} ${lim?.max_prompt_image_size ? `${(lim.max_prompt_image_size / 1048576).toFixed(0)} MB` : "-"}`.padEnd(40) +
            ` ${p ? `${p.inputPrice}/${p.outputPrice}` : "-"}`.padEnd(26) +
            ` ${(m.policy?.state ?? "-").padEnd(10)} ${configured.has(m.id) ? "yes" : ""}`,
        );
      }
      const missing = cfg.models.filter((id) => !models.some((m) => m.id === id));
      if (missing.length) console.log(`\nWARNING: configured models not available to this account: ${missing.join(", ")}`);
    } finally {
      await backend.stop();
    }
    return;
  }

  if (cmd === "run") {
    if (!values.dataset) throw new Error("run requires --dataset <name>");
    const models = values.models ? values.models.split(",").map((s) => s.trim()).filter(Boolean) : cfg.models;
    const backend: VisionBackend =
      values.backend === "mock"
        ? new MockBackend()
        : new CopilotBackend({ timeoutMs: cfg.timeoutMs, reasoningEffort: cfg.reasoningEffort, runtime: cfg.runtime, log: console.log });
    await backend.start();
    let interrupted = false;
    process.once("SIGINT", () => {
      interrupted = true;
      console.log("\nInterrupted — finished calls are cached; re-run the same command to resume.");
      void backend.stop().finally(() => process.exit(130));
    });
    try {
      const r = await runBenchmark({
        dataset: values.dataset,
        models,
        backend,
        backendName: values.backend,
        concurrency: int(values.concurrency, cfg.concurrency),
        maxRetries: cfg.maxRetries,
        limit: values.limit ? int(values.limit, 0) : undefined,
        retryInvalid: values["retry-invalid"],
        reasoningEffort: cfg.reasoningEffort,
        maxCredits: values["max-credits"] ? Number(values["max-credits"]) : undefined,
      });
      console.log(
        `Done: ${r.called} model calls, ${r.cached} cached, ${r.failed} failed, ${r.credits.toFixed(2)} AI credits spent this run${r.stoppedForBudget ? " (stopped at --max-credits; re-run to continue)" : ""}.`,
      );
    } finally {
      if (!interrupted) await backend.stop();
    }
    if (!values["no-report"]) await generateReport({ dataset: values.dataset, models, backend: values.backend, reasoningEffort: cfg.reasoningEffort });
    return;
  }

  if (cmd === "report") {
    if (!values.dataset) throw new Error("report requires --dataset <name>");
    const models = values.models?.split(",").map((s) => s.trim()).filter(Boolean);
    await generateReport({ dataset: values.dataset, models, commonOnly: values.common, backend: values.backend, reasoningEffort: cfg.reasoningEffort });
    return;
  }

  throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
