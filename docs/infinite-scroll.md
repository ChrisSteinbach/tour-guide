# The Browse List

The app shows Wikipedia articles in one distance-ordered list that spans the whole globe, rendered through a virtual scroll. The list is **materialized whole** before it is displayed: its length is exact from the first render, any index can be read without fetching anything, and the last entry really is the furthest article in the language.

| Module                         | Concern                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `virtual-scroll.ts`            | Viewport math, overscan buffer, RAF-throttled rendering            |
| `browse-list.ts`               | Grading the local tier by distance band, merging with far-field    |
| `browse-list-lifecycle.ts`     | Owns the list and the far-field tier; rebuilds when inputs change  |
| `farfield.ts`                  | Far-field binary codec, shared by pipeline and app                 |
| `farfield-loader.ts`           | Fetches and IDB-caches the tier, keyed by content hash             |
| `infinite-scroll-lifecycle.ts` | Bundles virtual list, enrichment, and map sync as one lifecycle    |
| `summary-loader.ts`            | Concurrency-limited, cancellable batch fetcher for summaries       |
| `scroll-pause-detector.ts`     | Detects user scroll to trigger live-location → infinite transition |

## Levels of detail

Tiles give exhaustive coverage, but only near the user. Two hard limits rule out simply loading more of them to cover the whole globe:

- **Reaching the far end costs the entire dataset.** English is 1,234,576 articles across 1,374 tiles — 154 MB. The furthest article from any position is near its antipode, so a tile-by-tile walk outward has to load essentially everything.
- **The browser cannot render the list.** 1,234,576 rows × 68 px is ~84 Mpx. Chrome caps element height around 33.5 Mpx and Firefox around 17.9 Mpx, so a truthful 1:1 virtual list is not merely slow — it is unrepresentable.

So the list has level of detail, the way a map thins labels as it zooms out:

1. **Full detail**, out to `FULL_DETAIL_RADIUS_M` (1 km) — everything, unsampled. "Everything within walking distance" is the promise the app exists to keep, so this innermost band is never thinned.
2. **Distance-banded sampling**, beyond that out to the tile coverage radius — the `DISTANCE_BAND_QUOTA` (250) most notable articles per doubling of distance.
3. **The far-field tier**, beyond the coverage radius — the most notable articles from every populated 5° cell on Earth.

### Why bands, not a flat cap

A flat cap on article count fails at global scale: a limit generous enough to matter in a sparse region is exhausted within a few blocks of a dense one. In the real English build, the nearest 5,000 articles to a position run out long before the loaded tiles do:

| From           | Nearest 5,000 articles reached | Tile coverage radius |
| -------------- | ------------------------------ | -------------------- |
| central London | 4.6 km                         | 112 km               |
| Manhattan      | 7.1 km                         | 43 km                |

A cap like that spends its whole local budget on one neighbourhood and then falls straight to the far-field tier's 25-articles-per-populated-cell, leaving tens of thousands of already-downloaded articles in between unused. Distance banding spends the same number of rows on each doubling of distance instead. Bands are geometric rather than linear because a band's area — and so its article count — grows with its radius; equal-width bands would put almost every row in the outermost one. The quota is also self-calibrating: a band holding fewer articles than `DISTANCE_BAND_QUOTA` keeps all of them, so sparse regions like rural Wyoming stay fully exhaustive and only dense cities are thinned.

### The far-field tier

The pipeline writes `data/tiles/{lang}/farfield.bin` alongside the tiles — the top `FARFIELD_TOP_K` (25) articles by weight class from each populated cell. For English that is 26,781 entries, ~756 KB raw and ~335 KB brotli: roughly four average tiles, fetched once per language and cached in IDB under the content hash recorded in `index.json`.

Two choices worth noting:

- **Per cell, not a global weight threshold.** A uniform notability floor would crowd Europe and North America and leave the Pacific empty — in a distance-ordered list that reads as a dead zone rather than as sparse terrain.
- **Every populated cell contributes**, including cells too sparse to triangulate into a tile (fewer than `MIN_ARTICLES`). Those articles are unreachable through tiles at all, so the tier is their only route into the app.

The tier is optional. An index without a `farField` entry, a 404, a network failure, or corrupt data all degrade to an empty tier, and the list simply ends at the tile coverage radius.

## Building the list

`buildBrowseList()` in `browse-list.ts` merges the levels:

```
full detail       every article within FULL_DETAIL_RADIUS_M (1 km)
distance bands    DISTANCE_BAND_QUOTA most notable per doubling of
                  distance beyond that, out to the coverage radius
far-field tier    every entry not already listed, deduped by title
                  → concat, sort by distance
```

**Coverage radius** (`coverageRadiusMeters`) is the distance to the nearest tile that exists but is not loaded — computed with `tileBoxLowerBoundMeters`, which is deliberately conservative, so the radius under-claims rather than over-claims. Beyond it the loaded tiles have holes.

The radius bounds the query itself, not just the list. `queryLocal` calls `findWithinRadiusTiled()` (`tile-loader.ts`), a range query that prunes any tile whose box already lies beyond the radius, rather than running a k-nearest search and cutting the result down afterward. Local articles past the radius are never fetched, let alone dropped: keeping them would make list density depend on which direction the user happens to face — hundreds of articles at 600 km where a tile is loaded, three where one is not — which reads as a broken list. The cost is only the long tail in partly-covered cells, since the far-field tier still carries their notable articles.

The range query also outruns a k-nearest one at this size. `NearestQuery.withinRadius` is a flat scan comparing squared chord lengths against the radius — a subtraction and a comparison per vertex, the arc computed only for vertices that survive — so its cost is a property of the tile rather than of how crowded the neighbourhood is. Asking a k-nearest walk the same question means guessing a `k` large enough to reach the radius and paying a heap operation and a BFS visit for every candidate on the way. Measured in the browser against Manhattan's two loaded tiles (43 km coverage radius):

| Query                      | Reached | Articles | Median |
| -------------------------- | ------- | -------- | ------ |
| `withinRadius` to 43 km    | 43 km   | 11,720   | 2.8 ms |
| `findNearestTiled`, k=20k  | 43 km   | 20,000   | 35 ms  |
| `findNearestTiled`, k=5000 | 7.1 km  | 5,000    | 6.4 ms |

So the range scan returns twice the articles, six times further out, in under half the time the old capped query took.

**Deduplication is by title alone.** A far-field entry inside the covered radius is either already listed — caught here — or it is one the distance-band sampling dropped, or it comes from a cell too sparse to have produced a tile at all. In the last two cases it belongs: the far-field tier is itself a notability ranking, so an entry it carries has already earned a row.

## Lifecycle

`BrowseListLifecycle` (`browse-list-lifecycle.ts`) owns the list and the tier.

- **`rebuild(position)`** — Fetches the far-field tier if the language changed, then rebuilds synchronously from the current position, filter, and loaded tiles. The first build does not wait on the tier: a list that is instantly correct-but-short beats a spinner, and the tier is usually an IDB hit. When it lands, the list is rebuilt and re-rendered.
- **`reset()`** — Drops the list. The tier survives, since it is scoped to the language rather than the position.
- **`attachObserver(fn)`** — Exactly one subscriber. `compose-app.ts` wires it to dispatch `articlesSync` (making the list `state.phase.articles`) and then resize the virtual list.

Rebuilds are triggered by the `requery` effect, and **must run after** its `queryResult` dispatch: `getNearby` returns only `INFINITE_SCROLL_INITIAL` articles as a viewport seed, so rebuilding first would let that seed overwrite the full list.

## Virtual Scroll

The virtual list (`virtual-scroll.ts`) renders only the items visible in the viewport plus an overscan buffer, absolutely positioned within a height-sized container.

**Core math** (`computeVisibleRange`):

- `start = floor(scrollTop / itemHeight) - overscan`
- `end = ceil((scrollTop + viewportHeight) / itemHeight) + overscan`
- Clamped to `[0, totalCount)`

`totalCount` is the real list length — there is no optimistic headroom, no never-shrink ratchet, and no near-end expansion, because nothing about the list is pending.

**Constants:** `VIRTUAL_ITEM_HEIGHT = 68px`, `overscan = 5`.

The list is sized in **group-index space** — one row per coincident-article cluster — so `compose-app.ts` converts article counts through the `GroupView` before calling `update()`.

## How Infinite Scroll Starts

1. **Picked position or manual pause** — `computeScrollMode()` returns `"infinite"` immediately, because the position is stable.
2. **Live GPS + user scrolls** — the scroll-pause detector fires past `SCROLL_PAUSE_THRESHOLD` (136px = 2 × item height), dispatching `scrollPause`, which sets `paused: true`, `pauseReason: "scroll"`, `scrollMode: "infinite"` and emits a `requery`.

In both cases `renderBrowsingListDOM()` sees `scrollMode === "infinite"` and calls `renderInfiniteScrollDOM()`, which sizes the virtual list to `state.phase.articles.length`.

## Enrichment and Map Sync

Two debounced side effects run on `onRangeChange`:

**Enrichment** (`enrich-scheduler.ts`): after the visible range settles for 300 ms, fetches Wikipedia summaries for visible articles, tracking already-enriched titles. `SummaryLoader` (`summary-loader.ts`) manages a concurrency-limited queue (3 concurrent) with cancellation and priority boosting via `request()`.

**`SummaryLoader.request()` semantics:** when a title is already pending, `request()` moves it to the **front** of the queue so viewport items beat off-screen ones. On a **cache hit** it is a no-op — it does NOT invoke `onSummary`; callers wanting the cached value must use `get()`. This stops scroll-settle from re-firing DOM patches over already-delivered items, which would reset hover state on every scroll quiet point.

**Map sync** (`debounced-map-sync.ts`): after 150 ms of scroll settle, syncs the active spatial view (radar or map) with the visible articles.

## Scroll Mode Transitions

| Transition                  | scrollMode | Trigger                                |
| --------------------------- | ---------- | -------------------------------------- |
| GPS + not paused            | `viewport` | Default for live tracking              |
| User scrolls past threshold | `infinite` | `scrollPause` event                    |
| User manually pauses        | `infinite` | `togglePause` (pause)                  |
| User resumes (unpauses)     | `viewport` | `togglePause` (resume) + scroll to top |
| Picked position             | `infinite` | `computeScrollMode("picked", *)`       |
| Switch to GPS               | `viewport` | `useGps` event                         |

Going `infinite` → `viewport` emits `scrollToTop`, since viewport mode is a short, GPS-updated list. Going `viewport` → `infinite`, `renderBrowsingListDOM` tears down the viewport list and initializes the infinite scroll lifecycle.

## See Also

- [State Machine](state-machine.md) — `scrollPause` and `togglePause` transitions
- [Architecture Overview](architecture.md) — End-to-end system design
- [Tiling Strategy](tiling.md) — Geographic tiling and on-demand loading
