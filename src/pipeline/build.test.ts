import {
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { deserializeBinary } from "spherical-delaunay";
import { decodeArticlePayload } from "../article-payload.js";
import {
  collectTileArticles,
  buildArticleIndex,
  parseArgs,
  readArticles,
  buildTile,
  attachWeights,
  mergeCoincident,
  buildFarField,
  cellCandidates,
  buildMidFieldDigest,
} from "./build.js";
import { decodeFarField, FARFIELD_TOP_K } from "../farfield.js";
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

// ---------- parseArgs ----------

describe("parseArgs", () => {
  it("returns defaults when no flags are given", () => {
    const { limit, bounds, lang } = parseArgs([]);
    expect(limit).toBe(Infinity);
    expect(bounds).toBeNull();
    expect(lang).toBe("en");
  });

  it("parses --limit as a positive integer", () => {
    expect(parseArgs(["--limit=500"]).limit).toBe(500);
  });

  it("rejects --limit=0 and negative values", () => {
    expect(() => parseArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseArgs(["--limit=-1"])).toThrow(/Invalid --limit/);
  });

  it("rejects non-numeric --limit", () => {
    expect(() => parseArgs(["--limit=abc"])).toThrow(/Invalid --limit/);
  });

  it("parses --bounds as west,south,east,north", () => {
    const { bounds } = parseArgs(["--bounds=1,2,3,4"]);
    expect(bounds).toEqual({ west: 1, south: 2, east: 3, north: 4 });
  });

  it("accepts a supported language", () => {
    expect(parseArgs(["--lang=de"]).lang).toBe("de");
  });

  it("rejects an unsupported language", () => {
    expect(() => parseArgs(["--lang=xx"])).toThrow(/Unsupported language/);
  });

  it("ignores unknown flags rather than failing", () => {
    // Forward-compatibility: unrecognized flags shouldn't break the pipeline.
    const { limit, lang } = parseArgs(["--unknown=foo", "--limit=10"]);
    expect(limit).toBe(10);
    expect(lang).toBe("en");
  });
});

// ---------- readArticles ----------

describe("readArticles", () => {
  const tmp = join(tmpdir(), "build-readArticles-" + Date.now());

  beforeAll(() => mkdirSync(tmp, { recursive: true }));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function writeNdjson(name: string, articles: Article[]): string {
    const path = join(tmp, name);
    writeFileSync(path, articles.map((a) => JSON.stringify(a)).join("\n"));
    return path;
  }

  it("reads all articles when limit is Infinity and bounds are null", async () => {
    const path = writeNdjson("all.ndjson", [
      { title: "A", lat: 1, lon: 1 },
      { title: "B", lat: 2, lon: 2 },
      { title: "C", lat: 3, lon: 3 },
    ]);
    const articles = await readArticles(path, Infinity, null);
    expect(articles.map((a) => a.title)).toEqual(["A", "B", "C"]);
  });

  it("stops reading at the limit", async () => {
    const path = writeNdjson("limited.ndjson", [
      { title: "A", lat: 1, lon: 1 },
      { title: "B", lat: 2, lon: 2 },
      { title: "C", lat: 3, lon: 3 },
    ]);
    const articles = await readArticles(path, 2, null);
    expect(articles.map((a) => a.title)).toEqual(["A", "B"]);
  });

  it("filters articles outside the bounds", async () => {
    const path = writeNdjson("bounded.ndjson", [
      { title: "inside", lat: 1, lon: 1 },
      { title: "outside-north", lat: 50, lon: 1 },
      { title: "outside-east", lat: 1, lon: 50 },
    ]);
    const articles = await readArticles(path, Infinity, {
      west: 0,
      south: 0,
      east: 5,
      north: 5,
    });
    expect(articles.map((a) => a.title)).toEqual(["inside"]);
  });

  it("skips blank lines without crashing", async () => {
    const path = join(tmp, "blanks.ndjson");
    writeFileSync(
      path,
      [
        JSON.stringify({ title: "A", lat: 1, lon: 1 }),
        "",
        "  ",
        JSON.stringify({ title: "B", lat: 2, lon: 2 }),
      ].join("\n"),
    );
    const articles = await readArticles(path, Infinity, null);
    expect(articles.map((a) => a.title)).toEqual(["A", "B"]);
  });

  it("preserves the optional views field and leaves it absent for old NDJSON", async () => {
    const path = writeNdjson("views.ndjson", [
      { title: "A", lat: 1, lon: 1, views: 2048 },
      { title: "B", lat: 2, lon: 2 }, // old NDJSON line without views
    ]);
    const articles = await readArticles(path, Infinity, null);
    expect(articles[0].views).toBe(2048);
    expect(articles[1].views).toBeUndefined();
  });
});

// ---------- buildTile ----------

describe("buildTile", () => {
  it("returns a non-empty buffer for a valid set of well-spread articles", () => {
    const articles: Article[] = [
      { title: "NE", lat: 14, lon: 4 },
      { title: "NW", lat: 14, lon: 1 },
      { title: "SE", lat: 11, lon: 4 },
      { title: "SW", lat: 11, lon: 1 },
      { title: "C", lat: 12.5, lon: 2.5 },
    ];
    const buf = buildTile(mergeCoincident(attachWeights(articles)));
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBeGreaterThan(0);
  });

  it("returns null when articles are coplanar (cannot form a 3D hull)", () => {
    // All on the equator on the same longitude → degenerate (collinear in 3D).
    const collinear: Article[] = [
      { title: "A", lat: 0, lon: 0 },
      { title: "B", lat: 0, lon: 0.1 },
      { title: "C", lat: 0, lon: 0.2 },
      { title: "D", lat: 0, lon: 0.3 },
    ];
    expect(buildTile(mergeCoincident(attachWeights(collinear)))).toBeNull();
  });

  it("derives per-vertex weights from article views via percentile ranking", () => {
    // class[i] = round(255 * rank / N), N = 5 articles, ranks 0..4 by views.
    const articles: Article[] = [
      { title: "NE", lat: 14, lon: 4, views: 10 }, // rank 0/5 → round(255*0/5) = 0
      { title: "NW", lat: 14, lon: 1, views: 20 }, // rank 1/5 → round(255*1/5) = 51
      { title: "SE", lat: 11, lon: 4, views: 30 }, // rank 2/5 → round(255*2/5) = 102
      { title: "SW", lat: 11, lon: 1, views: 40 }, // rank 3/5 → round(255*3/5) = 153
      { title: "C", lat: 12.5, lon: 2.5, views: 50 }, // rank 4/5 → round(255*4/5) = 204
    ];

    const buf = buildTile(mergeCoincident(attachWeights(articles)));
    expect(buf).not.toBeNull();
    const { payload } = deserializeBinary(buf!);
    const { groups } = decodeArticlePayload(payload);

    const weightByTitle = new Map(
      groups.flat().map((m) => [m.title, m.weight]),
    );
    expect(weightByTitle.get("NE")).toBe(0);
    expect(weightByTitle.get("NW")).toBe(51);
    expect(weightByTitle.get("SE")).toBe(102);
    expect(weightByTitle.get("SW")).toBe(153);
    expect(weightByTitle.get("C")).toBe(204);
  });

  it("builds tiles with all-zero weights when no article has views (old NDJSON)", () => {
    const articles: Article[] = [
      { title: "NE", lat: 14, lon: 4 },
      { title: "NW", lat: 14, lon: 1 },
      { title: "SE", lat: 11, lon: 4 },
      { title: "SW", lat: 11, lon: 1 },
    ];

    const buf = buildTile(mergeCoincident(attachWeights(articles)));
    expect(buf).not.toBeNull();
    const { payload } = deserializeBinary(buf!);
    const { groups } = decodeArticlePayload(payload);
    expect(groups.flat().map((m) => m.weight)).toEqual([0, 0, 0, 0]);
  });

  it("gives tied views the same class and zero/missing views class 0", () => {
    const articles: Article[] = [
      { title: "A", lat: 14, lon: 4, views: 100 },
      { title: "B", lat: 14, lon: 1, views: 100 }, // tied with A
      { title: "C", lat: 11, lon: 4, views: 0 }, // explicit zero
      { title: "D", lat: 11, lon: 1 }, // missing views
    ];

    const buf = buildTile(mergeCoincident(attachWeights(articles)));
    expect(buf).not.toBeNull();
    const { payload } = deserializeBinary(buf!);
    const { groups } = decodeArticlePayload(payload);

    const weightByTitle = new Map(
      groups.flat().map((m) => [m.title, m.weight]),
    );
    expect(weightByTitle.get("A")).toBe(weightByTitle.get("B"));
    expect(weightByTitle.get("A")).toBeGreaterThan(0);
    expect(weightByTitle.get("C")).toBe(0);
    expect(weightByTitle.get("D")).toBe(0);
  });
});

// ---------- mergeCoincident ----------

describe("mergeCoincident", () => {
  it("groups articles at bit-identical coordinates into one unit", () => {
    const merged = mergeCoincident([
      { title: "Building", lat: 40, lon: -74, weight: 100 },
      { title: "Museum", lat: 40, lon: -74, weight: 200 },
      { title: "Elsewhere", lat: 41, lon: -75, weight: 50 },
    ]);

    expect(merged).toHaveLength(2);
    // Unit order follows first occurrence of each coordinate; within a group,
    // articles are ordered most-notable first.
    expect(merged[0].group.map((a) => a.title)).toEqual(["Museum", "Building"]);
    expect(merged[1].group.map((a) => a.title)).toEqual(["Elsewhere"]);
  });

  it("orders a group by weight desc, then title asc, and takes group[0] as representative", () => {
    const merged = mergeCoincident([
      { title: "Zeta", lat: 0, lon: 0, weight: 10 },
      { title: "Alpha", lat: 0, lon: 0, weight: 10 }, // tie → title breaks it
      { title: "Top", lat: 0, lon: 0, weight: 99 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].group.map((a) => a.title)).toEqual([
      "Top",
      "Alpha",
      "Zeta",
    ]);
    expect(merged[0].title).toBe("Top");
    expect(merged[0].weight).toBe(99);
  });

  it("leaves distinct coordinates as singleton units", () => {
    const merged = mergeCoincident([
      { title: "A", lat: 1, lon: 1, weight: 0 },
      { title: "B", lat: 2, lon: 2, weight: 0 },
    ]);

    expect(merged.map((u) => u.group.length)).toEqual([1, 1]);
  });
});

describe("buildFarField", () => {
  it("keeps the most notable articles from each cell", () => {
    const index = buildArticleIndex(
      mergeCoincident(
        attachWeights([
          { title: "popular", lat: 12, lon: 2, views: 10_000 },
          { title: "middling", lat: 12.1, lon: 2, views: 500 },
          { title: "obscure", lat: 12.2, lon: 2, views: 1 },
        ]),
      ),
    );

    const farField = buildFarField(index, 2);

    expect(farField.map((e) => e.title)).toEqual(["popular", "middling"]);
  });

  it("covers cells too sparse to become a tile", () => {
    // Two articles is below MIN_ARTICLES, so this cell produces no .bin —
    // without the far field its articles would be unreachable entirely.
    const index = buildArticleIndex(
      mergeCoincident(
        attachWeights([
          { title: "Remote Atoll", lat: -19.5, lon: -139.5, views: 30 },
          { title: "Atoll Lagoon", lat: -19.4, lon: -139.4, views: 20 },
        ]),
      ),
    );

    expect(buildFarField(index, 25).map((e) => e.title)).toEqual([
      "Remote Atoll",
      "Atoll Lagoon",
    ]);
  });

  it("lets co-located articles compete for slots individually", () => {
    // Same coordinates — these collapse to one triangulation vertex, but each
    // is a distinct article and should be ranked on its own notability.
    const index = buildArticleIndex(
      mergeCoincident(
        attachWeights([
          { title: "The Building", lat: 12, lon: 2, views: 900 },
          { title: "The Institution", lat: 12, lon: 2, views: 8_000 },
        ]),
      ),
    );

    const farField = buildFarField(index, 25);

    expect(farField.map((e) => e.title)).toEqual([
      "The Institution",
      "The Building",
    ]);
    expect(farField[0].lat).toBe(12);
    expect(farField[1].lat).toBe(12);
  });

  it("emits cells in sorted tile order so rebuilds are byte-identical", () => {
    const index = buildArticleIndex(
      mergeCoincident(
        attachWeights([
          { title: "Tokyo area", lat: 37, lon: 141, views: 100 }, // tile 25-64
          { title: "Africa area", lat: 12, lon: 2, views: 100 }, // tile 20-36
        ]),
      ),
    );

    expect(buildFarField(index, 25).map((e) => e.title)).toEqual([
      "Africa area",
      "Tokyo area",
    ]);
  });
});

describe("cellCandidates", () => {
  it("flattens a cell's units into candidates tagged with each unit's coordinates", () => {
    const index = buildArticleIndex(
      mergeCoincident([
        { title: "North Point", lat: 14, lon: 2, weight: 50 },
        { title: "South Point", lat: 11, lon: 2, weight: 10 },
      ]),
    );

    const candidates = cellCandidates(index, "20-36");

    expect(candidates).toEqual(
      expect.arrayContaining([
        { title: "North Point", lat: 14, lon: 2, weight: 50 },
        { title: "South Point", lat: 11, lon: 2, weight: 10 },
      ]),
    );
    expect(candidates).toHaveLength(2);
  });
});

describe("buildMidFieldDigest", () => {
  it("returns null when a cell has FARFIELD_TOP_K candidates or fewer", () => {
    // Exactly 25 (== FARFIELD_TOP_K): the boundary the far field already
    // covers in full, so this cell should get no digest at all.
    const articles = Array.from({ length: 25 }, (_, i) => ({
      title: `Article ${i}`,
      lat: 12 + i * 0.01,
      lon: 2,
      weight: i,
    }));
    const index = buildArticleIndex(mergeCoincident(articles));

    expect(buildMidFieldDigest(index, "20-36")).toBeNull();
  });

  it("keeps the top-K most notable articles once a cell exceeds FARFIELD_TOP_K candidates", () => {
    // 30 distinct articles in one cell — comfortably more than
    // FARFIELD_TOP_K (25) — each at a slightly different coordinate so they
    // don't merge into one unit.
    const articles = Array.from({ length: 30 }, (_, i) => ({
      title: `Article ${i}`,
      lat: 12 + i * 0.01,
      lon: 2,
      weight: i,
    }));
    const index = buildArticleIndex(mergeCoincident(articles));

    const digest = buildMidFieldDigest(index, "20-36", 3);

    expect(digest?.map((e) => e.title)).toEqual([
      "Article 29",
      "Article 28",
      "Article 27",
    ]);
  });

  it("lets coincident articles compete individually for digest slots", () => {
    // 24 unremarkable filler articles clear the FARFIELD_TOP_K threshold on
    // their own; three more share one coordinate (one triangulation vertex)
    // but stay individually ranked, so all three should take the top slots.
    const filler = Array.from({ length: 24 }, (_, i) => ({
      title: `Filler ${i}`,
      lat: 12 + i * 0.01,
      lon: 2,
      weight: 0,
    }));
    const coincident = [
      { title: "The Institution", lat: 13, lon: 2, weight: 900 },
      { title: "The Building", lat: 13, lon: 2, weight: 500 },
      { title: "The Society", lat: 13, lon: 2, weight: 100 },
    ];
    const index = buildArticleIndex(
      mergeCoincident([...filler, ...coincident]),
    );

    const digest = buildMidFieldDigest(index, "20-36", 3);

    expect(digest?.map((e) => e.title)).toEqual([
      "The Institution",
      "The Building",
      "The Society",
    ]);
  });
});

describe("far field and mid-field digest nesting", () => {
  it("has far-field entries that are exactly the first FARFIELD_TOP_K of the cell's digest", () => {
    // The two tiers share a sort (weight desc, then title asc), so slicing
    // the same candidate list at two different depths must nest — the far
    // field is always a prefix of the digest, never a divergent selection.
    const articles = Array.from({ length: 30 }, (_, i) => ({
      title: `Article ${i}`,
      lat: 12 + i * 0.01,
      lon: 2,
      weight: i,
    }));
    const index = buildArticleIndex(mergeCoincident(articles));

    const farField = buildFarField(index);
    const digest = buildMidFieldDigest(index, "20-36");

    expect(digest).not.toBeNull();
    expect(farField.map((e) => e.title)).toEqual(
      digest!.slice(0, FARFIELD_TOP_K).map((e) => e.title),
    );
  });
});

describe("buildTile (coincident articles)", () => {
  it("keeps every co-located article in one vertex group instead of dropping it", () => {
    // Four distinct corners plus two articles sharing the center coordinate.
    const merged = mergeCoincident(
      attachWeights([
        { title: "Center Tower", lat: 12.5, lon: 2.5, views: 500 },
        { title: "Center Museum", lat: 12.5, lon: 2.5, views: 100 },
        { title: "NE", lat: 14, lon: 4 },
        { title: "NW", lat: 14, lon: 1 },
        { title: "SE", lat: 11, lon: 4 },
        { title: "SW", lat: 11, lon: 1 },
      ]),
    );

    const buf = buildTile(merged);
    expect(buf).not.toBeNull();
    const { groups } = decodeArticlePayload(deserializeBinary(buf!).payload);

    // All six survive — none silently dropped by the hull's coincident dedupe.
    expect(new Set(groups.flat().map((a) => a.title))).toEqual(
      new Set(["Center Tower", "Center Museum", "NE", "NW", "SE", "SW"]),
    );
    // The two coincident articles are carried together on one vertex.
    const centerGroup = groups.find((g) =>
      g.some((a) => a.title === "Center Tower"),
    );
    expect(centerGroup!.map((a) => a.title).sort()).toEqual([
      "Center Museum",
      "Center Tower",
    ]);
  });
});

// ---------- Integration: tiled pipeline ----------

describe("tiled pipeline (e2e)", () => {
  const testDir = join(tmpdir(), "build-tiled-test-" + Date.now());
  const dataDir = join(testDir, "data");
  const articlesPath = join(dataDir, "articles-en.json");

  // These subprocesses run tsx with cwd inside a throwaway temp dir. tsx
  // discovers tsconfig `paths` from its cwd, so from outside the repo it can't
  // map the `spherical-delaunay` workspace specifier to live TS source and
  // falls back to the package's published `dist/` entry (absent in dev). Point
  // tsx at the repo tsconfig explicitly so it resolves to source regardless.
  const pipelineEnv = {
    ...process.env,
    TSX_TSCONFIG_PATH: join(process.cwd(), "tsconfig.json"),
  };

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
      { cwd: testDir, timeout: 30_000, env: pipelineEnv },
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

    // The far-field tier: every cell contributes, and the index describes it
    // so the app can cache-invalidate on content change.
    expect(index.farField).toBeDefined();
    expect(index.farField!.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(index.farField!.count).toBe(30);

    const farFieldBuf = readFileSync(join(tilesDir, "farfield.bin"));
    expect(farFieldBuf.byteLength).toBe(index.farField!.bytes);
    const farField = decodeFarField(
      farFieldBuf.buffer.slice(
        farFieldBuf.byteOffset,
        farFieldBuf.byteOffset + farFieldBuf.byteLength,
      ),
    );
    expect(farField).toHaveLength(30);
    expect(farField.map((e) => e.title).sort()).toContain("Stockholm_0");

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
      const { fd, payload } = deserializeBinary(
        binBuf.buffer.slice(
          binBuf.byteOffset,
          binBuf.byteOffset + binBuf.byteLength,
        ),
      );
      const { groups } = decodeArticlePayload(payload);

      // Total articles (summed across per-vertex groups) covers at least the
      // tile's native count; vertex count is one per group.
      expect(groups.flat().length).toBeGreaterThanOrEqual(tile.articles);
      expect(fd.vertexPoints.length).toBe(groups.length * 3);
    }

    // Verify total native article count matches input
    const totalArticles = index.tiles.reduce((s, t) => s + t.articles, 0);
    expect(totalArticles).toBe(30); // 3 clusters * 10 articles

    // Verify per-tile .bin files on disk match the index (farfield.bin is a
    // single global artifact, not a tile)
    const binFiles = readdirSync(tilesDir).filter(
      (f) => f.endsWith(".bin") && f !== "farfield.bin",
    );
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
      execFileSync(tsxBin, [buildScript], {
        cwd: testDir1,
        timeout: 30_000,
        env: pipelineEnv,
      });
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
      execFileSync(tsxBin, [buildScript], {
        cwd: testDir2,
        timeout: 30_000,
        env: pipelineEnv,
      });
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

  it("writes a mid-field digest only for tiles whose candidate count exceeds FARFIELD_TOP_K", () => {
    const digestTestDir = join(tmpdir(), "build-digest-test-" + Date.now());
    const digestDataDir = join(digestTestDir, "data");

    try {
      mkdirSync(digestDataDir, { recursive: true });

      const lines: string[] = [];
      // 30 articles in one tile (tile 28-36, same grid cell as the "London"
      // cluster above) — comfortably over FARFIELD_TOP_K (25) — each with a
      // distinct view count so ranking is unambiguous.
      for (let i = 0; i < 30; i++) {
        lines.push(
          JSON.stringify({
            title: `Big_${i}`,
            lat: 52.0 + (i % 10) * 0.1,
            lon: 2.0 + Math.floor(i / 10) * 0.1,
            views: (i + 1) * 100,
          }),
        );
      }
      // An ordinary 10-article tile (tile 29-39, the "Stockholm" cluster's
      // grid cell) that should get no digest at all.
      for (let i = 0; i < 10; i++) {
        lines.push(
          JSON.stringify({
            title: `Small_${i}`,
            lat: 57.0 + (i % 5) * 0.2,
            lon: 17.0 + Math.floor(i / 5) * 0.2,
          }),
        );
      }
      writeFileSync(
        join(digestDataDir, "articles-en.json"),
        lines.join("\n"),
        "utf-8",
      );

      execFileSync(
        join(process.cwd(), "node_modules", ".bin", "tsx"),
        [join(process.cwd(), "src/pipeline/build.ts")],
        { cwd: digestTestDir, timeout: 30_000, env: pipelineEnv },
      );

      const tilesDir = join(digestDataDir, "tiles", "en");
      const index: TileIndex = JSON.parse(
        readFileSync(join(tilesDir, "index.json"), "utf-8"),
      );

      const bigTile = index.tiles.find((t) => t.id === "28-36");
      const smallTile = index.tiles.find((t) => t.id === "29-39");
      expect(bigTile).toBeDefined();
      expect(smallTile).toBeDefined();

      // Too few candidates to earn a digest: no metadata, no file on disk.
      expect(smallTile!.digest).toBeUndefined();
      expect(existsSync(join(tilesDir, "29-39.digest.bin"))).toBe(false);

      // Comfortably over the threshold: metadata in the index and a file on
      // disk that decodes back to every one of its 30 articles.
      expect(bigTile!.digest).toBeDefined();
      expect(bigTile!.digest!.count).toBe(30);
      expect(bigTile!.digest!.hash).toMatch(/^[0-9a-f]{8}$/);

      const digestBuf = readFileSync(join(tilesDir, "28-36.digest.bin"));
      expect(digestBuf.byteLength).toBe(bigTile!.digest!.bytes);

      const digest = decodeFarField(
        digestBuf.buffer.slice(
          digestBuf.byteOffset,
          digestBuf.byteOffset + digestBuf.byteLength,
        ),
      );
      expect(digest).toHaveLength(30);
      expect(digest[0].title).toBe("Big_29"); // highest views → ranked first
    } finally {
      rmSync(digestTestDir, { recursive: true, force: true });
    }
  });
});
