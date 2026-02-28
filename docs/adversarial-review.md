# Adversarial Documentation Review

An adversarial review of all project documentation (`docs/`, `README.md`, `CLAUDE.md`) following the Verification-Driven Development (VDD) methodology. Every claim was verified against the actual source code. Issues are categorized by severity.

## Critical Issues

### 1. `langChanged` transition table is incomplete (state-machine.md)

The transition table (lines 139–171) documents `langChanged` only from `browsing` and `dataUnavailable`:

```
| browsing        | langChanged | — | downloading | storeLang, loadData, render |
| dataUnavailable | langChanged | — | downloading | storeLang, loadData, render |
```

But the actual handler in `src/app/state-machine.ts:396-415` is a **top-level switch case** that catches `langChanged` from **any phase**. It transitions any post-welcome phase to `downloading`. The table omits `langChanged` from `detail`, `downloading`, `locating`, `loadingTiles`, and `error` — all of which are valid and handled identically by the code. This is a documentation gap for anyone trying to understand the state machine from the docs alone.

The ASCII transition diagram (line 109) correctly annotates `langChanged` as applying to "any post-welcome phase," but the "complete transition table" — which calls itself complete — contradicts this by listing only two source phases.

### 2. Complexity claim omits worst case (nearest-neighbor.md)

Line 34 states:

> **Complexity:** O(N log N) expected for the incremental hull.

This is correct for the expected case with randomized insertion, but the document never mentions the **O(N²) worst-case** complexity. For a technical document that positions itself as explaining the theory, this omission is misleading. The implementation itself acknowledges worst-case degradation through multiple fallback strategies (greedy walk → FaceGrid lookup → BFS → linear scan in `convex-hull.ts`), but the docs present only the optimistic figure.

### 3. Project identity crisis — "WikiRadar" vs "tour-guide"

The project uses two names inconsistently across documentation and code:

| Location                                  | Name used          |
| ----------------------------------------- | ------------------ |
| README.md title                           | WikiRadar          |
| CLAUDE.md                                 | WikiRadar          |
| package.json `name`                       | tour-guide         |
| GitHub repo URL                           | tour-guide         |
| IDB database name (`idb.ts:12`)           | tour-guide         |
| PWA manifest name (`vite.config.ts:95`)   | WikiRadar          |
| `sessionStorage` key (`state-machine.ts`) | tour-guide-started |

No document explains this duality. A contributor reading the README sees "WikiRadar," then clones `tour-guide`, runs `npm test` on package `tour-guide`, and interacts with IDB database `tour-guide`. The user-facing name and the developer-facing name are completely different with zero explanation.

## High Issues

### 4. README command table missing `lint:fix` (README.md vs CLAUDE.md)

CLAUDE.md (line 11) documents `npm run lint:fix` — a useful command that auto-fixes ESLint and Prettier issues. README.md's command table (lines 68–77) omits it entirely. A contributor who only reads the README won't know this command exists.

Additionally, `package.json` defines several other scripts not documented in either file: `lint:eslint`, `lint:eslint:fix`, `format`, `format:fix`, `preview`. These are used by CI (`ci.yml` runs `npm run format` and `npm run lint:eslint` as separate steps) but are invisible to anyone reading the docs.

### 5. "Complete transition table" has silent gaps (state-machine.md)

Beyond the `langChanged` omission (issue #1), the transition table doesn't document what happens when events arrive in "wrong" phases. For example:

- What happens when `showMore` fires during `detail` phase? (Answer: nothing — it falls through to the default return. But the table doesn't say this.)
- What happens when `selectArticle` fires during `downloading`? (Same.)
- What happens when `tileLoadStarted` fires? It's listed as an event (line 62) but never appears in the transition table at all.

A "complete" table that omits no-op transitions and entire events is not complete. Either rename it to "key transitions" or actually enumerate the no-ops.

### 6. Architecture doc's file list has undocumented files (architecture.md)

The "Key Files" section (lines 234–274) is missing:

- `src/pipeline/dump-test-fixtures.ts` — a test fixture utility added recently

The disclaimer at line 232 ("This list is manually maintained and may not reflect recent file additions or renames") is honest, but a disclaimer doesn't fix a stale inventory. If the list isn't maintained, it's misleading; if it's meant to be maintained, it's already out of date.

## Medium Issues

### 7. ci.yml description is subtly wrong (architecture.md)

Line 271 describes ci.yml as:

> `ci.yml  Three parallel jobs: lint (format + eslint), type-check (tsc), test (vitest + coverage)`

The actual ci.yml has three jobs, but the `lint` job description is misleading. It runs two **separate steps**: `npm run format` (Prettier only) and `npm run lint:eslint` (ESLint only). These are different npm scripts, not the combined `npm run lint` script (which also includes `tsc --noEmit`). The parenthetical "format + eslint" implies they're a combined operation when they're distinct, independently-failing steps. And the type-check is separated into its own job precisely because `npm run lint` bundles it with ESLint — but the docs don't explain this architectural choice.

### 8. "Zero runtime dependencies" is technically true but misleading (README.md)

Line 150:

> **TypeScript** (strict mode, ES2022) — zero runtime dependencies

This is true in the `package.json` sense — there's no `dependencies` section. But the app bundles Workbox (via `vite-plugin-pwa`) as runtime service worker code, and `@vitejs/plugin-basic-ssl` generates runtime TLS behavior. "Zero npm runtime dependencies" would be more precise. The current phrasing could mislead someone into thinking the app ships zero third-party code at runtime.

### 9. IDB migration strategy has an unacknowledged limitation (architecture.md)

Lines 76 states:

> Data migration is handled by bumping the version in the prefix — old keys are orphaned and cleaned up on startup, avoiding the need for `onupgradeneeded`-based data migration.

This strategy works because the IDB schema version is hardcoded to `1` (`idb.ts:28`: `indexedDB.open(IDB_NAME, 1)`) and there's only one object store. But if the project ever needs a **second object store**, it would need to bump the IDB version AND handle `onupgradeneeded` — which would conflict with the documented strategy. The docs present key-prefix versioning as a permanent solution without acknowledging this constraint.

### 10. The `--bounds` flag uses a non-standard coordinate order with no justification

README.md (line 93) and data-extraction.md (line 56) both document:

> Geographic subset (south,north,west,east — not the WGS84 west,south,east,north convention)

The docs warn about the non-standard order, which is good. But neither document explains **why** the project chose a non-standard convention. Is it an intentional design choice? A historical accident? Following some other convention? Without this context, a contributor might "fix" it to match WGS84 and break the pipeline.

### 11. Binary format forward-compatibility claim is speculative (binary-format.md)

Line 66:

> Each entry is either a plain `string` (title only) or a `[string, string]` tuple (title + description). The serializer currently produces `string[]` only; the deserializer accepts both forms for forward compatibility.

Documenting a format that doesn't exist yet as "forward compatibility" is speculative design. If the tuple format is never used, this is dead documentation about dead code. If it is eventually used, the docs will need to be updated anyway. This is the kind of premature abstraction the project's own CLAUDE.md warns against ("Don't design for hypothetical future requirements").

### 12. "Adding a New Language" steps could cause TypeScript errors (data-extraction.md)

Lines 97–105 list five steps to add a new language. Step 1 says:

> Add the language code to the `SUPPORTED_LANGS` array in `src/lang.ts`.

Step 2 says:

> Add canary landmarks for the new language in `src/pipeline/canary.ts`

What the docs don't explain is that `Lang` is a derived type (`typeof SUPPORTED_LANGS[number]`), so step 1 automatically extends the type. But `canary.ts` uses `Record<Lang, Landmark[]>`, which means after step 1, TypeScript will immediately error because the new language key is missing from the LANDMARKS record. The steps are technically correct in order, but a developer following them literally would see a confusing type error between steps 1 and 2 if they try to compile.

## Low Issues

### 13. Tiling doc's S2 cells dismissal uses a made-up number (tiling.md)

Lines 27–28:

> computing S2 cell IDs from lat/lon requires implementing the S2 projection (~500+ lines of code)

The "~500+ lines" figure is not cited and appears to be a rough guess. Google's actual S2 geometry library implementations vary wildly in size depending on language and features included. This unsubstantiated number weakens an otherwise reasonable argument about the zero-dependency constraint.

### 14. Loading time estimates lack methodology (tiling.md)

The loading time table (lines 46–53) presents specific figures like "~0.3s" and "~8s" with bandwidth assumptions of "~10 Mbps" for 4G and "~1 Mbps" for 3G. These are rough approximations presented with false precision. The disclaimer "Bandwidth estimates are conservative approximations" is buried in a line above the table rather than in the table itself. The claim "first useful result in <5 seconds for all realistic mobile scenarios" is then presented in bold as a conclusion, despite being derived from these rough estimates.

### 15. Back-of-envelope math doesn't account for triangle overhead (tiling.md)

The "Bytes per article" calculation (lines 37–39) assumes exactly 2 triangles per vertex (T ≈ 2V via Euler's formula). This is correct for the interior of a triangulation but breaks down at tile boundaries where the buffer zone creates edge effects. The buffer articles increase the triangle-to-vertex ratio slightly. The ~64 bytes/article figure is an underestimate for buffered tiles, though the error is small (~10–20%).

### 16. Nearest-neighbor doc conflates O(sqrt(N)) per-tile with total query cost

README.md (line 16) and nearest-neighbor.md present the O(sqrt(N)) walk cost as the query complexity, but the actual query performs up to 4 independent tile walks plus de-duplication sorting. The total cost is O(k \* sqrt(N_tile)) where k is the number of loaded tiles (1-4), plus O(m log m) for the merge-sort of m candidates. This distinction matters when evaluating the "28x speedup" claim in tiling.md — the speedup is per-walk, not per-query.

### 17. State machine doc's dispatch loop is oversimplified (state-machine.md)

Lines 207–213 show the dispatch loop:

```typescript
function dispatch(event: Event): void {
  const { next, effects } = transition(appState, event);
  appState = next;
  for (const effect of effects) {
    executeEffect(effect);
  }
}
```

This omits error handling, the synchronous re-entry case (the `requery` effect calls `dispatch` recursively), and any guard against infinite loops from cyclic effect→event→effect chains. A reader might assume this is the actual implementation and wonder how re-entrant dispatches work safely.

## Methodology

This review follows the adversarial refinement phase ("The Roast") from the [Verification-Driven Development](https://gist.github.com/dollspace-gay/45c95ebfb5a3a3bae84d8bebd662cc25) methodology. Every claim was cross-referenced against source code. Mathematical formulas were independently verified. File references were checked for existence. Cross-document consistency was validated.

**What passed:** The majority of documentation is remarkably accurate. Binary format specifications, IDB key prefixes, cache configuration constants, tile grid math, distance formulas, ESLint rules, convex hull orientation conventions, and function signatures all match the code exactly. The project's documentation quality is well above average.

**Exit signal:** Several findings above may trigger hallucination-based pushback — the "forward compatibility" concern (#11) and the "dispatch loop oversimplification" (#17) are borderline, since the docs are describing the conceptual model rather than being a line-by-line code walkthrough. The remaining findings are grounded in verifiable discrepancies between documentation and code.
