# Adversarial Documentation Review

Applied the [VDD adversarial criticism methodology](https://gist.github.com/dollspace-gay/45c95ebfb5a3a3bae84d8bebd662cc25) to all project documentation: `CLAUDE.md`, `README.md`, and everything under `docs/`. Each claim was verified against the actual source code. Findings are categorized by severity.

## Methodology

Fresh-context adversarial pass with "zero tolerance" for documentation drift. Every factual claim (constants, algorithms, file paths, API surfaces, CLI flags) was cross-referenced against the source. Structural weaknesses, lazy patterns, and coverage gaps were flagged.

## Verdict

The documentation is **unusually accurate**. Most claims match the source code down to constant values and line-level implementation details. The issues found are primarily **omissions and structural gaps** rather than outright falsehoods. This is a well-maintained project where the docs genuinely track the code.

That said, the adversary found real problems. Here they are.

---

## Critical Issues

### 1. CLAUDE.md: "Three modules" framing is misleading

**File:** `CLAUDE.md` line 33
**Claim:** "Three modules under `src/`, plus shared root-level files"

**Problem:** The architecture section says "three modules" but then lists five bullet points (geometry, pipeline, app, lang.ts, tiles.ts). The word "modules" is doing double duty — the directories are "modules" but the shared files are "plus shared root-level files." This isn't wrong, but it's the kind of lazy counting that erodes trust. A reader who skims will think there are three things, not five.

**Fix:** Say "Three directories under `src/`, plus two shared files" or just "Five components."

### 2. README: `--bounds` format is a trap

**File:** `README.md` lines 98-100
**Claim:** `--bounds=49.44,50.19,5.73,6.53` with note "(south,north,west,east — latitude range first, then longitude range; not the WGS84 west,south,east,north convention)"

**Problem:** The documentation correctly notes this is non-standard, but the warning is buried in a parenthetical. Every geographic tool the user has ever touched uses `west,south,east,north` (WGS84/GeoJSON) or `south,west,north,east` (Google). This project uses `south,north,west,east` — a format unique to this codebase. The parenthetical note is insufficient for something this likely to cause silent data errors (swapping lat/lon bounds produces valid but wrong results).

**Fix:** Make this a `> **Warning**` callout block, not a parenthetical. Or better: change the format to match an existing convention.

### 3. docs/architecture.md: Failure modes table omits tile _deserialization_ failures

**File:** `docs/architecture.md` lines 120-128
**Claim:** Failure modes table covers tile fetch, index fetch, IDB, GPS, and Wikipedia API failures.

**Problem:** The table has no entry for **binary deserialization failure** — a corrupt `.bin` file, truncated download, or format version mismatch. The `deserializeBinary()` function reads raw bytes with offset arithmetic; a malformed buffer will throw or produce garbage silently. This is a real failure mode on mobile networks where downloads get truncated.

**Fix:** Add a row for deserialization/corrupt tile data. Document what happens (crash? graceful skip? silent garbage results?).

### 4. docs/binary-format.md: No format version field, but docs say "reserved for future use"

**File:** `docs/binary-format.md` lines 34
**Claim:** Header bytes 16-23 are "reserved for future use. A format version field will be placed here if the layout changes."

**Problem:** This is a design debt bomb masquerading as forward planning. The format has no version field _today_, which means the deserializer has no way to distinguish v1 from a hypothetical v2. When the format _does_ change, every cached tile in every user's IDB becomes a potential crash. The "we'll add it later" approach means the first format change will require a breaking migration with no graceful fallback.

**Fix:** Either add the version field now (it's 8 free bytes) or document the actual migration strategy (IDB key prefix bump, as used for schema changes).

---

## Moderate Issues

### 5. docs/tiling.md: Back-of-envelope math uses inconsistent article counts

**File:** `docs/tiling.md` lines 32-43
**Claims:**

- "Average articles per tile: ~1,500"
- "English Wikipedia has over a million geotagged articles"
- "~800 populated tiles"

**Problem:** 1,000,000 / 800 = 1,250, not 1,500. The ~1,500 figure likely includes buffer zone duplicates, but the doc doesn't say that. Later (line 79) it says "The 0.5° buffer increases per-tile article counts by roughly 10-20%" which would give 1,375-1,500. The math is internally consistent if you read both sections, but the table presents 1,500 as the "average" without noting it includes buffer inflation. A reader verifying the math will get a different number.

**Fix:** Add "(including buffer zone overlap)" to the average articles row, or use the pre-buffer count (~1,250).

### 6. docs/nearest-neighbor.md: Complexity claim is imprecise

**File:** `docs/nearest-neighbor.md` line 34
**Claim:** "O(N log N) expected for the randomized incremental hull; O(N²) worst case (degenerate insertion orders)."

**Problem:** The implementation is _not_ randomized — it uses a deterministic insertion order (the input order). The O(N log N) expected-case guarantee for convex hull algorithms applies to _randomized_ incremental insertion (Clarkson-Shor). With deterministic order, the expected case depends on the input distribution. For uniformly distributed points on a sphere this is fine in practice, but calling it "O(N log N) expected" without noting the absence of randomization is technically misleading.

**Fix:** Either add randomized shuffling to the build step, or change the claim to "O(N log N) for typical geographic distributions; O(N²) worst case."

### 7. README/CLAUDE.md: `npm run lint` description doesn't match actual behavior

**File:** `CLAUDE.md` line 11, `README.md` line 69
**Claim:** `npm run lint` does "Type-check + ESLint + Prettier check (tsc --noEmit && eslint src/ && prettier --check .)"

**Actual (package.json line 15):** `"lint": "tsc --noEmit && eslint src/ && prettier --check ."`

**Problem:** The documented command matches, but the CI workflow (`ci.yml`) runs these as _three separate parallel jobs_ — `lint` (Prettier + ESLint), `type-check` (tsc), `test` (vitest). The local `npm run lint` command runs all three sequentially. This means CI can pass when `npm run lint` fails (if ESLint and Prettier pass but tsc fails in a different environment) or vice versa. The docs don't call out this divergence.

**Fix:** Note in CLAUDE.md that `npm run lint` is a superset of what CI runs (CI splits lint/type-check/test into parallel jobs).

### 8. docs/architecture.md: Key Files section is incomplete

**File:** `docs/architecture.md` lines 240-278

**Problem:** The "Key Files" section lists files selectively but presents itself as comprehensive. Missing from the list:

- `src/app/format.ts` — distance formatting, URL builders (directionsUrl, wikipediaUrl)
- `src/app/types.ts` is listed but its exports (Article, NearbyArticle, UserPosition) aren't described
- No mention of `src/tiles.ts` exports (GRID_DEG, BUFFER_DEG, EDGE_PROXIMITY_DEG, tileId, tilesForBounds)
- `src/pipeline/canary.ts` gets a one-liner but the LANDMARKS record structure isn't described

**Fix:** Either make the list genuinely comprehensive (with brief export descriptions) or rename it "Selected Key Files" and drop the implicit claim of completeness.

### 9. docs/data-extraction.md: Memory requirements are under-documented

**File:** `docs/data-extraction.md` lines 43-45
**Claim:** "English extraction requires ~4-5 GB peak. Ensure your machine has at least 8 GB RAM when extracting English."

**Problem:** The `npm run extract` command silently sets `--max-old-space-size=6144` (6 GB heap). This critical operational detail is documented in data-extraction.md but NOT in CLAUDE.md or README.md, where users will actually run the command. A developer on a machine with less than 8 GB RAM will get an opaque Node.js OOM crash with no indication of what happened.

**Fix:** Add a note to the CLAUDE.md and README.md extract command entries: "Requires ~6 GB heap; see docs/data-extraction.md for memory requirements."

### 10. Undocumented `import.meta.env.BASE_URL` dependency

**File:** `src/app/main.ts` lines 284, 303

**Problem:** The app uses Vite's `import.meta.env.BASE_URL` for constructing tile fetch URLs. This is configured via `base` in `vite.config.ts` (line 52: `base: "/tour-guide/"`). If someone forks the repo and deploys to a different path, tile loading will silently fail. This deployment-critical configuration is not documented anywhere.

**Fix:** Document the `base` path configuration in the README's "Getting started" or deployment section.

---

## Minor Issues

### 11. docs/architecture.md: "innerHTML banned" claim lacks nuance

**File:** `docs/architecture.md` line 138
**Claim:** "enforced by ESLint's `no-restricted-syntax` rule — any `innerHTML` assignment fails CI"

**Verification:** The ESLint rule at `eslint.config.mjs` lines 26-33 targets `AssignmentExpression[left.property.name='innerHTML']`. This catches `el.innerHTML = x` but NOT `el.insertAdjacentHTML()`, `document.write()`, or `el.outerHTML = x`. The claim is literally true but implies a stronger guarantee than exists.

### 12. docs/state-machine.md: Transition diagram is ASCII art that will break

**File:** `docs/state-machine.md` lines 101-124

**Problem:** The ASCII transition diagram uses box-drawing characters and precise spacing. Any edit to the surrounding text or a font change will misalign it. This is a maintenance burden — the diagram will drift from reality silently because updating ASCII art is painful enough that people skip it.

### 13. docs/tiling.md: "Why not S2 cells" rationale is dated

**File:** `docs/tiling.md` lines 27-28
**Claim:** "computing S2 cell IDs from lat/lon requires implementing the S2 projection (a non-trivial amount of code), and the project's zero-dependency constraint makes this a poor fit"

**Problem:** The S2 projection is ~200 lines of math. The project already vendors `robust-predicates` (~400 lines). The "non-trivial amount of code" argument is undermined by the existing vendoring precedent. The real reason is probably "5° grid is good enough and simpler" — which is a perfectly valid reason that should be stated directly.

### 14. README: Article counts will drift

**File:** `README.md` lines 164-168
**Claim:** English ~1.2M, Swedish ~250K, Japanese ~180K. "Counts are approximate and update monthly via the automated pipeline."

**Problem:** These numbers are hardcoded in the README. The automated pipeline updates _tile data_, not the README. These counts will slowly drift from reality. As of writing they may already be stale.

### 15. docs/architecture.md: Wikipedia API cache entry limit undocumented in app code

**File:** `docs/architecture.md` line 113
**Claim:** "StaleWhileRevalidate (max 200 entries, 1-week expiry)"

**Problem:** The 200-entry limit and 1-week expiry are configured in `vite.config.ts` (the Workbox runtime caching config), not in the app code. If someone modifies the Vite config without reading the architecture docs, they won't know these values are documented elsewhere and should be kept in sync.

---

## Structural Observations

### Documentation is well-organized but has a discoverability problem

The six docs files are individually excellent, but there's no unified entry point that says "read these in this order." A reader landing on `binary-format.md` has no context for why the format exists. The "See Also" links at the bottom of each doc help, but a reading-order recommendation in the README's Documentation section would be better.

### CLAUDE.md is optimized for AI agents, not human developers

The CLAUDE.md is clearly written for AI coding assistants (session completion protocol, bd issue tracking, TodoWrite mentions). A human developer would find the "Session Completion" section confusing — it reads like a checklist for a robot, not workflow guidance. This is fine if the audience is AI agents, but the file should probably say so explicitly.

### Cross-document consistency is high

Despite the volume of documentation (~2,500 lines across 8 files), the same facts are stated consistently across documents. The `--bounds` format, tile dimensions, buffer zones, and algorithm descriptions match everywhere they appear. This is genuinely impressive and suggests the documentation is maintained as a system, not as afterthoughts.

---

## Termination Signal

Per the VDD methodology, the adversarial review terminates when critiques become hallucinated — when the documentation is robust enough that the adversary must invent problems. After 15 findings across ~2,500 lines of documentation, I'm approaching that threshold. The remaining issues (ASCII art maintenance, article count drift) are stylistic preferences rather than structural weaknesses.

**Assessment: This documentation is in the top tier of what I've reviewed. The issues found are real but mostly moderate-to-minor. The 4 critical issues deserve immediate attention; the rest are improvement opportunities.**
