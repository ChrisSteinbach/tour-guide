# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Wikipedia-powered tour guide that uses spherical nearest-neighbor search to find nearby Wikipedia articles based on geographic coordinates. Early-stage: geometry library and pipeline are stubs, planning docs are in `docs/`.

## Commands

```bash
npm test              # Run tests once (vitest run)
npm run test:watch    # Run tests in watch mode
npm run dev           # Start Vite dev server (app frontend)
npm run build         # Production build → dist/app/
npm run pipeline      # Run offline build pipeline (tsx src/pipeline/build.ts)
npm run extract       # Extract geotagged articles from Wikidata → data/articles.json
npx tsc               # Type-check without emitting
```

Run a single test file: `npx vitest run src/geometry/index.test.ts`

### Extraction

`npm run extract` queries the Wikidata SPARQL endpoint for all English Wikipedia articles with geographic coordinates and writes NDJSON to `data/articles.json`. A full global run fetches ~1.2M articles in batches of 50k and takes roughly 5–7 minutes.

Use `--bounds=south,north,west,east` to extract a geographic subset:

```bash
# Luxembourg (~500 articles, single batch, a few seconds)
npm run extract -- --bounds=49.44,50.19,5.73,6.53

# Inspect output
head -3 data/articles.json
wc -l data/articles.json
```

Output format (one JSON object per line):
```
{"title":"Eiffel Tower","lat":48.8584,"lon":2.2945,"desc":"iron lattice tower in Paris, France"}
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
