// Far-field tier: the globe's most notable articles, sampled per tile.
//
// The browse list is a radial projection of the globe, and like a map it needs
// level of detail. Tiles give exhaustive coverage near the user, but reaching
// the furthest article that way means downloading every tile (154 MB for en) —
// and a 1:1 virtual list of every article would be ~84 Mpx tall, past the
// ~33.5 Mpx element-height ceiling browsers enforce. So beyond the loaded
// tiles the list switches to this tier: the top `FARFIELD_TOP_K` articles by
// weight class from each populated 5° cell, which keeps global coverage
// geographically even (a uniform notability floor would leave long empty
// stretches over Africa and the Pacific and crowd Europe) while fitting in one
// small artifact the app can hold entirely in memory.
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
 * Articles sampled from each populated tile. 25 keeps the artifact around
 * 335 KB brotli for English (~27k entries) — roughly four average tiles, once
 * per language — while leaving the merged browse list well under the browser's
 * element-height ceiling from any position.
 */
export const FARFIELD_TOP_K = 25;

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
