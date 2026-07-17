import { encodeArticlePayload, decodeArticlePayload } from "./article-payload";
import type { ArticleMeta } from "./article-payload";

describe("encodeArticlePayload / decodeArticlePayload round trip", () => {
  it("round-trips titles and weights, including non-ASCII titles", () => {
    const articles: ArticleMeta[] = [
      { title: "Šibenik", weight: 0 },
      { title: "東京タワー", weight: 255 },
      { title: "Paris", weight: 128 },
    ];

    const decoded = decodeArticlePayload(encodeArticlePayload(articles));

    expect(decoded.articles).toEqual([
      { title: "Šibenik", weight: 0 },
      { title: "東京タワー", weight: 255 },
      { title: "Paris", weight: 128 },
    ]);
    expect(Array.from(decoded.weights)).toEqual([0, 255, 128]);
  });

  it("decodes an article with an omitted weight as 0", () => {
    const articles: ArticleMeta[] = [{ title: "No Weight Article" }];

    const decoded = decodeArticlePayload(encodeArticlePayload(articles));

    expect(decoded.articles).toEqual([
      { title: "No Weight Article", weight: 0 },
    ]);
    expect(Array.from(decoded.weights)).toEqual([0]);
  });

  it("round-trips an empty articles array", () => {
    const payload = encodeArticlePayload([]);

    // 4-byte count header + 0 weight bytes + 2-byte "[]" titles JSON.
    expect(payload.byteLength).toBe(6);

    const decoded = decodeArticlePayload(payload);
    expect(decoded.articles).toEqual([]);
    expect(Array.from(decoded.weights)).toEqual([]);
  });

  it("returns weights as a standalone copy, not a view sharing the input payload's buffer", () => {
    const payload = encodeArticlePayload([{ title: "Alpha", weight: 7 }]);

    const decoded = decodeArticlePayload(payload);

    expect(decoded.weights.buffer).not.toBe(payload.buffer);
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

  it("rejects a titles array whose length does not match the declared count", () => {
    // count=2, two weight bytes, but the titles JSON array has only one entry.
    const weights = [10, 20];
    const titlesJson = new TextEncoder().encode(JSON.stringify(["OnlyOne"]));
    const payload = new Uint8Array(4 + weights.length + titlesJson.byteLength);
    new DataView(payload.buffer).setUint32(0, 2, true);
    payload.set(weights, 4);
    payload.set(titlesJson, 4 + weights.length);

    expect(() => decodeArticlePayload(payload)).toThrow(
      "Invalid article payload",
    );
  });
});
