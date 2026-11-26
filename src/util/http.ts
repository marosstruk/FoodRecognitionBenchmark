import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retries/backoff on network errors, 429 and 5xx. */
export async function fetchWithRetry(url: string, init: RequestInit = {}, retries = 5): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
      if (String(err).includes("HTTP 4")) throw err;
    }
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

export async function fetchText(url: string): Promise<string> {
  return (await fetchWithRetry(url)).text();
}

export async function fetchBuffer(url: string): Promise<Buffer> {
  return Buffer.from(await (await fetchWithRetry(url)).arrayBuffer());
}

/** Writes atomically (temp file + rename) so interrupted runs never leave half-written files. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.part`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
