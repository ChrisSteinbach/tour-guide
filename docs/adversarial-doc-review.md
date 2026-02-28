# Adversarial Documentation Review

Review of all project documentation (`CLAUDE.md`, `README.md`, `docs/*`) using
adversarial criticism methodology. Every claim was verified against source code
where possible.

## Critical: Factual Errors

### 1. Demo data is Paris, not Stockholm

**File:** `docs/tiling.md:210`

The doc says:

> For the **demo data** path ("Use demo data" button), the app loads a hardcoded
> tile for the demo location (Stockholm → tile row 32, col 39).

The actual code (`src/app/mock-data.ts:3-6`):

```typescript
/** Mock position: near the Eiffel Tower, Paris */
export const mockPosition: UserPosition = {
  lat: 48.8584,
  lon: 2.2945,
};
```

Using the tile formula from tiling.md itself: row = floor((48.86+90)/5) = **27**,
col = floor((2.29+180)/5) = **36**. Not row 32, col 39. Not Stockholm.

### 2. Articles section tuple support is phantom documentation

**File:** `docs/binary-format.md:64-68`

The doc claims each articles entry can be a string or a `[title, description]`
tuple. The serializer (`serialization.ts:176`) only writes `string[]`:

```typescript
const articlesBytes = encoder.encode(JSON.stringify(data.articles));
```

The `TriangulationFile` type defines `articles: string[]`. The deserializer does
parse tuples at `serialization.ts:310`, but this is dead-code backwards
compatibility. The documentation presents a feature that doesn't exist in the
write path.

## High: Numbers That Don't Add Up

### 3. Monolith file size: 120 MB vs 108 MB

- `docs/binary-format.md:84`: "produces a file around **120 MB**"
- `docs/tiling.md:236`: "Current... **108 MB** monolith"

Tiling doc's own bytes-per-article math (~89 bytes × 1.2M) yields ~107 MB,
consistent with 108 MB but not with 120 MB.

### 4. Bytes-per-article breakdown hides assumptions

**File:** `docs/tiling.md:37-39`

The "~64 bytes numeric" figure implicitly assumes T = 2V (two triangles per
vertex), which is only approximately true for large triangulations and less
accurate for small tiles with boundary effects. The T/V ratio assumption should
be made explicit.

### 5. Tile index manifest size underestimated

**File:** `docs/tiling.md:145`

Claims ~800 tiles × ~90 bytes = 72 KB raw, ~15 KB gzipped. Counting the actual
JSON example in the same document, a single tile entry is ~106-120 bytes.
Realistic total: 85-95 KB raw, ~20 KB gzipped.

## Medium: Stale or Misleading Content

### 6. Architecture overview omits tiling from summary

**File:** `docs/architecture.md:3`

The opening summary describes three phases but makes the pipeline sound like a
monolithic build. The detail section correctly describes per-tile triangulations,
but the summary is misleading.

### 7. O(√N) complexity claims are imprecise

The full nearest-neighbor operation includes triangle walk (O(√N)), greedy vertex
walk, and BFS expansion. Only the triangle walk is O(√N); calling the full query
"O(√N) time" (architecture.md:3) conflates the walk with the complete operation.

### 8. nearest-neighbor.md is a textbook chapter, not project docs

This document discusses planar Voronoi theory, slab methods, Kirkpatrick
hierarchies, and KD-trees but never references a single file in the codebase,
never mentions the actual implementation choices (incremental convex hull,
FaceGrid spatial index, flat typed-array walks), and never links to
architecture.md. It should be framed as background theory and cross-reference the
implementation docs.

### 9. binary-format.md misattributes tile fetching to query.ts

**File:** `docs/binary-format.md:94`

Says `query.ts` "fetches the `.bin` file over HTTP" — but `query.ts` is a pure
computation module. Tile fetching is handled by `tile-loader.ts`, as correctly
described in architecture.md.

## Low: Inconsistencies and Polish

### 10. Complexity notation varies

`O(√N)` (CLAUDE.md, architecture.md), `O(sqrt(N))` (tiling.md), `O(n^{1/2})`
(nearest-neighbor.md). Pick one and use it everywhere.

### 11. Tile count: range vs point estimate

tiling.md says "700-900 tiles" then uses "~800 tiles" later. Consistent in
spirit but needlessly imprecise on first mention.

### 12. README commands not in CLAUDE.md

`test:watch` and `test:coverage` are in README.md but not in CLAUDE.md, which is
supposed to be the command reference.

### 13. Extraction timing unqualified

Data extraction doc says "~10 minutes for English" without qualifying hardware
assumptions.

### 14. "Self-signed certificate" claim ungrounded

README.md claims dev server uses a self-signed certificate for HTTPS. This is an
implementation detail that should reference the specific Vite plugin or config.

## Summary

| Severity | Count | Key Issues                                              |
| -------- | ----- | ------------------------------------------------------- |
| Critical | 2     | Paris/Stockholm mismatch, phantom tuple feature         |
| High     | 3     | 120 vs 108 MB, hand-wavy byte math, manifest size       |
| Medium   | 4     | Stale summary, imprecise complexity, textbook doc, file |
| Low      | 5     | Notation, tile counts, missing commands, timing, HTTPS  |
