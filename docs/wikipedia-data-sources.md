# Wikipedia Geographic Data Sources

Research into how to obtain Wikipedia articles with geographic coordinates for the tour-guide pipeline.

## Requirements

The pipeline needs for each article: **title**, **URL** (derived from title), **lat/lon**, and a **brief description**.

English Wikipedia has ~1.2M articles with geographic coordinates.

## Options Evaluated

### 1. `geo_tags` SQL Dump (Discontinued)

The GeoData extension's `geo_tags` table was a small (~50-100 MB) structured dump with page IDs and coordinates. **Discontinued as of Feb 2025** (Phabricator T382069). No longer available at dumps.wikimedia.org.

### 2. Full Wikitext Dump + `{{coord}}` Parsing

The `enwiki-*-pages-articles.xml.bz2` dump (~24 GB compressed) contains all article wikitext. Coordinates can be extracted by parsing `{{coord}}` templates, but:

- 24 GB download, hours of processing
- Template parsing is fragile (many variant forms)
- Extracting clean summaries from wikitext is non-trivial
- Overkill when SPARQL gives the same coordinates directly

### 3. MediaWiki Geosearch API

`action=query&list=geosearch&gscoord=LAT|LON&gsradius=RADIUS`

Designed for point queries ("what's near me?"), not bulk extraction. Max 500 results per query, 500 requests/hour anonymous. Cannot enumerate all geo-tagged articles without tiling the entire globe. **Not suitable for offline pipeline.**

### 4. Wikidata SPARQL (P625) — Recommended for Bulk Extraction

Endpoint: `https://query.wikidata.org/sparql`

Query all entities with coordinate property (P625) and English Wikipedia sitelinks:

```sparql
SELECT ?item ?itemLabel ?itemDescription ?lat ?lon ?article WHERE {
  ?item wdt:P625 ?coord .
  ?article schema:about ?item ;
           schema:isPartOf <https://en.wikipedia.org/> .
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
LIMIT 50000
OFFSET 0
```

Returns per item: article title (from sitelink URL), lat, lon, short Wikidata description (e.g., "iron lattice tower in Paris, France").

**Constraints:**
- 60-second query timeout — must batch with LIMIT/OFFSET
- ~1.2M rows total, ~50-100 MB as JSON, ~15-25 MB gzipped
- Near-real-time freshness (reflects recent Wikidata edits)

### 5. Wikipedia REST API (`/page/summary/{title}`)

Returns rich data per article: title, plain-text extract (first paragraph), thumbnail, Wikidata description. But one article per request — fetching 1.2M articles at 5,000 req/hr takes ~10 days. **Only practical for on-demand enrichment, not bulk.**

### 6. Pre-built Datasets

- **Kaggle Wikidata geo dump**: Last updated Sept 2021, too stale.
- **wikibase-dump-filter (npm)**: Filters full Wikidata JSON dump (~130 GB) for `--claim P625 --sitelink enwiki`. Viable fallback but heavy.

## Chosen Approach

### Build-time: Wikidata SPARQL Batch Extraction

The pipeline (`src/pipeline/build.ts`) will:

1. Run batched SPARQL queries (LIMIT 50000, incrementing OFFSET) against `query.wikidata.org`
2. Extract: article title, lat, lon, short description
3. Derive URL from title: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
4. Convert lat/lon to unit-sphere Cartesian (x, y, z)
5. Compute spherical Delaunay triangulation
6. Output static data files for the PWA

Expected pipeline output per article:
```typescript
interface Article {
  title: string;     // "Eiffel Tower"
  lat: number;       // 48.8584
  lon: number;       // 2.2945
  desc: string;      // "iron lattice tower in Paris, France"
}
```

At ~80 bytes/article, raw JSON is ~96 MB; gzipped ~15-25 MB.

### Runtime: On-Demand Summary Enrichment

When a user taps an article, fetch the full summary via the Wikipedia REST API:

```
GET https://en.wikipedia.org/api/rest_v1/page/summary/{title}
```

This returns a rich extract, thumbnail, and full URL without needing to ship megabytes of summaries in the static bundle.

### Fallback

If SPARQL batching proves unreliable (timeouts, rate limiting):

1. Download the full Wikidata JSON dump (~130 GB compressed)
2. Filter with `wikibase-dump-filter` (`npm` package, fits our toolchain): `--claim P625 --sitelink enwiki`
3. Post-process filtered NDJSON to extract the same fields
