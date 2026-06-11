import {
  parseLocationHash,
  encodeLocationHash,
  createUrlMirror,
} from "./url-state";

describe("encodeLocationHash", () => {
  it("formats lat/lon to 4 decimal places and always includes the language", () => {
    expect(encodeLocationHash({ lat: 41.8902, lon: 12.4922 }, "en")).toBe(
      "#41.8902,12.4922&lang=en",
    );
  });

  it("rounds and pads coordinates to exactly 4 decimals", () => {
    expect(encodeLocationHash({ lat: 41.890231, lon: 12.5 }, "sv")).toBe(
      "#41.8902,12.5000&lang=sv",
    );
  });

  it("appends filter=all when the Everything filter is active", () => {
    expect(
      encodeLocationHash({ lat: 41.8902, lon: 12.4922 }, "en", "all"),
    ).toBe("#41.8902,12.4922&lang=en&filter=all");
  });

  it("omits the filter param for the default Highlights filter", () => {
    expect(
      encodeLocationHash({ lat: 41.8902, lon: 12.4922 }, "en", "highlights"),
    ).toBe("#41.8902,12.4922&lang=en");
  });
});

describe("parseLocationHash", () => {
  it("round-trips an encoded hash back to position and language", () => {
    const hash = encodeLocationHash({ lat: 41.8902, lon: 12.4922 }, "sv");

    expect(parseLocationHash(hash)).toEqual({
      position: { lat: 41.8902, lon: 12.4922 },
      lang: "sv",
      filter: undefined,
    });
  });

  it("round-trips an encoded hash with the Everything filter", () => {
    const hash = encodeLocationHash(
      { lat: 41.8902, lon: 12.4922 },
      "sv",
      "all",
    );

    expect(parseLocationHash(hash)).toEqual({
      position: { lat: 41.8902, lon: 12.4922 },
      lang: "sv",
      filter: "all",
    });
  });

  it("parses lang and filter together regardless of param order", () => {
    expect(parseLocationHash("#41.8902,12.4922&filter=all&lang=de")).toEqual({
      position: { lat: 41.8902, lon: 12.4922 },
      lang: "de",
      filter: "all",
    });
  });

  it("yields filter: undefined when the param is absent (old URLs)", () => {
    const parsed = parseLocationHash("#48.8584,2.2945&lang=en");

    expect(parsed?.position).toEqual({ lat: 48.8584, lon: 2.2945 });
    expect(parsed?.filter).toBeUndefined();
  });

  it("accepts an explicit filter=highlights", () => {
    expect(parseLocationHash("#48.8584,2.2945&filter=highlights")?.filter).toBe(
      "highlights",
    );
  });

  it("keeps the position but drops an unrecognised filter value", () => {
    const parsed = parseLocationHash("#48.8584,2.2945&filter=banana");

    expect(parsed?.position).toEqual({ lat: 48.8584, lon: 2.2945 });
    expect(parsed?.filter).toBeUndefined();
  });

  it("parses a hash without the leading '#'", () => {
    expect(parseLocationHash("41.8902,12.4922&lang=de")).toEqual({
      position: { lat: 41.8902, lon: 12.4922 },
      lang: "de",
    });
  });

  it("parses a bare position with no language as lang: undefined", () => {
    expect(parseLocationHash("#48.8584,2.2945")).toEqual({
      position: { lat: 48.8584, lon: 2.2945 },
      lang: undefined,
    });
  });

  it("keeps the position but drops an unsupported language", () => {
    expect(parseLocationHash("#48.8584,2.2945&lang=xx")).toEqual({
      position: { lat: 48.8584, lon: 2.2945 },
      lang: undefined,
    });
  });

  it("accepts negative coordinates at the valid range boundaries", () => {
    expect(parseLocationHash("#-90,-180")).toEqual({
      position: { lat: -90, lon: -180 },
      lang: undefined,
    });
  });

  it("returns null for an empty hash", () => {
    expect(parseLocationHash("")).toBeNull();
    expect(parseLocationHash("#")).toBeNull();
  });

  it("returns null for junk text", () => {
    expect(parseLocationHash("#not-a-coordinate")).toBeNull();
  });

  it("returns null when a coordinate is non-numeric", () => {
    expect(parseLocationHash("#41.8902,abc")).toBeNull();
  });

  it("returns null when a coordinate is missing", () => {
    expect(parseLocationHash("#41.8902")).toBeNull();
    expect(parseLocationHash("#41.8902,")).toBeNull();
  });

  it("returns null when latitude is out of range", () => {
    expect(parseLocationHash("#91,12")).toBeNull();
    expect(parseLocationHash("#-90.1,12")).toBeNull();
  });

  it("returns null when longitude is out of range", () => {
    expect(parseLocationHash("#41,181")).toBeNull();
    expect(parseLocationHash("#41,-180.5")).toBeNull();
  });

  it("returns null for non-finite coordinates", () => {
    expect(parseLocationHash("#Infinity,0")).toBeNull();
    expect(parseLocationHash("#NaN,0")).toBeNull();
  });
});

describe("createUrlMirror", () => {
  function makeDeps(initialHash = "", state: unknown = { view: "detail" }) {
    const location = { hash: initialHash };
    const history = {
      state,
      replaceState: vi.fn((_data: unknown, _title: string, url: string) => {
        location.hash = url;
      }),
    };
    return { history, location };
  }

  it("writes the encoded hash and preserves the current history.state", () => {
    const deps = makeDeps("", { view: "detail", title: "Colosseum" });
    const mirror = createUrlMirror(deps);

    mirror({ lat: 41.8902, lon: 12.4922 }, "en");

    expect(deps.history.replaceState).toHaveBeenCalledWith(
      { view: "detail", title: "Colosseum" },
      "",
      "#41.8902,12.4922&lang=en",
    );
  });

  it("does nothing when there is no position", () => {
    const deps = makeDeps();
    const mirror = createUrlMirror(deps);

    mirror(null, "en");

    expect(deps.history.replaceState).not.toHaveBeenCalled();
  });

  it("skips the write when the encoded hash already matches the address bar", () => {
    const deps = makeDeps("#41.8902,12.4922&lang=en");
    const mirror = createUrlMirror(deps);

    mirror({ lat: 41.8902, lon: 12.4922 }, "en");

    expect(deps.history.replaceState).not.toHaveBeenCalled();
  });

  it("does not re-write the hash for sub-4dp position changes", () => {
    const deps = makeDeps();
    const mirror = createUrlMirror(deps);

    mirror({ lat: 41.8902, lon: 12.4922 }, "en");
    expect(deps.history.replaceState).toHaveBeenCalledTimes(1);

    // Jitter below 4 decimal places encodes to the same hash → no extra write.
    mirror({ lat: 41.89021, lon: 12.49224 }, "en");
    expect(deps.history.replaceState).toHaveBeenCalledTimes(1);
  });

  it("writes again when the language changes at the same position", () => {
    const deps = makeDeps();
    const mirror = createUrlMirror(deps);

    mirror({ lat: 41.8902, lon: 12.4922 }, "en");
    mirror({ lat: 41.8902, lon: 12.4922 }, "sv");

    expect(deps.history.replaceState).toHaveBeenCalledTimes(2);
    expect(deps.history.replaceState).toHaveBeenLastCalledWith(
      { view: "detail" },
      "",
      "#41.8902,12.4922&lang=sv",
    );
  });

  it("writes filter=all when the Everything filter becomes active", () => {
    const deps = makeDeps();
    const mirror = createUrlMirror(deps);

    mirror({ lat: 41.8902, lon: 12.4922 }, "en", "highlights");
    mirror({ lat: 41.8902, lon: 12.4922 }, "en", "all");

    expect(deps.history.replaceState).toHaveBeenCalledTimes(2);
    expect(deps.history.replaceState).toHaveBeenLastCalledWith(
      { view: "detail" },
      "",
      "#41.8902,12.4922&lang=en&filter=all",
    );
  });

  it("drops the filter param when switching back to Highlights", () => {
    const deps = makeDeps("#41.8902,12.4922&lang=en&filter=all");
    const mirror = createUrlMirror(deps);

    mirror({ lat: 41.8902, lon: 12.4922 }, "en", "highlights");

    expect(deps.history.replaceState).toHaveBeenLastCalledWith(
      { view: "detail" },
      "",
      "#41.8902,12.4922&lang=en",
    );
  });
});
