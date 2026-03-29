import {
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { deserializeBinary } from "../geometry/serialization.js";
import { collectTileArticles, buildArticleIndex } from "./build.js";
import type { TileIndex } from "../tiles.js";
import type { Article } from "./extract-dump.js";

// ---------- Unit: collectTileArticles ----------

describe("collectTileArticles", () => {
  // Tile row=20, col=36 → south=10, north=15, west=0, east=5
  const row = 20;
  const col = 36;

  const articles: Article[] = [
    { title: "inside", lat: 12, lon: 2 },
    { title: "buffer-south", lat: 9.8, lon: 2 }, // 0.2° below south boundary
    { title: "buffer-north", lat: 15.3, lon: 2 }, // 0.3° above north boundary
    { title: "outside", lat: 7, lon: 2 }, // 3° below south — outside buffer
    { title: "edge-exact", lat: 10, lon: 0 }, // on south-west corner
  ];
  const index = buildArticleIndex(articles);

  it("separates native and buffer articles", () => {
    const { native, all } = collectTileArticles(index, row, col);

    expect(native.map((a) => a.title)).toEqual(["inside", "edge-exact"]);
    expect(all.map((a) => a.title)).toEqual(
      expect.arrayContaining([
        "inside",
        "buffer-south",
        "buffer-north",
        "edge-exact",
      ]),
    );
    expect(all).toHaveLength(4);
  });

  it("excludes articles beyond buffer zone", () => {
    const { all } = collectTileArticles(index, row, col);
    expect(all.find((a) => a.title === "outside")).toBeUndefined();
  });

  it("uses half-open interval for native (includes south/west, excludes north/east)", () => {
    const edgeArticles: Article[] = [
      { title: "on-south", lat: 10, lon: 2 }, // native (>= south)
      { title: "on-north", lat: 15, lon: 2 }, // NOT native (>= north)
      { title: "on-west", lat: 12, lon: 0 }, // native (>= west)
      { title: "on-east", lat: 12, lon: 5 }, // NOT native (>= east)
    ];
    const edgeIndex = buildArticleIndex(edgeArticles);
    const { native } = collectTileArticles(edgeIndex, row, col);
    expect(native.map((a) => a.title)).toEqual(
      expect.arrayContaining(["on-south", "on-west"]),
    );
    expect(native).toHaveLength(2);
  });

  it("wraps columns across the antimeridian (col=0 pulls from col=71)", () => {
    // Tile col=0: west=-180, east=-175. Buffer extends to west=-180.5.
    // An article at lon=179.8 in col=71 is only 0.2° away — should appear in buffer.
    const articles: Article[] = [
      { title: "native-west", lat: 12, lon: -178 }, // native to col=0
      { title: "across-dateline", lat: 12, lon: 179.8 }, // col=71, within buffer
      { title: "far-east", lat: 12, lon: 170 }, // col=70, too far
    ];
    const idx = buildArticleIndex(articles);
    const { native, all } = collectTileArticles(idx, row, 0);

    expect(native.map((a) => a.title)).toEqual(["native-west"]);
    expect(all.map((a) => a.title)).toEqual(
      expect.arrayContaining(["native-west", "across-dateline"]),
    );
    expect(all).toHaveLength(2);
  });

  it("wraps columns across the antimeridian (col=71 pulls from col=0)", () => {
    // Tile col=71: west=175, east=180. Buffer extends to east=180.5.
    // An article at lon=-179.8 in col=0 is only 0.2° away — should appear in buffer.
    const articles: Article[] = [
      { title: "native-east", lat: 12, lon: 177 }, // native to col=71
      { title: "across-dateline", lat: 12, lon: -179.8 }, // col=0, within buffer
      { title: "far-west", lat: 12, lon: -170 }, // col=2, too far
    ];
    const idx = buildArticleIndex(articles);
    const { native, all } = collectTileArticles(idx, row, 71);

    expect(native.map((a) => a.title)).toEqual(["native-east"]);
    expect(all.map((a) => a.title)).toEqual(
      expect.arrayContaining(["native-east", "across-dateline"]),
    );
    expect(all).toHaveLength(2);
  });

  it("classifies article near lon=+180 as native for easternmost tile (col=71)", () => {
    // Tile col=71: west=175, east=180. An article at lon=179.99 is inside the
    // native half-open interval [175, 180) and should be classified as native.
    const articles: Article[] = [
      { title: "near-dateline", lat: 12, lon: 179.99 }, // native to col=71
      { title: "mid-tile", lat: 12, lon: 177 }, // also native
    ];
    const idx = buildArticleIndex(articles);
    const { native, all } = collectTileArticles(idx, row, 71);

    expect(native.map((a) => a.title)).toEqual(
      expect.arrayContaining(["near-dateline", "mid-tile"]),
    );
    expect(native).toHaveLength(2);
    expect(all).toHaveLength(2);
  });
});

// ---------- Integration: tiled pipeline ----------

describe("tiled pipeline (e2e)", () => {
  const testDir = join(tmpdir(), "build-tiled-test-" + Date.now());
  const dataDir = join(testDir, "data");
  const articlesPath = join(dataDir, "articles-en.json");

  beforeAll(() => {
    mkdirSync(dataDir, { recursive: true });

    // Generate test articles across 3 well-separated tiles
    // Each cluster has 10 articles centered well within a tile (>1° from edges)
    const clusters = [
      { baseLat: 57.0, baseLon: 17.0, prefix: "Stockholm" }, // tile 29-39 (55-60, 15-20)
      { baseLat: 52.0, baseLon: 2.0, prefix: "London" }, // tile 28-36 (50-55, 0-5)
      { baseLat: 37.0, baseLon: 141.0, prefix: "Tokyo" }, // tile 25-64 (35-40, 140-145)
    ];

    const lines: string[] = [];
    for (const c of clusters) {
      for (let i = 0; i < 10; i++) {
        const lat = c.baseLat + (i % 5) * 0.2;
        const lon = c.baseLon + Math.floor(i / 5) * 0.2;
        lines.push(JSON.stringify({ title: `${c.prefix}_${i}`, lat, lon }));
      }
    }

    writeFileSync(articlesPath, lines.join("\n"), "utf-8");
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it("produces index.json and per-tile .bin files that deserialize correctly", () => {
    // Run the pipeline in the temp directory (it resolves paths relative to cwd)
    execFileSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [join(process.cwd(), "src/pipeline/build.ts")],
      { cwd: testDir, timeout: 30_000 },
    );

    const tilesDir = join(dataDir, "tiles", "en");

    // Verify index.json exists and is valid
    const indexRaw = readFileSync(join(tilesDir, "index.json"), "utf-8");
    const index: TileIndex = JSON.parse(indexRaw);

    expect(index.version).toBe(1);
    expect(index.gridDeg).toBe(5);
    expect(index.bufferDeg).toBe(0.5);
    expect(index.generated).toBeTruthy();
    expect(index.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(index.tiles.length).toBe(3);

    // Verify each tile entry has required fields
    for (const tile of index.tiles) {
      expect(tile.id).toMatch(/^\d{2}-\d{2}$/);
      expect(tile.row).toBeGreaterThanOrEqual(0);
      expect(tile.col).toBeGreaterThanOrEqual(0);
      expect(tile.articles).toBeGreaterThan(0);
      expect(tile.bytes).toBeGreaterThan(0);
      expect(tile.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(tile.north - tile.south).toBe(5);
      expect(tile.east - tile.west).toBe(5);

      // Verify the .bin file exists and deserializes
      const binPath = join(tilesDir, `${tile.id}.bin`);
      const binBuf = readFileSync(binPath);
      const { fd, articles } = deserializeBinary(
        binBuf.buffer.slice(
          binBuf.byteOffset,
          binBuf.byteOffset + binBuf.byteLength,
        ),
      );

      expect(articles.length).toBeGreaterThanOrEqual(tile.articles);
      expect(fd.vertexPoints.length).toBe(articles.length * 3);
    }

    // Verify total native article count matches input
    const totalArticles = index.tiles.reduce((s, t) => s + t.articles, 0);
    expect(totalArticles).toBe(30); // 3 clusters * 10 articles

    // Verify .bin files on disk match the index
    const binFiles = readdirSync(tilesDir).filter((f) => f.endsWith(".bin"));
    expect(binFiles.length).toBe(index.tiles.length);
  });

  it("produces different tile hashes when article coordinates change", () => {
    const makeArticles = (latOffset: number) => {
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        const lat = 52.0 + latOffset + (i % 5) * 0.2;
        const lon = 2.0 + Math.floor(i / 5) * 0.2;
        lines.push(JSON.stringify({ title: `Place_${i}`, lat, lon }));
      }
      return lines.join("\n");
    };

    const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");
    const buildScript = join(process.cwd(), "src/pipeline/build.ts");

    const testDir1 = join(tmpdir(), "build-hash-test1-" + Date.now());
    const testDir2 = join(tmpdir(), "build-hash-test2-" + Date.now());

    try {
      // First run: original coordinates
      const dataDir1 = join(testDir1, "data");
      mkdirSync(dataDir1, { recursive: true });
      writeFileSync(
        join(dataDir1, "articles-en.json"),
        makeArticles(0),
        "utf-8",
      );
      execFileSync(tsxBin, [buildScript], { cwd: testDir1, timeout: 30_000 });
      const index1: TileIndex = JSON.parse(
        readFileSync(join(dataDir1, "tiles", "en", "index.json"), "utf-8"),
      );

      // Second run: shifted coordinates
      const dataDir2 = join(testDir2, "data");
      mkdirSync(dataDir2, { recursive: true });
      writeFileSync(
        join(dataDir2, "articles-en.json"),
        makeArticles(0.5),
        "utf-8",
      );
      execFileSync(tsxBin, [buildScript], { cwd: testDir2, timeout: 30_000 });
      const index2: TileIndex = JSON.parse(
        readFileSync(join(dataDir2, "tiles", "en", "index.json"), "utf-8"),
      );

      // Same tile (both clusters land in the same grid cell), different hash
      expect(index1.tiles).toHaveLength(1);
      expect(index2.tiles).toHaveLength(1);
      expect(index1.tiles[0].id).toBe(index2.tiles[0].id);
      expect(index1.tiles[0].hash).not.toBe(index2.tiles[0].hash);
      expect(index1.hash).not.toBe(index2.hash);
    } finally {
      rmSync(testDir1, { recursive: true, force: true });
      rmSync(testDir2, { recursive: true, force: true });
    }
  });
});
