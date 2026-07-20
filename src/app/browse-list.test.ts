import {
  DISTANCE_BAND_QUOTA,
  FULL_DETAIL_RADIUS_M,
  buildBrowseList,
  coverageRadiusMeters,
  sampleByDistanceBand,
  selectDigestCells,
} from "./browse-list";
import { tileBoxLowerBoundMeters } from "./tile-loader";
import type { FarFieldEntry } from "../farfield";
import type { SampledTierMeta, TileEntry } from "../tiles";
import type { NearbyArticle } from "./types";

/** `digest` is set only when the caller wants this cell to carry mid-field metadata. */
function tileEntry(id: string, digest?: SampledTierMeta): TileEntry {
  const [row, col] = id.split("-").map(Number);
  const south = row * 5 - 90;
  const west = col * 5 - 180;
  return {
    id,
    row,
    col,
    south,
    north: south + 5,
    west,
    east: west + 5,
    articles: 100,
    bytes: 1000,
    hash: "abcd1234",
    ...(digest ? { digest } : {}),
  };
}

function tileMap(...ids: string[]): Map<string, TileEntry> {
  return new Map(ids.map((id) => [id, tileEntry(id)]));
}

describe("coverageRadiusMeters", () => {
  it("reaches to the nearest tile that exists but is not loaded", () => {
    // Position sits in tile 20-36. 20-37 is the neighbour to the east,
    // 25-64 is on the other side of the planet.
    const tiles = tileMap("20-36", "20-37", "25-64");

    const radius = coverageRadiusMeters(tiles, new Set(["20-36"]), 12, 2);

    expect(radius).toBe(tileBoxLowerBoundMeters("20-37", 12, 2));
  });

  it("is unbounded once every existing tile is loaded", () => {
    const tiles = tileMap("20-36", "20-37");

    const radius = coverageRadiusMeters(
      tiles,
      new Set(["20-36", "20-37"]),
      12,
      2,
    );

    expect(radius).toBe(Infinity);
  });

  it("shrinks when a nearer tile goes unloaded", () => {
    const tiles = tileMap("20-36", "20-37", "25-64");

    const nearUnloaded = coverageRadiusMeters(tiles, new Set(["20-36"]), 12, 2);
    const onlyFarUnloaded = coverageRadiusMeters(
      tiles,
      new Set(["20-36", "20-37"]),
      12,
      2,
    );

    expect(nearUnloaded).toBeLessThan(onlyFarUnloaded);
  });
});

describe("selectDigestCells", () => {
  const position = { lat: 0, lon: 0 }; // sits in tile 18-36
  const DIGEST_META: SampledTierMeta = {
    count: 250,
    bytes: 2048,
    hash: "aabbccdd",
  };

  it("skips a populated cell that has no digest", () => {
    const tiles = new Map([
      ["18-36", tileEntry("18-36", DIGEST_META)],
      ["18-37", tileEntry("18-37")],
    ]);

    const cells = selectDigestCells(tiles, position.lat, position.lon);

    expect(cells).toEqual(["18-36"]);
  });

  it("excludes cells beyond MID_FIELD_RADIUS_M and includes cells within it", () => {
    const tiles = new Map([
      ["18-38", tileEntry("18-38", DIGEST_META)], // ~1,056 km away: inside
      ["18-39", tileEntry("18-39", DIGEST_META)], // ~1,612 km away: outside
    ]);

    const cells = selectDigestCells(tiles, position.lat, position.lon);

    expect(cells).toEqual(["18-38"]);
  });

  it("orders results nearest cell first", () => {
    const tiles = new Map([
      ["18-38", tileEntry("18-38", DIGEST_META)], // ~1,056 km away
      ["18-36", tileEntry("18-36", DIGEST_META)], // 0 km: contains the position
      ["18-37", tileEntry("18-37", DIGEST_META)], // ~500 km away
    ]);

    const cells = selectDigestCells(tiles, position.lat, position.lon);

    expect(cells).toEqual(["18-36", "18-37", "18-38"]);
  });

  it("includes the cell the position is standing in, even though it is already loaded", () => {
    const tiles = new Map([["18-36", tileEntry("18-36", DIGEST_META)]]);

    const cells = selectDigestCells(tiles, position.lat, position.lon);

    expect(cells).toEqual(["18-36"]);
  });
});

describe("sampleByDistanceBand", () => {
  it("keeps every article within the full-detail radius, however dense", () => {
    const crowd: NearbyArticle[] = Array.from(
      { length: DISTANCE_BAND_QUOTA * 10 },
      (_, i) => ({
        title: `Doorstep ${i}`,
        lat: 0,
        lon: 0,
        distanceM: FULL_DETAIL_RADIUS_M - i,
        weight: 1,
      }),
    );

    expect(sampleByDistanceBand(crowd)).toHaveLength(crowd.length);
  });

  it("thins a crowded band to its quota, keeping the most notable", () => {
    const band: NearbyArticle[] = Array.from({ length: 1000 }, (_, i) => ({
      title: `Bus stop ${i}`,
      lat: 0,
      lon: 0,
      distanceM: FULL_DETAIL_RADIUS_M * 1.5,
      weight: i,
    }));

    const kept = sampleByDistanceBand(band);

    expect(kept).toHaveLength(DISTANCE_BAND_QUOTA);
    const lightest = Math.min(...kept.map((a) => a.weight ?? 0));
    expect(lightest).toBe(1000 - DISTANCE_BAND_QUOTA);
  });

  it("keeps a sparse band whole, so quiet regions stay exhaustive", () => {
    const countryside: NearbyArticle[] = [
      { title: "Barn", lat: 0, lon: 0, distanceM: 4_000, weight: 0 },
      { title: "Chapel", lat: 0, lon: 0, distanceM: 40_000, weight: 0 },
      { title: "Quarry", lat: 0, lon: 0, distanceM: 400_000, weight: 0 },
    ];

    expect(sampleByDistanceBand(countryside).map((a) => a.title)).toEqual(
      expect.arrayContaining(["Barn", "Chapel", "Quarry"]),
    );
  });

  it("spends the same number of rows on every doubling of distance", () => {
    // 2,000 articles per band across five bands, all equally crowded.
    const city: NearbyArticle[] = [];
    for (let band = 0; band < 5; band++) {
      for (let i = 0; i < 2000; i++) {
        city.push({
          title: `Band ${band} article ${i}`,
          lat: 0,
          lon: 0,
          distanceM: FULL_DETAIL_RADIUS_M * 2 ** band * 1.5,
          weight: i,
        });
      }
    }

    const kept = sampleByDistanceBand(city);

    const perBand = new Map<number, number>();
    for (const article of kept) {
      const band = Math.floor(
        Math.log2(article.distanceM / FULL_DETAIL_RADIUS_M),
      );
      perBand.set(band, (perBand.get(band) ?? 0) + 1);
    }
    expect([...perBand.values()]).toEqual(Array(5).fill(DISTANCE_BAND_QUOTA));
  });

  it("prefers the nearer of two equally notable articles", () => {
    const pair: NearbyArticle[] = Array.from({ length: 300 }, (_, i) => ({
      title: `Tie ${i}`,
      lat: 0,
      lon: 0,
      distanceM: FULL_DETAIL_RADIUS_M * 1.1 + i,
      weight: 100,
    }));

    const kept = sampleByDistanceBand(pair);

    expect(kept).toHaveLength(DISTANCE_BAND_QUOTA);
    expect(kept.map((a) => a.title)).toContain("Tie 0");
    expect(kept.map((a) => a.title)).not.toContain("Tie 299");
  });
});

describe("buildBrowseList", () => {
  const position = { lat: 0, lon: 0 };

  it("continues the list past the loaded tiles with far-field articles", () => {
    const local: NearbyArticle[] = [
      { title: "Next door", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Another continent", lat: 50, lon: 0, weight: 200 },
    ];

    const list = buildBrowseList({ position, local, midField: [], farField });

    expect(list.map((a) => a.title)).toEqual([
      "Next door",
      "Another continent",
    ]);
  });

  it("includes mid-field entries in the merged, distance-ordered list", () => {
    const local: NearbyArticle[] = [
      { title: "Next door", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const midField: FarFieldEntry[] = [
      { title: "Mid-field town", lat: 2, lon: 0, weight: 100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Another continent", lat: 50, lon: 0, weight: 200 },
    ];

    const list = buildBrowseList({ position, local, midField, farField });

    expect(list.map((a) => a.title)).toEqual([
      "Next door",
      "Mid-field town",
      "Another continent",
    ]);
  });

  it("orders the merged list by distance regardless of tier", () => {
    const local: NearbyArticle[] = [
      { title: "Very close", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Far", lat: 50, lon: 0, weight: 200 },
      { title: "Middle", lat: 5, lon: 0, weight: 200 },
    ];

    const list = buildBrowseList({ position, local, midField: [], farField });

    expect(list.map((a) => a.title)).toEqual(["Very close", "Middle", "Far"]);
  });

  it("lists an article once when both tiers carry it", () => {
    const local: NearbyArticle[] = [
      { title: "Notable Landmark", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Notable Landmark", lat: 0.01, lon: 0, weight: 250 },
    ];

    const list = buildBrowseList({ position, local, midField: [], farField });

    expect(list).toHaveLength(1);
  });

  it("lists an article once when both mid-field and far-field carry it", () => {
    const midField: FarFieldEntry[] = [
      { title: "Notable Landmark", lat: 2, lon: 0, weight: 250 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Notable Landmark", lat: 2, lon: 0, weight: 250 },
    ];

    const list = buildBrowseList({ position, local: [], midField, farField });

    expect(list).toHaveLength(1);
  });

  it("keeps the local entry when the same title also appears in mid-field", () => {
    // local carries real query data (a real distanceM and weight); a sampled
    // tier repeating the same title must not shadow it.
    const local: NearbyArticle[] = [
      { title: "Corner Cafe", lat: 0.001, lon: 0, distanceM: 50, weight: 12 },
    ];
    const midField: FarFieldEntry[] = [
      { title: "Corner Cafe", lat: 0.001, lon: 0, weight: 250 },
    ];

    const list = buildBrowseList({
      position,
      local,
      midField,
      farField: [],
    });

    expect(list).toHaveLength(1);
    expect(list[0].weight).toBe(12);
  });

  it("surfaces far-field articles from cells too sparse to have a tile", () => {
    // Inside the covered radius, but no tile was ever built for its cell —
    // the far-field tier is the only route to this article.
    const local: NearbyArticle[] = [
      { title: "Covered", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Lone Island", lat: 0.5, lon: 0, weight: 30 },
    ];

    const list = buildBrowseList({ position, local, midField: [], farField });

    expect(list.map((a) => a.title)).toEqual(["Covered", "Lone Island"]);
  });

  it("applies the Highlights floor to far-field articles", () => {
    const farField: FarFieldEntry[] = [
      { title: "Famous", lat: 5, lon: 0, weight: 250 },
      { title: "Unremarkable", lat: 5, lon: 0, weight: 10 },
    ];

    const list = buildBrowseList({
      position,
      local: [],
      midField: [],
      farField,
      minWeight: 204,
    });

    expect(list.map((a) => a.title)).toEqual(["Famous"]);
  });

  it("applies the Highlights floor to mid-field articles", () => {
    const midField: FarFieldEntry[] = [
      { title: "Famous", lat: 2, lon: 0, weight: 250 },
      { title: "Unremarkable", lat: 2, lon: 0, weight: 10 },
    ];

    const list = buildBrowseList({
      position,
      local: [],
      midField,
      farField: [],
      minWeight: 204,
    });

    expect(list.map((a) => a.title)).toEqual(["Famous"]);
  });

  it("keeps a dense city from burying the rest of the planet", () => {
    // 20,000 articles spread over 1-100 km: seven doublings of distance, so
    // the graded tier costs at most seven quotas however crowded the city is.
    const city: NearbyArticle[] = Array.from({ length: 20_000 }, (_, i) => ({
      title: `City article ${i}`,
      lat: 0.01,
      lon: 0,
      distanceM: 1_001 + (i % 99_000),
      weight: i % 256,
    }));
    const farField: FarFieldEntry[] = [
      { title: "Another continent", lat: 50, lon: 0, weight: 200 },
    ];

    const list = buildBrowseList({
      position,
      local: city,
      midField: [],
      farField,
    });

    expect(list.length).toBeLessThanOrEqual(7 * DISTANCE_BAND_QUOTA + 1);
    expect(list[list.length - 1].title).toBe("Another continent");
  });

  it("restores a notable article the band sampling dropped", () => {
    // The far-field tier is itself a notability ranking, so anything it
    // carries has earned a row even when the local quota had no space left.
    const crowd: NearbyArticle[] = Array.from({ length: 1000 }, (_, i) => ({
      title: `Bus stop ${i}`,
      lat: 0.02,
      lon: 0,
      distanceM: 2_000,
      weight: 0,
    }));
    const farField: FarFieldEntry[] = [
      { title: "Bus stop 999", lat: 0.02, lon: 0, weight: 250 },
    ];

    const list = buildBrowseList({
      position,
      local: crowd,
      midField: [],
      farField,
    });

    expect(list.map((a) => a.title)).toContain("Bus stop 999");
  });

  it("is empty when neither tier has anything", () => {
    expect(
      buildBrowseList({ position, local: [], midField: [], farField: [] }),
    ).toEqual([]);
  });
});
