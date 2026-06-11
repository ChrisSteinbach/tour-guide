// Nominatim (OpenStreetMap) geocoding client. Pure data — no Leaflet, no DOM —
// so it can be unit-tested in isolation and reused anywhere. The `fetch`
// implementation is injectable to keep tests offline and deterministic.
//
// Nominatim's usage policy forbids per-keystroke autocomplete, so callers must
// only invoke this on an explicit user action (form submit). A browser request
// carries a Referer automatically, which satisfies the policy's identification
// requirement (the User-Agent header cannot be set from a browser anyway).

export interface NominatimResult {
  displayName: string;
  lat: number;
  lon: number;
}

export interface SearchPlacesOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

const SEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const RESULT_LIMIT = 5;

/** Raw shape of a single Nominatim search hit (coordinates arrive as strings). */
interface RawNominatimResult {
  display_name?: string;
  lat?: string;
  lon?: string;
}

/** Build the search request URL with the query safely encoded. */
export function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: String(RESULT_LIMIT),
    q: query,
  });
  return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

/**
 * Geocode a free-text place query. Resolves with up to {@link RESULT_LIMIT}
 * matches; rejects on HTTP errors or network failures so the UI can surface an
 * error state. Malformed hits (missing name or non-numeric coordinates) are
 * dropped rather than surfaced as broken list entries.
 */
export async function searchPlaces(
  query: string,
  { fetchFn = fetch, signal }: SearchPlacesOptions = {},
): Promise<NominatimResult[]> {
  const response = await fetchFn(buildSearchUrl(query), { signal });
  if (!response.ok) {
    throw new Error(`Nominatim search failed with status ${response.status}`);
  }

  const raw = (await response.json()) as RawNominatimResult[];
  return raw
    .map((hit) => ({
      displayName: hit.display_name ?? "",
      lat: Number(hit.lat),
      lon: Number(hit.lon),
    }))
    .filter(
      (result) =>
        result.displayName !== "" &&
        Number.isFinite(result.lat) &&
        Number.isFinite(result.lon),
    );
}
