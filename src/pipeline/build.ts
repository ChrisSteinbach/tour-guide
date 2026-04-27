// Offline build pipeline
// Reads pre-extracted NDJSON articles, builds tiled Delaunay triangulation
// Run with: npm run pipeline [--limit=N] [--bounds=west,south,east,north]

import { createReadStream, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  toCartesian,
  convexHull,
  buildTriangulation,
  serialize,
  serializeBinary,
} from "spherical-delaunay";
import type { ArticleMeta } from "spherical-delaunay";
import { SUPPORTED_LANGS, DEFAULT_LANG } from "../lang.js";
import type { Lang } from "../lang.js";
import { isInBounds, parseBounds } from "./extract-dump.js";
import type { Article, Bounds } from "./extract-dump.js";
import {
  GRID_DEG,
  BUFFER_DEG,
  ROWS,
  tileFor,
  tileId,
  wrapCol,
} from "../tiles.js";
import type { TileEntry, TileIndex } from "../tiles.js";

// ---------- CLI arg parsing ----------

export function parseArgs(argv: readonly string[]): {
  limit: number;
  bounds: Bounds | null;
  lang: Lang;
} {
  let limit = Infinity;
  let bounds: Bounds | null = null;
  let lang: Lang = DEFAULT_LANG;

  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
    } else if (arg.startsWith("--bounds=")) {
      bounds = parseBounds(arg.slice("--bounds=".length));
    } else if (arg.startsWith("--lang=")) {
      const val = arg.slice("--lang=".length);
      if (!(SUPPORTED_LANGS as readonly string[]).includes(val)) {
        throw new Error(
          `Unsupported language "${val}". Supported: ${SUPPORTED_LANGS.join(", ")}`,
        );
      }
      lang = val as Lang;
    }
  }

  return { limit, bounds, lang };
}

// ---------- NDJSON reader ----------

export async function readArticles(
  inputPath: string,
  limit: number,
  bounds: Bounds | null,
): Promise<Article[]> {
  const articles: Article[] = [];

  const rl = createInterface({
    input: createReadStream(inputPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (articles.length >= limit) break;

    const trimmed = line.trim();
    if (!trimmed) continue;

    const article = JSON.parse(trimmed) as Article;

    if (bounds && !isInBounds(article.lat, article.lon, bounds)) {
      continue;
    }

    articles.push(article);
  }

  return articles;
}

// ---------- Tiling ----------

const MIN_ARTICLES = 4;
/** Shift longitude to be within ±180° of a reference longitude. */
function normalizeLon(lon: number, refLon: number): number {
  const d = lon - refLon;
  if (d > 180) return lon - 360;
  if (d < -180) return lon + 360;
  return lon;
}

/** Spatial index mapping tile IDs to their articles. */
export type ArticleIndex = Map<string, Article[]>;

/** Build a spatial index of articles keyed by tile ID. */
export function buildArticleIndex(articles: Article[]): ArticleIndex {
  const index: ArticleIndex = new Map();
  for (const a of articles) {
    const { row, col } = tileFor(a.lat, a.lon);
    const id = tileId(row, col);
    let bucket = index.get(id);
    if (!bucket) {
      bucket = [];
      index.set(id, bucket);
    }
    bucket.push(a);
  }
  return index;
}

/** Collect articles for a tile: native articles + buffer zone from adjacent tiles. */
export function collectTileArticles(
  index: ArticleIndex,
  row: number,
  col: number,
): { native: Article[]; all: Article[] } {
  const south = row * GRID_DEG - 90;
  const north = south + GRID_DEG;
  const west = col * GRID_DEG - 180;
  const east = west + GRID_DEG;

  const bufferedBounds: Bounds = {
    south: south - BUFFER_DEG,
    north: north + BUFFER_DEG,
    west: west - BUFFER_DEG,
    east: east + BUFFER_DEG,
  };

  const tileCenterLon = (west + east) / 2;
  const native: Article[] = [];
  const all: Article[] = [];

  for (let dr = -1; dr <= 1; dr++) {
    const nr = row + dr;
    if (nr < 0 || nr >= ROWS) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const nc = wrapCol(col + dc);
      const bucket = index.get(tileId(nr, nc));
      if (!bucket) continue;
      for (const a of bucket) {
        const alon = normalizeLon(a.lon, tileCenterLon);
        if (isInBounds(a.lat, alon, bufferedBounds)) {
          // Push original a.lon (not normalized alon): toCartesian uses
          // cos/sin which are periodic mod 360°, so ±180° wrapping is harmless.
          all.push(a);
          if (a.lat >= south && a.lat < north && alon >= west && alon < east) {
            native.push(a);
          }
        }
      }
    }
  }

  return { native, all };
}

/** Build a single tile's triangulation and return the binary buffer, or null if hull fails. */
export function buildTile(tileArticles: Article[]): ArrayBuffer | null {
  const points = tileArticles.map((a) =>
    toCartesian({ lat: a.lat, lon: a.lon }),
  );
  let hull;
  try {
    hull = convexHull(points);
  } catch {
    // Articles are coplanar (e.g., along a line) — skip this tile
    return null;
  }
  const tri = buildTriangulation(hull);
  const meta: ArticleMeta[] = tri.originalIndices.map((i) => ({
    title: tileArticles[i].title,
  }));
  const data = serialize(tri, meta);
  return serializeBinary(data);
}

/** SHA-256 hash of a buffer, truncated to 8 hex characters. */
function hashBuffer(buf: ArrayBuffer): string {
  return createHash("sha256")
    .update(Buffer.from(buf))
    .digest("hex")
    .slice(0, 8);
}

/** Build tiled output: per-tile .bin files + index.json manifest. */
async function buildTiled(articles: Article[], lang: Lang): Promise<void> {
  const t0 = performance.now();

  // Step 2: Assign articles to tiles
  console.log("\nStep 2: Assigning articles to tiles...");
  const articleIndex = buildArticleIndex(articles);
  const tileMap = new Map<string, { row: number; col: number }>();
  for (const id of articleIndex.keys()) {
    const bucket = articleIndex.get(id)!;
    const { row, col } = tileFor(bucket[0].lat, bucket[0].lon);
    tileMap.set(id, { row, col });
  }
  console.log(`  → ${tileMap.size} populated tiles`);

  // Step 3: Build per-tile triangulations
  console.log("\nStep 3: Building per-tile triangulations...");
  const tilesDir = resolve(`data/tiles/${lang}`);
  await mkdir(tilesDir, { recursive: true });

  const tileEntries: TileEntry[] = [];
  let built = 0;
  let skipped = 0;

  for (const [id, { row, col }] of tileMap) {
    const { native, all } = collectTileArticles(articleIndex, row, col);

    if (all.length < MIN_ARTICLES) {
      skipped++;
      continue;
    }

    const buf = buildTile(all);
    if (buf === null) {
      skipped++;
      continue;
    }

    const tilePath = resolve(tilesDir, `${id}.bin`);
    writeFileSync(tilePath, Buffer.from(buf));

    const south = row * GRID_DEG - 90;
    tileEntries.push({
      id,
      row,
      col,
      south,
      north: south + GRID_DEG,
      west: col * GRID_DEG - 180,
      east: col * GRID_DEG - 180 + GRID_DEG,
      articles: native.length,
      bytes: buf.byteLength,
      hash: hashBuffer(buf),
    });

    built++;
    if (built % 100 === 0) {
      console.log(`  → ${built} tiles built...`);
    }
  }

  const t1 = performance.now();
  console.log(
    `  → ${built} tiles built, ${skipped} skipped (<${MIN_ARTICLES} articles) in ${((t1 - t0) / 1000).toFixed(1)}s`,
  );

  // Step 4: Write tile index
  console.log("\nStep 4: Writing tile index...");
  tileEntries.sort((a, b) => a.id.localeCompare(b.id));

  const combinedHashes = tileEntries.map((t) => t.hash).join("");
  const indexHash = createHash("sha256")
    .update(combinedHashes)
    .digest("hex")
    .slice(0, 8);

  const index: TileIndex = {
    version: 1,
    gridDeg: GRID_DEG,
    bufferDeg: BUFFER_DEG,
    generated: new Date().toISOString(),
    hash: indexHash,
    tiles: tileEntries,
  };

  const indexPath = resolve(tilesDir, "index.json");
  const indexJson = JSON.stringify(index, null, 2);
  writeFileSync(indexPath, indexJson, "utf-8");

  const totalBytes = tileEntries.reduce((sum, t) => sum + t.bytes, 0);
  const totalArticles = tileEntries.reduce((sum, t) => sum + t.articles, 0);
  console.log(`  → ${indexPath}`);
  console.log(
    `  → ${tileEntries.length} tiles, ${totalArticles} articles, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`,
  );

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${totalTime}s`);
}

async function main() {
  const { limit, bounds, lang } = parseArgs(process.argv.slice(2));

  console.log("tour-guide build pipeline\n");
  console.log(`  --lang=${lang}`);
  if (Number.isFinite(limit)) console.log(`  --limit=${limit}`);
  if (bounds)
    console.log(
      `  --bounds=${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
    );

  const inputPath = resolve(`data/articles-${lang}.json`);

  // Step 1: Read NDJSON articles
  console.log(`\nStep 1: Reading articles from data/articles-${lang}.json...`);
  const t0 = performance.now();
  const articles = await readArticles(inputPath, limit, bounds);
  const t1 = performance.now();
  console.log(
    `  → ${articles.length} articles read in ${((t1 - t0) / 1000).toFixed(1)}s`,
  );

  if (articles.length < 4) {
    throw new Error(
      `Need at least 4 articles for convex hull (got ${articles.length}). ` +
        "Check data/articles.json or adjust --bounds/--limit.",
    );
  }

  await buildTiled(articles, lang);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Pipeline failed:", err);
    process.exit(1);
  });
}
