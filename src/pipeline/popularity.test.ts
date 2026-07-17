import { assignWeightClasses } from "./popularity";

describe("assignWeightClasses", () => {
  it("returns an empty array for no articles", () => {
    expect(assignWeightClasses([])).toEqual(new Uint8Array(0));
  });

  it("assigns class 0 to every article when all views are zero", () => {
    expect(assignWeightClasses([0, 0, 0])).toEqual(new Uint8Array([0, 0, 0]));
  });

  it("spreads distinct view counts across the percentile scale", () => {
    // sorted positions 0..3 of 4 → round(255 * i / 4) = 0, 64, 128, 191
    expect(assignWeightClasses([0, 1, 2, 3])).toEqual(
      new Uint8Array([0, 64, 128, 191]),
    );
  });

  it("preserves input order when assigning classes", () => {
    expect(assignWeightClasses([3, 0, 2, 1])).toEqual(
      new Uint8Array([191, 0, 128, 64]),
    );
  });

  it("gives equal views an equal class", () => {
    // sorted: [0, 1, 5, 5] → 0→0, 1→round(255/4)=64, 5→round(255*2/4)=128
    expect(assignWeightClasses([5, 5, 1, 0])).toEqual(
      new Uint8Array([128, 128, 64, 0]),
    );
  });

  it("assigns the top article of five the class 204 (top-20% boundary)", () => {
    // HIGHLIGHT_MIN_WEIGHT = 204 means "top 20%": in a set of 5 distinct
    // view counts, exactly the most-viewed article reaches the threshold.
    const classes = assignWeightClasses([10, 20, 30, 40, 50]);
    expect(classes[4]).toBe(204);
    expect(classes[3]).toBeLessThan(204);
  });

  it("treats negative and non-finite views as zero", () => {
    expect(assignWeightClasses([-5, NaN, Infinity, 0, 7])).toEqual(
      new Uint8Array([0, 0, 0, 0, 204]),
    );
  });

  it("assigns class 0 to a single article", () => {
    expect(assignWeightClasses([12345])).toEqual(new Uint8Array([0]));
  });
});
