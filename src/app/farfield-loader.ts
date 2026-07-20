// Fetch and cache the far-field tier — the notable-article sample that carries
// the browse list past the loaded tiles. One artifact per language, fetched
// once and kept in IDB until its content hash changes.

import { decodeFarField } from "../farfield";
import type { FarFieldEntry } from "../farfield";
import type { FarFieldEntryMeta } from "../tiles";
import type { Lang } from "../lang";
import { defaultDeps } from "./tile-loader";
import type { TileLoaderDeps } from "./tile-loader";

/** IDB key for a language's cached far-field tier. */
export function farFieldCacheKey(lang: Lang): string {
  return `farfield-v1-${lang}`;
}

interface CachedFarField {
  hash: string;
  buf: ArrayBuffer;
}

function isCachedFarField(value: unknown): value is CachedFarField {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CachedFarField).hash === "string" &&
    (value as CachedFarField).buf instanceof ArrayBuffer
  );
}

/**
 * Load a language's far-field tier.
 *
 * Returns `[]` rather than throwing whenever the tier is unavailable — a
 * missing `farField` entry (an index built before the tier existed), a 404, a
 * network failure with nothing cached, or corrupt data. The browse list then
 * simply ends at the tile coverage radius, which is the behaviour that shipped
 * before this tier: degraded reach, not a broken list. Aborts propagate, since
 * those mean the caller moved on.
 */
export async function loadFarField(
  baseUrl: string,
  lang: Lang,
  meta: FarFieldEntryMeta | undefined,
  signal?: AbortSignal,
  deps: TileLoaderDeps = defaultDeps,
): Promise<FarFieldEntry[]> {
  if (!meta) return [];

  const key = farFieldCacheKey(lang);
  const db = await deps.openDb();

  if (db) {
    try {
      const cached = await deps.getAny<unknown>(db, key);
      if (isCachedFarField(cached) && cached.hash === meta.hash) {
        return decodeFarField(cached.buf);
      }
    } catch (err) {
      console.warn("far-field cache read failed:", err);
    }
  }

  let buf: ArrayBuffer;
  try {
    const response = await fetch(`${baseUrl}tiles/${lang}/farfield.bin`, {
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buf = await response.arrayBuffer();
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`far-field fetch failed for "${lang}":`, err);
    return [];
  }

  let entries: FarFieldEntry[];
  try {
    entries = decodeFarField(buf);
  } catch (err) {
    console.warn(`far-field data for "${lang}" is unusable:`, err);
    return [];
  }

  if (db) {
    deps
      .putAny(db, key, { hash: meta.hash, buf } satisfies CachedFarField)
      .catch((e) => console.warn("far-field cache write failed:", e));
  }

  return entries;
}
