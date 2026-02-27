# Adversarial Documentation Review

An adversarial review of WikiRadar's documentation corpus, conducted using
the Verification-Driven Development (VDD) methodology: every claim checked
against source code, every cross-reference checked for consistency, every
gap catalogued. The goal is to identify real flaws — not to nitpick style.

**Scope:** `docs/` (5 files), `README.md`, `CLAUDE.md`, `LICENSE`,
`src/app/CLAUDE.md`, `src/pipeline/CLAUDE.md`, `.beads/README.md`.

---

## Methodology

Each document was read in full. Specific factual claims (byte offsets,
algorithm complexity, command names, file paths, numeric constants) were
verified against the corresponding source files. Cross-references between
documents were checked for consistency. The review distinguishes between:

- **Verified** — claim matches source code exactly
- **Imprecise** — claim is defensible but could mislead a careful reader
- **Inconsistent** — two documents contradict each other
- **Stale** — language or references that no longer reflect the current state
- **Gap** — important information that is absent

---

## Source-Code Verification (15 claims checked)

All 15 specific factual claims verified against source were **correct**.
The documentation is unusually precise about implementation details. Full
verification log:

| #   | Claim                                                                  | Source file                                     | Verdict             |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------- |
| 1   | Binary header: 24 bytes, fields at offsets 0/4/8/12/16                 | `serialization.ts:164,198-202`                  | Exact match         |
| 2   | Pipeline distance: `acos(dot(a,b))`                                    | `geometry/index.ts:83`                          | Exact match         |
| 3   | App distance: `2 * asin(\|\|v-q\|\| / 2)`                              | `app/query.ts:53-65`                            | Exact match         |
| 4   | All 6 CLAUDE.md commands exist in package.json                         | `package.json`                                  | Exact match         |
| 5   | Tile grid: `GRID_DEG=5`, `BUFFER_DEG=0.5`                              | `tiles.ts:3-5`                                  | Exact match         |
| 6   | FaceGrid: up to 128³ cells                                             | `convex-hull.ts:363`                            | Exact match         |
| 7   | IDB prefixes: `tile-index-v1-`, `tile-v1-`, `tile-lru-v1-`             | `idb.ts:16-20`                                  | Exact match         |
| 8   | `test:watch` and `test:coverage` commands exist                        | `package.json:11-12`                            | Exact match         |
| 9   | Perturbation magnitude: 1e-6                                           | `convex-hull.ts:78`                             | Exact match         |
| 10  | SW: `.bin`/`.json` → NetworkOnly; Wikipedia API → StaleWhileRevalidate | `vite.config.ts:119-141`                        | Exact match         |
| 11  | BFS oversampling: `max(2k, k+6)`                                       | `query.ts:221`                                  | Exact match         |
| 12  | Re-query threshold: 15 m                                               | `state-machine.ts:16`                           | Exact match         |
| 13  | Entry points: `extract-dump.ts`, `build.ts`                            | `src/pipeline/`                                 | Exist               |
| 14  | Demo tile: Paris → row 27, col 36                                      | `mock-data.ts:4-6` via `floor((48.86+90)/5)=27` | Correct             |
| 15  | O(N log N) expected complexity for incremental hull                    | `convex-hull.ts` comments                       | Correctly qualified |

Two claims deserve footnotes:

- **Claim 14 (Euler's formula / average degree < 6):** Mathematically
  correct — average degree = `6 - 12/V`, which is strictly less than 6 for
  all finite V. The phrasing is fine.
- **Claim 15 (O(N log N) expected):** The word "expected" is doing heavy
  lifting. Worst-case incremental 3D convex hull is O(N²). The FaceGrid
  spatial index and deterministic perturbation make the expected case
  realistic, but a reader unfamiliar with randomized analysis could read
  this as a guarantee. Consider adding a parenthetical: _(worst-case O(N²),
  mitigated by spatial indexing)_.

---

## Cross-Document Inconsistencies

### 1. Beads command mismatch — CLAUDE.md vs .beads/README.md

**Severity: High**

CLAUDE.md teaches:

```bash
bd close <id>         # Complete work
```

`.beads/README.md` teaches:

```bash
bd update <id> --status done
```

These may or may not be aliases for the same operation, but the
documentation gives no indication that they are equivalent. A developer
(or AI agent) following CLAUDE.md will use `bd close`; one following
`.beads/README.md` will use `bd update --status done`. If they differ in
behavior, bugs will follow silently.

Additionally, CLAUDE.md lists `bd ready` (not mentioned in
`.beads/README.md`) and omits `bd create` and `bd list` (which
`.beads/README.md` documents). The two files present incompatible subsets
of the beads CLI.

**Recommendation:** Unify the command reference. Either CLAUDE.md should be
the single source of truth for this project's beads workflow (and
`.beads/README.md` should defer to it), or both should show identical
commands.

### 2. CLAUDE.md omits test:watch, test:coverage, and lint-fix commands

**Severity: Medium**

README.md documents `npm run test:watch` and `npm run test:coverage`.
package.json also defines `lint:fix`, `lint:eslint`, `lint:eslint:fix`,
`format`, and `format:fix`. None of these appear in CLAUDE.md, which is
the primary reference for AI agents working in this codebase.

An AI agent following CLAUDE.md will never discover watch mode or
auto-fixing. For a file explicitly designed to instruct automated
developers, this is a meaningful gap.

**Recommendation:** Add at minimum `test:watch`, `test:coverage`, and
`lint:fix` to CLAUDE.md's command table. The others are discoverable from
package.json but the high-frequency ones should be surfaced.

### 3. README language table shows "varies" with no explanation

**Severity: Low**

```
| Swedish (sv)  | varies   |
| Japanese (ja) | varies   |
```

Every other document that mentions article counts gives a specific number
for English (~1.2M) and says nothing about sv/ja. "varies" in the README
is a placeholder that communicates zero information. It could mean 10,000
or 10,000,000.

**Recommendation:** Either give approximate counts (even rough order of
magnitude) or remove the column. "varies" is worse than no data because it
looks like someone measured something and then forgot to write it down.

---

## Stale Language and References

### 4. tiling.md talks about the future in present tense

**Severity: Medium**

`docs/tiling.md` contains pervasive language that reads as a design
proposal rather than documentation of an implemented system:

- Line 3: "Instead of downloading a single monolithic file" — implies the
  monolithic approach still exists as a comparison baseline.
- Line 184: "Even querying 4 tiles is faster than the current monolithic
  query" — "current" suggests the monolith is what's deployed.
- Line 219: "Same speed as today's monolithic cache" — "today's" is a
  temporal marker from before tiling was implemented.
- Line 237-243: The summary table has a "Current" vs "Tiled" comparison
  column that reads as a proposal, not a retrospective.

Meanwhile, `docs/architecture.md` describes the tiled system as the
implemented reality, and the codebase clearly implements tiling. The tiling
doc was evidently written as a design document and never updated to
reflect that the design was built.

**Recommendation:** Rewrite tiling.md in past/present tense. Remove or
relabel the "Current vs Tiled" comparison table (perhaps as "Before/After"
or "Why we moved to tiling"). The document has excellent technical content
but its framing undermines trust.

### 5. Stale issue reference in tiling.md

**Severity: Low**

Line 143: _"This aligns with the existing issue tour-guide-5du (replacing
Last-Modified with content hashes)."_

This references an issue ID (`tour-guide-5du`) in what appears to be a
previous issue tracker. It is not verifiable through beads or any other
system currently documented. Either the issue was completed (in which case
the reference is noise) or it wasn't (in which case it should be migrated
to beads).

**Recommendation:** Remove the reference or replace it with a beads issue
ID if the work is still pending.

---

## Gaps

### 6. No error recovery documentation

**Severity: Medium**

The docs describe the happy path in excellent detail. They do not describe:

- What happens when a tile fetch fails at runtime (retry? fallback?
  error screen?)
- What happens when IndexedDB is unavailable or full
- What happens when the Wikipedia REST API is down (the SW
  StaleWhileRevalidate strategy implies graceful degradation, but this
  isn't documented)
- What happens when GPS is denied or unavailable (the "demo data" path
  is mentioned but the error-to-demo-data flow isn't)

For a PWA that runs on mobile networks, failure modes are not edge cases —
they are the primary operating environment.

**Recommendation:** Add a "Failure Modes" or "Error Handling" section to
`docs/architecture.md` covering network failures, storage limits, GPS
denial, and API outages.

### 7. No contribution or development setup guide

**Severity: Low**

README.md has a "Getting started" section that covers cloning and running
the dev server. It does not cover:

- Node.js version requirements
- How to run the extraction pipeline locally (it downloads multi-GB dumps)
- How to run a subset of the pipeline for local testing (the `--limit`
  and `--bounds` flags are documented in the data pipeline section but
  not in "Getting started")
- How to run tests

For an open-source project, the path from `git clone` to "I submitted a
PR" is undocumented.

**Recommendation:** Either expand "Getting started" or add a CONTRIBUTING
section. At minimum, state the Node.js version requirement.

### 8. Binary format has no versioning or magic bytes

**Severity: Low (design observation, not doc bug)**

`docs/binary-format.md` documents a format with 8 reserved bytes (offsets
16-23) but no magic number and no version field. If the format ever
changes, there is no way for a reader to distinguish v1 from v2 short of
the tile index's content hash changing.

The reserved bytes are clearly intended for future versioning, but the doc
doesn't say so explicitly. A future developer might use them for something
else.

**Recommendation:** Add a sentence to the reserved bytes description:
_"Reserved for future use; a format version field will be placed here if
the layout changes."_

---

## LICENSE

### 9. Copyright year

**Severity: Trivial**

The LICENSE file says `Copyright (c) 2025 Chris Steinbach`. The current
date is 2026-02-27. This is standard practice (copyright year reflects
initial publication, not last modification), so this is not technically
wrong. However, if the project was actively developed in 2026 with new
copyrightable contributions, the year range should be `2025-2026`.

The ISC license text itself is standard and correct.

---

## What the Documentation Gets Right

This section exists because adversarial reviews that find only flaws are
themselves flawed — they create the false impression that everything is
broken. The documentation corpus is, on balance, **unusually good**:

- **Source-code accuracy:** 15/15 specific claims verified. This is rare.
  Most project documentation drifts from implementation within weeks. The
  fact that byte offsets, algorithm constants, and IDB key prefixes all
  match exactly suggests the docs are maintained alongside the code.

- **Layered depth:** The docs form a coherent hierarchy — README for
  orientation, CLAUDE.md for workflow, architecture.md for the full
  picture, and specialist docs (binary-format, tiling, nearest-neighbor,
  data-extraction) for deep dives. A reader can stop at any layer and
  have a complete (if less detailed) understanding.

- **Honest complexity analysis:** The nearest-neighbor doc correctly
  qualifies O(N log N) as "expected", explains why chord distance is
  needed for Float32 data, and gives a fair comparison of alternatives
  (KD-trees, Kirkpatrick). It doesn't oversell the approach.

- **Back-of-envelope calculations:** The tiling doc includes concrete size
  estimates, loading time projections, and a "why not geohash / S2"
  analysis. This is the kind of reasoning that usually lives only in
  someone's head.

- **Zero contradictions in technical content:** The algorithm descriptions,
  data flow diagrams, and file format specs are consistent across all 11
  documents. The inconsistencies found are all in process/workflow
  documentation, not in the technical core.

---

## Summary

| #   | Finding                                                          | Severity | Category      |
| --- | ---------------------------------------------------------------- | -------- | ------------- |
| 1   | Beads commands differ between CLAUDE.md and .beads/README.md     | High     | Inconsistency |
| 2   | CLAUDE.md missing test:watch, test:coverage, lint:fix            | Medium   | Gap           |
| 3   | README language table shows "varies"                             | Low      | Imprecise     |
| 4   | tiling.md written as design proposal, not implemented-system doc | Medium   | Stale         |
| 5   | Stale issue ID reference (tour-guide-5du) in tiling.md           | Low      | Stale         |
| 6   | No error/failure-mode documentation                              | Medium   | Gap           |
| 7   | No contribution guide or Node.js version requirement             | Low      | Gap           |
| 8   | Binary format reserved bytes lack stated purpose                 | Low      | Gap           |
| 9   | Copyright year could be updated to 2025-2026                     | Trivial  | Stale         |

**High:** 1 &nbsp;|&nbsp; **Medium:** 3 &nbsp;|&nbsp; **Low:** 4 &nbsp;|&nbsp; **Trivial:** 1

The technical documentation is accurate and well-structured. The issues
are concentrated in process documentation (beads commands, command
references) and temporal framing (tiling.md's proposal language). None of
the findings indicate incorrect technical content.
