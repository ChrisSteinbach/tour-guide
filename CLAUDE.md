# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Wikipedia-powered tour guide that uses spherical nearest-neighbor search to find nearby Wikipedia articles based on geographic coordinates. Early-stage: geometry library and pipeline are stubs, planning docs are in `docs/`.

## Commands

```bash
npm test              # Run tests once (vitest run)
npm run test:watch    # Run tests in watch mode
npm run dev           # Start Vite dev server (binds 0.0.0.0 for phone testing)
npm run build         # Production build → dist/app/
npm run pipeline      # Run offline build pipeline (tsx src/pipeline/build.ts)
npm run extract       # Extract geotagged articles from Wikipedia dumps → data/articles-{lang}.json
npx tsc               # Type-check without emitting
```

Run a single test file: `npx vitest run src/geometry/index.test.ts`

### Extraction

`npm run extract` downloads Wikipedia SQL dumps (`geo_tags`, `page`, `page_props`) and joins them to produce the full set of geotagged articles. This captures articles with coordinates via `{{coord}}` templates that may not be mirrored to Wikidata. Descriptions are batch-fetched from the Wikidata API using Q-IDs from page_props.

Dump files are downloaded to `data/dumps/` and cached across runs. A full English extraction fetches ~1.2M articles.

```bash
# Full extraction
npm run extract -- --lang=en

# Skip download (reuse existing dumps)
npm run extract -- --lang=sv --skip-download

# Skip descriptions (faster, for testing)
npm run extract -- --lang=sv --no-desc

# Geographic subset
npm run extract -- --lang=en --bounds=49.44,50.19,5.73,6.53

# Inspect output
head -3 data/articles-en.json
wc -l data/articles-en.json
```

The old SPARQL-based extractor is available as `npm run extract:sparql`.

Output format (one JSON object per line):
```
{"title":"Eiffel Tower","lat":48.8584,"lon":2.2945,"desc":"iron lattice tower in Paris, France"}
```

### Pipeline

`npm run pipeline` reads extracted NDJSON articles, builds a spherical Delaunay triangulation, and writes a compact binary file used by the app at runtime.

```bash
# Build triangulation for a language (default: en)
npm run pipeline -- --lang=en

# Output JSON instead of binary (for debugging)
npm run pipeline -- --lang=en --json

# Convert existing JSON to binary
npm run pipeline -- --lang=en --convert

# Limit articles or restrict to a bounding box (for quick local testing)
npm run pipeline -- --lang=en --limit=10000
npm run pipeline -- --lang=en --bounds=49.44,50.19,5.73,6.53
```

Input: `data/articles-{lang}.json` (NDJSON from extraction step)
Output: `data/triangulation-{lang}.bin` (or `.json` with `--json`)

### Data Refresh & Deployment

Data is refreshed automatically via GitHub Actions (`pipeline.yml`) on a monthly schedule or manual trigger. The workflow:

1. **Extract** — Downloads Wikipedia SQL dumps and joins geo_tags/page/page_props for each language (en, sv, ja)
2. **Build** — Runs the pipeline to produce `triangulation-{lang}.bin`
3. **Publish** — Uploads compressed `.bin.gz` files to a `data-latest` GitHub Release

Deployment (`deploy.yml`) runs on every push to main:

1. Downloads `triangulation-*.bin.gz` from the `data-latest` release
2. Decompresses and copies `.bin` files into `dist/app/`
3. Deploys to GitHub Pages

To refresh data manually:

```bash
# Run locally for one language
npm run extract -- --lang=en
npm run pipeline -- --lang=en

# Or trigger the GitHub Actions workflow
gh workflow run pipeline.yml
```

## Architecture

Three modules under `src/`, sharing a common geometry library:

- **`src/geometry/`** — Shared spherical math primitives (coordinate conversion, great-circle distance, Delaunay triangulation). Used by both pipeline and app.
- **`src/pipeline/`** — Offline build step that extracts Wikipedia coordinates, computes spherical Delaunay triangulation, and outputs static data files. Run via `tsx`, not Vite.
- **`src/app/`** — PWA frontend that loads pre-computed data and performs nearest-neighbor queries at runtime. This is the Vite root (`vite.config.ts` sets `root: "src/app"`).

The core algorithm: spherical Delaunay triangulation (via 3D convex hull) enables O(√N) nearest-neighbor queries using triangle walks. Points are represented as 3D Cartesian coordinates on a unit sphere. See `docs/nearest-neighbor.md` for theory and `docs/nearesat-neighbor-plan.md` for the implementation roadmap.

## Testing

Vitest with globals enabled — use `describe`, `it`, `expect` without imports. Tests live alongside source as `*.test.ts` files.

## TypeScript

Strict mode, ES2022 target, ESNext modules with bundler resolution. No runtime dependencies — dev-only tooling (vite, vitest, tsx, typescript).

## Browser Verification

After any UI change, verify visually in the browser before committing:

1. Start the dev server: `npm run dev`
2. Navigate to `https://localhost:5173/` using Playwright MCP
3. Walk through the affected flows (use "Or try with demo data" for quick testing)
4. Take screenshots at both desktop and mobile (375×667) widths
5. Check for interaction issues — dropdowns, focus states, transitions

The app does full DOM rebuilds on GPS position updates, so interactive elements (dropdowns, inputs) in the list view must survive re-renders. The `render()` function in `main.ts` skips re-rendering when the article list is unchanged to avoid this.

## Issue Tracking

This project uses **beads** (`bd`) for issue tracking instead of markdown files or TodoWrite.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Session Completion

When ending a work session, ALL steps below are mandatory. Work is NOT complete until `git push` succeeds.

1. **File issues for remaining work** — Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) — Tests, linters, builds
3. **Update issue status** — Close finished work, update in-progress items
4. **Push to remote:**
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** — Clear stashes, prune remote branches
6. **Verify** — All changes committed AND pushed
7. **Hand off** — Provide context for next session

NEVER stop before pushing — that leaves work stranded locally. If push fails, resolve and retry until it succeeds.
