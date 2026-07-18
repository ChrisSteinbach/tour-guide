# Data Extraction

This document describes how tour-guide obtains geotagged Wikipedia articles and transforms them into the data files used by the app.

## Overview

The extraction pipeline downloads and joins `geo_tags` and `page` tables from Wikipedia SQL dumps, then joins monthly pageview counts from a separate Wikimedia dump (see [Pageviews](#pageviews)) to give each article a popularity signal. This captures all articles with `{{coord}}` templates and works offline after the initial download (~10 minutes for English on a modern laptop with cached dumps; the pageviews dump adds a one-time ~6 GB download shared across all languages).

Article descriptions are not extracted — the app fetches them on demand from the Wikipedia REST API when the user opens an article detail view.

## SQL Dump Extraction

**Entry point:** `src/pipeline/extract-dump.ts` — `npm run extract`

### Data Sources

Two SQL dump files are downloaded per language from `dumps.wikimedia.org`:

| Table      | File                            | Contents                                        | Size (English) |
| ---------- | ------------------------------- | ----------------------------------------------- | -------------- |
| `page`     | `{wiki}-latest-page.sql.gz`     | Article IDs, titles, namespaces, redirect flags | ~2 GB          |
| `geo_tags` | `{wiki}-latest-geo_tags.sql.gz` | Geographic coordinates linked to page IDs       | ~600 MB        |

Files are downloaded to `data/dumps/` and cached across runs. Wikipedia publishes new SQL dumps every 1–2 weeks per wiki. Geographic coordinate data (`geo_tags`) changes slowly relative to article text, so a monthly refresh (see `pipeline.yml`) captures new and relocated articles without excessive CI cost.

### Extraction Steps

1. **Download** — Streams dump files with progress reporting. Skips files that already exist when `--skip-download` is set.
2. **Build page map** — Parses the `page` dump into a `Map<page_id, title>`. Filters to namespace 0 (main articles) and excludes redirects.
3. **Join pageviews** — Sums monthly view counts onto the page map by `page_id` (see [Pageviews](#pageviews)). Skipped entirely with `--no-pageviews`.
4. **Join geo_tags** — Streams the `geo_tags` dump row by row. For each row, filters to `globe=earth` and `primary=1`, validates coordinates (rejects NaN, out-of-range, and Null Island 0,0), applies optional bounding box, and looks up the title (and joined view count) from the page map.
5. **Deduplicate** — Keeps the first occurrence of each title. This is a title-level dedup only: distinct articles that happen to share exact coordinates (e.g. a building and the institution sited in it) are different titles, so both pass through untouched here — they're merged later, in the build pipeline, which collapses same-coordinate articles into one triangulation vertex carrying the full group (see [binary-format.md](binary-format.md) or [tiling.md](tiling.md)), so no coincident article is silently dropped.
6. **Write NDJSON** — Outputs one JSON object per line.
7. **Canary validation** — Checks per-language landmarks against the output (`canary.ts`). Each supported language has its own landmark set (e.g. en: Eiffel Tower, Statue of Liberty, Sydney Opera House; sv: Eiffeltornet, Globen; ja: エッフェル塔, 東京タワー). Coordinate mismatches fail the pipeline. Missing landmarks (expected for `--bounds` or `--limit` extractions) are reported but tolerated.

### SQL Dump Parser

The parser (`src/pipeline/dump-parser.ts`) handles gzipped MySQL dump files:

- Discovers column schemas from `CREATE TABLE` statements
- Parses `INSERT INTO ... VALUES` with full MySQL escape sequence support (`\'`, `\\`, `\n`, etc.)
- Streams rows one at a time to keep memory usage bounded

### Memory Requirements

The extract command allocates up to 6 GB of heap memory (`--max-old-space-size=6144`) for the in-memory page map. English extraction requires ~4-5 GB peak. Ensure your machine has at least 8 GB RAM when extracting English. Smaller languages (sv, ja) use significantly less memory.

### Usage

```bash
# Full extraction (English)
npm run extract -- --lang=en

# Skip download (reuse existing dumps and pageviews file)
npm run extract -- --lang=sv --skip-download

# Geographic subset (west,south,east,north — standard WGS84 bounding box order)
npm run extract -- --lang=en --bounds=5.73,49.44,6.53,50.19

# Skip the pageviews join (fast, geo-only — all weights 0, Highlights empty)
npm run extract -- --lang=en --no-pageviews

# Pin the pageviews month instead of auto-resolving the newest
npm run extract -- --lang=en --pageviews-month=2026-06
```

### Output

`data/articles-{lang}.json` — NDJSON, one article per line:

```json
{"title":"Eiffel Tower","lat":48.8584,"lon":2.2945,"views":512345}
{"title":"Louvre","lat":48.8606,"lon":2.3376,"views":87018}
```

`views` is the article's monthly pageview count (see [Pageviews](#pageviews)). It is omitted when the article had zero or unmatched views; the build pipeline then assigns the article weight class 0 (unknown). See [binary-format.md](binary-format.md) for how views map to an article's weight class — a per-language popularity percentile, not the raw count.

A full English extraction produces ~1.2M articles.

## Pageviews

**Entry point:** `src/pipeline/pageviews.ts` — `npm run pageviews`

### Data Source

Wikimedia publishes a monthly `pageview_complete` dump: one ~6 GB bz2 file covering every wiki, split by access agent. Extraction uses the `-user` variant (human traffic only) from `dumps.wikimedia.org/other/pageview_complete/monthly/`. Lines are space-separated:

```
{wiki} {title} {page_id|null} {access_method} {monthly_total} {daily_breakdown}
en.wikipedia Eiffel_Tower 9232 desktop 512345 A17102B16544...
```

Non-content pages carry a `null` page ID and are skipped. One article's views are split across several rows — access methods (desktop/mobile-web/mobile-app), internal file sections, and redirect titles resolved to the same page ID — and those rows are not all adjacent; a popular article can span dozens of rows spread through the file.

### Download & Split

Because one file covers every language, `ensureViewsFiles()` downloads it once, streams it through `lbzip2 -dc` (parallel, used when available) or `bzip2 -dc` as a fallback, and splits it into gzipped per-language TSVs — `data/pageviews/pageviews-YYYYMM-{lang}.tsv.gz`, `{page_id}\t{views}` rows with adjacent same-id runs pre-summed. A page ID can still appear on multiple rows (the dump scatters an article's rows); the extraction join sums duplicates, so totals are exact regardless. The multi-GB decompressed stream is never written to disk.

`npm run extract` calls this automatically (unless `--skip-download` is set) and, in a single pass, ensures views files exist for **every** supported language — not just the one being extracted — so the 6 GB dump is downloaded once and reused by every subsequent `--lang=` run.

### Month Selection

Pass `--month=YYYY-MM` (or, from `extract`, `--pageviews-month=YYYY-MM`) for an explicit month. Without it, the newest **complete** month is resolved automatically by HEAD-probing up to 3 months back — a month's dump isn't published until partway through the following month, so the current calendar month is never a valid choice.

### Usage

```bash
# All supported languages, newest complete month
npm run pageviews

# Specific languages and month
npm run pageviews -- --langs=en,sv --month=2026-06

# Custom output directory
npm run pageviews -- --dir=/tmp/pageviews
```

### Joining onto Articles

`npm run extract` joins the per-language views file onto the page map by `page_id`, summing across rows (defensive — the per-language split already sums access methods per page). Because the join key is `page_id` and the page map only contains non-redirect articles (namespace 0, `page_is_redirect=0`), a pageview logged against a **redirect's** own page_id has no matching entry and is silently dropped rather than credited to the redirect's target. This is a known, accepted limitation: an article's `views` count reflects only traffic to its own title, not traffic arriving via redirects or alternate names.

With `--skip-download`, extraction reuses the pageviews TSV already on disk for that language — the newest one present, or exactly the requested month when `--pageviews-month` is also given — and fails with guidance if it doesn't exist.

## Descriptions

Descriptions are **not** embedded in the extraction output. Instead, the app fetches them on demand via the [Wikipedia REST API](https://en.wikipedia.org/api/rest_v1/):

```
GET https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}
```

This returns the article's description, extract, thumbnail, and page URL. Responses are cached in-memory and by the service worker (StaleWhileRevalidate, 200 entries, 1-week expiry).

This approach avoids bloating the static data files and ensures descriptions stay current.

## Multi-Language Support

14 languages are supported: English (`en`), German (`de`), French (`fr`), Spanish (`es`), Italian (`it`), Russian (`ru`), Chinese (`zh`), Portuguese (`pt`), Polish (`pl`), Dutch (`nl`), Korean (`ko`), Arabic (`ar`), Swedish (`sv`), and Japanese (`ja`).

Each language produces its own independent data file (e.g. `articles-en.json`, `articles-de.json`). The language list is defined in `src/lang.ts`.

The `--lang` flag controls which language to extract:

```bash
npm run extract -- --lang=ja
```

## Adding a New Language

To add a new language:

1. Add the language code to the `SUPPORTED_LANGS` array in `src/lang.ts`. This automatically extends the `Lang` type.
2. Add canary landmarks for the new language in `src/pipeline/canary.ts` (the `LANDMARKS` record). The `Record<Lang, ...>` type requires this — TypeScript will report a type error after step 1 until this step is done. Without canary landmarks, extraction will succeed but data integrity won't be validated.
3. Run extraction: `npm run extract -- --lang=xx`
4. Run the pipeline: `npm run pipeline -- --lang=xx`

The CI pipeline (`.github/workflows/pipeline.yml`) reads `SUPPORTED_LANGS` from `src/lang.ts` dynamically — no manual workflow edit is needed. Monthly rebuilds will automatically include the new language after step 1.

No special parsing is needed — the SQL dump format is identical across all Wikipedia languages. CJK titles (Japanese, Chinese, Korean) are handled transparently via UTF-8.

## What Happens Next

After extraction, the pipeline step (`npm run pipeline`) reads the NDJSON articles and builds a spherical Delaunay triangulation for nearest-neighbor queries. See [architecture.md](architecture.md) for the full data flow.
