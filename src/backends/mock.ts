import type { AnalyzeResult, VisionBackend } from "./backend.ts";

/**
 * Offline backend for testing the pipeline without spending AI credits. It returns a
 * deterministic plate based on the image bytes; numbers are meaningless.
 */
export class MockBackend implements VisionBackend {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async analyze(model: string, image: Buffer): Promise<AnalyzeResult> {
    const h = image.reduce((a, b) => (a * 31 + b) >>> 0, 7);
    const grams = 100 + (h % 200);
    const reply = {
      items: [
        { name: "white rice", usda_query: "rice white cooked", grams, calories: Math.round(grams * 1.3), protein_g: 3, carbs_g: 40, fat_g: 0.5 },
        { name: "chicken breast", usda_query: "chicken breast roasted", grams: 120, calories: 198, protein_g: 37, carbs_g: 0, fat_g: 4 },
      ],
      total_calories: Math.round(grams * 1.3) + 198,
    };
    return { text: "```json\n" + JSON.stringify(reply) + "\n```", usage: { input_tokens: 0, output_tokens: 0, ai_credits: 0 }, latencyMs: 1 };
  }
}
