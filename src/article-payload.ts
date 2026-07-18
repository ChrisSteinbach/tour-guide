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

// A triangulation vertex is a single point on the sphere, but several distinct
// articles can share bit-identical coordinates (e.g. a building and the
// institution sited in it, or every year's running of an event at one venue).
// Coincident points collapse to one hull vertex, so the payload carries a
// GROUP of articles per vertex rather than one — every co-located article
// stays findable. Groups are ordered most-notable-first (weight desc) by the
// pipeline, so `group[0]` is the vertex's representative article.
export type VertexArticles = ArticleMeta[];

// Binary layout:
//   [0..3]      count A   uint32 LE — total articles across all vertices
//   [4..4+A)    weights   Uint8[A] — weight class per article, in vertex-major
//                         order (each vertex's articles contiguous, matching
//                         the titles JSON below; values outside 0-255 wrap per
//                         Uint8Array semantics)
//   [4+A..end)  titles    UTF-8 JSON of string[][] — one inner array of titles
//                         per vertex; inner-array lengths delimit the groups
//                         (so no separate per-vertex count is stored, which
//                         also sidesteps the 255-per-vertex Uint8 ceiling)

/** Encode per-vertex article groups into the binary payload format above. */
export function encodeArticlePayload(groups: VertexArticles[]): Uint8Array {
  let total = 0;
  for (const g of groups) total += g.length;

  const titlesJson = new TextEncoder().encode(
    JSON.stringify(groups.map((g) => g.map((a) => a.title))),
  );

  const out = new Uint8Array(4 + total + titlesJson.byteLength);
  new DataView(out.buffer).setUint32(0, total, true);
  let w = 4;
  for (const g of groups) {
    for (const a of g) out[w++] = a.weight ?? 0;
  }
  out.set(titlesJson, 4 + total);
  return out;
}

/**
 * Zip a `string[][]` of titles with a flat, vertex-major `Uint8Array` of
 * weights back into per-vertex `ArticleMeta` groups. The caller must have
 * already validated that `weights.length` equals the total title count; this
 * consumes weights sequentially across groups. Shared by `decodeArticlePayload`
 * and the tile-loader's IndexedDB cache-hit path.
 */
export function zipTitlesWeights(
  titles: string[][],
  weights: Uint8Array,
): VertexArticles[] {
  const groups: VertexArticles[] = [];
  let i = 0;
  for (const g of titles) {
    const group: VertexArticles = [];
    for (const title of g) group.push({ title, weight: weights[i++] });
    groups.push(group);
  }
  return groups;
}

/**
 * Decode a binary payload produced by encodeArticlePayload back into per-vertex
 * article groups. `weight` is always populated on the returned articles (0 when
 * the source article had none).
 *
 * Throws a plain Error, message prefixed "Invalid article payload: ", when
 * the bytes are too short for the declared count, or the titles section
 * isn't a JSON `string[][]` whose total length matches that count.
 */
export function decodeArticlePayload(payload: Uint8Array): {
  groups: VertexArticles[];
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
  const total = view.getUint32(0, true);

  if (payload.byteLength < 4 + total) {
    throw new Error(
      `Invalid article payload: too short for ${total} articles (need at least ${4 + total} bytes, got ${payload.byteLength})`,
    );
  }

  // Standalone copy, NOT a subarray view: the app stores these weights in
  // IndexedDB, and structured-cloning a view would drag the whole payload
  // buffer along with it into storage.
  const weights = payload.slice(4, 4 + total);

  let titles: unknown;
  try {
    titles = JSON.parse(new TextDecoder().decode(payload.subarray(4 + total)));
  } catch {
    throw new Error("Invalid article payload: titles JSON failed to parse");
  }
  if (!Array.isArray(titles)) {
    throw new Error("Invalid article payload: titles JSON is not an array");
  }

  let counted = 0;
  for (const group of titles) {
    if (!Array.isArray(group)) {
      throw new Error(
        "Invalid article payload: titles JSON is not an array of arrays",
      );
    }
    for (const title of group) {
      if (typeof title !== "string") {
        throw new Error(
          "Invalid article payload: titles JSON contains a non-string title",
        );
      }
      counted++;
    }
  }
  if (counted !== total) {
    throw new Error(
      `Invalid article payload: title count (${counted}) does not match article count (${total})`,
    );
  }

  return { groups: zipTitlesWeights(titles as string[][], weights) };
}
