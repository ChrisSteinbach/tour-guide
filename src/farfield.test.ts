import {
  decodeFarField,
  encodeFarField,
  selectFarFieldEntries,
} from "./farfield";
import type { FarFieldEntry } from "./farfield";

function encoded(entries: FarFieldEntry[]): ArrayBuffer {
  const bytes = encodeFarField(entries);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("far-field codec", () => {
  it("round-trips titles, coordinates and weights", () => {
    const entries: FarFieldEntry[] = [
      { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945, weight: 251 },
      { title: "Pacific–Antarctic Ridge", lat: -62, lon: -157, weight: 7 },
    ];

    const decoded = decodeFarField(encoded(entries));

    expect(decoded).toHaveLength(2);
    expect(decoded[0].title).toBe("Eiffel Tower");
    expect(decoded[0].lat).toBeCloseTo(48.8584, 4);
    expect(decoded[0].lon).toBeCloseTo(2.2945, 4);
    expect(decoded[0].weight).toBe(251);
    expect(decoded[1].title).toBe("Pacific–Antarctic Ridge");
    expect(decoded[1].weight).toBe(7);
  });

  it("round-trips an empty tier", () => {
    expect(decodeFarField(encoded([]))).toEqual([]);
  });

  it("preserves non-ASCII titles", () => {
    const entries = [
      { title: "東京タワー", lat: 35.6586, lon: 139.7454, weight: 200 },
    ];

    expect(decodeFarField(encoded(entries))[0].title).toBe("東京タワー");
  });

  it("quantizes coordinates to Float32 so distances match tile data", () => {
    const entries = [{ title: "Precise", lat: 1 / 3, lon: -2 / 3, weight: 1 }];

    const decoded = decodeFarField(encoded(entries));

    expect(decoded[0].lat).toBe(Math.fround(1 / 3));
    expect(decoded[0].lon).toBe(Math.fround(-2 / 3));
  });

  it("rejects a buffer too short to hold its header", () => {
    expect(() => decodeFarField(new ArrayBuffer(2))).toThrow(/truncated/);
  });

  it("rejects a buffer whose entries are cut short", () => {
    const full = encodeFarField([
      { title: "One", lat: 0, lon: 0, weight: 0 },
      { title: "Two", lat: 1, lon: 1, weight: 0 },
    ]);
    const truncated = full.slice(0, 8).buffer;

    expect(() => decodeFarField(truncated)).toThrow(/truncated/);
  });

  it("rejects data whose title count disagrees with its header", () => {
    // Planes sized for two entries, but only one title — the shape a partial
    // pipeline write would leave behind.
    const titles = new TextEncoder().encode(JSON.stringify(["Only"]));
    const corrupted = new Uint8Array(4 + 2 * 9 + titles.byteLength);
    new DataView(corrupted.buffer).setUint32(0, 2, true);
    corrupted.set(titles, 4 + 2 * 9);

    expect(() => decodeFarField(corrupted.buffer)).toThrow(/mismatch/);
  });
});

describe("selectFarFieldEntries", () => {
  it("keeps the most notable articles", () => {
    const articles: FarFieldEntry[] = [
      { title: "Obscure", lat: 0, lon: 0, weight: 3 },
      { title: "Famous", lat: 0, lon: 0, weight: 250 },
      { title: "Middling", lat: 0, lon: 0, weight: 120 },
    ];

    expect(selectFarFieldEntries(articles, 2).map((e) => e.title)).toEqual([
      "Famous",
      "Middling",
    ]);
  });

  it("returns everything when the tile holds fewer than topK", () => {
    const articles: FarFieldEntry[] = [
      { title: "Only", lat: 0, lon: 0, weight: 5 },
    ];

    expect(selectFarFieldEntries(articles, 25)).toHaveLength(1);
  });

  it("breaks weight ties on title so rebuilds stay byte-identical", () => {
    const articles: FarFieldEntry[] = [
      { title: "Beta", lat: 0, lon: 0, weight: 10 },
      { title: "Alpha", lat: 0, lon: 0, weight: 10 },
    ];

    expect(selectFarFieldEntries(articles, 2).map((e) => e.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("leaves the caller's array unmodified", () => {
    const articles: FarFieldEntry[] = [
      { title: "Obscure", lat: 0, lon: 0, weight: 3 },
      { title: "Famous", lat: 0, lon: 0, weight: 250 },
    ];

    selectFarFieldEntries(articles, 1);

    expect(articles[0].title).toBe("Obscure");
  });
});
