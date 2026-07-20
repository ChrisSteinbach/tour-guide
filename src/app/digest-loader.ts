// Fetch and cache one cell's mid-field digest — a 5° cell's sample of its
// most notable articles (see MIDFIELD_TOP_K in ../farfield), used to fill the
// browse list in the band just beyond the loaded tiles, before the sparser
// far-field tier takes over.
//
// The far-field tier is one artifact for an entire language, because "the
// world's most notable articles" is the same set no matter where the user is
// standing. A digest isn't: which cells are near enough to matter is
// position-dependent and changes as the user travels, so there is no single
// artifact to fetch once and hold in memory. Each nearby cell's digest is
// instead fetched and cached independently, keyed by cell as well as
// language — otherwise the same shape as the far-field tier, down to sharing
// its binary codec (see ../farfield), since both are just "notable articles
// sampled from a region" at different scales.
//
// Cached digests are never evicted, unlike tiles. Tiles need an LRU because
// there are 1,374 of them for English at ~110 KB apiece; every digest that
// exists for a language totals about 4 MB, less than the tile LRU's own
// budget. A user who visited every cell on Earth would still be inside it, so
// a second eviction policy would cost more complexity than it could ever save.

import { decodeFarField } from "../farfield";
import type { FarFieldEntry } from "../farfield";
import type { SampledTierMeta } from "../tiles";
import type { Lang } from "../lang";
import { defaultDeps } from "./tile-loader";
import type { TileLoaderDeps } from "./tile-loader";

/** IDB key for one cell's cached mid-field digest. */
export function digestCacheKey(lang: Lang, tileId: string): string {
  return `digest-v1-${lang}-${tileId}`;
}

interface CachedDigest {
  hash: string;
  buf: ArrayBuffer;
}

function isCachedDigest(value: unknown): value is CachedDigest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CachedDigest).hash === "string" &&
    (value as CachedDigest).buf instanceof ArrayBuffer
  );
}

/**
 * Load one cell's mid-field digest.
 *
 * Returns `[]` rather than throwing whenever the digest is unavailable — a
 * 404, a network failure with nothing cached, or corrupt data. The browse
 * list then simply falls back to whatever reach it had for that band before
 * this tier existed: degraded coverage, not a broken list. Aborts propagate,
 * since those mean the caller moved on.
 *
 * Unlike `loadFarField`, `meta` here is required: callers only reach this
 * function for cells that advertise a `digest` in the tile index (see
 * `TileEntry.digest`), so there is no "tier predates this index" case to
 * absorb.
 */
export async function loadDigest(
  baseUrl: string,
  lang: Lang,
  tileId: string,
  meta: SampledTierMeta,
  signal?: AbortSignal,
  deps: TileLoaderDeps = defaultDeps,
): Promise<FarFieldEntry[]> {
  const key = digestCacheKey(lang, tileId);
  const db = await deps.openDb();

  if (db) {
    try {
      const cached = await deps.getAny<unknown>(db, key);
      if (isCachedDigest(cached) && cached.hash === meta.hash) {
        return decodeFarField(cached.buf);
      }
    } catch (err) {
      console.warn(`digest cache read failed for "${lang}/${tileId}":`, err);
    }
  }

  let buf: ArrayBuffer;
  try {
    const response = await fetch(
      `${baseUrl}tiles/${lang}/${tileId}.digest.bin`,
      { signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buf = await response.arrayBuffer();
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`digest fetch failed for "${lang}/${tileId}":`, err);
    return [];
  }

  let entries: FarFieldEntry[];
  try {
    entries = decodeFarField(buf);
  } catch (err) {
    console.warn(`digest data for "${lang}/${tileId}" is unusable:`, err);
    return [];
  }

  if (db) {
    deps
      .putAny(db, key, { hash: meta.hash, buf } satisfies CachedDigest)
      .catch((e) =>
        console.warn(`digest cache write failed for "${lang}/${tileId}":`, e),
      );
  }

  return entries;
}
