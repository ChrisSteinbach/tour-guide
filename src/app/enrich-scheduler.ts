// Viewport-aware enrichment scheduler.
// Debounces visible range changes and triggers enrichment only
// after articles settle in view. Pure timing logic — no DOM, no network.

import type { VisibleRange } from "./virtual-scroll";

export interface EnrichSchedulerOptions {
  /** How long articles must be visible before enrichment triggers. */
  settleMs: number;
  /** Map an index to an article title, or null if not available. */
  getTitle: (index: number) => string | null;
  /** Enrich a single article by title. */
  enrich: (title: string) => void;
  /** Cancel all in-flight enrichment (optional). */
  cancel?: () => void;
}

export interface EnrichScheduler {
  /** Called when the virtual scroll's visible range changes. */
  onRangeChange: (range: VisibleRange) => void;
  /** Clear enrichment state (e.g., on position change). */
  reset: () => void;
  /** Stop all timers and clean up. */
  destroy: () => void;
}

export function createEnrichScheduler(
  options: EnrichSchedulerOptions,
): EnrichScheduler {
  const { settleMs, getTitle, enrich, cancel } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let enrichedSet = new Set<string>();
  let hasEnrichedAny = false;
  let destroyed = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function onRangeChange(range: VisibleRange): void {
    if (destroyed) return;

    // Cancel previous enrichment if we had already settled
    if (hasEnrichedAny) {
      cancel?.();
      hasEnrichedAny = false;
    }

    clearTimer();

    timer = setTimeout(() => {
      if (destroyed) return;
      for (let i = range.start; i < range.end; i++) {
        const title = getTitle(i);
        if (title && !enrichedSet.has(title)) {
          enrichedSet.add(title);
          enrich(title);
        }
      }
      hasEnrichedAny = true;
    }, settleMs);
  }

  return {
    onRangeChange,

    reset() {
      clearTimer();
      enrichedSet = new Set();
      hasEnrichedAny = false;
    },

    destroy() {
      destroyed = true;
      clearTimer();
    },
  };
}
