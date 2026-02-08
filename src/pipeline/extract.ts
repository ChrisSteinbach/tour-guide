// Article extraction from Wikidata SPARQL endpoint
// Orchestrates batched queries, parsing, deduplication, and NDJSON output

import { buildQuery, executeSparql, SparqlError } from "./sparql.js";
import type { SparqlBinding, SparqlResponse } from "./sparql.js";

// ---------- Types ----------

export interface Article {
  title: string;
  lat: number;
  lon: number;
  desc: string;
}

export interface ExtractOptions {
  endpoint?: string;
  batchSize?: number;
  bounds?: { south: number; north: number; west: number; east: number };
  fetchFn?: typeof fetch;
  onBatch?: (info: { batch: number; articlesInBatch: number; totalSoFar: number }) => void;
  maxRetries?: number;
}

// ---------- Pure functions ----------

export function parseBinding(binding: SparqlBinding): Article | null {
  const lat = parseFloat(binding.lat?.value);
  const lon = parseFloat(binding.lon?.value);

  if (!isValidCoordinate(lat, lon)) return null;

  let title = binding.itemLabel?.value;
  if (!title && binding.article?.value) {
    // Fall back to extracting title from article URL
    const urlPath = new URL(binding.article.value).pathname;
    title = decodeURIComponent(urlPath.split("/").pop() ?? "").replace(/_/g, " ");
  }
  if (!title) return null;

  const desc = binding.desc?.value ?? "";

  return { title, lat, lon, desc };
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  if (Number.isNaN(lat) || Number.isNaN(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  // Null Island — common Wikidata artifact for "unknown location"
  if (lat === 0 && lon === 0) return false;
  return true;
}

export function deduplicateArticles(articles: Article[]): Article[] {
  const seen = new Map<string, Article>();
  for (const article of articles) {
    if (!seen.has(article.title)) {
      seen.set(article.title, article);
    }
  }
  return Array.from(seen.values());
}

// ---------- Orchestrator ----------

const DEFAULT_ENDPOINT = "https://query.wikidata.org/sparql";
const DEFAULT_BATCH_SIZE = 50_000;
const DEFAULT_MAX_RETRIES = 3;
const BATCH_DELAY_MS = 1500;
const MAX_BACKOFF_MS = 30_000;

const RETRYABLE_STATUSES = new Set([429, 500, 503]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function extractArticles(options: ExtractOptions = {}): Promise<Article[]> {
  const {
    endpoint = DEFAULT_ENDPOINT,
    batchSize = DEFAULT_BATCH_SIZE,
    bounds,
    fetchFn = fetch,
    onBatch,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  const allArticles: Article[] = [];
  let offset = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const query = buildQuery({ limit: batchSize, offset, bounds });

    let response: SparqlResponse;
    let attempt = 0;

    while (true) {
      try {
        response = await executeSparql(query, endpoint, fetchFn);
        break;
      } catch (err) {
        attempt++;
        if (err instanceof SparqlError) {
          // Fail immediately on non-retryable errors
          if (!RETRYABLE_STATUSES.has(err.status)) throw err;
        }
        if (attempt >= maxRetries) throw err;

        const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        await sleep(backoff);
      }
    }

    const bindings = response.results.bindings;
    if (bindings.length === 0) break;

    const parsed: Article[] = [];
    for (const binding of bindings) {
      const article = parseBinding(binding);
      if (article) parsed.push(article);
    }

    allArticles.push(...parsed);
    onBatch?.({ batch: batchNum, articlesInBatch: parsed.length, totalSoFar: allArticles.length });

    offset += batchSize;

    if (bindings.length < batchSize) break;
    await sleep(BATCH_DELAY_MS);
  }

  return deduplicateArticles(allArticles);
}

// ---------- CLI runner ----------

async function main() {
  const args = process.argv.slice(2);
  let bounds: ExtractOptions["bounds"];

  const boundsArg = args.find((a) => a.startsWith("--bounds="));
  if (boundsArg) {
    const parts = boundsArg.slice("--bounds=".length).split(",").map((s: string) => Number(s));
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      console.error("Usage: --bounds=south,north,west,east");
      process.exit(1);
    }
    bounds = { south: parts[0], north: parts[1], west: parts[2], east: parts[3] };
  }

  console.log(bounds ? `Extracting articles within bounds: ${JSON.stringify(bounds)}` : "Extracting all geotagged articles...");

  const articles = await extractArticles({
    bounds,
    onBatch({ batch, articlesInBatch, totalSoFar }) {
      console.log(`  Batch ${batch}: ${articlesInBatch} articles (${totalSoFar} total)`);
    },
  });

  console.log(`Extraction complete: ${articles.length} unique articles`);

  // Write NDJSON output
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.resolve("data");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, "articles.json");
  const stream = fs.createWriteStream(outPath);
  for (const article of articles) {
    stream.write(JSON.stringify(article) + "\n");
  }
  stream.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  console.log(`Wrote ${articles.length} articles to ${outPath}`);
}

// Run when executed directly
const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/extract.ts") || process.argv[1].endsWith("/extract.js"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Extraction failed:", err);
    process.exit(1);
  });
}
