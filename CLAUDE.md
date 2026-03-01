# CLAUDE.md

**WikiRadar** — a Wikipedia-powered tour guide PWA using spherical nearest-neighbor search to find nearby Wikipedia articles. Deployed to GitHub Pages. Reference docs in `docs/`.

## Commands

```bash
npm test              # Lint + tests (runs npm run lint, then vitest run)
npm run test:watch    # Tests in watch mode
npm run test:coverage # Tests with coverage report
npm run lint          # Type-check + ESLint + Prettier check (tsc --noEmit && eslint src/ && prettier --check .)
npm run lint:fix      # Auto-fix ESLint + Prettier issues
npm run lint:eslint   # ESLint only (no type-check)
npm run format        # Prettier check only
npm run format:fix    # Prettier auto-fix only
npm run dev           # Start Vite dev server (binds 0.0.0.0 for phone testing)
npm run build         # Production build → dist/app/
npm run preview       # Preview production build locally
npm run pipeline      # Run offline build pipeline (tsx src/pipeline/build.ts)
npm run extract       # Extract geotagged articles from Wikipedia dumps → data/articles-{lang}.json
```

Run a single test file: `npx vitest run src/geometry/index.test.ts`

Requires **Node.js 18+** (ES2022 target; tested with Node 20 and 22).

## Pre-commit Hooks

Husky runs lint-staged on every commit, auto-fixing ESLint and Prettier issues on staged `.ts` files. Hooks are installed automatically by `npm install` (via the `prepare` script).

## Architecture

Three directories under `src/`, plus two shared files:

- **`src/geometry/`** — Spherical math primitives (coordinate conversion, great-circle distance, Delaunay triangulation).
- **`src/pipeline/`** — Offline build: extracts Wikipedia coordinates, computes triangulation, outputs static tiles. Run via `tsx`.
- **`src/app/`** — PWA frontend: loads pre-computed data, performs nearest-neighbor queries. Vite root (`root: "src/app"`).
- **`src/lang.ts`** — Supported language definitions, shared by all modules.
- **`src/tiles.ts`** — Tile grid constants and ID computation, shared by pipeline and app.

Core algorithm: spherical Delaunay triangulation (3D convex hull) → O(√N) nearest-neighbor via triangle walks. See `docs/` for theory and data flow details.

## Testing

Vitest with globals — use `describe`, `it`, `expect` without imports. Tests live alongside source as `*.test.ts` files. TypeScript strict mode, ES2022 target, ESNext modules.

- **Test behavior, not implementation.** Assert on outcomes, not call sequences.
- **DAMP over DRY.** Inline setup so each test reads in isolation.
- **One behavior per test.** Each failure should name the exact scenario.
- **Pragmatic coverage.** Don't chase 100%. Every test should pay rent.

## Issue Tracking

This project uses **beads** (`bd`) for issue tracking instead of markdown files or TodoWrite.

```bash
bd list               # View all issues
bd ready              # Find available work
bd show <id>          # View issue details
bd create "<title>"   # Create a new issue
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work (alias for bd update --status done)
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

If quality gates fail, fix the issues before pushing. Never push broken code. NEVER stop before pushing — that leaves work stranded locally. If push fails, resolve and retry until it succeeds.
