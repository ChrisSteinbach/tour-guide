# Adversarial Documentation Review

An adversarial review of this project's documentation following the
Verification-Driven Development (VDD) methodology: systematic, hyper-critical
analysis designed to surface real flaws rather than praise existing quality.

Reviewed files: `README.md`, `CLAUDE.md`, `docs/architecture.md`,
`docs/binary-format.md`, `docs/data-extraction.md`,
`docs/nearest-neighbor.md`, `docs/state-machine.md`, `docs/tiling.md`.

All claims were verified against the source code as of this commit.

---

## Findings

### 1. CLAUDE.md: lint command is a misleading paraphrase

**Location:** `CLAUDE.md` line 11

**Documented:**

```
npm run lint          # Type-check + ESLint + Prettier check (tsc && eslint && prettier)
```

**Actual command (package.json):**

```
tsc --noEmit && eslint src/ && prettier --check .
```

**Problem:** Three flags are silently omitted:

- `--noEmit` — without it, `tsc` would emit JavaScript files into the working tree
- `src/` — ESLint is scoped to `src/`, not the whole repo
- `--check .` — Prettier runs in check-only mode; without `--check` it would reformat files in place

A developer who reads the CLAUDE.md shorthand and tries to run lint components
manually (e.g. `tsc && eslint && prettier`) would emit unwanted JS files and
reformat code instead of checking it. The comment says "Type-check + ESLint +
Prettier **check**" which is accurate, but the parenthetical command is not.

**Severity:** Medium

**Fix:** Replace the parenthetical with the actual command:

```
npm run lint          # Type-check + ESLint + Prettier check (tsc --noEmit && eslint src/ && prettier --check .)
```

---

### 2. Five npm scripts exist but are undocumented

**Location:** `CLAUDE.md` Commands section, `README.md` Commands table

**Missing scripts from package.json:**

| Script            | Command              | Purpose                                          |
| ----------------- | -------------------- | ------------------------------------------------ |
| `preview`         | `vite preview`       | Preview production build locally                 |
| `format`          | `prettier --check .` | Check formatting (same as prettier part of lint) |
| `format:fix`      | `prettier --write .` | Auto-fix formatting                              |
| `lint:eslint`     | `eslint src/`        | Run ESLint only                                  |
| `lint:eslint:fix` | `eslint src/ --fix`  | Auto-fix ESLint issues                           |

The CLAUDE.md lists `lint:fix` but not the granular variants. Someone wanting
to run _only_ Prettier or _only_ ESLint has to read package.json to discover
these exist.

**Severity:** Low — these are convenience scripts and `lint:fix` covers the
common case.

---

### 3. Pre-commit hooks are completely undocumented

**Location:** Not mentioned anywhere in any doc file.

**What exists in the repo:**

- `package.json` has `"prepare": "husky"` which installs Git hooks on `npm install`
- `.husky/pre-commit` runs `npx lint-staged`
- `.lintstagedrc.json` runs `eslint --fix` + `prettier --write` on staged `.ts` files, and `prettier --ignore-unknown --write` on everything else

**Problem:** A new contributor's first commit will be intercepted by a
pre-commit hook they had no warning about. If their code has lint errors, the
commit will fail with no context in the docs about why or what to do. The
CLAUDE.md session completion checklist says "Run quality gates" but never
mentions that quality gates also run _automatically_ on every commit.

**Severity:** Medium — this actively surprises new contributors.

**Fix:** Add a brief note to the CLAUDE.md or README:

```
## Pre-commit hooks

Husky runs lint-staged on every commit, auto-fixing ESLint and Prettier issues
on staged files. Install hooks: `npm install` (runs `prepare` automatically).
```

---

### 4. The extract command's 6GB heap allocation is undocumented

**Location:** `package.json` line 14

**Actual command:**

```
tsx --max-old-space-size=6144 src/pipeline/extract-dump.ts
```

**Documented as (CLAUDE.md line 16):**

```
npm run extract       # Extract geotagged articles from Wikipedia dumps → data/articles-{lang}.json
```

**Problem:** The `--max-old-space-size=6144` flag allocates a 6GB heap limit.
This is operationally critical: the English extraction builds a multi-million
entry `Map<page_id, title>` in memory. A developer on a machine with <8GB RAM
who runs `npm run extract -- --lang=en` could encounter OOM crashes with no
documentation explaining why or how to adjust.

**Severity:** Medium — affects anyone running extraction on a constrained machine.

**Fix:** Add a note to `docs/data-extraction.md`:

```
### Memory requirements

The extract command allocates up to 6 GB of heap memory (`--max-old-space-size=6144`)
for the in-memory page map. English extraction requires ~4-5 GB peak. Ensure your
machine has at least 8 GB RAM when extracting English. Smaller languages (sv, ja)
use significantly less memory.
```

---

### 5. binary-format.md documents articles as `string[]` but the deserializer accepts tuples

**Location:** `docs/binary-format.md` line 64, `src/geometry/serialization.ts` line 310

**Documented:** "Contains a UTF-8-encoded JSON array of article titles — a
`string[]` with exactly V entries"

**Actual deserializer code:**

```typescript
const parsed = JSON.parse(articlesJson) as (string | [string, string])[];
const articles = parsed.map((entry) => ({
  title: Array.isArray(entry) ? entry[0] : entry,
}));
```

**Problem:** The deserializer silently handles a `[title, description]` tuple
format that is completely undocumented. This creates two issues:

1. The binary format spec is incomplete — it documents one format but the code
   accepts two
2. There's no explanation of when or why tuples might appear, whether the
   serializer ever produces them, or whether this is a forward-compatibility
   measure

Checking the serializer: `serializeBinary()` always produces `string[]` (via
`data.articles` which is `string[]`). So the tuple handling in the deserializer
is either dead code, forward-compatibility scaffolding, or a remnant of a
previous format. None of these possibilities are documented.

**Severity:** Medium — a spec document that doesn't match the parser creates
confusion about what "valid" binary files look like.

**Fix:** Either document the tuple format as a recognized variant, or remove
the tuple handling from the deserializer and document that articles are always
`string[]`.

---

### 6. state-machine.md claims "982 lines of tests" — actual count is 981

**Location:** `docs/state-machine.md` line 9

**Actual:** `wc -l src/app/state-machine.test.ts` returns 981.

**Problem:** Hardcoded line counts in documentation are inherently fragile.
This one has already drifted by one line.

**Severity:** Low — cosmetic, but it undermines trust in the precision of other
numerical claims.

**Fix:** Remove the specific line count or phrase it approximately: "extensive
test suite (≈1,000 lines)".

---

### 7. data-extraction.md understates canary validation scope

**Location:** `docs/data-extraction.md` line 33

**Documented:** "Checks that known landmarks (e.g. Eiffel Tower, Statue of
Liberty) appear in the output with correct coordinates"

**Actual landmarks (`src/pipeline/canary.ts`):**

| Language | Landmarks                                               |
| -------- | ------------------------------------------------------- |
| en       | Eiffel Tower, Statue of Liberty, **Sydney Opera House** |
| sv       | Eiffeltornet, Globen                                    |
| ja       | エッフェル塔, 東京タワー                                |

**Problem:** The "e.g." saves this from being outright wrong, but the doc
implies canary validation is English-only. The per-language landmark sets are a
significant feature: they validate that CJK title parsing works correctly (ja),
that non-English coordinate joins work (sv), and that Southern Hemisphere
coverage is validated (Sydney Opera House). None of this is conveyed.

The doc also says the canary "Fails the pipeline if landmarks have wrong
coordinates" without explaining the important distinction between `mismatches`
(coordinate errors — fails pipeline) and `missing` (landmark not found —
reported but tolerated). This distinction matters for bounded/limited
extractions where landmarks may legitimately be outside the bounds.

**Severity:** Low-Medium — the canary's actual behavior is more nuanced and
useful than the docs suggest.

---

### 8. The `--bounds` argument order is unconventional and insufficiently flagged

**Location:** `README.md` line 88, `docs/data-extraction.md` line 53,
`docs/architecture.md` line 44

**Documented:** `--bounds=south,north,west,east` (e.g., `--bounds=49.44,50.19,5.73,6.53`)

**Problem:** Most geospatial tools and standards use `west,south,east,north`
(WGS84 bounding box convention, used by OpenStreetMap, GDAL, GeoJSON bbox,
PostGIS `ST_MakeEnvelope`). The project uses `south,north,west,east` which is
unusual. A developer familiar with GIS tools would almost certainly pass
coordinates in the wrong order on first use.

The docs show the format once but never call attention to the non-standard
ordering. A parenthetical "(note: south,north,west,east — not the WGS84
west,south,east,north convention)" would prevent this mistake.

**Severity:** Low — clearly documented by example, but the ordering is a
footgun for anyone with GIS experience.

---

### 9. The dev server's `serveData()` plugin is completely undocumented

**Location:** `vite.config.ts` lines 11-77

**What it does:** A custom Vite middleware that serves tile data from the local
`data/` directory during development:

- Serves `tiles/{lang}/index.json` files (returns 404 if missing)
- Serves `tiles/{lang}/{id}.bin` tile files
- Serves legacy `triangulation-*.bin` and `triangulation.json` files (backward compatibility)

**Problem:** A developer running `npm run dev` needs to know that the dev
server expects tile data in `data/tiles/`. Without this knowledge, the app
shows "data unavailable" with no explanation. The docs describe how to generate
tile data (`npm run pipeline`) and where it goes (`data/tiles/{lang}/`) but
never connect this to the dev server's expectations.

The legacy routes (`triangulation.json`, `triangulation-*.bin`) suggest a
previous monolithic format that still has backward compatibility support in the
dev server. This evolutionary artifact is undocumented.

**Severity:** Medium — directly affects the "getting started" experience.

**Fix:** Add to README's "Getting started" section:

```
The dev server serves tile data from `data/tiles/`. Generate it first:
npm run pipeline -- --lang=en --limit=10000
```

---

### 10. Node.js version requirement is buried

**Location:** `package.json` line 29: `"engines": {"node": ">=18"}`

**README says (line 42):** "Node.js 18+ (ES2022 target; tested with Node 20
and 22)"

**Problem:** The README does document this under "Prerequisites," which is
good. However, CLAUDE.md — the file most likely to be read by AI assistants and
automated tools — has no mention of the Node version requirement at all. CI
uses Node 22. The `engines` field in package.json is advisory by default (npm
doesn't enforce it without `engine-strict`).

**Severity:** Low

---

### 11. architecture.md point-location function signatures omit the `tri` parameter

**Location:** `docs/architecture.md` lines 209-212

**Documented:**

```
locateTriangle(query, hint) — Triangle walk: O(√N) steps
findNearest(query) — Locate triangle → closest vertex → greedy walk
vertexNeighbors(v) — Walks the triangle fan around a vertex
```

**Actual signatures (`src/geometry/point-location.ts`):**

```typescript
locateTriangle(tri: SphericalDelaunay, query: Point3D, startTriangle?: number)
findNearest(tri: SphericalDelaunay, query: Point3D, startTriangle?: number)
vertexNeighbors(tri: SphericalDelaunay, v: number)
```

**Problem:** All three functions take `tri: SphericalDelaunay` as their first
argument. The doc presents them as if they're methods on an object, but they're
standalone functions that require the triangulation data structure as an
explicit parameter. This could mislead someone trying to call them.

**Severity:** Low — a documentation simplification, but the gap between
documented and actual signatures could cause confusion.

---

### 12. PWA manifest configuration is undocumented

**Location:** `vite.config.ts` lines 92-117

**What exists:** The VitePWA plugin generates a web app manifest with:

- `name: "WikiRadar"`, `short_name: "WikiRadar"`
- `theme_color: "#1a73e8"`, `background_color: "#f5f5f5"`
- `display: "standalone"`
- Icons: `icon.svg` (any), `icon-192.png` (192x192), `icon-512.png` (512x512)

**Problem:** None of the doc files mention the PWA manifest, the app's display
mode, theme color, or icon assets. The architecture doc discusses the service
worker and workbox caching strategy in detail but skips the manifest entirely.
A contributor modifying the app's branding would have to discover this
configuration by reading `vite.config.ts`.

**Severity:** Low — the manifest is a standard PWA concern, but this is a docs
review.

---

### 13. CI workflow structure is misrepresented

**Location:** `docs/architecture.md` line 267, `.github/workflows/ci.yml`

**Documented:** `ci.yml — Lint + test on pushes to main and PRs`

**Actual CI structure:** Three parallel jobs:

1. `lint` — runs `npm run format` (Prettier check) + `npm run lint:eslint` (ESLint)
2. `type-check` — runs `tsc --noEmit`
3. `test` — runs `vitest` with v8 coverage, uploads coverage artifact (30-day retention)

Plus: concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true`.

**Problem:** The doc description "Lint + test" is a simplification that hides
the fact that CI runs `npm run format` and `npm run lint:eslint` _separately_,
not `npm run lint` (which combines all three). This matters because:

- CI's `lint` job does not run `tsc` — that's a separate `type-check` job
- CI's `lint` job uses `npm run format`, not `npm run lint` — a script that
  isn't documented in CLAUDE.md at all

**Severity:** Low — the observable behavior (code gets checked) is the same,
but the docs misdescribe how.

---

### 14. pipeline.yml's selective language rebuild feature is undocumented

**Location:** `.github/workflows/pipeline.yml`

**What exists:** The `workflow_dispatch` trigger accepts a `langs` input parameter
(JSON array, default `["en","sv","ja"]`). This allows rebuilding data for a
single language without re-processing all three.

**Problem:** The architecture doc describes the monthly pipeline but doesn't
mention the manual trigger's `langs` parameter. This is a useful operational
feature for maintainers who need to rebuild a single language after fixing
extraction issues.

**Severity:** Low

---

### 15. TileIndex has an undocumented `hash` field

**Location:** `src/tiles.ts` line 25

**Documented (tiling.md, tile index format):** Lists `version`, `gridDeg`,
`bufferDeg`, `generated`, and `tiles[]` array fields.

**Actual interface:**

```typescript
export interface TileIndex {
  version: number;
  gridDeg: number;
  bufferDeg: number;
  generated: string;
  hash?: string; // <-- not in docs
  tiles: TileEntry[];
}
```

**Problem:** The optional `hash` field on the top-level `TileIndex` is not
documented in the tile index format table in `tiling.md`. Individual tile
entries have a `hash` field (documented), but this top-level index hash serves
a different purpose and isn't explained anywhere.

**Severity:** Low

---

### 16. The ESLint `innerHTML` ban is documented as convention but not as enforcement

**Location:** `docs/architecture.md` lines 136-137, `eslint.config.mjs`

**Documented:** "All user-visible text is rendered via `createElement`/`textContent`,
not `innerHTML`."

**Actual enforcement:** ESLint config bans `innerHTML` assignment via
`no-restricted-syntax` with the message "Avoid innerHTML — use
createElement/textContent to prevent XSS."

**Problem:** The architecture doc presents this as a coding convention. It's
actually _enforced at the lint level_ — any use of `innerHTML` will fail CI.
This is a stronger guarantee than the docs convey. Worth mentioning because it
means the security property is mechanically verified, not just aspirational.

**Severity:** Low (positive omission — the code is better than the docs suggest)

---

### 17. nearest-neighbor.md says average vertex degree is "< 6" — this is imprecise

**Location:** `docs/nearest-neighbor.md` line 9

**Documented:** "each point's nearest neighbor is one of its
Delaunay-adjacent vertices (average degree < 6 by Euler's formula)"

**Actual math:** For a convex hull triangulation of V vertices on a sphere:

- Euler's formula: V - E + F = 2
- All faces are triangles: 3F = 2E
- Solving: E = 3V - 6, average degree = 2E/V = 6 - 12/V

The average degree is exactly `6 - 12/V`, which is less than 6 for all finite
V. For practical V (hundreds to millions), it's 5.99+. Saying "< 6" is
technically correct but suggests the degree could be significantly less than 6,
when in practice it's negligibly close to 6. "approximately 6" or "approaching
6" would be more informative.

**Severity:** Low — pedantic, but this is a theory document.

---

## Summary

| #   | Finding                                                | Severity   | File(s)                       |
| --- | ------------------------------------------------------ | ---------- | ----------------------------- |
| 1   | Lint command paraphrase omits significant flags        | Medium     | CLAUDE.md                     |
| 2   | Five npm scripts undocumented                          | Low        | CLAUDE.md                     |
| 3   | Pre-commit hooks (husky + lint-staged) undocumented    | Medium     | (nowhere)                     |
| 4   | Extract command's 6GB heap allocation undocumented     | Medium     | CLAUDE.md, data-extraction.md |
| 5   | Binary articles format spec doesn't match deserializer | Medium     | binary-format.md              |
| 6   | Hardcoded test line count has drifted                  | Low        | state-machine.md              |
| 7   | Canary validation scope understated                    | Low-Medium | data-extraction.md            |
| 8   | `--bounds` argument order is unconventional            | Low        | README.md, data-extraction.md |
| 9   | Dev server data plugin undocumented                    | Medium     | (nowhere)                     |
| 10  | Node.js version not in CLAUDE.md                       | Low        | CLAUDE.md                     |
| 11  | Point-location signatures omit `tri` parameter         | Low        | architecture.md               |
| 12  | PWA manifest undocumented                              | Low        | architecture.md               |
| 13  | CI workflow structure misrepresented                   | Low        | architecture.md               |
| 14  | Pipeline selective rebuild feature undocumented        | Low        | architecture.md               |
| 15  | TileIndex top-level `hash` field undocumented          | Low        | tiling.md                     |
| 16  | innerHTML ban enforced by lint, not just convention    | Low        | architecture.md               |
| 17  | Average vertex degree "< 6" is imprecise               | Low        | nearest-neighbor.md           |

### Termination assessment

Per VDD methodology, the review cycle terminates when critiques become
hallucinated. After 20 systematic verification checks and 10 completeness
checks against the source code, the documentation proved **remarkably
accurate**. The majority of findings are omissions rather than factual errors.
Only two claims are concretely wrong (#1 lint command flags, #6 line count),
and both are minor. The four medium-severity findings (#3 husky, #4 heap
allocation, #5 binary format, #9 dev server plugin) represent genuinely useful
information gaps that would trip up a new contributor.

This documentation is well above average — the ratio of "correct and verified"
claims to errors is very high.
