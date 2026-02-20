# Data Extraction

This document describes how tour-guide obtains geotagged Wikipedia articles and transforms them into the data files used by the app.

## Overview

The extraction pipeline has two methods for obtaining article coordinates:

1. **SQL dumps** (primary) — Downloads and joins `geo_tags` and `page` tables from Wikipedia database dumps. Fast, complete, and offline-capable.
2. **SPARQL** (fallback) — Queries the Wikidata SPARQL endpoint. Slower and subject to rate limits, but useful for small regions or when dumps are unavailable.

Article descriptions are not extracted — the app fetches them on demand from the Wikipedia REST API when the user opens an article detail view.

## SQL Dump Extraction (Primary)

**Entry point:** `src/pipeline/extract-dump.ts` — `npm run extract`

### Data Sources

Two SQL dump files are downloaded per language from `dumps.wikimedia.org`:

| Table      | File                            | Contents                                        | Size (English) |
| ---------- | ------------------------------- | ----------------------------------------------- | -------------- |
| `page`     | `{wiki}-latest-page.sql.gz`     | Article IDs, titles, namespaces, redirect flags | ~2 GB          |
| `geo_tags` | `{wiki}-latest-geo_tags.sql.gz` | Geographic coordinates linked to page IDs       | ~600 MB        |

Files are downloaded to `data/dumps/` and cached across runs.

### Extraction Steps

1. **Download** — Streams dump files with progress reporting. Skips files that already exist when `--skip-download` is set.
2. **Build page map** — Parses the `page` dump into a `Map<page_id, title>`. Filters to namespace 0 (main articles) and excludes redirects.
3. **Join geo_tags** — Streams the `geo_tags` dump row by row. For each row, filters to `globe=earth` and `primary=1`, validates coordinates (rejects NaN, out-of-range, and Null Island 0,0), applies optional bounding box, and looks up the title from the page map.
4. **Deduplicate** — Keeps the first occurrence of each title.
5. **Write NDJSON** — Outputs one JSON object per line.

### SQL Dump Parser

The parser (`src/pipeline/dump-parser.ts`) handles gzipped MySQL dump files:

- Discovers column schemas from `CREATE TABLE` statements
- Parses `INSERT INTO ... VALUES` with full MySQL escape sequence support (`\'`, `\\`, `\n`, etc.)
- Streams rows one at a time to keep memory usage bounded

### Usage

```bash
# Full extraction (English)
npm run extract -- --lang=en

# Skip download (reuse existing dumps)
npm run extract -- --lang=sv --skip-download

# Geographic subset (south,north,west,east)
npm run extract -- --lang=en --bounds=49.44,50.19,5.73,6.53
```

### Output

`data/articles-{lang}.json` — NDJSON, one article per line:

```json
{"title":"Eiffel Tower","lat":48.8584,"lon":2.2945}
{"title":"Louvre","lat":48.8606,"lon":2.3376}
```

A full English extraction produces ~1.2M articles.

## SPARQL Extraction (Fallback)

**Entry point:** `src/pipeline/extract.ts` — `npm run extract:sparql`

Queries the Wikidata SPARQL endpoint (`query.wikidata.org`) for items with coordinates (P625) and a Wikipedia article in the target language.

### How It Works

- Divides the globe into 10°×10° tiles and queries each tile with pagination (50,000 results per batch)
- On timeout or server error, adaptively subdivides the tile into quadrants (minimum 0.3°)
- Supports checkpoint/resume for interrupted extractions
- Includes exponential backoff and configurable retry limits
- Returns article descriptions from Wikidata labels

### Usage

```bash
# Full extraction (slow — hours for English)
npm run extract:sparql -- --lang=en

# Bounded region (much faster)
npm run extract:sparql -- --lang=sv --bounds=55.0,69.0,10.0,25.0

# Resume interrupted extraction
npm run extract:sparql -- --lang=en  # auto-detects checkpoint
```

### Output

Same NDJSON format but includes a `desc` field from Wikidata:

```json
{
  "title": "Eiffel Tower",
  "lat": 48.8584,
  "lon": 2.2945,
  "desc": "iron lattice tower in Paris, France"
}
```

### Why SQL Dumps Are Preferred

|              | SQL Dumps                 | SPARQL                     |
| ------------ | ------------------------- | -------------------------- |
| Speed        | ~10 minutes (English)     | Hours                      |
| Rate limits  | None                      | Wikidata throttling        |
| Coverage     | All `{{coord}}` templates | Only Wikidata-linked items |
| Descriptions | Not included              | Included from Wikidata     |
| Offline      | After initial download    | Requires network           |

The SQL dump approach captures articles with `{{coord}}` templates that may not have corresponding Wikidata items, giving better geographic coverage.

## Descriptions

Descriptions are **not** embedded in the extraction output. Instead, the app fetches them on demand via the [Wikipedia REST API](https://en.wikipedia.org/api/rest_v1/):

```
GET https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}
```

This returns the article's description, extract, thumbnail, and page URL. Responses are cached in-memory and by the service worker (StaleWhileRevalidate, 200 entries, 1-week expiry).

This approach avoids bloating the static data files and ensures descriptions stay current.

## Multi-Language Support

Three languages are supported: English (`en`), Swedish (`sv`), and Japanese (`ja`).

Each language produces its own independent data file (`articles-en.json`, `articles-sv.json`, `articles-ja.json`). The language list is defined in `src/lang.ts`.

The `--lang` flag controls which language to extract:

```bash
npm run extract -- --lang=ja
npm run extract:sparql -- --lang=sv
```

## What Happens Next

After extraction, the pipeline step (`npm run pipeline`) reads the NDJSON articles and builds a spherical Delaunay triangulation for nearest-neighbor queries. See [architecture.md](architecture.md) for the full data flow.
