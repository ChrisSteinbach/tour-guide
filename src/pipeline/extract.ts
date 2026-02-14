// Article extraction from Wikidata SPARQL endpoint
// Orchestrates batched queries, parsing, deduplication, and NDJSON output

import { buildQuery, executeSparql, SparqlError } from "./sparql.js";
import type { SparqlBinding, SparqlResponse } from "./sparql.js";
import { SUPPORTED_LANGS, DEFAULT_LANG } from "../lang.js";
import type { Lang } from "../lang.js";

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
  regions?: { south: number; north: number; west: number; east: number }[];
  fetchFn?: typeof fetch;
  onBatch?: (info: { batch: number; articlesInBatch: number; totalSoFar: number }) => void;
  maxRetries?: number;
  tileDelayMs?: number;
  lang?: Lang;
}

export interface ExtractResult {
  articles: Article[];
  leafTiles: { south: number; north: number; west: number; east: number }[];
  failedTiles: { south: number; north: number; west: number; east: number }[];
}

// ---------- Pure functions ----------

export function parseBinding(binding: SparqlBinding): Article | null {
  const lat = parseFloat(binding.lat?.value);
  const lon = parseFloat(binding.lon?.value);

  if (!isValidCoordinate(lat, lon)) return null;

  // Prefer the Wikipedia article URL (canonical title with correct capitalisation)
  // over the Wikidata label, which may differ (e.g. "Östuna church" vs "Östuna Church").
  let title: string | undefined;
  if (binding.article?.value) {
    const urlPath = new URL(binding.article.value).pathname;
    title = decodeURIComponent(urlPath.split("/").pop() ?? "").replace(/_/g, " ");
  }
  if (!title) title = binding.itemLabel?.value;
  if (!title) return null;

  const desc = binding.itemDescription?.value ?? "";

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

// ---------- Geographic tiling ----------

type Bounds = NonNullable<ExtractOptions["bounds"]>;

const TILE_LAT_SIZE = 10;
const TILE_LON_SIZE = 10;
const MIN_TILE_DEG = 0.3;

export function generateTiles(latSize: number = TILE_LAT_SIZE, lonSize: number = TILE_LON_SIZE): Bounds[] {
  const tiles: Bounds[] = [];
  for (let south = -90; south < 90; south += latSize) {
    for (let west = -180; west < 180; west += lonSize) {
      tiles.push({
        south,
        north: Math.min(south + latSize, 90),
        west,
        east: Math.min(west + lonSize, 180),
      });
    }
  }
  return tiles;
}

export function subdivideTile(tile: Bounds): Bounds[] {
  const midLat = (tile.south + tile.north) / 2;
  const midLon = (tile.west + tile.east) / 2;
  return [
    { south: tile.south, north: midLat, west: tile.west, east: midLon },
    { south: tile.south, north: midLat, west: midLon, east: tile.east },
    { south: midLat, north: tile.north, west: tile.west, east: midLon },
    { south: midLat, north: tile.north, west: midLon, east: tile.east },
  ];
}

function canSubdivide(tile: Bounds): boolean {
  return (tile.north - tile.south) > MIN_TILE_DEG && (tile.east - tile.west) > MIN_TILE_DEG;
}

// ---------- Orchestrator ----------

const DEFAULT_ENDPOINT = "https://query.wikidata.org/sparql";
const DEFAULT_BATCH_SIZE = 50_000;
const DEFAULT_MAX_RETRIES = 5;
const BATCH_DELAY_MS = 1500;
const TILE_DELAY_MS = 200;
const MAX_BACKOFF_MS = 30_000;

const RETRYABLE_STATUSES = new Set([0, 429, 500, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof SparqlError) return RETRYABLE_STATUSES.has(err.status);
  return true; // Network errors, timeouts, etc. are retryable
}

interface ExtractContext {
  endpoint: string;
  batchSize: number;
  fetchFn: typeof fetch;
  maxRetries: number;
  tileDelayMs: number;
  lang: Lang;
  onBatch?: ExtractOptions["onBatch"];
  allArticles: Article[];
  leafTiles: Bounds[];
  failedTiles: Bounds[];
  batchNum: number;
}

async function extractRegion(region: Bounds, ctx: ExtractContext): Promise<void> {
  try {
    let offset = 0;

    while (true) {
      ctx.batchNum++;
      const query = buildQuery({ limit: ctx.batchSize, offset, bounds: region, lang: ctx.lang });

      let response: SparqlResponse;
      let attempt = 0;

      while (true) {
        try {
          response = await executeSparql(query, ctx.endpoint, ctx.fetchFn);
          break;
        } catch (err) {
          attempt++;
          if (!isRetryableError(err)) throw err;
          if (attempt >= ctx.maxRetries) throw err;

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

      ctx.allArticles.push(...parsed);
      ctx.onBatch?.({ batch: ctx.batchNum, articlesInBatch: parsed.length, totalSoFar: ctx.allArticles.length });

      offset += ctx.batchSize;

      if (bindings.length < ctx.batchSize) break;
      await sleep(BATCH_DELAY_MS);
    }
    ctx.leafTiles.push(region);
  } catch (err) {
    if (!isRetryableError(err)) throw err;

    // Adaptive subdivision: split the failed tile into 4 smaller quadrants
    if (canSubdivide(region)) {
      const subTiles = subdivideTile(region);
      for (const sub of subTiles) {
        await extractRegion(sub, ctx);
        if (ctx.tileDelayMs > 0) await sleep(ctx.tileDelayMs);
      }
    } else {
      ctx.failedTiles.push(region);
    }
  }
}

export async function extractArticles(options: ExtractOptions = {}): Promise<ExtractResult> {
  const {
    endpoint = DEFAULT_ENDPOINT,
    batchSize = DEFAULT_BATCH_SIZE,
    bounds,
    regions: explicitRegions,
    fetchFn = fetch,
    onBatch,
    maxRetries = DEFAULT_MAX_RETRIES,
    tileDelayMs = TILE_DELAY_MS,
    lang = DEFAULT_LANG,
  } = options;

  const regions = explicitRegions ?? (bounds ? [bounds] : generateTiles());

  const ctx: ExtractContext = {
    endpoint,
    batchSize,
    fetchFn,
    maxRetries,
    tileDelayMs,
    lang,
    onBatch,
    allArticles: [],
    leafTiles: [],
    failedTiles: [],
    batchNum: 0,
  };

  for (const region of regions) {
    await extractRegion(region, ctx);
    if (regions.length > 1 && tileDelayMs > 0) {
      await sleep(tileDelayMs);
    }
  }

  if (ctx.failedTiles.length > 0) {
    console.error(
      `Warning: ${ctx.failedTiles.length} tile(s) failed at minimum size and were skipped:`,
      ctx.failedTiles.map((t) => `[${t.south},${t.north}]×[${t.west},${t.east}]`).join(", "),
    );
  }

  return {
    articles: deduplicateArticles(ctx.allArticles),
    leafTiles: ctx.leafTiles,
    failedTiles: ctx.failedTiles,
  };
}

// ---------- CLI runner ----------

async function main() {
  const args = process.argv.slice(2);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.resolve("data");

  // Parse --lang
  const langArg = args.find((a) => a.startsWith("--lang="));
  const lang: Lang = (() => {
    if (!langArg) return DEFAULT_LANG;
    const val = langArg.slice("--lang=".length);
    if (!(SUPPORTED_LANGS as readonly string[]).includes(val)) {
      console.error(`Unsupported language "${val}". Supported: ${SUPPORTED_LANGS.join(", ")}`);
      process.exit(1);
    }
    return val as Lang;
  })();

  const cachePath = path.join(outDir, `tile-cache-${lang}.json`);

  let bounds: ExtractOptions["bounds"];
  let regions: Bounds[] | undefined;
  const noCache = args.includes("--no-cache");

  const boundsArg = args.find((a) => a.startsWith("--bounds="));
  if (boundsArg) {
    const parts = boundsArg.slice("--bounds=".length).split(",").map((s: string) => Number(s));
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      console.error("Usage: --bounds=south,north,west,east [--no-cache] [--lang=xx]");
      process.exit(1);
    }
    bounds = { south: parts[0], north: parts[1], west: parts[2], east: parts[3] };
  }

  // Load tile cache for full-globe extraction
  if (!bounds && !noCache) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      const cached = cache.tiles?.length ?? 0;
      const failed = cache.failedTiles?.length ?? 0;
      regions = [...(cache.tiles ?? []), ...(cache.failedTiles ?? [])];
      console.log(`Loaded tile cache: ${regions.length} regions (${cached} cached + ${failed} previously failed)`);
    } catch {
      // No cache file — will use default tiling
    }
  }

  console.log(`Language: ${lang}`);
  if (bounds) {
    console.log(`Extracting articles within bounds: ${JSON.stringify(bounds)}`);
  } else if (!regions) {
    const tiles = generateTiles();
    console.log(`Extracting all geotagged articles (${tiles.length} initial tiles, adaptive subdivision)...`);
  }

  const result = await extractArticles({
    bounds,
    regions,
    lang,
    onBatch({ batch, articlesInBatch, totalSoFar }) {
      console.log(`  Batch ${batch}: ${articlesInBatch} articles (${totalSoFar} total)`);
    },
  });

  console.log(`Extraction complete: ${result.articles.length} unique articles`);

  // Write tile cache for full-globe extraction
  if (!bounds) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      articleCount: result.articles.length,
      tiles: result.leafTiles,
      failedTiles: result.failedTiles,
    }));
    console.log(`Saved tile cache: ${result.leafTiles.length} tiles + ${result.failedTiles.length} failed → ${cachePath}`);
  }

  // Write NDJSON output
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `articles-${lang}.json`);
  const stream = fs.createWriteStream(outPath);
  for (const article of result.articles) {
    stream.write(JSON.stringify(article) + "\n");
  }
  stream.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  console.log(`Wrote ${result.articles.length} articles to ${outPath}`);
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
