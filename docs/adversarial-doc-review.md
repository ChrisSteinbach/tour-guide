# Adversarial Documentation Review

Review conducted using the Verification-Driven Development (VDD) adversarial criticism methodology. Every claim in the project's documentation (`docs/`, `README.md`, `CLAUDE.md`, `LICENSE`) was verified against the actual source code with zero tolerance for inaccuracy, staleness, vagueness, or gaps.

**Scope:** `docs/architecture.md`, `docs/binary-format.md`, `docs/data-extraction.md`, `docs/nearest-neighbor.md`, `docs/tiling.md`, `README.md`, `CLAUDE.md`, `LICENSE`

---

## Severity Levels

- **CRITICAL** — Factually wrong or will cause real confusion/failure
- **HIGH** — Stale or misleading content that contradicts the codebase
- **MEDIUM** — Vague, unverified, or incomplete in ways that matter
- **LOW** — Minor imprecision or style issues

---

## CRITICAL

### 1. No Node.js version documented anywhere

No `.nvmrc`, no `engines` field in `package.json`, no mention in `README.md` or `CLAUDE.md`. The project uses `tsx`, ESNext modules, and modern TypeScript. A developer cloning this repo has zero guidance on what Node version to use. If they use Node 14 or 16, it will fail silently or with cryptic errors.

**Files:** `README.md`, `CLAUDE.md`, `package.json`

**Fix:** Add `"engines": { "node": ">=18" }` to `package.json`, create `.nvmrc`, and mention Node version in README's "Getting started" section.

---

## HIGH

### 2. tiling.md summary table references a monolithic system that no longer exists

`tiling.md:235-243` — The "Current vs Tiled" comparison table has a "Current" column describing a monolithic ~120 MB single-file system. But the monolithic code path was removed. Evidence: `src/app/idb.test.ts:116` explicitly comments `"triangulation-v3-en", // old (monolithic removed)"`. The pipeline only produces tiled output. There is no monolithic code path anywhere in the codebase.

This table reads like transition-era design documentation that was never updated after the tiling implementation landed. A reader encountering this table will think two code paths exist when only one does.

**File:** `docs/tiling.md`

**Fix:** Relabel "Current" as "Before tiling (historical)" or remove the column entirely and just document the tiled system's properties.

### 3. tiling.md references a non-existent issue tracker ID

`tiling.md:143` — "This aligns with the existing issue tour-guide-5du (replacing Last-Modified with content hashes)." This is internal project jargon leaking into documentation. The string `tour-guide-5du` appears nowhere else in the codebase. A reader cannot look this up. It's a dead reference that adds no value and suggests the doc was written in a planning context that was never cleaned up.

**File:** `docs/tiling.md`

**Fix:** Remove the issue reference or replace with a sentence explaining the design rationale inline.

### 4. tiling.md code example has wrong return type

`tiling.md:170` — The `mergedFindNearest` function signature shows `): QueryResult[]` as the return type. But `NearestQuery.findNearest()` in `src/app/query.ts:178-183` actually returns `{ results: QueryResult[]; lastTriangle: number }`. The example code would need to destructure the return value, e.g. `t.findNearest(lat, lon, k).results`, not use the return directly. As written, the example silently misrepresents the API.

**File:** `docs/tiling.md`

**Fix:** Update the example to use `.results` or show the full destructured type.

### 5. "zero-copy deserialization" claim is half-false

`architecture.md:79` says: "typed array views enable zero-copy deserialization in the browser." `architecture.md:222` says: "Uint32 sections use zero-copy typed array views directly into the ArrayBuffer."

The Uint32 part is true — those are genuine views into the buffer. But the Float32 vertex data is explicitly copied into a Float64Array via a for-loop (`serialization.ts:291-295`). For ~1,500-vertex tiles, the vertex section is the largest numeric section (~18 KB of the ~64 bytes/article numeric budget). Calling the overall process "zero-copy" when the largest section by bytes is copied is misleading.

Credit: `binary-format.md:87` is honest about this — "Uint32 sections are zero-copy views into the original buffer. Float32 vertex data is copied into a Float64Array." The other docs should match this precision.

**Files:** `docs/architecture.md`

**Fix:** Replace "zero-copy deserialization" with "near-zero-copy deserialization (Uint32 sections are direct views; Float32 vertices are copied to Float64 for numerical stability)."

---

## MEDIUM

### 6. binary-format.md "120 MB" figure is contextually misleading

`binary-format.md:81` — "the English Wikipedia dataset (~1.2M articles) produces a file around 120 MB." In the current tiled system, no single 120 MB file exists. There are ~800 tile files totaling ~138 MB (per `tiling.md:242`). A reader of binary-format.md would reasonably conclude a 120 MB blob is produced somewhere. It isn't.

**File:** `docs/binary-format.md`

**Fix:** Clarify: "For reference, encoding all ~1.2M English articles in a single file would produce ~120 MB. The tiled system produces ~800 smaller files totaling ~138 MB (1.15x larger due to buffer overlap)."

### 7. "~10 minutes for English" extraction time is unqualified

`data-extraction.md:7` — "fast (~10 minutes for English)." On what hardware? With what network speed for the initial download? This number will rot. There is no timing instrumentation in the extraction code, no CI step that reports duration. It's a hand-wavy estimate presented as fact.

**File:** `docs/data-extraction.md`

**Fix:** Either remove the specific number, qualify it ("~10 minutes on a modern laptop after dumps are cached locally"), or add timing instrumentation to the pipeline.

### 8. README article counts for Swedish and Japanese are "varies"

`README.md:133-134` — The supported languages table shows "varies" for Swedish and Japanese. This is placeholder text that was never filled in. "Varies" based on what? The dump date? The phase of the moon? Every other number in this documentation suite is specific. These two cells stick out as laziness.

**File:** `README.md`

**Fix:** Run the extraction for sv and ja, report actual numbers (even approximate), or explain the variance: "Depends on dump date; typically ~250K for sv, ~180K for ja."

### 9. "~0.06% of points" linear scan statistic is unmeasured

`nearest-neighbor.md:28` — "linear scan (~0.06% of points)." The same number appears as a comment in `convex-hull.ts:482-484`. But there is no logging, counter, or test that measures this. It's a claim presented as empirical fact with no supporting evidence. If this statistic is wrong by an order of magnitude, the performance story changes.

**File:** `docs/nearest-neighbor.md`

**Fix:** Either add instrumentation to measure and log the actual fallback rate, or soften the language: "linear scan (rare, estimated <1% of points)."

### 10. No error handling or failure mode documentation

The docs thoroughly cover the happy path but are silent on failure modes:

- What happens when GPS permission is denied?
- What happens when the user is offline with no cached tiles?
- What happens when a tile fetch fails mid-session?
- What happens when IDB is full (QuotaExceededError)?
- What happens when the Wikipedia REST API returns an error?

The code handles these cases (there's a `status.ts` for error screens, IDB tests for QuotaExceededError), but the documentation pretends failures don't exist. For a PWA that runs on flaky mobile networks, this is a significant gap.

**Files:** `docs/architecture.md`, `README.md`

**Fix:** Add an "Error handling" or "Failure modes" section to `architecture.md` documenting the degradation strategy.

### 11. No browser compatibility documented

The app uses IndexedDB, Service Workers, Geolocation API, CSS features, and ES2022+ JavaScript. Not a single document mentions which browsers are supported. Is IE11 out? Is Safari supported (its IDB implementation has known quirks)? Does the SW work in Firefox?

**Files:** `README.md`, `docs/architecture.md`

**Fix:** Add a "Browser support" section to README listing minimum browser versions.

### 12. No security or privacy considerations

The app:

- Collects GPS coordinates
- Fetches data from Wikipedia's REST API (third-party origin)
- Stores data in IDB
- Runs a service worker

There is zero documentation on:

- Content Security Policy
- CORS handling for Wikipedia API requests
- What GPS data is stored or transmitted
- Privacy implications of location tracking
- XSS risk from Wikipedia API response content

The code appears to use safe DOM methods (createElement/textContent rather than innerHTML), which is good, but this is undocumented. A security reviewer would have to read every line of rendering code to verify.

**Files:** `README.md`, `docs/architecture.md`

**Fix:** Add a "Security" section covering CSP, CORS, DOM rendering safety, and a "Privacy" note explaining that GPS data stays on-device.

### 13. ~1.2M articles figure is duplicated in five files

The string "~1.2M" (or "1.2M" or "1,200,000") appears in: `architecture.md`, `binary-format.md`, `data-extraction.md`, `tiling.md`, and `README.md`. When the English Wikipedia dataset grows (it will — it grows by ~50K articles/year), five files need updating. This is a DRY violation in documentation that guarantees future inconsistency.

**Files:** All five listed above

**Fix:** Define the canonical number in one place (e.g., `data-extraction.md`) and have other docs reference it or use vaguer language ("over a million").

### 14. Extraction steps described twice with drift risk

`architecture.md:33-40` and `data-extraction.md:28-33` both describe the extraction steps. The architecture doc lists 4 steps; the extraction doc lists 6 (adding deduplication and canary validation). A reader comparing them would wonder which is authoritative. This will drift over time.

**Files:** `docs/architecture.md`, `docs/data-extraction.md`

**Fix:** Have `architecture.md` provide a one-sentence summary and link to `data-extraction.md` as the authoritative source, rather than duplicating the step list.

### 15. Binary format described in two places

`architecture.md:59-79` contains a full binary format specification. `binary-format.md` contains the same specification with more detail. Two places to maintain, two places that can diverge. The architecture doc's version already diverges slightly (it doesn't mention the forward-compatibility note about `[title, description]` tuples).

**Files:** `docs/architecture.md`, `docs/binary-format.md`

**Fix:** Reduce the architecture doc's binary format section to a brief summary and link to `binary-format.md`.

### 16. No guide for adding a new language

Three languages are supported. The lang list lives in `src/lang.ts`. But there's no documentation on how to add a fourth language. What dump URL patterns change? Do CI workflows need updating? Are there any language-specific parsing considerations (e.g., CJK title encoding)?

**Files:** `docs/data-extraction.md`, `README.md`

**Fix:** Add a "Adding a new language" section to `data-extraction.md`.

---

## LOW

### 17. "auto-update mode" is unexplained jargon

`architecture.md:87` — "Register service worker (auto-update mode)." This maps to `registerType: "autoUpdate"` in `vite.config.ts:93`, a vite-plugin-pwa concept meaning updates install silently without user interaction. A reader unfamiliar with Workbox/vite-plugin-pwa terminology won't know what this means.

**File:** `docs/architecture.md`

**Fix:** Expand: "Register service worker (auto-update: new versions install silently without prompting the user)."

### 18. Performance estimates use unsourced bandwidth assumptions

`tiling.md:47-51` assumes 4G = 10 Mbps and 3G = 1 Mbps. These are reasonable conservative estimates, but they're presented as self-evident truth with no source. The resulting load time calculations (0.3s, 0.9s, 8s) inherit this uncertainty.

**File:** `docs/tiling.md`

**Fix:** Add a footnote: "Bandwidth estimates are conservative approximations; actual performance varies by carrier, congestion, and device."

### 19. architecture.md Key Files section is a maintenance burden

`architecture.md:224-266` — A 42-line manually maintained file inventory. Every file addition, deletion, or rename requires updating this list. It's already tight (the verification found all files exist), but this is the kind of section that silently rots.

**File:** `docs/architecture.md`

**Fix:** Consider whether this adds value over IDE navigation. If kept, add a note: "Run `find src -name '*.ts' | sort` to verify this list is current."

### 20. tiling.md still references "the current Last-Modified header approach"

`tiling.md:143` — "The content hash replaces the current `Last-Modified` header approach." This reads as transition-era documentation. Is there still a Last-Modified approach being replaced, or has it already been replaced? The use of present tense ("replaces") suggests the transition hasn't happened, but the tiled system is already live.

**File:** `docs/tiling.md`

**Fix:** Update to past tense if the transition is complete, or remove the comparison entirely.

### 21. binary-format.md documents speculative forward-compatibility

`binary-format.md:66` — "Note: the deserializer also accepts `[title, description]` tuples for forward-compatibility, but the current serializer only writes plain strings." Documenting features that don't exist yet (and may never exist) adds noise. If someone reads this, they might try to use the tuple format and waste time figuring out why it doesn't round-trip through the serializer.

**File:** `docs/binary-format.md`

**Fix:** Remove or move to a code comment. Documentation should describe what is, not what might be.

### 22. Chord distance formula notation inconsistency

`nearest-neighbor.md:62` writes the chord distance as `2 * asin(||v - q|| / 2)`. `architecture.md:114` writes it as `2 * asin(||v - q|| / 2)`. But the actual code in `query.ts:64` computes it as `2 * Math.asin(chord < 2 ? chord / 2 : 1)` where `chord` is the Euclidean distance. The docs omit the clamping guard (`chord < 2 ? ... : 1`), which is a meaningful numerical safety measure, not just an implementation detail.

**Files:** `docs/nearest-neighbor.md`, `docs/architecture.md`

**Fix:** Mention the clamping, or at least note that the implementation includes numerical guards not shown in the formula.

### 23. LICENSE copyright year

`LICENSE:3` — "Copyright (c) 2025 Chris Steinbach." The current date is 2026. Copyright dates indicate first publication, so 2025 is correct if that's when the project was first published. Not an error, but worth a conscious check: does the copyright need to cover 2026 as well (e.g., "2025-2026")?

**File:** `LICENSE`

**Fix:** No action required if 2025 is the year of first publication. Consider "2025-present" if the project is actively developed.

### 24. CLAUDE.md doesn't explain what to do when quality gates fail

`CLAUDE.md:49-67` — The Session Completion section mandates running quality gates ("Tests, linters, builds") but doesn't say what to do if they fail. "Fix it" is implied but for an AI agent following these instructions literally, there's no explicit recovery path. The instruction "NEVER stop before pushing" could be read as "push even if tests fail."

**File:** `CLAUDE.md`

**Fix:** Add: "If quality gates fail, fix the issues before pushing. Never push broken code."

---

## Summary

| #   | Severity | Issue                                                     | File(s)                              |
| --- | -------- | --------------------------------------------------------- | ------------------------------------ |
| 1   | CRITICAL | No Node.js version documented                             | README, CLAUDE.md, package.json      |
| 2   | HIGH     | Tiling summary table references removed monolithic system | tiling.md                            |
| 3   | HIGH     | Dead issue tracker reference (tour-guide-5du)             | tiling.md                            |
| 4   | HIGH     | Code example has wrong return type                        | tiling.md                            |
| 5   | HIGH     | "zero-copy" claim is half-false                           | architecture.md                      |
| 6   | MEDIUM   | "120 MB" figure is contextually misleading                | binary-format.md                     |
| 7   | MEDIUM   | Extraction timing is unqualified                          | data-extraction.md                   |
| 8   | MEDIUM   | "varies" placeholder for article counts                   | README.md                            |
| 9   | MEDIUM   | Linear scan statistic is unmeasured                       | nearest-neighbor.md                  |
| 10  | MEDIUM   | No error handling documentation                           | architecture.md                      |
| 11  | MEDIUM   | No browser compatibility documented                       | README.md                            |
| 12  | MEDIUM   | No security/privacy documentation                         | README.md, architecture.md           |
| 13  | MEDIUM   | ~1.2M figure duplicated in 5 files                        | Multiple                             |
| 14  | MEDIUM   | Extraction steps duplicated with drift risk               | architecture.md, data-extraction.md  |
| 15  | MEDIUM   | Binary format duplicated in 2 files                       | architecture.md, binary-format.md    |
| 16  | MEDIUM   | No guide for adding a new language                        | data-extraction.md                   |
| 17  | LOW      | "auto-update mode" unexplained                            | architecture.md                      |
| 18  | LOW      | Unsourced bandwidth assumptions                           | tiling.md                            |
| 19  | LOW      | Key Files section is manual maintenance burden            | architecture.md                      |
| 20  | LOW      | Stale "current Last-Modified" reference                   | tiling.md                            |
| 21  | LOW      | Speculative forward-compatibility documented              | binary-format.md                     |
| 22  | LOW      | Chord distance clamping guard omitted                     | nearest-neighbor.md, architecture.md |
| 23  | LOW      | Copyright year check                                      | LICENSE                              |
| 24  | LOW      | No failure recovery in session completion                 | CLAUDE.md                            |

**Scorecard:** 1 critical, 4 high, 11 medium, 8 low across 8 documentation files.

The documentation is unusually accurate on surface-level facts — every file, function, and constant it names actually exists in the code. The problems are predominantly staleness from the monolithic-to-tiled transition, duplicated content that will drift, undocumented assumptions presented as measurements, and complete silence on failure modes, security, privacy, and compatibility.
