# Infinite Scroll

The app uses virtual infinite scroll to display articles sorted by distance. Instead of the old tier-based "Show more" button, articles load progressively as the user scrolls, with tiles fetched on demand in expanding rings around the user's position.

The system spans six modules, each handling one concern:

| Module                         | Concern                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `virtual-scroll.ts`            | Viewport math, overscan buffer, RAF-throttled rendering                   |
| `infinite-scroll-lifecycle.ts` | Orchestrates virtual list, enrichment, map sync as a single lifecycle     |
| `article-window.ts`            | Distance-windowed data model with async expansion                         |
| `article-window-lifecycle.ts`  | ArticleWindow creation, reset, and coordination with infinite scroll      |
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

**Scroll connection** (`connectScroll`): Listens to `scroll` events on either `window` (mobile) or a container element (desktop split-view). Throttled via `requestAnimationFrame` — at most one `refresh()` per frame.

**Constants:**

- `VIRTUAL_ITEM_HEIGHT = 68px`
- `overscan = 5` items above and below the viewport

On each refresh, if the visible range changed, `onRangeChange` fires, which drives enrichment, map sync, and near-end detection.

## Data Model: ArticleWindow

`ArticleWindow` (`article-window.ts`) is a distance-windowed data model — a sparse map of `index → NearbyArticle` with async expansion. It has no DOM or network knowledge; those are injected via `ArticleProvider`.

**Key operations:**

- `getArticle(index)` — Synchronous lookup. Returns `undefined` for indices outside the loaded window.
- `ensureRange(start, end)` — Async. Fetches missing articles from the provider if `[start, end)` isn't fully loaded. Concurrent calls are serialized (second call waits for the first).
- `loadedCount()` — The exclusive end of the contiguous loaded range. This is what sets the virtual list's `totalCount`.

**Eviction:** When the map exceeds `windowSize` (1000), articles are evicted from whichever end is farther from the requested range. This keeps memory bounded while allowing both forward and backward scrolling.

**Provider chain:**

```
ArticleWindow
  → TileRadiusProvider.fetchRange(start, end)
    → loadRing(ring)          // fetch tiles at Chebyshev distance `ring`
    → queryAllTiles()         // merge all loaded tiles, findNearestTiled(99999)
    → sort by distance, slice [start, end)
```

The `TileRadiusProvider` expands rings until it has enough articles to satisfy the request or runs out of tiles. Ring 0 is the user's tile; ring 1 is the 8 surrounding tiles; and so on. Tiles already loaded by the state machine are reused (not re-fetched).

## Near-End Detection and Expansion

The infinite scroll lifecycle detects when the user approaches the end of loaded content:

```
onRangeChange(range)
  → if range.end >= currentTotalCount - nearEndThreshold (50)
    → onNearEnd()
```

`onNearEnd` in `main.ts` handles two cases:

1. **ArticleWindow exists** — Calls `aw.ensureRange(range.start, range.end + 200)`. This is async: the provider may need to load new tile rings. When the promise resolves, `onWindowChange` fires, which calls `infiniteScroll.update(loadedCount)` to expand the virtual list height.

2. **No ArticleWindow yet** — Dispatches `expandInfiniteScroll` to the state machine, which increments `infiniteScrollLimit` by `INFINITE_SCROLL_STEP` (200) and emits a `requery` effect.

**Constants:**

- `nearEndThreshold = 50` — trigger distance from the end
- `INFINITE_SCROLL_INITIAL = 200` — articles loaded on first entry into infinite scroll
- `INFINITE_SCROLL_STEP = 200` — articles added per expansion
- `windowSize = 1000` — max articles in memory before eviction

## Enrichment and Map Sync

Two debounced side effects run on `onRangeChange`:

**Enrichment** (`enrich-scheduler.ts`): After the visible range settles for 300ms, fetches Wikipedia summaries for visible articles. Tracks already-enriched titles to avoid duplicate requests. Resets on position change.

**Map sync** (`debounced-map-sync.ts`): After 150ms of scroll settle, syncs browse-map markers with the currently visible articles. Desktop only.

Both are created during `infiniteScroll.init()` and destroyed with the lifecycle.

## Lifecycle Management

The `InfiniteScrollLifecycle` (`infinite-scroll-lifecycle.ts`) bundles the virtual list, enrichment scheduler, map sync, and scroll listener as a single init/update/destroy lifecycle.

- **`init(totalCount)`** — Clears the container, renders the header, creates the virtual list and sub-components, connects scroll events.
- **`update(totalCount)`** — Refreshes the header and virtual list with new data. Called when `loadedCount` changes (articles fetched) or when the article list changes (requery).
- **`updateHeader()`** — Replaces only the header element. Used by `renderBrowsingHeaderDOM` when GPS updates arrive while scroll-paused (avoids rebuilding the list, which would destroy hover states).
- **`destroy()`** — Tears down all sub-components and listeners.

The `ArticleWindowLifecycle` (`article-window-lifecycle.ts`) manages the ArticleWindow instance and its AbortController. Its `onWindowChange` callback connects the data model to the DOM: when articles load, it calls `infiniteScroll.update(loadedCount)`.

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

## Known Issue: Scroll Bump on Fast Scroll

When scrolling fast in live-location mode, there is a brief "bump" — the scroll hits the bottom of the virtual list before new articles load.

**Sequence:**

1. User scrolls past 136px → `scrollPause` fires → state machine emits `requery(200)`
2. `requery` runs `getNearby(200)` synchronously → `queryResult` → `renderBrowsingList`
3. `renderInfiniteScrollDOM()` calls `infiniteScroll.init(totalCount)` where `totalCount` comes from `loadedCount()` or `articles.length`
4. Virtual list height = `totalCount × 68px`
5. User continues scrolling → `onNearEnd()` fires → `ensureRange()` starts async fetch
6. **Gap:** async fetch is in flight, but virtual list height hasn't expanded yet
7. User scrolls to the bottom boundary → bump
8. Fetch completes → `onWindowChange` → `infiniteScroll.update(newCount)` → list expands
9. Bump resolves

Tracked in [tour-guide-ea1](../tour-guide-ea1).

## See Also

- [State Machine](state-machine.md) — `scrollPause`, `expandInfiniteScroll`, and `togglePause` transitions
- [Architecture Overview](architecture.md) — End-to-end system design
- [Tiling Strategy](tiling.md) — Geographic tiling and on-demand loading
