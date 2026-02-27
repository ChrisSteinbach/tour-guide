# Adversarial Documentation Review — Pass 2

Second-pass review using the Verification-Driven Development (VDD) adversarial criticism methodology. Every claim in the project's documentation (`docs/`, `README.md`, `CLAUDE.md`, `LICENSE`) was verified against the actual source code. This review supersedes the previous pass, which was itself found to be stale.

**Scope:** `docs/architecture.md`, `docs/binary-format.md`, `docs/data-extraction.md`, `docs/nearest-neighbor.md`, `docs/tiling.md`, `README.md`, `CLAUDE.md`, `LICENSE`

**Method:** All factual claims (file paths, function names, constants, algorithms, data formats, performance numbers) were cross-referenced against source code. Each issue was verified to be a genuine defect, not a hallucination.

---

## Severity Levels

- **CRITICAL** — Factually wrong; will cause real confusion or failure
- **HIGH** — Misleading or internally contradictory content
- **MEDIUM** — Incomplete, unverifiable, or will rot without maintenance
- **LOW** — Minor imprecision or style nits

---

## Previous Review Status

The first-pass adversarial review (24 issues) led to substantial fixes. **19 of 24 issues were resolved.** The following were addressed: Node.js version documentation (#1), monolithic table labeling (#2), dead issue tracker reference (#3), code example return type (#4), "zero-copy" precision (#5), "120 MB" contextualization (#6), extraction timing qualification (#7), Swedish/Japanese article counts (#8), linear scan statistic softening (#9), failure mode documentation (#10), browser compatibility (#11), security/privacy documentation (#12), extraction step deduplication (#14), language addition guide (#16), "auto-update mode" expansion (#17), bandwidth assumptions sourcing (#18), Last-Modified reference removal (#20), forward-compatibility speculation removal (#21), chord distance clamping mention (#22), copyright year (#23), and quality gate failure recovery (#24).

**5 issues remain** from the original review. **3 new issues** were found. Total open: **8 issues.**

---

## CRITICAL

### 1. tiling.md tile example coordinates are mathematically wrong

`tiling.md:13` — The descriptive text for the tile ID example is factually incorrect:

> Tile IDs use zero-padded row and column indices: `"14-38"` for row 14, column 38 (corresponding to 70°N-75°N, 190°-195° remapped as -170° to -165°).

By the formula defined two lines below (`row = floor((lat + 90) / 5)`, `col = floor((lon + 180) / 5)`):

- Row 14: south = 14 × 5 − 90 = **−20°** (20°S), north = **−15°** (15°S)
- Col 38: west = 38 × 5 − 180 = **10°** (10°E), east = **15°** (15°E)

That's somewhere in southern Africa/Zambia — not the Arctic. The JSON example at `tiling.md:115-121` correctly shows `south: -20, north: -15, west: 10, east: 15`, so the formula and the example agree with each other but the descriptive text contradicts both.

A reader who trusts the prose over the formula will have a completely wrong mental model of the coordinate system.

**File:** `docs/tiling.md:13`

**Fix:** Replace the parenthetical with `(corresponding to 20°S–15°S, 10°E–15°E)` or pick a more recognizable tile as the example (e.g. tile `27-36` for Paris).

---

## HIGH

### 2. The in-memory cache is not "cleared on navigation"

`architecture.md:147` states:

> Three independent cache layers: IDB (tile data, survives reload), in-memory LRU (article summaries, **cleared on navigation**), and Workbox runtime cache

The wiki-api.ts cache is a module-scope `Map<string, ArticleSummary>` with `MAX_CACHE_SIZE = 100` (`wiki-api.ts:22-27`). It implements LRU via insertion-order eviction. However, there is no code anywhere that clears this cache on navigation — not in `main.ts`, not in `detail.ts`, not in the state machine. The Map persists for the lifetime of the page. It's only cleared on a full page reload (module re-evaluation), which is not "navigation" in any PWA sense.

"Cleared on navigation" implies an intentional cache invalidation strategy that doesn't exist. This could mislead someone debugging cache behavior or estimating memory usage.

**File:** `docs/architecture.md:147`

**Fix:** Replace "cleared on navigation" with "cleared on page reload" or just "session-scoped."

---

## MEDIUM

### 3. README claims "npm 9+" but nothing enforces it

`README.md:41` lists `npm 9+` as a prerequisite. The `package.json` engines field specifies `"node": ">=18"` but has no `npm` constraint. A developer on Node 18 with npm 8 (which ships with Node 18.0–18.16) would satisfy the engines check but violate the README's stated requirement. If npm 9+ is genuinely needed (e.g. for lockfile format or `--install-strategy`), it should be in `engines`. If it isn't needed, the README is overstating requirements.

**Files:** `README.md:41`, `package.json:27-29`

**Fix:** Either add `"npm": ">=9"` to the `engines` field, or remove the npm version from the README prerequisites.

### 4. "~0.06%" linear scan figure persists in source, contradicts docs

The first-pass review correctly noted the unmeasured `~0.06%` statistic. The docs were updated — `nearest-neighbor.md:28` now says "rare, typically <1% of points." But the source code comment in `convex-hull.ts:483-484` still says:

> rare points (~0.06%) where walk, grid, and BFS all fail

A developer reading the code sees a precise statistic (0.06%). A developer reading the docs sees a vague bound (<1%). These are compatible but inconsistent — one implies measurement, the other admits uncertainty. If the number was never measured, the code comment is worse than the doc because it has the authority of being "closest to the implementation."

**Files:** `docs/nearest-neighbor.md:28`, `src/geometry/convex-hull.ts:483`

**Fix:** Either instrument the code to measure the actual fallback rate and use the real number everywhere, or soften the code comment to match the docs.

### 5. ~1.2M article count duplicated across 5 files

The string "~1.2M" or equivalent appears in `README.md`, `architecture.md`, `binary-format.md`, `data-extraction.md`, and `tiling.md`. English Wikipedia gains ~50K geotagged articles per year. After one pipeline run produces a different count, five files become stale. This is a DRY violation in documentation that guarantees future inconsistency.

**Files:** `README.md:5`, `architecture.md:3`, `binary-format.md:79`, `data-extraction.md:65`, `tiling.md:32`

**Fix:** Use the exact number in one authoritative place (e.g. `data-extraction.md`). In other docs, say "over a million" or "see data-extraction.md for current counts."

### 6. Binary format documented in two places with drift risk

`architecture.md:50-70` contains a full binary format specification (header layout, section order, all field types and sizes). `binary-format.md` contains the same specification with more detail. Two sources of truth means two places to maintain and two places that can diverge. The architecture doc's version has already silently drifted once (the first-pass review caught a missing forward-compatibility note, which was since removed from both — but only by coincidence).

**Files:** `docs/architecture.md:50-70`, `docs/binary-format.md`

**Fix:** Reduce the architecture doc's binary format section to a 2-sentence summary with a link: "See [binary-format.md](binary-format.md) for the byte-level specification."

---

## LOW

### 7. Key Files inventory is a manual maintenance burden

`architecture.md:244-284` — A 40-line manually maintained file listing. Every file addition, deletion, or rename requires updating this list. The current list is accurate (all 28 files verified), but this is the kind of section that silently rots. No CI check validates it. One missed rename and it becomes misleading.

**File:** `docs/architecture.md:244-284`

**Fix:** Either remove it (IDE navigation and `find src -name '*.ts'` are sufficient), add a CI check that validates it, or add a note that it may be stale.

### 8. README dev server URL omits network access context

`README.md:34` says the dev server starts at `https://localhost:5173/`. The vite config binds `0.0.0.0` (`vite.config.ts:83`), meaning the server is accessible on the local network — which is the entire point (the CLAUDE.md says "binds 0.0.0.0 for phone testing"). But the README URL only mentions localhost. A developer trying to test on their phone would need to know to use their machine's IP address, which isn't mentioned.

**File:** `README.md:34`

**Fix:** Add a note: "Access from other devices on your network using `https://<your-ip>:5173/`."

---

## Summary

| #   | Severity | Issue                                             | File(s)                             |
| --- | -------- | ------------------------------------------------- | ----------------------------------- |
| 1   | CRITICAL | Tile example coordinates are mathematically wrong | tiling.md                           |
| 2   | HIGH     | Cache "cleared on navigation" claim is false      | architecture.md                     |
| 3   | MEDIUM   | npm 9+ stated but unenforced                      | README.md, package.json             |
| 4   | MEDIUM   | 0.06% code comment contradicts "<1%" in docs      | convex-hull.ts, nearest-neighbor.md |
| 5   | MEDIUM   | ~1.2M article count duplicated in 5 files         | Multiple                            |
| 6   | MEDIUM   | Binary format spec duplicated in 2 files          | architecture.md, binary-format.md   |
| 7   | LOW      | Key Files section is manual maintenance burden    | architecture.md                     |
| 8   | LOW      | Dev server URL omits network access info          | README.md                           |

**Scorecard:** 1 critical, 1 high, 4 medium, 2 low across 7 files.

**Verdict:** The documentation is in good shape after the first-pass fixes — 19 of 24 original issues were resolved, demonstrating that the VDD adversarial loop works. The remaining 8 issues are real but increasingly minor. The one critical issue (wrong coordinates in tiling.md) is a genuine factual error that will confuse anyone reading the tiling strategy. The rest are maintenance hygiene. The documentation is approaching Zero-Slop status; one more fix cycle targeting the critical and high issues would likely get there.
