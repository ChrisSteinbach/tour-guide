// Offline build pipeline
// Reads pre-extracted NDJSON articles, builds Delaunay triangulation, outputs static data
// Run with: npm run pipeline [--limit=N] [--bounds=south,north,west,east]

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
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
} from "../geometry/index.js";
import type { ArticleMeta, TriangulationFile } from "../geometry/index.js";
import { SUPPORTED_LANGS, DEFAULT_LANG } from "../lang.js";
import type { Lang } from "../lang.js";
import { isInBounds, parseBounds } from "./extract-dump.js";
import type { Article, Bounds } from "./extract-dump.js";
import { GRID_DEG, BUFFER_DEG, tileFor, tileId } from "../tiles.js";
import type { TileEntry, TileIndex } from "../tiles.js";

// ---------- CLI arg parsing ----------

function parseArgs(): {
  limit: number;
  bounds: Bounds | null;
  json: boolean;
  convert: boolean;
  tiled: boolean;
  lang: Lang;
} {
  let limit = Infinity;
  let bounds: Bounds | null = null;
  let json = false;
  let convert = false;
  let tiled = false;
  let lang: Lang = DEFAULT_LANG;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
    } else if (arg.startsWith("--bounds=")) {
      bounds = parseBounds(arg.slice("--bounds=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--convert") {
      convert = true;
    } else if (arg === "--tiled") {
      tiled = true;
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

  return { limit, bounds, json, convert, tiled, lang };
}

// ---------- NDJSON reader ----------

async function readArticles(
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

// ---------- Main ----------

function writeBinary(data: TriangulationFile, outputPath: string): void {
  const buf = serializeBinary(data);
  writeFileSync(outputPath, Buffer.from(buf));
  const sizeMB = (buf.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  → ${sizeMB} MB binary written to ${outputPath}`);
}

function writeJson(data: TriangulationFile, outputPath: string): void {
  const json = JSON.stringify(data);
  writeFileSync(outputPath, json, "utf-8");
  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
  console.log(`  → ${sizeMB} MB JSON written to ${outputPath}`);
}

// ---------- Tiling ----------

const MIN_ARTICLES = 4;

// Re-export for build.test.ts
export { tileFor } from "../tiles.js";
export type { TileEntry, TileIndex } from "../tiles.js";

/** Collect articles for a tile: native articles + buffer zone from adjacent tiles. */
export function collectTileArticles(
  articles: Article[],
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

  const native: Article[] = [];
  const all: Article[] = [];

  for (const a of articles) {
    if (isInBounds(a.lat, a.lon, bufferedBounds)) {
      all.push(a);
      if (a.lat >= south && a.lat < north && a.lon >= west && a.lon < east) {
        native.push(a);
      }
    }
  }

  return { native, all };
}

/** Build a single tile's triangulation and return the binary buffer, or null if hull fails. */
function buildTile(tileArticles: Article[]): ArrayBuffer | null {
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
  const tileMap = new Map<string, { row: number; col: number }>();
  for (const a of articles) {
    const { row, col } = tileFor(a.lat, a.lon);
    const id = tileId(row, col);
    if (!tileMap.has(id)) {
      tileMap.set(id, { row, col });
    }
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
    const { native, all } = collectTileArticles(articles, row, col);

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

  const index: TileIndex = {
    version: 1,
    gridDeg: GRID_DEG,
    bufferDeg: BUFFER_DEG,
    generated: new Date().toISOString(),
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
  const { limit, bounds, json, convert, tiled, lang } = parseArgs();

  console.log("tour-guide build pipeline\n");
  console.log(`  --lang=${lang}`);
  if (Number.isFinite(limit)) console.log(`  --limit=${limit}`);
  if (bounds)
    console.log(
      `  --bounds=${bounds.south},${bounds.north},${bounds.west},${bounds.east}`,
    );
  if (json) console.log(`  --json (JSON output)`);
  if (convert) console.log(`  --convert (converting existing JSON to binary)`);
  if (tiled) console.log(`  --tiled (tiled output)`);

  // --convert mode: read existing JSON → write binary
  if (convert) {
    const jsonPath = resolve(`data/triangulation-${lang}.json`);
    const binPath = resolve(`data/triangulation-${lang}.bin`);
    console.log(`\nReading ${jsonPath}...`);
    const t0 = performance.now();
    const data = JSON.parse(
      readFileSync(jsonPath, "utf-8"),
    ) as TriangulationFile;
    const t1 = performance.now();
    console.log(
      `  → Parsed in ${((t1 - t0) / 1000).toFixed(1)}s (${data.vertexCount} vertices, ${data.triangleCount} triangles)`,
    );
    console.log("\nWriting binary...");
    writeBinary(data, binPath);
    const t2 = performance.now();
    console.log(`\nDone in ${((t2 - t0) / 1000).toFixed(1)}s`);
    return;
  }

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

  // --tiled mode: build per-tile triangulations
  if (tiled) {
    await buildTiled(articles, lang);
    return;
  }

  // Step 2: Convert to Cartesian
  console.log("\nStep 2: Converting to Cartesian coordinates...");
  const t2 = performance.now();
  const points = articles.map((a) => toCartesian({ lat: a.lat, lon: a.lon }));
  const t3 = performance.now();
  console.log(
    `  → ${points.length} points in ${((t3 - t2) / 1000).toFixed(1)}s`,
  );

  // Step 3: Build convex hull
  console.log("\nStep 3: Building convex hull...");
  const t4 = performance.now();
  const hull = convexHull(points);
  const t5 = performance.now();
  console.log(
    `  → ${hull.faces.length} faces in ${((t5 - t4) / 1000).toFixed(1)}s`,
  );

  // Step 4: Extract Delaunay triangulation
  console.log("\nStep 4: Building Delaunay triangulation...");
  const t6 = performance.now();
  const tri = buildTriangulation(hull);
  const t7 = performance.now();
  console.log(
    `  → ${tri.vertices.length} vertices, ${tri.triangles.length} triangles in ${((t7 - t6) / 1000).toFixed(1)}s`,
  );

  // Step 5: Serialize and write output
  if (tri.originalIndices.length < articles.length) {
    console.log(
      `  → ${tri.originalIndices.length} of ${articles.length} vertices on hull (interior points filtered)`,
    );
  }
  const meta: ArticleMeta[] = tri.originalIndices.map((i) => ({
    title: articles[i].title,
  }));
  const data = serialize(tri, meta);
  const t8 = performance.now();

  if (json) {
    console.log(`\nStep 5: Serializing to data/triangulation-${lang}.json...`);
    writeJson(data, resolve(`data/triangulation-${lang}.json`));
  } else {
    console.log(`\nStep 5: Serializing to data/triangulation-${lang}.bin...`);
    writeBinary(data, resolve(`data/triangulation-${lang}.bin`));
  }

  const t9 = performance.now();
  console.log(`  Written in ${((t9 - t8) / 1000).toFixed(1)}s`);

  const totalTime = ((t9 - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${totalTime}s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Pipeline failed:", err);
    process.exit(1);
  });
}
