// WikiRadar's article-metadata payload, carried as the opaque payload of a
// `spherical-delaunay` binary tile; the geometry library never interprets
// these bytes.

/** A Wikipedia article's title and (optional) popularity weight class. */
export interface ArticleMeta {
  title: string;
  /**
   * Weight class 0-255: popularity percentile of the article among its
   * language build's articles by monthly pageviews (see
   * src/pipeline/popularity.ts); 0 = no views / unknown. Optional so callers
   * without weight data can omit it; treated as 0 when absent.
   */
  weight?: number;
}

// Binary layout:
//   [0..3]      count V   uint32 LE — number of articles
//   [4..4+V)    weights   Uint8[V] — weight class per article (values
//                         outside 0-255 wrap per Uint8Array semantics)
//   [4+V..end)  titles    UTF-8 JSON of string[V]

/** Encode article metadata into the binary payload format described above. */
export function encodeArticlePayload(articles: ArticleMeta[]): Uint8Array {
  const count = articles.length;
  const titlesJson = new TextEncoder().encode(
    JSON.stringify(articles.map((a) => a.title)),
  );

  const out = new Uint8Array(4 + count + titlesJson.byteLength);
  new DataView(out.buffer).setUint32(0, count, true);
  for (let i = 0; i < count; i++) {
    out[4 + i] = articles[i].weight ?? 0;
  }
  out.set(titlesJson, 4 + count);
  return out;
}

/**
 * Decode a binary payload produced by encodeArticlePayload back into article
 * metadata. `weight` is always populated on the returned articles (0 when
 * the source article had none).
 *
 * Throws a plain Error, message prefixed "Invalid article payload: ", when
 * the bytes are too short for the declared count, or the titles section
 * isn't a JSON array matching that count.
 */
export function decodeArticlePayload(payload: Uint8Array): {
  articles: ArticleMeta[];
  weights: Uint8Array;
} {
  if (payload.byteLength < 4) {
    throw new Error(
      `Invalid article payload: too short (${payload.byteLength} bytes, need at least 4)`,
    );
  }

  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const count = view.getUint32(0, true);

  if (payload.byteLength < 4 + count) {
    throw new Error(
      `Invalid article payload: too short for ${count} articles (need at least ${4 + count} bytes, got ${payload.byteLength})`,
    );
  }

  // Standalone copy, NOT a subarray view: the app stores `weights` in
  // IndexedDB, and structured-cloning a view would drag the whole payload
  // buffer along with it into storage.
  const weights = payload.slice(4, 4 + count);

  let titles: unknown;
  try {
    titles = JSON.parse(new TextDecoder().decode(payload.subarray(4 + count)));
  } catch {
    throw new Error("Invalid article payload: titles JSON failed to parse");
  }
  if (!Array.isArray(titles)) {
    throw new Error("Invalid article payload: titles JSON is not an array");
  }
  if (titles.length !== count) {
    throw new Error(
      `Invalid article payload: titles length (${titles.length}) does not match article count (${count})`,
    );
  }

  const articles: ArticleMeta[] = (titles as string[]).map((title, i) => ({
    title,
    weight: weights[i],
  }));

  return { articles, weights };
}
