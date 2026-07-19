import { collapseCoincident } from "./coincident";
import type { NearbyArticle } from "./types";

function article(
  title: string,
  lat: number,
  lon: number,
  weight?: number,
  distanceM = 100,
): NearbyArticle {
  return { title, lat, lon, distanceM, weight };
}

describe("collapseCoincident", () => {
  it("passes distinct articles through as singleton groups", () => {
    const eiffel = article("Eiffel Tower", 48.858, 2.294);
    const louvre = article("Louvre", 48.861, 2.337);

    const groups = collapseCoincident([eiffel, louvre]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      representative: eiffel,
      members: [eiffel],
      lat: eiffel.lat,
      lon: eiffel.lon,
      distanceM: eiffel.distanceM,
    });
    expect(groups[1].representative).toBe(louvre);
    expect(groups[1].members).toEqual([louvre]);
  });

  it("collapses co-located articles into one group led by the higher-weight member", () => {
    const building = article("Building", 40, -74, 100);
    const museum = article("Museum", 40, -74, 200);

    const groups = collapseCoincident([building, museum]);

    expect(groups).toHaveLength(1);
    expect(groups[0].representative).toBe(museum);
    expect(groups[0].members).toEqual([building, museum]);
    expect(groups[0].lat).toBe(40);
    expect(groups[0].lon).toBe(-74);
  });

  it("keeps articles at distinct coordinates in separate groups", () => {
    const a = article("A", 40, -74, 100);
    const b = article("B", 41, -75, 50);

    const groups = collapseCoincident([a, b]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.members.length)).toEqual([1, 1]);
  });

  it("preserves first-seen group order and within-group input order", () => {
    const first = article("First", 10, 10, 5);
    const second = article("Second", 20, 20, 999); // distinct coordinate
    const third = article("Third", 10, 10, 50); // same coordinate as first, outweighs it

    const groups = collapseCoincident([first, second, third]);

    // Group order follows first occurrence of each coordinate: (10,10) then (20,20).
    expect(groups.map((g) => g.lat)).toEqual([10, 20]);
    // Members keep input order even though "Third" outweighs "First".
    expect(groups[0].members.map((a) => a.title)).toEqual(["First", "Third"]);
    expect(groups[0].representative.title).toBe("Third");
  });

  it("breaks a representative tie by first occurrence", () => {
    const first = article("First", 5, 5, 100);
    const second = article("Second", 5, 5, 100);

    const groups = collapseCoincident([first, second]);

    expect(groups[0].representative).toBe(first);
  });

  it("treats a missing weight as 0 when picking the representative", () => {
    const noWeight = article("NoWeight", 1, 1, undefined);
    const zeroWeight = article("ZeroWeight", 1, 1, 0);

    const groups = collapseCoincident([noWeight, zeroWeight]);

    // 0 is not greater than (undefined ?? 0) === 0, so the first-seen
    // article stays representative.
    expect(groups[0].representative).toBe(noWeight);
  });

  it("takes lat/lon/distanceM from the group's shared coordinate", () => {
    const a = article("A", 1, 1, 10, 250);
    const b = article("B", 1, 1, 20, 250);

    const groups = collapseCoincident([a, b]);

    expect(groups[0].lat).toBe(1);
    expect(groups[0].lon).toBe(1);
    expect(groups[0].distanceM).toBe(250);
  });
});
