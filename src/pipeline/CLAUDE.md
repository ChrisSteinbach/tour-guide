# Pipeline & Extraction

## Extraction

`npm run extract` downloads Wikipedia SQL dumps (`geo_tags`, `page`) and joins them to produce the full set of geotagged articles. This captures articles with coordinates via `{{coord}}` templates that may not be mirrored to Wikidata. Descriptions are fetched on demand by the app at runtime via the Wikipedia REST API.

Dump files are downloaded to `data/dumps/` and cached across runs. A full English extraction fetches ~1.2M articles.

```bash
# Full extraction
npm run extract -- --lang=en

# Skip download (reuse existing dumps)
npm run extract -- --lang=sv --skip-download

# Geographic subset
npm run extract -- --lang=en --bounds=5.73,49.44,6.53,50.19

# Inspect output
head -3 data/articles-en.json
wc -l data/articles-en.json
```

Output format (one JSON object per line):

```
{"title":"Eiffel Tower","lat":48.8584,"lon":2.2945}
```

## Pipeline

`npm run pipeline` reads extracted NDJSON articles, builds per-tile spherical Delaunay triangulations, and writes tiled binary files used by the app at runtime.

```bash
# Build tiled triangulation for a language (default: en)
npm run pipeline -- --lang=en

# Limit articles or restrict to a bounding box (for quick local testing)
npm run pipeline -- --lang=en --limit=10000
npm run pipeline -- --lang=en --bounds=5.73,49.44,6.53,50.19
```

Input: `data/articles-{lang}.json` (NDJSON from extraction step)
Output: `data/tiles/{lang}/` (index.json + per-tile .bin files)

## Local Tile Data

Tile data is pipeline-generated and not checked into git. The app needs tiles in `data/tiles/{lang}/` to display articles for a given language. If tiles are missing for a language, that language will show "0 attractions" in the browser.

To generate tiles locally for a specific language:

```bash
# Extract + build (downloads dumps on first run, ~5-15 min per language)
npm run extract -- --lang=de
npm run pipeline -- --lang=de

# Reuse cached dumps (faster, skips download)
npm run extract -- --lang=de --skip-download
npm run pipeline -- --lang=de

# Quick subset for testing (seconds instead of minutes)
npm run extract -- --lang=de --bounds=5.73,49.44,6.53,50.19
npm run pipeline -- --lang=de --bounds=5.73,49.44,6.53,50.19
```

For browser testing with language switching, generate tiles for at least **en** plus one or two others (e.g. **de**, **sv**). Check coverage with `ls data/tiles/`.

## Data Refresh & Deployment

Data is refreshed automatically via GitHub Actions (`pipeline.yml`) on a monthly schedule or manual trigger. The workflow processes all 14 supported languages (from `SUPPORTED_LANGS` in `src/lang.ts`):

1. **Extract** — Downloads Wikipedia SQL dumps and joins geo_tags/page for each language
2. **Build** — Runs the pipeline to produce tiled output in `data/tiles/{lang}/`
3. **Publish** — Uploads compressed tile archives to a `data-latest` GitHub Release

Deployment (`deploy.yml`) is triggered manually via `workflow_dispatch`:

1. Downloads tile archives from `data-latest` release
2. Decompresses tile files into `dist/app/tiles/`
3. Deploys to GitHub Pages

To refresh data manually:

```bash
# Run locally for one language
npm run extract -- --lang=en
npm run pipeline -- --lang=en

# Or trigger the GitHub Actions workflow
gh workflow run pipeline.yml
```
