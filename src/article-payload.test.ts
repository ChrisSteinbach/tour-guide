import {
  encodeArticlePayload,
  decodeArticlePayload,
  zipTitlesWeights,
} from "./article-payload";
import type { VertexArticles } from "./article-payload";

describe("encodeArticlePayload / decodeArticlePayload round trip", () => {
  it("round-trips one article per vertex, including non-ASCII titles", () => {
    const groups: VertexArticles[] = [
      [{ title: "Šibenik", weight: 0 }],
      [{ title: "東京タワー", weight: 255 }],
      [{ title: "Paris", weight: 128 }],
    ];

    const decoded = decodeArticlePayload(encodeArticlePayload(groups));

    expect(decoded.groups).toEqual([
      [{ title: "Šibenik", weight: 0 }],
      [{ title: "東京タワー", weight: 255 }],
      [{ title: "Paris", weight: 128 }],
    ]);
  });

  it("round-trips a vertex carrying several coincident articles", () => {
    const groups: VertexArticles[] = [
      [
        { title: "United States Capitol", weight: 200 },
        { title: "1900 State of the Union Address", weight: 12 },
        { title: "Burning of Washington", weight: 90 },
      ],
      [{ title: "Lone Article", weight: 5 }],
    ];

    const decoded = decodeArticlePayload(encodeArticlePayload(groups));

    // Group boundaries and per-article weights both survive the round trip.
    expect(decoded.groups).toEqual(groups);
  });

  it("decodes an article with an omitted weight as 0", () => {
    const groups: VertexArticles[] = [[{ title: "No Weight Article" }]];

    const decoded = decodeArticlePayload(encodeArticlePayload(groups));

    expect(decoded.groups).toEqual([
      [{ title: "No Weight Article", weight: 0 }],
    ]);
  });

  it("round-trips an empty groups array", () => {
    const payload = encodeArticlePayload([]);

    // 4-byte count header + 0 weight bytes + 2-byte "[]" titles JSON.
    expect(payload.byteLength).toBe(6);

    const decoded = decodeArticlePayload(payload);
    expect(decoded.groups).toEqual([]);
  });

  it("preserves an empty vertex group as an empty inner array", () => {
    const groups: VertexArticles[] = [
      [{ title: "Alpha", weight: 1 }],
      [],
      [{ title: "Beta", weight: 2 }],
    ];

    const decoded = decodeArticlePayload(encodeArticlePayload(groups));

    expect(decoded.groups).toEqual(groups);
  });

  it("returns groups detached from the input payload's buffer", () => {
    const payload = encodeArticlePayload([[{ title: "Alpha", weight: 7 }]]);

    const decoded = decodeArticlePayload(payload);
    // Corrupt the weight byte in the source buffer after decoding.
    payload[4] = 200;

    expect(decoded.groups[0][0].weight).toBe(7);
  });
});

describe("zipTitlesWeights", () => {
  it("threads a flat, vertex-major weight array across group boundaries", () => {
    const groups = zipTitlesWeights(
      [["A", "B"], ["C"], []],
      Uint8Array.from([1, 2, 3]),
    );

    expect(groups).toEqual([
      [
        { title: "A", weight: 1 },
        { title: "B", weight: 2 },
      ],
      [{ title: "C", weight: 3 }],
      [],
    ]);
  });
});

describe("decodeArticlePayload errors", () => {
  it("rejects a completely empty payload", () => {
    expect(() => decodeArticlePayload(new Uint8Array(0))).toThrow(
      "Invalid article payload",
    );
  });

  it("rejects a payload shorter than the 4-byte count header", () => {
    expect(() => decodeArticlePayload(new Uint8Array(3))).toThrow(
      "Invalid article payload",
    );
  });

  it("rejects a declared count larger than the remaining bytes", () => {
    // Header claims 5 articles, but no weight or title bytes follow.
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, 5, true);

    expect(() => decodeArticlePayload(payload)).toThrow(
      "Invalid article payload",
    );
  });

  it("rejects a corrupt titles JSON tail", () => {
    // count=1, one weight byte, then bytes that aren't valid JSON.
    const weights = [42];
    const tail = new TextEncoder().encode("not json");
    const payload = new Uint8Array(4 + weights.length + tail.byteLength);
    new DataView(payload.buffer).setUint32(0, 1, true);
    payload.set(weights, 4);
    payload.set(tail, 4 + weights.length);

    expect(() => decodeArticlePayload(payload)).toThrow(
      "Invalid article payload",
    );
  });

  it("rejects titles JSON that is a flat array, not an array of arrays", () => {
    // count=1, one weight byte, titles JSON is ["X"] (a string, not an array).
    const weights = [10];
    const titlesJson = new TextEncoder().encode(JSON.stringify(["X"]));
    const payload = new Uint8Array(4 + weights.length + titlesJson.byteLength);
    new DataView(payload.buffer).setUint32(0, 1, true);
    payload.set(weights, 4);
    payload.set(titlesJson, 4 + weights.length);

    expect(() => decodeArticlePayload(payload)).toThrow(
      "Invalid article payload",
    );
  });

  it("rejects a total title count that does not match the declared count", () => {
    // count=2, two weight bytes, but the titles JSON holds only one title.
    const weights = [10, 20];
    const titlesJson = new TextEncoder().encode(JSON.stringify([["OnlyOne"]]));
    const payload = new Uint8Array(4 + weights.length + titlesJson.byteLength);
    new DataView(payload.buffer).setUint32(0, 2, true);
    payload.set(weights, 4);
    payload.set(titlesJson, 4 + weights.length);

    expect(() => decodeArticlePayload(payload)).toThrow(
      "Invalid article payload",
    );
  });
});
