# Infinite Scroll

The app uses virtual infinite scroll to display articles sorted by distance. Articles load progressively as the user scrolls, with tiles fetched on demand in expanding rings around the user's position.

The system spans eight modules, each handling one concern:

| Module                         | Concern                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `virtual-scroll.ts`            | Viewport math, overscan buffer, RAF-throttled rendering                   |
| `infinite-scroll-lifecycle.ts` | Orchestrates virtual list, enrichment, map sync as a single lifecycle     |
| `article-window.ts`            | Distance-windowed data model with async expansion                         |
| `article-window-factory.ts`    | Constructs an ArticleWindow with its TileRadiusProvider wiring            |
| `article-window-lifecycle.ts`  | ArticleWindow reset/create orchestration and infinite scroll coordination |
| `summary-loader.ts`            | Concurrency-limited, cancellable batch fetcher for article summaries      |
| `scroll-pause-detector.ts`     | Detects user scroll to trigger live-location → infinite scroll transition |
| `tile-radius.ts`               | Progressive tile loading by expanding Chebyshev rings                     |

## How It Starts

Infinite scroll activates in two ways:

1. **Picked position or manual pause** — `computeScrollMode()` returns `"infinite"` immediately because the position is stable.
2. **Live GPS + user scrolls** — The scroll-pause detector fires after the user scrolls past `SCROLL_PAUSE_THRESHOLD` (136px = 2 × item height). This dispatches `scrollPause` to the state machine, which sets `paused: true`, `pauseReason: "scroll"`, `scrollMode: "infinite"`, and emits a `requery` effect with `INFINITE_SCROLL_INITIAL` (200) articles.

In both cases, `renderBrowsingListDOM()` sees `scrollMode === "infinite"` and calls `renderInfiniteScrollDOM()`, which initializes the infinite scroll lifecycle.

```
User scrolls 136px
  → ScrollPauseDetector fires
    → dispatch({ type: "scrollPause" })
      → state: paused=true, scrollMode="infinite"
      → effect: requery(count=200)
        → getNearby(200) → queryResult
          → renderBrowsingList
            → renderInfiniteScrollDOM()
              → infiniteScroll.init(totalCount)
```

## Virtual Scroll

The virtual list (`virtual-scroll.ts`) renders only the items visible in the viewport plus an overscan buffer, using absolute positioning within a height-sized container.

**Core math** (`computeVisibleRange`):

- `start = floor(scrollTop / itemHeight) - overscan`
- `end = ceil((scrollTop + viewportHeight) / itemHeight) + overscan`
- Clamped to `[0, totalCount)`

**DOM structure:**

```
<div class="virtual-scroll-container">
  <ul class="nearby-list virtual-scroll" style="height: {totalCount × itemHeight}px; position: relative">
    <li style="position: absolute; top: {i × itemHeight}px; height: {itemHeight}px">
      ...article content...
    </li>
    <!-- only items in [start, end) are rendered -->
  </ul>
</div>
```

**Scroll connection** (`connectScroll`): Listens to `scroll` events on the scroll container element (the `.app-scroll` wrapper), not `window`. Throttled via `requestAnimationFrame` — at most one `refresh()` per frame.

**Compressed mode:** For very large lists whose natural height (`totalCount * itemHeight`) exceeds browser scroll-height limits, the virtual list switches to compressed mode. The container height is capped at `MAX_SAFE_SCROLL_HEIGHT` (10,000,000 px — safely below Chrome's ~33M and Firefox's ~17.8M limits), and scroll position is mapped proportionally to a virtual index using a viewport-aware denominator:

```
viewportItems = ceil(viewportHeight / itemHeight)
fraction      = clamp(scrollTop / (MAX_SAFE_SCROLL_HEIGHT - viewportHeight), 0, 1)
exactIndex    = fraction * (totalCount - viewportItems)
```

Subtracting `viewportHeight` from the denominator is required because `scrollTop` can never reach `MAX_SAFE_SCROLL_HEIGHT` itself (the browser's scrollable range is capped at `MAX_SAFE_SCROLL_HEIGHT − viewportHeight`). Scaling the index range by `totalCount − viewportItems` ensures the final scroll frame lands on the last visible window rather than sailing past it. Compressed mode also **skips overscan**: items are repositioned every frame relative to the current scroll anchor, so the overscan buffer would be wasted. Items are positioned at natural spacing (`itemHeight` apart) anchored to the current scroll position, so scrolling remains visually smooth with no frame-to-frame jumps at index boundaries. In direct mode (small lists), items use absolute positioning at `i * itemHeight`.

**Constants:**

- `VIRTUAL_ITEM_HEIGHT = 68px`
- `overscan = 5` items above and below the viewport
- `MAX_SAFE_SCROLL_HEIGHT = 10,000,000px` — threshold for compressed mode

On each refresh, if the visible range changed, `onRangeChange` fires, which drives enrichment, map sync, and near-end detection.

## Data Model: ArticleWindow

`ArticleWindow` (`article-window.ts`) is a distance-windowed data model — a sparse map of `index → NearbyArticle` with async expansion. It has no DOM or network knowledge; those are injected via `ArticleProvider`.

**Key operations:**

- `getArticle(index)` — Synchronous lookup. Returns `undefined` for indices outside the loaded window.
- `ensureRange(start, end)` — Async. Fetches missing articles from the provider if `[start, end)` isn't fully loaded. Concurrent calls are serialized (second call waits for the first).
- `totalKnown()` — Total articles known to exist across all loaded tiles (from the provider's `totalAvailable`). May exceed `loadedCount` because tiles can contain articles beyond the contiguous fetched range.
- `loadedCount()` — The exclusive end of the contiguous loaded range.

**Eviction:** When the map exceeds `windowSize` (1000), articles are evicted from whichever end is farther from the requested range. This keeps memory bounded while allowing both forward and backward scrolling.

**Provider chain:**

```
ArticleWindow
  → TileRadiusProvider.fetchRange(start, end)
    → loadRing(ring)          // fetch tiles at Chebyshev distance `ring`
    → queryTiles(newTileIds)  // query only newly loaded tiles (not all tiles)
    → dedup against seenTitles set
    → mergeInto(fresh)        // merge fresh articles into cumulative sorted list
    → slice [start, end) from cumulative list
```

The `TileRadiusProvider` is **resumable**: it maintains a cumulative sorted list of all discovered articles and a `seenTitles` set for cross-ring deduplication. When a new ring is loaded, only its newly loaded tiles are queried (via `queryTiles(tileIds)`), and the results are deduped and merged into the existing list via a **merge tail** of `MERGE_TAIL_SIZE` (500) articles. Articles before the tail are finalized and never re-sorted; only the tail is re-sorted with incoming articles, handling the Chebyshev-vs-great-circle distance interleaving at ring boundaries.

The provider expands rings until it has enough articles to satisfy the request or reaches `MAX_RING` (the point where the entire grid is covered). Expansion continues past empty rings — a ring that loads no new tiles does not stop the search. Ring 0 is the user's tile; ring 1 is the 8 surrounding tiles; and so on. Tiles already loaded by the state machine are reused (not re-fetched).

## Near-End Detection and Expansion

The infinite scroll lifecycle (`infinite-scroll-lifecycle.ts`) detects when the user approaches the end of loaded content:

```
onRangeChange(range)
  → if !compressed
       && currentLoadedCount > 0
       && range.end >= currentLoadedCount - nearEndThreshold (100)
    → onNearEnd()
  → else
    → onVisibleRangeChange(range)
```

The gate compares `range.end` to **`currentLoadedCount`** (the real contiguous fetched range tracked by the lifecycle), not to the optimistic virtual-list height. The lifecycle's `update()` accepts an optional `loadedCount` argument that's forwarded from the scroll-count observer; when the optimistic count grows past the real loaded count, the gate stays anchored to the smaller value so near-end fires at the right moment.

**Compressed-mode skip:** In compressed mode the visible range lives in virtual-index space (mapped proportionally onto a capped scroll height), so `range.end` can sit arbitrarily far above `currentLoadedCount` and would fire near-end on every scroll event. The check is gated on `!virtualList.isCompressed()`. `onVisibleRangeChange` still fires in compressed mode and ensures data around the mapped window via `ensureRange`, so the prefetch optimization isn't needed there.

**Re-fetch on range change:** When near-end does NOT fire, `onVisibleRangeChange(range)` calls `ensureRange(start, end)` on the ArticleWindow. This re-fetches articles that were evicted from the ArticleWindow when the user scrolled away (the window has a bounded `windowSize` of 1000). The call is a no-op when the range is already loaded, so it is cheap on normal forward scrolls. When near-end DOES fire, `onVisibleRangeChange` is **skipped** — `onNearEnd`'s `ensureRange(start, end + PREFETCH_BUFFER)` is a strict superset of the unbuffered call, and both serialize on the same `pendingFetch` promise, so firing the unbuffered fetch first would just block the prefetch behind a redundant request.

**Backward-scroll prefetch:** `onVisibleRangeChange` in `infinite-scroll-wiring.ts` tracks `lastVisibleStart` across calls. When `range.start < lastVisibleStart` the user is scrolling backward, and the fetch start is padded by `BACKWARD_PREFETCH_BUFFER` (200): `ensureRange(max(0, range.start - 200), range.end)`. Forward scrolls rely on `onNearEnd`'s `PREFETCH_BUFFER` to stay ahead of the viewport, so they need no symmetric backward pad. The `lastSeenWindow` reference resets `lastVisibleStart` whenever `getCurrentWindow()` flips through `null` (during `resetArticleWindow()` between positions) so the backward heuristic doesn't carry across windows.

`onNearEnd` in `infinite-scroll-wiring.ts` handles two cases:

1. **ArticleWindow exists** — First optimistically expands the virtual list height by calling `applyOptimisticCount(aw.loadedCount())` on the article-window lifecycle. `applyOptimisticCount` enforces a never-shrink ratchet: `lastScrollCount = max(lastScrollCount, count)`, so the high-water mark can only grow while async fetches are in flight. The `nearEndThreshold` triggers `onNearEnd` before the user reaches the bottom, keeping the list growing ahead of scroll. Then calls `aw.ensureRange(range.start, range.end + PREFETCH_BUFFER)`. When the promise resolves, `onWindowChange` fires, which **bypasses the ratchet** and writes `lastScrollCount = articleWindow.loadedCount()` directly — allowing the count to settle to the real total so the list never extends past the last actual article.

2. **No ArticleWindow yet** — Dispatches `expandInfiniteScroll` to the state machine, which increments `infiniteScrollLimit` by `INFINITE_SCROLL_STEP` (200) and emits a `requery` effect.

**Constants:**

- `nearEndThreshold = 100` — trigger distance from the end (items)
- `PREFETCH_BUFFER = 200` — extra articles to prefetch beyond the visible range end
- `BACKWARD_PREFETCH_BUFFER = 200` — items to pad the fetch start when scrolling backward into evicted territory
- `INFINITE_SCROLL_INITIAL = 200` — articles loaded on first entry into infinite scroll
- `INFINITE_SCROLL_STEP = 200` — articles added per expansion
- `windowSize = 1000` — max articles in memory before eviction

## Enrichment and Map Sync

Two debounced side effects run on `onRangeChange`:

**Enrichment** (`enrich-scheduler.ts`): After the visible range settles for 300ms, enqueues visible articles for enrichment. In-flight requests are allowed to finish across range changes — the debounce already suppresses _new_ requests during active scrolling, and aborting mid-flight on slow networks just guarantees summaries never load. The `SummaryLoader`'s in-memory cache handles dedup, so previously fetched summaries return instantly on revisit without any local `enrichedSet` tracking. The scheduler has no position-change reset — it is destroyed with the infinite-scroll lifecycle (see "Lifecycle Management" below). The actual fetching is handled by `SummaryLoader` (`summary-loader.ts`), which manages a concurrency-limited queue (default 3 concurrent requests) with per-item callbacks, cancellation support, and priority boosting for viewport-visible items via `request()`.

**`SummaryLoader.request()` semantics:** When the title is already pending (queued by a prior `load()`), `request()` moves it to the **front** of the queue so viewport items beat off-screen items still waiting their turn. This is the core integration between the enrich scheduler and the loader — the scheduler doesn't reorder anything itself, it just prods `request()` for whatever is currently visible. When the title is a **cache hit**, `request()` is a no-op: it does NOT invoke `onSummary`. Callers that want the cached value must use `get()` explicitly. This stops scroll-settle from re-firing DOM patches over already-delivered items, which would otherwise reset hover state and re-run reconciliation on every scroll quiet point.

**Map sync** (`debounced-map-sync.ts`): After 150ms of scroll settle, syncs browse-map markers with the currently visible articles (rendered in the map drawer).

Both are created during `infiniteScroll.init()` and destroyed with the lifecycle.

## Lifecycle Management

The `InfiniteScrollLifecycle` (`infinite-scroll-lifecycle.ts`) bundles the virtual list, enrichment scheduler, map sync, and scroll listener as a single init/update/destroy lifecycle.

- **`init(totalCount, loadedCount?)`** — Clears the container, renders the header, creates the virtual list and sub-components, connects scroll events. The optional `loadedCount` seeds `currentLoadedCount`, the comparand the near-end gate checks; when omitted it defaults to `totalCount`, which suppresses near-end firing until `update()` supplies a real loaded count.
- **`update(totalCount, loadedCount?)`** — Refreshes the header and virtual list with new data. Called when `loadedCount` changes (articles fetched) or when the article list changes (requery). The optional `loadedCount` is forwarded from the scroll-count observer so `currentLoadedCount` tracks the real contiguous fetched range rather than the optimistic list height. When omitted, the prior value is retained.
- **`updateHeader()`** — Replaces only the header element. Used by `renderBrowsingHeaderDOM` when GPS updates arrive while scroll-paused (avoids rebuilding the list, which would destroy hover states).
- **`destroy()`** — Tears down all sub-components and listeners.

The `ArticleWindowLifecycle` (`article-window-lifecycle.ts`) manages the ArticleWindow instance and its AbortController. It delegates construction to `ArticleWindowFactory` (`article-window-factory.ts`), which wires up the `TileRadiusProvider` with tile-merging logic and returns a ready-to-use `ArticleWindow`. This factory/lifecycle separation keeps the provider wiring (pure construction) independent from the reset/create orchestration and state machine integration. The lifecycle's `onWindowChange` callback connects the data model to the DOM: when articles load, it writes `lastScrollCount = articleWindow.loadedCount()` directly (no ratchet), allowing the count to settle to the real total so the list never extends past the last actual article. The separate `applyOptimisticCount` path enforces the never-shrink ratchet for pre-fetch headroom on `onNearEnd`. The lifecycle's `getArticleByIndex` falls back to viewport articles when the ArticleWindow hasn't loaded the requested index yet, ensuring smooth content during the transition to infinite scroll.

## Scroll Mode Transitions

The state machine tracks `scrollMode: "infinite" | "viewport"` on the browsing phase:

| Transition                  | scrollMode | Trigger                                |
| --------------------------- | ---------- | -------------------------------------- |
| GPS + not paused            | `viewport` | Default for live tracking              |
| User scrolls past threshold | `infinite` | `scrollPause` event                    |
| User manually pauses        | `infinite` | `togglePause` (pause)                  |
| User resumes (unpauses)     | `viewport` | `togglePause` (resume) + scroll to top |
| Picked position             | `infinite` | `computeScrollMode("picked", *)`       |
| Switch to GPS               | `viewport` | `useGps` event                         |

When transitioning from `infinite` → `viewport` (resume), the state machine emits `scrollToTop` to reset the scroll position, since viewport mode is a short, GPS-updated list.

When transitioning from `viewport` → `infinite` (scroll-pause), `renderBrowsingListDOM` tears down the viewport list and initializes the infinite scroll lifecycle.

## Scroll Headroom: Avoiding the Bottom Boundary

When transitioning from viewport mode to infinite scroll (e.g., the user scrolls past 136px in live-location mode), articles load asynchronously. Without headroom, the user could hit the bottom of the virtual list before new articles arrive, causing a jarring "bump."

Three mechanisms prevent this:

1. **Optimistic initial height** — `renderInfiniteScrollDOM()` sets `totalCount = loadedCount > 0 ? loadedCount : articles.length`, so the virtual list starts with a reasonable height from the first batch of data, avoiding the empty-list jump.

   This fallback is deliberately **truth-first**: if only 30 articles exist synchronously near the user (sparse region, or the state-machine tile cache has only returned a handful), the list renders at 30 rows rather than padding to a fixed floor. Earlier code used `max(loadedCount, articles.length, infiniteScrollLimit)` as the fallback, which guaranteed at least 200 rows of headroom but also showed phantom rows past the last real article in sparse regions. The trade-off was resolved in favor of accuracy: a user in a genuinely sparse region may briefly bonk the bottom before `onNearEnd` expands the window via `ensureRange`, but never sees empty rows beyond real content. In typical (moderately dense) areas with warm tiles, `articles.length` is already well above 100 and the bonk is unreachable.

2. **Optimistic expansion on near-end** — When `onNearEnd` fires and an ArticleWindow exists, the wiring calls `applyOptimisticCount(aw.loadedCount())` on the lifecycle _before_ the async `ensureRange()` call. `applyOptimisticCount` enforces a **never-shrink ratchet**: `lastScrollCount = Math.max(lastScrollCount, count)`, so the high-water mark only grows and the list height cannot shrink while fetches are in flight. The `nearEndThreshold` triggers expansion before the user reaches the bottom, keeping the list growing ahead of scroll. This gives the user scroll space while tiles load.

3. **`loadedCount` in `onWindowChange`** — When tiles finish loading, the callback writes `lastScrollCount = articleWindow.loadedCount()` directly. Unlike `applyOptimisticCount`, `onWindowChange` does _not_ ratchet: it sets `lastScrollCount` to the real contiguous fetched range, allowing the count to settle to the real total so the list never extends past the last actual article. Since `totalKnown` and `loadedCount` only grow as more tiles are discovered, `loadedCount` is monotonically non-decreasing — no scroll-jump risk. The high-water mark resets on `resetArticleWindow` (new position or query).

## See Also

- [State Machine](state-machine.md) — `scrollPause`, `expandInfiniteScroll`, and `togglePause` transitions
- [Architecture Overview](architecture.md) — End-to-end system design
- [Tiling Strategy](tiling.md) — Geographic tiling and on-demand loading
