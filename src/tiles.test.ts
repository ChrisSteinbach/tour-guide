import { tileFor, tileId, wrapCol } from "./tiles";

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

  it("clamps lat=90 to max row", () => {
    expect(tileFor(90, 0)).toEqual({ row: 35, col: 36 });
  });

  it("clamps lon=180 to max col", () => {
    expect(tileFor(0, 180)).toEqual({ row: 18, col: 71 });
  });
});

describe("wrapCol", () => {
  it("returns positive in-range columns unchanged", () => {
    expect(wrapCol(0)).toBe(0);
    expect(wrapCol(35)).toBe(35);
    expect(wrapCol(71)).toBe(71);
  });

  it("wraps negative columns into range", () => {
    expect(wrapCol(-1)).toBe(71);
    expect(wrapCol(-3)).toBe(69);
    expect(wrapCol(-72)).toBe(0);
  });

  it("wraps large positive columns into range", () => {
    expect(wrapCol(73)).toBe(1);
    expect(wrapCol(144)).toBe(0);
    expect(wrapCol(145)).toBe(1);
  });

  it("wraps exact multiples of COLS (72) to 0", () => {
    expect(wrapCol(72)).toBe(0);
    expect(wrapCol(144)).toBe(0);
    expect(wrapCol(-72)).toBe(0);
    expect(wrapCol(-144)).toBe(0);
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
