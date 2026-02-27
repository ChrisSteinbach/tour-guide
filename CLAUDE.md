# **CLAUDE.md**

**WikiRadar** — a Wikipedia-powered tour guide PWA using spherical nearest-neighbor search to find nearby Wikipedia articles. Deployed to GitHub Pages. Reference docs in `docs/`.

## **I. Commands**

```bash
npm test              # Lint + tests (runs npm run lint, then vitest run)
npm run lint          # Type-check + ESLint + Prettier check (tsc && eslint && prettier)
npm run dev           # Start Vite dev server (binds 0.0.0.0 for phone testing)
npm run build         # Production build → dist/app/
npm run pipeline      # Run offline build pipeline (tsx src/pipeline/build.ts)
npm run extract       # Extract geotagged articles from Wikipedia dumps → data/articles-{lang}.json
```

Run a single test file: `npx vitest run src/geometry/index.test.ts`

## **II. Architecture**

Three modules under `src/`, sharing a common geometry library:

- **`src/geometry/`** — Spherical math primitives (coordinate conversion, great-circle distance, Delaunay triangulation).
- **`src/pipeline/`** — Offline build: extracts Wikipedia coordinates, computes triangulation, outputs static tiles. Run via `tsx`.
- **`src/app/`** — PWA frontend: loads pre-computed data, performs nearest-neighbor queries. Vite root (`root: "src/app"`).

Core algorithm: spherical Delaunay triangulation (3D convex hull) → O(sqrt(N)) nearest-neighbor via triangle walks. See `docs/` for theory and data flow details.

## **III. Testing**

Vitest with globals — use `describe`, `it`, `expect` without imports. Tests live alongside source as `*.test.ts` files. TypeScript strict mode, ES2022 target, ESNext modules.

- **Test behavior, not implementation.** Assert on outcomes, not call sequences.
- **DAMP over DRY.** Inline setup so each test reads in isolation.
- **One behavior per test.** Each failure should name the exact scenario.
- **Pragmatic coverage.** Don't chase 100%. Every test should pay rent.

## **IV. Issue Tracking**

This project uses **beads** (`bd`) for issue tracking instead of markdown files or TodoWrite.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## **V. Session Completion**

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
