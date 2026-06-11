import {
  radarRange,
  scaleRadius,
  blipOffset,
  hitTest,
  sweepTrailBoost,
} from "./radar-math";
import type { RadarBlip } from "./radar-math";

function expectClose(actual: number, expected: number, tol = 1e-9) {
  expect(Math.abs(actual - expected)).toBeLessThan(tol);
}

describe("radarRange", () => {
  it("covers a typical urban spread with km rings", () => {
    expect(radarRange(3400)).toEqual({
      maxM: 4000,
      rings: [1000, 2000, 3000, 4000],
    });
  });

  it("scales down to street-level distances", () => {
    expect(radarRange(90)).toEqual({ maxM: 100, rings: [25, 50, 75, 100] });
  });

  it("scales up to rural distances", () => {
    expect(radarRange(18_000)).toEqual({
      maxM: 20_000,
      rings: [5000, 10_000, 15_000, 20_000],
    });
  });

  it("falls back to a 1 km scale when there is nothing to fit", () => {
    expect(radarRange(0)).toEqual({
      maxM: 1000,
      rings: [250, 500, 750, 1000],
    });
    expect(radarRange(Number.NaN)).toEqual(radarRange(0));
  });

  it("always reaches at least the requested distance", () => {
    for (const d of [1, 7, 49, 333, 1001, 4999, 123_456, 2_000_000]) {
      const { maxM, rings } = radarRange(d);
      expect(maxM).toBeGreaterThanOrEqual(d);
      expect(rings.at(-1)).toBe(maxM);
      expect(rings.length).toBeGreaterThanOrEqual(3);
      expect(rings.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("scaleRadius", () => {
  it("maps full-scale distance to the full radius", () => {
    expectClose(scaleRadius(2000, 2000, 150), 150);
  });

  it("maps a quarter of full scale to half the radius (sqrt scale)", () => {
    expectClose(scaleRadius(500, 2000, 150), 75);
  });

  it("clamps beyond-range distances to the radius", () => {
    expect(scaleRadius(9999, 2000, 150)).toBe(150);
  });

  it("maps zero distance to the center", () => {
    expect(scaleRadius(0, 2000, 150)).toBe(0);
  });
});

describe("blipOffset", () => {
  const R = 100;

  it("places a northern article straight up in north-up mode", () => {
    const { x, y } = blipOffset(0, 1000, 0, 1000, R);
    expectClose(x, 0);
    expectClose(y, -R);
  });

  it("places an eastern article to the right in north-up mode", () => {
    const { x, y } = blipOffset(90, 1000, 0, 1000, R);
    expectClose(x, R);
    expectClose(y, 0);
  });

  it("places a southern article straight down in north-up mode", () => {
    const { x, y } = blipOffset(180, 1000, 0, 1000, R);
    expectClose(x, 0);
    expectClose(y, R);
  });

  it("rotates with the device heading: facing east puts an eastern article ahead", () => {
    const { x, y } = blipOffset(90, 1000, 90, 1000, R);
    expectClose(x, 0);
    expectClose(y, -R);
  });
});

describe("hitTest", () => {
  const blips: RadarBlip<string>[] = [
    { x: 10, y: 0, item: "east" },
    { x: -10, y: 0, item: "west" },
    { x: 0, y: -40, item: "north" },
  ];

  it("returns the nearest blip within tolerance", () => {
    expect(hitTest(blips, 8, 1, 20)).toBe("east");
  });

  it("returns null when nothing is within tolerance", () => {
    expect(hitTest(blips, 100, 100, 20)).toBeNull();
  });

  it("prefers the nearer of two candidates in range", () => {
    expect(hitTest(blips, -2, 0, 50)).toBe("west");
  });

  it("returns null for an empty blip list", () => {
    expect(hitTest([], 0, 0, 20)).toBeNull();
  });
});

describe("sweepTrailBoost", () => {
  it("is 1 exactly at the sweep angle", () => {
    expectClose(sweepTrailBoost(45, 45), 1);
  });

  it("fades to half strength midway through the trail", () => {
    expectClose(sweepTrailBoost(0, 60, 120), 0.5);
  });

  it("is 0 once the trail has passed", () => {
    expect(sweepTrailBoost(0, 200, 120)).toBe(0);
  });

  it("is 0 just ahead of the sweep", () => {
    expect(sweepTrailBoost(50, 45, 120)).toBe(0);
  });

  it("handles wrap-around: sweep just past north lights a blip at 350°", () => {
    expectClose(sweepTrailBoost(350, 10, 120), 1 - 20 / 120);
  });
});
