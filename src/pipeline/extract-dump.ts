/**
 * Wikipedia dump-based article extraction.
 *
 * Replaces SPARQL extraction with a three-phase dump-based pipeline:
 * 1. Download SQL dump files from dumps.wikimedia.org
 * 2. Stream-parse and join tables by page_id
 * 3. Batch-fetch descriptions from Wikidata API
 *
 * Output: NDJSON with {title, lat, lon, desc} — same format as SPARQL extractor.
 */

import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { SUPPORTED_LANGS, DEFAULT_LANG } from "../lang.js";
import type { Lang } from "../lang.js";
import { downloadAllDumps, dumpPath, formatBytes } from "./dump-download.js";
import type { DownloadResult } from "./dump-download.js";
import { streamDump } from "./dump-parser.js";
import type { SqlRow } from "./dump-parser.js";

// ---------- Types ----------

export interface Article {
  title: string;
  lat: number;
  lon: number;
  desc: string;
}

export interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface ExtractDumpOptions {
  lang: Lang;
  bounds?: Bounds;
  skipDownload?: boolean;
  skipDescriptions?: boolean;
  dumpsDir?: string;
  outputPath?: string;
  fetchFn?: typeof fetch;
  onPhase?: (phase: string) => void;
  onProgress?: (phase: string, count: number) => void;
  batchSize?: number;
  batchDelayMs?: number;
}

// ---------- Column indices ----------

// geo_tags columns
const GT_PAGE_ID = "gt_page_id";
const GT_GLOBE = "gt_globe";
const GT_PRIMARY = "gt_primary";
const GT_LAT = "gt_lat";
const GT_LON = "gt_lon";

// page columns
const PAGE_ID = "page_id";
const PAGE_NAMESPACE = "page_namespace";
const PAGE_TITLE = "page_title";
const PAGE_IS_REDIRECT = "page_is_redirect";

// page_props columns
const PP_PAGE = "pp_page";
const PP_PROPNAME = "pp_propname";
const PP_VALUE = "pp_value";

// ---------- Phase 1: Build page map ----------

/**
 * Build a map of page_id → title from the page dump.
 * Filters: namespace=0 (articles), not redirect.
 */
export async function buildPageMap(
  filePath: string,
  onProgress?: (count: number) => void,
): Promise<Map<number, string>> {
  const pages = new Map<number, string>();

  for await (const row of streamDump({
    filePath,
    tableName: "page",
    requiredColumns: [PAGE_ID, PAGE_NAMESPACE, PAGE_TITLE, PAGE_IS_REDIRECT],
    onProgress,
    progressInterval: 500_000,
  })) {
    // row indices: page_id(0), page_namespace(1), page_title(2), page_is_redirect(3), ...
    const namespace = row[1] as number;
    const isRedirect = row[3] as number;

    if (namespace === 0 && isRedirect === 0) {
      const pageId = row[0] as number;
      const title = (row[2] as string).replace(/_/g, " ");
      pages.set(pageId, title);
    }
  }

  return pages;
}

// ---------- Phase 2: Build Q-ID map ----------

/**
 * Build a map of page_id → Wikidata Q-ID from page_props dump.
 * Filters for propname='wikibase_item'.
 */
export async function buildQidMap(
  filePath: string,
  onProgress?: (count: number) => void,
): Promise<Map<number, string>> {
  const qids = new Map<number, string>();

  for await (const row of streamDump({
    filePath,
    tableName: "page_props",
    requiredColumns: [PP_PAGE, PP_PROPNAME, PP_VALUE],
    onProgress,
    progressInterval: 500_000,
  })) {
    // row indices: pp_page(0), pp_propname(1), pp_value(2), pp_sortkey(3)
    const propname = row[1] as string;
    if (propname === "wikibase_item") {
      const pageId = row[0] as number;
      const qid = row[2] as string;
      qids.set(pageId, qid);
    }
  }

  return qids;
}

// ---------- Phase 3: Stream geo_tags and join ----------

/**
 * Check if coordinates are valid.
 */
function isValidCoord(lat: number, lon: number): boolean {
  if (Number.isNaN(lat) || Number.isNaN(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  // Reject Null Island (0,0)
  if (lat === 0 && lon === 0) return false;
  return true;
}

/**
 * Check if coordinates are within bounds.
 */
function isInBounds(lat: number, lon: number, bounds: Bounds): boolean {
  return (
    lat >= bounds.south &&
    lat <= bounds.north &&
    lon >= bounds.west &&
    lon <= bounds.east
  );
}

/**
 * Stream geo_tags dump, join with page and Q-ID maps, yield articles.
 */
export async function* streamGeoArticles(
  filePath: string,
  pages: Map<number, string>,
  qids: Map<number, string>,
  opts: {
    bounds?: Bounds;
    onProgress?: (count: number) => void;
  } = {},
): AsyncGenerator<Article & { qid?: string }> {
  const { bounds, onProgress } = opts;
  let count = 0;

  for await (const row of streamDump({
    filePath,
    tableName: "geo_tags",
    requiredColumns: [GT_PAGE_ID, GT_GLOBE, GT_PRIMARY, GT_LAT, GT_LON],
    onProgress: onProgress
      ? (n) => {
          count = n;
          onProgress(n);
        }
      : undefined,
    progressInterval: 100_000,
  })) {
    // row indices: gt_id(0), gt_page_id(1), gt_globe(2), gt_primary(3), gt_lat(4), gt_lon(5), ...
    const globe = row[2] as string;
    const primary = row[3] as number;

    if (globe !== "earth" || primary !== 1) continue;

    const pageId = row[1] as number;
    const lat = row[4] as number;
    const lon = row[5] as number;

    if (lat === null || lon === null) continue;
    if (!isValidCoord(lat, lon)) continue;

    if (bounds && !isInBounds(lat, lon, bounds)) continue;

    const title = pages.get(pageId);
    if (!title) continue; // Not an article or is a redirect

    const qid = qids.get(pageId);
    yield { title, lat, lon, desc: "", qid };
  }
}

// ---------- Phase 4: Batch-fetch descriptions ----------

/**
 * Fetch descriptions from Wikidata API for a batch of Q-IDs.
 */
export async function fetchDescriptions(
  qidToArticles: Map<string, Article[]>,
  lang: Lang,
  opts: {
    fetchFn?: typeof fetch;
    batchSize?: number;
    batchDelayMs?: number;
    onProgress?: (fetched: number, total: number) => void;
  } = {},
): Promise<void> {
  const {
    fetchFn = fetch,
    batchSize = 50,
    batchDelayMs = 100,
    onProgress,
  } = opts;

  const allQids = [...qidToArticles.keys()];
  const total = allQids.length;
  let fetched = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = allQids.slice(i, i + batchSize);
    const ids = batch.join("|");

    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=descriptions&languages=${lang}&format=json`;

    try {
      const response = await fetchFn(url);
      if (!response.ok) {
        console.error(`Wikidata API error: ${response.status} — skipping batch`);
        fetched += batch.length;
        if (onProgress) onProgress(fetched, total);
        continue;
      }

      const data = (await response.json()) as {
        entities?: Record<string, {
          descriptions?: Record<string, { value: string }>;
        }>;
      };

      if (data.entities) {
        for (const qid of batch) {
          const entity = data.entities[qid];
          if (entity?.descriptions?.[lang]) {
            const desc = entity.descriptions[lang].value;
            const articles = qidToArticles.get(qid);
            if (articles) {
              for (const article of articles) {
                article.desc = desc;
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`Wikidata API request failed: ${err} — skipping batch`);
    }

    fetched += batch.length;
    if (onProgress) onProgress(fetched, total);

    // Rate limit
    if (i + batchSize < total) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }
}

// ---------- Main orchestrator ----------

export async function extractDump(opts: ExtractDumpOptions): Promise<{
  articleCount: number;
  outputPath: string;
}> {
  const {
    lang,
    bounds,
    skipDownload = false,
    skipDescriptions = false,
    dumpsDir = "data/dumps",
    outputPath = `data/articles-${lang}.json`,
    fetchFn = fetch,
    onPhase,
    onProgress,
    batchSize = 50,
    batchDelayMs = 100,
  } = opts;

  // Phase 0: Download dumps
  if (!skipDownload) {
    onPhase?.("Downloading dump files");
    await downloadAllDumps({
      lang,
      dir: dumpsDir,
      fetchFn,
      skipExisting: false,
      onProgress: (table, downloaded, total) => {
        const pct = total ? ` (${((downloaded / total) * 100).toFixed(0)}%)` : "";
        process.stderr.write(`\r  ${table}: ${formatBytes(downloaded)}${pct}    `);
      },
      onComplete: (table, bytes) => {
        process.stderr.write(`\r  ${table}: ${formatBytes(bytes)} ✓\n`);
      },
    });
  }

  // Phase 1: Build page map
  onPhase?.("Building page map");
  const pageMap = await buildPageMap(
    dumpPath(lang, "page", dumpsDir),
    (n) => onProgress?.("page", n),
  );
  console.error(`  Page map: ${pageMap.size.toLocaleString()} articles`);

  // Phase 2: Build Q-ID map
  onPhase?.("Building Q-ID map");
  const qidMap = await buildQidMap(
    dumpPath(lang, "page_props", dumpsDir),
    (n) => onProgress?.("page_props", n),
  );
  console.error(`  Q-ID map: ${qidMap.size.toLocaleString()} entries`);

  // Phase 3: Stream geo_tags and join
  onPhase?.("Streaming geo_tags and joining");

  const articles: Article[] = [];
  const seen = new Set<string>();
  const qidToArticles = new Map<string, Article[]>();

  for await (const entry of streamGeoArticles(
    dumpPath(lang, "geo_tags", dumpsDir),
    pageMap,
    qidMap,
    {
      bounds,
      onProgress: (n) => onProgress?.("geo_tags", n),
    },
  )) {
    // Deduplicate by title
    if (seen.has(entry.title)) continue;
    seen.add(entry.title);

    const article: Article = {
      title: entry.title,
      lat: entry.lat,
      lon: entry.lon,
      desc: "",
    };
    articles.push(article);

    // Track Q-ID → articles for description fetching
    if (entry.qid) {
      const existing = qidToArticles.get(entry.qid);
      if (existing) existing.push(article);
      else qidToArticles.set(entry.qid, [article]);
    }
  }

  console.error(`  Geo articles: ${articles.length.toLocaleString()} (deduplicated)`);

  // Free maps — no longer needed
  pageMap.clear();
  qidMap.clear();

  // Phase 4: Fetch descriptions
  if (!skipDescriptions && qidToArticles.size > 0) {
    onPhase?.("Fetching descriptions from Wikidata");
    console.error(`  Fetching descriptions for ${qidToArticles.size.toLocaleString()} Q-IDs...`);

    await fetchDescriptions(qidToArticles, lang, {
      fetchFn,
      batchSize,
      batchDelayMs,
      onProgress: (fetched, total) => {
        process.stderr.write(
          `\r  Descriptions: ${fetched.toLocaleString()}/${total.toLocaleString()}    `,
        );
      },
    });
    process.stderr.write("\n");
  }

  // Phase 5: Write NDJSON
  onPhase?.("Writing output");
  const outputDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (outputDir) await mkdir(outputDir, { recursive: true });

  const ws = createWriteStream(outputPath);
  for (const article of articles) {
    ws.write(JSON.stringify(article) + "\n");
  }
  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve());
    ws.on("error", reject);
  });

  console.error(`  Output: ${outputPath} (${articles.length.toLocaleString()} articles)`);

  return { articleCount: articles.length, outputPath };
}

// ---------- CLI ----------

function parseBounds(str: string): Bounds {
  const [south, north, west, east] = str.split(",").map(Number);
  if ([south, north, west, east].some(Number.isNaN)) {
    throw new Error(`Invalid bounds: ${str} (expected: south,north,west,east)`);
  }
  return { south, north, west, east };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(
    args
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [key, ...rest] = a.slice(2).split("=");
        return [key, rest.length ? rest.join("=") : "true"];
      }),
  );

  const lang = (flags.lang ?? DEFAULT_LANG) as Lang;
  if (!SUPPORTED_LANGS.includes(lang)) {
    console.error(`Unsupported language: ${lang}. Supported: ${SUPPORTED_LANGS.join(", ")}`);
    process.exit(1);
  }

  const bounds = flags.bounds ? parseBounds(flags.bounds) : undefined;
  const skipDownload = flags["skip-download"] === "true";
  const skipDescriptions = flags["no-desc"] === "true";

  console.error(`\nExtracting ${lang} articles from Wikipedia dumps\n`);

  const start = Date.now();

  const result = await extractDump({
    lang,
    bounds,
    skipDownload,
    skipDescriptions,
    onPhase: (phase) => console.error(`\n→ ${phase}`),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`\nDone in ${elapsed}s — ${result.articleCount.toLocaleString()} articles written to ${result.outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
