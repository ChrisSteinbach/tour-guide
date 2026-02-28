# Adversarial Documentation Review

An adversarial critique of all project documentation (`docs/`, `README.md`, `CLAUDE.md`) following the VDD "Roast" methodology: zero tolerance for inaccuracies, omissions, and internal contradictions. Every claim was verified against the actual codebase.

## Severity Levels

- **HIGH** — Factually wrong; will mislead a developer relying on the docs
- **MEDIUM** — Omission or inaccuracy that could cause confusion
- **LOW** — Minor inconsistency or cosmetic issue

---

## HIGH Severity

### 1. `state-machine.md`: `detail + tileLoaded` transition falsely claims requery effect

**Location:** `docs/state-machine.md`, transition table row for `detail + tileLoaded`

**Claim:** "detail | tileLoaded | --- | detail | requery (background update)"

**Reality:** The code (`src/app/state-machine.ts`) calls `forceRequery(next)` on this transition, but `forceRequery()` immediately checks `if (state.phase.phase !== "browsing")` and returns `{ next: state, effects: [] }` — **no effects at all**. The tile data is updated in the query state (the new tile is added to the map), but no requery effect is emitted during the `detail` phase.

**Impact:** A developer reading this table would expect background requery during detail view, which doesn't happen.

### 2. `architecture.md`: Service worker "installs silently without prompting" is misleading

**Location:** `docs/architecture.md`, Phase 3 Startup section, line 62

**Claim:** "auto-update: new versions install silently without prompting"

**Reality:** The `vite.config.ts` uses `registerType: "autoUpdate"`, so SW installation itself is automatic. However, `src/app/main.ts` listens for `controllerchange` events and dispatches `swUpdateAvailable`, which triggers the `showAppUpdateBanner` effect — rendering a visible "App update available" banner with a "Reload" button. The same docs (`state-machine.md`, line 169) explicitly document this `swUpdateAvailable` event and `showAppUpdateBanner` effect.

**Impact:** Internal contradiction within the docs themselves. The architecture doc says "without prompting" while the state machine doc documents the prompt mechanism.

---

## MEDIUM Severity

### 3. `state-machine.md`: `downloading` phase progress range is wrong

**Location:** `docs/state-machine.md`, Phase table, line 20

**Claim:** The `downloading` phase carries `progress (0-1)`.

**Reality:** The code initializes `downloadProgress` to `-1` (meaning "not started"). The phase is entered with `progress: state.downloadProgress`, so progress can be `-1`, not just `0-1`.

**Impact:** A developer implementing UI for the downloading state wouldn't account for the `-1` "not started" sentinel value.

### 4. `state-machine.md`: Missing transition row for `error + useMockData + query=none`

**Location:** `docs/state-machine.md`, transition table (around line 155)

**Claim:** Only one row exists: `error | useMockData | query=tiled | browsing | stopGps, loadTiles, requery`

**Reality:** The `useMockData` event is handled unconditionally. When received during the `error` phase with `query=none` (e.g., GPS error fires before tile index loads), `handleUseMockData` transitions to the `downloading` phase with effects `stopGps, render`. This is a realistic scenario — not an edge case.

**Impact:** Incomplete transition table; a developer relying on it for exhaustive state coverage would miss this path.

### 5. `architecture.md`: Undocumented legacy code in `vite.config.ts`

**Location:** `vite.config.ts`, `serveData()` plugin (lines 8-77)

**Reality:** The dev server middleware contains handlers for `triangulation-*.bin` and `triangulation.json` — a legacy monolithic format predating the tiling system. None of the documentation mentions this backward compatibility shim. It's dead code for the current architecture.

**Impact:** A developer reading the vite config would be confused by the pre-tiling data format references that contradict the docs' description of the current tiled architecture.

### 6. `architecture.md`: File inventory omits `apple-touch-icon.png`

**Location:** `docs/architecture.md`, PWA Manifest section

**Claim:** "Icon assets: icon.svg, icon-192.png, icon-512.png"

**Reality:** `src/app/public/` contains four icon files: `icon.svg`, `icon-192.png`, `icon-512.png`, **and** `apple-touch-icon.png`. The Apple touch icon is required for iOS home screen support but is not documented.

### 7. Multiple undocumented `CLAUDE.md` files

**Location:** All docs

**Reality:** Three `CLAUDE.md` files exist: `/CLAUDE.md` (root, documented), `/src/app/CLAUDE.md`, and `/src/pipeline/CLAUDE.md`. The subdirectory CLAUDE.md files are never mentioned in any documentation or file inventory, despite containing module-specific development instructions (e.g., browser verification workflow, pipeline commands).

### 8. Undocumented npm scripts

**Location:** `CLAUDE.md` Commands section, `README.md` Commands table

**Reality:** `package.json` contains scripts not listed in either doc:

| Script            | Command              | Purpose                     |
| ----------------- | -------------------- | --------------------------- |
| `preview`         | `vite preview`       | Preview production build    |
| `lint:eslint`     | `eslint src/`        | ESLint only (no type-check) |
| `lint:eslint:fix` | `eslint src/ --fix`  | ESLint auto-fix only        |
| `format`          | `prettier --check .` | Prettier check only         |
| `format:fix`      | `prettier --write .` | Prettier auto-fix only      |

These are used by CI (`ci.yml` runs `npm run format` and `npm run lint:eslint` as separate steps) but aren't documented for developer use.

---

## LOW Severity

### 9. `state-machine.md`: Transition diagram omits `downloading + useMockData`

**Location:** `docs/state-machine.md`, transition diagram (lines 99-124)

The ASCII diagram shows no arrow from `downloading` for the `useMockData` event. The transition table documents two rows for this case (`query=none` stays in `downloading`, `query=tiled` goes to `browsing/loadingTiles`). This is arguably acceptable simplification for a visual, but the diagram and table disagree on coverage.

### 10. Inconsistent `O(sqrt(N))` notation across docs

| Notation             | Used in                                          |
| -------------------- | ------------------------------------------------ |
| `O(√N)` (Unicode)    | README.md, CLAUDE.md, architecture.md            |
| `O(sqrt(N))` (ASCII) | nearest-neighbor.md, binary-format.md, tiling.md |

Purely cosmetic, but a sign the docs were written at different times without a style pass.

### 11. `architecture.md` Key Files disclaimer weakens trust

**Location:** `docs/architecture.md`, line 232

The note "This list is manually maintained and may not reflect recent file additions or renames" is honest but undermines the document's authority. The list is currently accurate for production source files, but the disclaimer suggests it might not be — a reader can't tell without checking.

### 12. CI coverage upload not documented

**Location:** `docs/architecture.md`, CI/CD section

The CI section says the test job runs "vitest + coverage" but doesn't mention that coverage artifacts are uploaded to GitHub Actions (with 30-day retention). Minor omission for a developer checking CI output.

---

## Verified Accurate (No Issues Found)

The following claims were verified against the codebase and found to be correct:

- **Architecture module structure**: Three modules (`geometry/`, `pipeline/`, `app/`) plus `lang.ts` and `tiles.ts`
- **All listed source files exist**: No phantom files in the inventory
- **All CI workflow files** (`ci.yml`, `pipeline.yml`, `deploy.yml`) exist and match descriptions
- **All documented npm scripts** match their actual commands and behavior
- **ESLint innerHTML rule**: `no-restricted-syntax` with `AssignmentExpression[left.property.name='innerHTML']` selector, set to `"error"`
- **`NEARBY_TIERS = [10, 20, 50, 100]`**: Exact match at `src/app/state-machine.ts:15`
- **`REQUERY_DISTANCE_M = 15`**: Exact match at `src/app/state-machine.ts:16`
- **Supported languages**: `["en", "sv", "ja"]` at `src/lang.ts:1`
- **PWA manifest config**: name "WikiRadar", display "standalone", theme_color "#1a73e8" — all match `vite.config.ts`
- **Service worker caching**: NetworkOnly for `.bin`/`.json`, StaleWhileRevalidate for Wikipedia API (200 entries, 1-week expiry) — all match
- **Convex hull perturbation**: ~1e-6 scale, seeded LCG PRNG (`0x9e3779b9`), reprojected onto sphere — all match `convex-hull.ts`
- **IDB key prefixes**: `tile-index-v1-`, `tile-v1-`, `tile-lru-v1-` — match `idb.ts` and usage in `tile-loader.ts`
- **Tile grid constants**: `GRID_DEG=5`, `BUFFER_DEG=0.5`, `EDGE_PROXIMITY_DEG=1` — match `tiles.ts`
- **Binary format header**: 24 bytes, fields at offsets 0/4/8/12/16 — match `serialization.ts`
- **Distance formula**: `2 * asin(chord / 2)` with clamp guard — match `query.ts:64`
- **Pipeline distance**: `acos(dot(a, b))` — match `geometry/index.ts:84`
- **`--bounds` format**: `south,north,west,east` parsed as `[south, north, west, east]` — match `extract-dump.ts:258`
- **FaceGrid**: Up to 128^3 cells, scaling with `ceil(∛N)` — match `convex-hull.ts:363`
- **Cross-document size estimates**: monolithic ~120 MB, tiled ~138 MB, per-tile ~89 bytes/article — consistent across `binary-format.md` and `tiling.md`
- **Cross-document article counts**: ~1.2M English — consistent across `README.md`, `data-extraction.md`, `tiling.md`
- **All internal doc links**: Every cross-reference points to an existing file

---

## Summary

| Severity | Count | Key Theme                                         |
| -------- | ----- | ------------------------------------------------- |
| HIGH     | 2     | Code behavior contradicts documented behavior     |
| MEDIUM   | 6     | Missing information that could mislead developers |
| LOW      | 4     | Cosmetic inconsistencies and minor omissions      |

The documentation is remarkably accurate overall — the vast majority of technical claims match the code exactly. The most serious issues are the two HIGH-severity items where the docs describe behavior that verifiably does not occur (the phantom requery effect in detail view, and the "without prompting" SW update claim that contradicts the state machine's own documented banner mechanism).
