import {
  LOCAL_EXHAUSTIVE_MAX,
  buildBrowseList,
  coverageRadiusMeters,
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

describe("buildBrowseList", () => {
  const position = { lat: 0, lon: 0 };

  it("continues the list past the loaded tiles with far-field articles", () => {
    const local: NearbyArticle[] = [
      { title: "Next door", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Another continent", lat: 50, lon: 0, weight: 200 },
    ];

    const list = buildBrowseList({
      position,
      local,
      farField,
      coverageRadiusM: 100_000,
    });

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

    const list = buildBrowseList({
      position,
      local,
      farField,
      coverageRadiusM: 100_000,
    });

    expect(list.map((a) => a.title)).toEqual(["Very close", "Middle", "Far"]);
  });

  it("drops exhaustive articles past the coverage radius", () => {
    // Beyond the covered radius the tiles have holes, so keeping these would
    // make list density depend on which direction happens to be loaded.
    const local: NearbyArticle[] = [
      { title: "Covered", lat: 0.1, lon: 0, distanceM: 11_000 },
      { title: "Past the edge", lat: 2, lon: 0, distanceM: 222_000 },
    ];

    const list = buildBrowseList({
      position,
      local,
      farField: [],
      coverageRadiusM: 100_000,
    });

    expect(list.map((a) => a.title)).toEqual(["Covered"]);
  });

  it("lists an article once when both tiers carry it", () => {
    const local: NearbyArticle[] = [
      { title: "Notable Landmark", lat: 0.01, lon: 0, distanceM: 1_100 },
    ];
    const farField: FarFieldEntry[] = [
      { title: "Notable Landmark", lat: 0.01, lon: 0, weight: 250 },
    ];

    const list = buildBrowseList({
      position,
      local,
      farField,
      coverageRadiusM: 100_000,
    });

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

    const list = buildBrowseList({
      position,
      local,
      farField,
      coverageRadiusM: 1_000_000,
    });

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
      coverageRadiusM: 0,
      minWeight: 204,
    });

    expect(list.map((a) => a.title)).toEqual(["Famous"]);
  });

  it("caps the exhaustive tier so one dense city cannot bury the planet", () => {
    const local: NearbyArticle[] = Array.from(
      { length: LOCAL_EXHAUSTIVE_MAX + 500 },
      (_, i) => ({
        title: `City article ${i}`,
        lat: 0.01,
        lon: 0,
        distanceM: 1_000 + i,
      }),
    );
    const farField: FarFieldEntry[] = [
      { title: "Another continent", lat: 50, lon: 0, weight: 200 },
    ];

    const list = buildBrowseList({
      position,
      local,
      farField,
      coverageRadiusM: 100_000,
    });

    expect(list).toHaveLength(LOCAL_EXHAUSTIVE_MAX + 1);
    expect(list[list.length - 1].title).toBe("Another continent");
  });

  it("is empty when neither tier has anything", () => {
    expect(
      buildBrowseList({
        position,
        local: [],
        farField: [],
        coverageRadiusM: 100_000,
      }),
    ).toEqual([]);
  });
});
