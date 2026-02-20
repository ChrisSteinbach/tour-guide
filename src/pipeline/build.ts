// Offline build pipeline
// Reads pre-extracted NDJSON articles, builds Delaunay triangulation, outputs static data
// Run with: npm run pipeline [--limit=N] [--bounds=south,north,west,east]

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
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

// ---------- Types ----------

interface Article {
  title: string;
  lat: number;
  lon: number;
}

interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

// ---------- CLI arg parsing ----------

function parseArgs(): {
  limit: number;
  bounds: Bounds | null;
  json: boolean;
  convert: boolean;
  lang: Lang;
} {
  let limit = Infinity;
  let bounds: Bounds | null = null;
  let json = false;
  let convert = false;
  let lang: Lang = DEFAULT_LANG;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
    } else if (arg.startsWith("--bounds=")) {
      const parts = arg.slice("--bounds=".length).split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error(
          `Invalid --bounds (expected south,north,west,east): ${arg}`,
        );
      }
      bounds = {
        south: parts[0],
        north: parts[1],
        west: parts[2],
        east: parts[3],
      };
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--convert") {
      convert = true;
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

  return { limit, bounds, json, convert, lang };
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

    if (bounds) {
      if (
        article.lat < bounds.south ||
        article.lat > bounds.north ||
        article.lon < bounds.west ||
        article.lon > bounds.east
      ) {
        continue;
      }
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

async function main() {
  const { limit, bounds, json, convert, lang } = parseArgs();

  console.log("tour-guide build pipeline\n");
  console.log(`  --lang=${lang}`);
  if (Number.isFinite(limit)) console.log(`  --limit=${limit}`);
  if (bounds)
    console.log(
      `  --bounds=${bounds.south},${bounds.north},${bounds.west},${bounds.east}`,
    );
  if (json) console.log(`  --json (JSON output)`);
  if (convert) console.log(`  --convert (converting existing JSON to binary)`);

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

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
