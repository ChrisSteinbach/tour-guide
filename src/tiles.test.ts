import { tileFor, tileId, GRID_DEG } from "./tiles";

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
    expect(tileFor(10, 0)).toEqual({ row: 20, col: 36 });
    expect(tileFor(9.99, 0)).toEqual({ row: 19, col: 36 });
  });
});

describe("tileId", () => {
  it("zero-pads single digits", () => {
    expect(tileId(5, 3)).toBe("05-03");
  });

  it("preserves double digits", () => {
    expect(tileId(29, 39)).toBe("29-39");
  });

  it("handles row 0 col 0", () => {
    expect(tileId(0, 0)).toBe("00-00");
  });
});

describe("constants", () => {
  it("GRID_DEG is 5", () => {
    expect(GRID_DEG).toBe(5);
  });
});
