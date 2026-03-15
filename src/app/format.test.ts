import {
  distanceMeters,
  formatDistance,
  wikipediaUrl,
  directionsUrl,
} from "./format";

describe("distanceMeters", () => {
  it("returns 0 for the same point", () => {
    const p = { lat: 48.8584, lon: 2.2945 };
    expect(distanceMeters(p, { ...p, title: "X" })).toBe(0);
  });

  it("returns ~350 m between Eiffel Tower and Champ de Mars", () => {
    const eiffel = { lat: 48.8584, lon: 2.2945 };
    const champ = { lat: 48.856, lon: 2.2983, title: "Champ de Mars" };
    const d = distanceMeters(eiffel, champ);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(450);
  });
});

describe("formatDistance", () => {
  it("formats meters below 1 km", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(350)).toBe("350 m");
    expect(formatDistance(999)).toBe("999 m");
  });

  it("formats km with one decimal below 10 km", () => {
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(1500)).toBe("1.5 km");
    expect(formatDistance(9999)).toBe("10.0 km");
  });

  it("formats km rounded above 10 km", () => {
    expect(formatDistance(10_000)).toBe("10 km");
    expect(formatDistance(12_345)).toBe("12 km");
    expect(formatDistance(100_000)).toBe("100 km");
  });
});

describe("wikipediaUrl", () => {
  it("encodes spaces as underscores", () => {
    expect(wikipediaUrl("Eiffel Tower")).toBe(
      "https://en.wikipedia.org/wiki/Eiffel_Tower",
    );
  });

  it("encodes special characters", () => {
    expect(wikipediaUrl("Pont d'Iéna")).toBe(
      "https://en.wikipedia.org/wiki/Pont_d'I%C3%A9na",
    );
  });

  it("defaults to English Wikipedia", () => {
    expect(wikipediaUrl("Test")).toContain("en.wikipedia.org");
  });

  it("uses specified language", () => {
    expect(wikipediaUrl("Eiffel Tower", "sv")).toBe(
      "https://sv.wikipedia.org/wiki/Eiffel_Tower",
    );
  });

  it("supports Japanese", () => {
    expect(wikipediaUrl("東京タワー", "ja")).toContain("ja.wikipedia.org");
  });
});

describe("directionsUrl", () => {
  const dest = { lat: 48.8584, lon: 2.2945 };
  const origin = { lat: 48.86, lon: 2.3 };

  it("returns Google Maps URL by default (desktop)", () => {
    const url = directionsUrl(dest.lat, dest.lon);
    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=48.8584,2.2945",
    );
  });

  it("includes origin in Google Maps URL when provided", () => {
    const url = directionsUrl(dest.lat, dest.lon, origin);
    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=48.8584,2.2945&origin=48.86,2.3",
    );
  });

  it("omits origin when not provided", () => {
    const url = directionsUrl(dest.lat, dest.lon);
    expect(url).not.toContain("origin");
    expect(url).not.toContain("saddr");
  });
});
