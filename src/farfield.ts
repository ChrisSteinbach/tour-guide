// Per-cell notability sampling: the globe's most notable articles, taken a
// fixed number per 5° cell.
//
// The browse list is a radial projection of the globe, and like a map it needs
// level of detail. Tiles give exhaustive coverage near the user, but reaching
// the furthest article that way means downloading every tile (154 MB for en) —
// and a 1:1 virtual list of every article would be ~84 Mpx tall, past the
// ~33.5 Mpx element-height ceiling browsers enforce. So beyond the loaded
// tiles the list switches to sampled tiers built from this codec.
//
// Sampling per cell rather than by a global notability floor is what keeps
// coverage geographically even: a uniform floor would crowd Europe and leave
// long empty stretches over Africa and the Pacific, which in a
// distance-ordered list reads as a dead zone.
//
// Two tiers use it, differing only in how many articles each cell contributes
// and how the result is packaged:
//
//   far field   `FARFIELD_TOP_K` per cell, every cell on Earth, one artifact
//               per language, fetched once and held in memory.
//   mid field   `MIDFIELD_TOP_K` per cell, one artifact per cell, fetched
//               only for the cells near the user.
//
// Shared by the pipeline (writer) and the app (reader).

/** A single far-field article: enough to place it and rank it, nothing more. */
export interface FarFieldEntry {
  title: string;
  lat: number;
  lon: number;
  /** Weight class 0-255, same scale as tile article payloads. */
  weight: number;
}

/**
 * Articles sampled from each populated cell into the global far-field tier —
 * the coarse base of the browse list's level-of-detail pyramid: one artifact,
 * every cell on Earth, fetched once and held in memory.
 *
 * It only has to be thin. Past ~1,200 km the number of cells within reach grows
 * with the square of the distance, so even a dozen apiece adds up to a dense
 * list; nearer than that the mid-field tier (`MIDFIELD_TOP_K`, fetched per cell)
 * now carries the density, so the far field no longer has to. 25 was the sample
 * before that tier existed, when the far field alone had to fill the near band;
 * with the mid-field in place, everything within 1,200 km is identical whether
 * the far field keeps 12 or 25, because the denser digest subsumes it there —
 * the thinner sample only ever shows beyond the mid-field's reach, which is
 * exactly where a dozen per cell is already plenty.
 *
 * 12 keeps the artifact around 180 KB brotli for English (~15k entries) — a
 * little over half the 25-per-cell sample it replaces — while every cell too
 * sparse to earn a digest (at or below this many candidates) is still carried
 * here in full, and the merged browse list stays well under the browser's
 * element-height ceiling from any position.
 */
export const FARFIELD_TOP_K = 12;

/**
 * Articles sampled into one cell's mid-field digest.
 *
 * The far field is deliberately thin, because every cell on Earth is in it.
 * That thinness is invisible far away — past ~1,000 km the number of populated
 * cells within reach grows with the square of the distance, so a dozen apiece
 * is plenty — but it bites just outside the loaded tiles, where only a handful
 * of cells are in range: from Times Square the whole 100-300 km band held just
 * 20 articles. Digests refill that band by raising the per-cell sample more
 * than twentyfold, for the cells near enough to matter.
 *
 * 250 is where the two tiers meet without a visible seam in either direction,
 * and it keeps a digest around 3 KB brotli: 30 KB of fetches at the median
 * position and 185 KB at the worst, against 8.5 MB to load the surrounding
 * tiles outright.
 */
export const MIDFIELD_TOP_K = 250;

// Binary layout (all little-endian):
//   [0..3]             count C    uint32
//   [4 .. 4+4C)        lats       Float32[C]
//   [4+4C .. 4+8C)     lons       Float32[C]
//   [4+8C .. 4+9C)     weights    Uint8[C]
//   [4+9C .. end)      titles     UTF-8 JSON of string[], length C
//
// Coordinate planes are stored separately rather than interleaved, and entries
// are written in tile order, so neighbouring values share magnitude and the
// transport compressor has runs to work with. Float32 matches the precision
// tiles already store, so an entry's distance is bit-identical whether it comes
// from here or from a loaded tile.

const HEADER_BYTES = 4;

/** Encode far-field entries into the binary transport format. */
export function encodeFarField(entries: readonly FarFieldEntry[]): Uint8Array {
  const count = entries.length;
  const titlesJson = new TextEncoder().encode(
    JSON.stringify(entries.map((e) => e.title)),
  );

  const out = new Uint8Array(HEADER_BYTES + count * 9 + titlesJson.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, count, true);

  const latsAt = HEADER_BYTES;
  const lonsAt = latsAt + count * 4;
  const weightsAt = lonsAt + count * 4;

  for (let i = 0; i < count; i++) {
    view.setFloat32(latsAt + i * 4, entries[i].lat, true);
    view.setFloat32(lonsAt + i * 4, entries[i].lon, true);
    out[weightsAt + i] = entries[i].weight;
  }
  out.set(titlesJson, weightsAt + count);

  return out;
}

/**
 * Decode the binary far-field format.
 *
 * Throws on truncated or inconsistent data rather than returning a partial
 * tier: a short read here would silently amputate the far end of every browse
 * list, which is far harder to notice than a failed load.
 */
export function decodeFarField(buffer: ArrayBuffer): FarFieldEntry[] {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error("far-field data truncated: missing header");
  }

  const view = new DataView(buffer);
  const count = view.getUint32(0, true);

  const latsAt = HEADER_BYTES;
  const lonsAt = latsAt + count * 4;
  const weightsAt = lonsAt + count * 4;
  const titlesAt = weightsAt + count;
  if (buffer.byteLength < titlesAt) {
    throw new Error(
      `far-field data truncated: ${count} entries need ${titlesAt} bytes, got ${buffer.byteLength}`,
    );
  }

  const titles: unknown = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, titlesAt)),
  );
  if (!Array.isArray(titles) || titles.length !== count) {
    throw new Error(
      `far-field title count mismatch: header says ${count}, titles array has ${Array.isArray(titles) ? titles.length : "non-array"}`,
    );
  }

  const weights = new Uint8Array(buffer, weightsAt, count);
  const entries: FarFieldEntry[] = new Array<FarFieldEntry>(count);
  for (let i = 0; i < count; i++) {
    entries[i] = {
      title: String(titles[i]),
      lat: view.getFloat32(latsAt + i * 4, true),
      lon: view.getFloat32(lonsAt + i * 4, true),
      weight: weights[i],
    };
  }
  return entries;
}

/**
 * Pick the `topK` most notable articles from one tile's native articles.
 *
 * Ties break on title ascending by code point so a rebuild of unchanged input
 * produces a byte-identical artifact — the content hash drives cache
 * invalidation, and a hash that churns on every pipeline run would re-download
 * the tier for every user each month.
 */
export function selectFarFieldEntries(
  articles: readonly FarFieldEntry[],
  topK: number = FARFIELD_TOP_K,
): FarFieldEntry[] {
  return [...articles]
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    })
    .slice(0, topK);
}
