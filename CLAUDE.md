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
npx tsc               # Type-check without emitting
```

Run a single test file: `npx vitest run src/geometry/index.test.ts`

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
