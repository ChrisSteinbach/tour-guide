# Infinite Scroll

The app uses virtual infinite scroll to display articles sorted by distance. Instead of the old tier-based "Show more" button, articles load progressively as the user scrolls, with tiles fetched on demand in expanding rings around the user's position.

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

**Scroll connection** (`connectScroll`): Listens to `scroll` events on `window`. Throttled via `requestAnimationFrame` — at most one `refresh()` per frame.

**Constants:**

- `VIRTUAL_ITEM_HEIGHT = 68px`
- `overscan = 5` items above and below the viewport

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
    → queryAllTiles()         // merge all loaded tiles, findNearestTiled(99999) (effectively unlimited)
    → sort by distance, slice [start, end)
```

The `TileRadiusProvider` expands rings until it has enough articles to satisfy the request or reaches `MAX_RING` (the point where the entire grid is covered). Expansion continues past empty rings — a ring that loads no new tiles does not stop the search. Ring 0 is the user's tile; ring 1 is the 8 surrounding tiles; and so on. Tiles already loaded by the state machine are reused (not re-fetched).

## Near-End Detection and Expansion

The infinite scroll lifecycle detects when the user approaches the end of loaded content:

```
onRangeChange(range)
  → if range.end >= currentTotalCount - nearEndThreshold (100)
    → onNearEnd()
```

`onNearEnd` in `main.ts` handles two cases:

1. **ArticleWindow exists** — First optimistically expands the virtual list height via `computeOptimisticCount(totalKnown, loadedCount, PREFETCH_BUFFER, MAX_OPTIMISTIC_LIMIT)` so the user never hits the bottom while the async fetch is in flight: if `totalKnown > loadedCount`, uses `totalKnown`; otherwise caps at `min(loadedCount + PREFETCH_BUFFER, MAX_OPTIMISTIC_LIMIT)`. Then calls `aw.ensureRange(range.start, range.end + PREFETCH_BUFFER)`. When the promise resolves, `onWindowChange` fires, which updates the list height to `max(totalKnown, loadedCount)` — but never below the previous count (see "Scroll Headroom" below).

2. **No ArticleWindow yet** — Dispatches `expandInfiniteScroll` to the state machine, which increments `infiniteScrollLimit` by `INFINITE_SCROLL_STEP` (200) and emits a `requery` effect.

**Constants:**

- `nearEndThreshold = 100` — trigger distance from the end (items)
- `PREFETCH_BUFFER = 200` — extra articles to prefetch beyond the visible range end
- `MAX_OPTIMISTIC_LIMIT = 5000` — upper bound for optimistic scroll expansion when `totalKnown` is unknown
- `INFINITE_SCROLL_INITIAL = 200` — articles loaded on first entry into infinite scroll
- `INFINITE_SCROLL_STEP = 200` — articles added per expansion
- `windowSize = 1000` — max articles in memory before eviction

## Enrichment and Map Sync

Two debounced side effects run on `onRangeChange`:

**Enrichment** (`enrich-scheduler.ts`): After the visible range settles for 300ms, fetches Wikipedia summaries for visible articles. Tracks already-enriched titles to avoid duplicate requests. Resets on position change. The actual fetching is handled by `SummaryLoader` (`summary-loader.ts`), which manages a concurrency-limited queue (default 3 concurrent requests) with per-item callbacks, cancellation support, and priority boosting for viewport-visible items via `request()`.

**Map sync** (`debounced-map-sync.ts`): After 150ms of scroll settle, syncs browse-map markers with the currently visible articles (rendered in the map drawer).

Both are created during `infiniteScroll.init()` and destroyed with the lifecycle.

## Lifecycle Management

The `InfiniteScrollLifecycle` (`infinite-scroll-lifecycle.ts`) bundles the virtual list, enrichment scheduler, map sync, and scroll listener as a single init/update/destroy lifecycle.

- **`init(totalCount)`** — Clears the container, renders the header, creates the virtual list and sub-components, connects scroll events.
- **`update(totalCount)`** — Refreshes the header and virtual list with new data. Called when `loadedCount` changes (articles fetched) or when the article list changes (requery).
- **`updateHeader()`** — Replaces only the header element. Used by `renderBrowsingHeaderDOM` when GPS updates arrive while scroll-paused (avoids rebuilding the list, which would destroy hover states).
- **`destroy()`** — Tears down all sub-components and listeners.

The `ArticleWindowLifecycle` (`article-window-lifecycle.ts`) manages the ArticleWindow instance and its AbortController. It delegates construction to `ArticleWindowFactory` (`article-window-factory.ts`), which wires up the `TileRadiusProvider` with tile-merging logic and returns a ready-to-use `ArticleWindow`. This factory/lifecycle separation keeps the provider wiring (pure construction) independent from the reset/create orchestration and state machine integration. The lifecycle's `onWindowChange` callback connects the data model to the DOM: when articles load, it updates the list height to `max(totalKnown, loadedCount)` but never below the previous count (never-shrink invariant), using the larger of `totalKnown` (all articles from loaded tiles) and `loadedCount` (contiguous fetched range) to provide scroll headroom. The lifecycle's `getArticleByIndex` falls back to viewport articles when the ArticleWindow hasn't loaded the requested index yet, ensuring smooth content during the transition to infinite scroll.

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

1. **Optimistic initial height** — `renderInfiniteScrollDOM()` sets `totalCount = max(loadedCount, articles.length, infiniteScrollLimit)`, so the virtual list starts tall enough to cover the scroll-pause transition even before the ArticleWindow has fetched data.

2. **Optimistic expansion on near-end** — When `onNearEnd` fires and an ArticleWindow exists, `computeOptimisticCount` immediately expands the list height _before_ the async `ensureRange()` call. If `totalKnown > loadedCount`, uses `totalKnown`; otherwise caps at `min(loadedCount + PREFETCH_BUFFER, MAX_OPTIMISTIC_LIMIT)`. This gives the user scroll space while tiles load.

3. **`totalKnown` in `onWindowChange`** — When tiles finish loading, the callback uses `max(totalKnown, loadedCount)` rather than just `loadedCount`. Since `totalKnown` reflects all articles across loaded tiles (not just the contiguous fetched window), this provides headroom for the next scroll burst. The callback also enforces a **never-shrink invariant**: `lastScrollCount` tracks the high-water mark, and `update()` always receives `max(lastScrollCount, realCount)`. This prevents scroll jumps when the optimistic count overshoots reality (e.g., the user is scrolled to position 100 but only 80 articles ultimately load). The high-water mark resets on `resetArticleWindow` (new position or query).

## See Also

- [State Machine](state-machine.md) — `scrollPause`, `expandInfiniteScroll`, and `togglePause` transitions
- [Architecture Overview](architecture.md) — End-to-end system design
- [Tiling Strategy](tiling.md) — Geographic tiling and on-demand loading
