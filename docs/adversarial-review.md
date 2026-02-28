# Adversarial Documentation Review

Review methodology: [Verification-Driven Development (VDD) via Iterative Adversarial Refinement](https://gist.github.com/dollspace-gay/45c95ebfb5a3a3bae84d8bebd662cc25). Every factual claim in the documentation was verified against the source code. This document reports only genuine discrepancies, not stylistic preferences.

**Scope:** `README.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/binary-format.md`, `docs/data-extraction.md`, `docs/nearest-neighbor.md`, `docs/state-machine.md`, `docs/tiling.md`

**Date:** 2026-02-28

---

## Findings

### 1. Function name mismatch in `docs/tiling.md`

**Severity: High** — Directly misleading to anyone reading the code.

`docs/tiling.md` section 4 (lines 166-182) shows a function called `mergedFindNearest()` that takes `NearestQuery[]`. The actual function in `src/app/tile-loader.ts:55` is called `findNearestTiled()` and takes `ReadonlyMap<string, NearestQuery>`. The signature also differs: the real function has `k = 1` (default parameter), the doc version has `k: number` (required).

The pseudocode correctly describes the algorithm (query each tile, deduplicate by title, sort by distance, slice to k), but using the wrong function name and signature means a developer searching for `mergedFindNearest` will find nothing.

### 2. Misleading claim about `onupgradeneeded` in `docs/architecture.md`

**Severity: High** — States something that is factually incorrect.

`docs/architecture.md` line 76 says:

> Schema migration is handled by bumping the version in the prefix — old keys are orphaned and cleaned up on startup, avoiding the need for `onupgradeneeded` migration logic.

But `src/app/idb.ts:29` **does** use `onupgradeneeded`:

```typescript
req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
```

The project uses **both** approaches: `onupgradeneeded` for creating the object store, and key prefix versioning for data migration. The doc implies the project avoids `onupgradeneeded` entirely, which is false. The phrasing "avoiding the need for `onupgradeneeded` migration logic" could be read as "we don't use `onupgradeneeded` for _migration_" (technically defensible) but in context it reads as "we don't use `onupgradeneeded` at all."

### 3. Missing step in "Adding a New Language" (`docs/data-extraction.md`)

**Severity: Medium** — A developer following the guide will produce a language without canary validation.

The "Adding a New Language" section (lines 97-102) lists 4 steps: add to `lang.ts`, run extract, run pipeline, add to CI. It does not mention adding canary landmarks to `src/pipeline/canary.ts`. The `LANDMARKS` record (`canary.ts:24-38`) is keyed by `Lang`, so a new language without entries will have no canary validation — the extraction will succeed but data integrity won't be verified.

### 4. `CLAUDE.md` omits `lang.ts` and `tiles.ts` from architecture

**Severity: Medium** — These are shared modules used by all three subsystems.

The CLAUDE.md Architecture section lists three directories (`src/geometry/`, `src/pipeline/`, `src/app/`) but does not mention `src/lang.ts` or `src/tiles.ts`. Both are actively used across all modules. The README.md Architecture section correctly lists them. A developer relying on CLAUDE.md for the project layout would miss these shared root-level files.

### 5. CI workflow description inconsistency (`docs/architecture.md`)

**Severity: Low** — Correct in spirit, imprecise in detail.

`docs/architecture.md:271` describes CI as:

> Three parallel jobs: lint (format + eslint), type-check (tsc), test (vitest + coverage)

The actual `ci.yml` lint job runs `npm run format` (Prettier check) and `npm run lint:eslint` (ESLint only). This is consistent with the doc's "(format + eslint)" label. However, the reader might confuse this with the local `npm run lint` command (documented in CLAUDE.md), which runs `tsc --noEmit && eslint src/ && prettier --check .` — i.e., includes type-checking. The CI deliberately splits type-checking into its own job for parallelism, but the shared "lint" naming creates ambiguity.

### 6. Undocumented npm scripts in `package.json`

**Severity: Low** — Not misleading, but incomplete.

Neither README.md nor CLAUDE.md documents these scripts that exist in `package.json`:

| Script            | Command              |
| ----------------- | -------------------- |
| `preview`         | `vite preview`       |
| `format`          | `prettier --check .` |
| `format:fix`      | `prettier --write .` |
| `lint:eslint`     | `eslint src/`        |
| `lint:eslint:fix` | `eslint src/ --fix`  |

These are used by CI (`format`, `lint:eslint`) and are useful for development. The documented `lint` and `lint:fix` commands are supersets, so this is a convenience issue rather than a correctness one.

### 7. Dev server port is a Vite default, not a guarantee (`README.md`)

**Severity: Low** — Technically misleading edge case.

README.md line 34 states "The dev server starts at `https://localhost:5173/`". The `vite.config.ts` does **not** configure a port — 5173 is Vite's default. If the port is occupied, Vite auto-increments to 5174, 5175, etc. A more precise statement would be "defaults to `https://localhost:5173/`".

### 8. Back-of-envelope math in `docs/tiling.md` is slightly inconsistent

**Severity: Low** — The estimates are reasonable but don't cross-check cleanly.

`docs/tiling.md` claims ~89 bytes/article and ~1.2M articles. Naive multiplication: 1.2M × 89 = ~107 MB. But `docs/binary-format.md:81` claims "~120 MB" for a monolith, and tiling.md's own summary table (line 238) also says "~120 MB monolith". The gap (~13 MB) is explained by variable title lengths in dense urban tiles, but this isn't stated. The 89-byte figure is presented as a straightforward average when it's actually a rough central estimate — the real average across the full dataset is closer to ~100 bytes/article to reach 120 MB.

### 9. `npm run extract` default language not mentioned (`README.md`)

**Severity: Informational** — Not wrong, just incomplete.

The README commands table says `npm run extract` does "Extract geotagged articles from Wikipedia dumps" without mentioning that `--lang` defaults to `en` (via `DEFAULT_LANG` in `src/lang.ts:3`). The detailed "Extraction" section below the table always shows `--lang=en` explicitly. A reader running `npm run extract` without flags would get English by default, which is fine — but the commands table could note the default.

---

## Verified Correct (selected highlights)

The vast majority of the documentation is accurate. These claims were verified against source and found to be correct:

- Binary format header layout (24 bytes, all field offsets) — matches `serialization.ts` exactly
- Float32→Float64 upcast on deserialization, Uint32 zero-copy views — confirmed
- State machine phases, events, effects, and transition table — all match `state-machine.ts`
- Dispatch loop implementation — `main.ts:64-70` is character-for-character what the doc shows
- Convex hull perturbation magnitude (1e-6), LCG PRNG, FaceGrid (8-128³ cells scaling with ∛N)
- Spherical distance formulas: `acos(dot)` in pipeline, `2*asin(chord/2)` in app runtime
- Tile grid (5°), buffer zone (0.5°), edge proximity (1°), IDB key formats
- All npm scripts match their documented behavior
- "Zero runtime dependencies" — confirmed; only `devDependencies` in `package.json`
- Euler's formula derivation (average degree 6 − 12/V) — mathematically verified
- Canary landmark lists per language — match `canary.ts` exactly
- SQL dump parser escape handling — confirmed in `dump-parser.ts`
- Tile index format — matches actual pipeline output format
- Robust predicates vendored from mourner/robust-predicates — confirmed

---

## Convergence Assessment

Per the VDD methodology, the adversarial cycle terminates when critiques become hallucinated. After exhaustive cross-referencing of ~8 documentation files against ~30 source files, the findings above represent the genuine issues. The documentation is unusually well-maintained — the 9 findings above (3 substantive, 6 minor) out of hundreds of verified claims is a strong signal that the docs are kept in sync with code changes.

The most impactful fixes are items 1-3: the wrong function name, the misleading `onupgradeneeded` claim, and the missing canary step for new languages.
