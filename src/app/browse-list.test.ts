import {
  DISTANCE_BAND_QUOTA,
  FULL_DETAIL_RADIUS_M,
  buildBrowseList,
  coverageRadiusMeters,
  sampleByDistanceBand,
} from "./browse-list";
import { tileBoxLowerBoundMeters } from "./tile-loader";
import type { FarFieldEntry } from "../farfield";
import type { TileEntry } from "../tiles";
import type { NearbyArticle } from "./types";

function tileEntry(id: string): TileEntry {
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

    const list = buildBrowseList({ position, local, farField });

    expect(list.map((a) => a.title)).toEqual([
      "Next door",
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

    const list = buildBrowseList({ position, local, farField });

    expect(list.map((a) => a.title)).toEqual(["Very close", "Middle", "Far"]);
  });

  it("lists an article once when both tiers carry it", () => {
    const local: NearbyArticle[] = [
      { title: "Notable Landmark", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Notable Landmark", lat: 0.01, lon: 0, weight: 250 },
    ];

    const list = buildBrowseList({ position, local, farField });

    expect(list).toHaveLength(1);
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

    const list = buildBrowseList({ position, local, farField });

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
      farField,
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

    const list = buildBrowseList({ position, local: city, farField });

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

    const list = buildBrowseList({ position, local: crowd, farField });

    expect(list.map((a) => a.title)).toContain("Bus stop 999");
  });

  it("is empty when neither tier has anything", () => {
    expect(buildBrowseList({ position, local: [], farField: [] })).toEqual([]);
  });
});
