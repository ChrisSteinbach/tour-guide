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
import { tileFor, collectTileArticles } from "./build.js";
import type { TileIndex } from "./build.js";
import type { Article } from "./extract-dump.js";

// ---------- Unit: tileFor ----------

describe("tileFor", () => {
  it("maps equator/prime meridian", () => {
    expect(tileFor(0.1, 0.1)).toEqual({ row: 18, col: 36 });
  });

  it("maps south pole region", () => {
    expect(tileFor(-89, 0)).toEqual({ row: 0, col: 36 });
  });

  it("maps north pole region", () => {
    expect(tileFor(89, 0)).toEqual({ row: 35, col: 36 });
  });

  it("maps negative longitude", () => {
    expect(tileFor(0, -170)).toEqual({ row: 18, col: 2 });
  });

  it("maps Stockholm (59.33, 18.07)", () => {
    expect(tileFor(59.33, 18.07)).toEqual({ row: 29, col: 39 });
  });

  it("maps tile boundaries to the lower tile", () => {
    // Exactly on a 5° boundary: lat=10 → row = floor(100/5) = 20
    expect(tileFor(10, 0)).toEqual({ row: 20, col: 36 });
    // Just below: lat=9.99 → row = floor(99.99/5) = 19
    expect(tileFor(9.99, 0)).toEqual({ row: 19, col: 36 });
  });
});

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

  it("separates native and buffer articles", () => {
    const { native, all } = collectTileArticles(articles, row, col);

    expect(native.map((a) => a.title)).toEqual(["inside", "edge-exact"]);
    expect(all.map((a) => a.title)).toEqual([
      "inside",
      "buffer-south",
      "buffer-north",
      "edge-exact",
    ]);
  });

  it("excludes articles beyond buffer zone", () => {
    const { all } = collectTileArticles(articles, row, col);
    expect(all.find((a) => a.title === "outside")).toBeUndefined();
  });

  it("uses half-open interval for native (includes south/west, excludes north/east)", () => {
    const edgeArticles: Article[] = [
      { title: "on-south", lat: 10, lon: 2 }, // native (>= south)
      { title: "on-north", lat: 15, lon: 2 }, // NOT native (>= north)
      { title: "on-west", lat: 12, lon: 0 }, // native (>= west)
      { title: "on-east", lat: 12, lon: 5 }, // NOT native (>= east)
    ];
    const { native } = collectTileArticles(edgeArticles, row, col);
    expect(native.map((a) => a.title)).toEqual(["on-south", "on-west"]);
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
      "npx",
      ["tsx", join(process.cwd(), "src/pipeline/build.ts"), "--tiled"],
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
});
