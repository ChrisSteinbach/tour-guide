// Scroll-pause detector: fires a callback when the user scrolls
// past a configurable threshold. Listens to both a primary scroll
// source and an optional container (desktop split-view).

/** Minimal interface for an event target we attach scroll listeners to. */
interface ScrollTarget {
  addEventListener(
    type: string,
    handler: () => void,
    options?: { passive?: boolean },
  ): void;
  removeEventListener(type: string, handler: () => void): void;
}

export interface ScrollPauseOptions {
  /** Pixel threshold before triggering. */
  threshold: number;
  /** Called once when scroll passes the threshold. */
  onPause: () => void;
  /** Primary scroll source (default: window). */
  scrollSource?: ScrollTarget & { scrollY?: number };
  /** Optional container element for split-view scroll. */
  container?: ScrollTarget & {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  };
}

export interface ScrollPauseDetector {
  /** Remove all scroll listeners. */
  destroy: () => void;
}

export function createScrollPauseDetector(
  options: ScrollPauseOptions,
): ScrollPauseDetector {
  const { threshold, onPause } = options;
  const cleanups: (() => void)[] = [];
  let fired = false;

  function trigger(): void {
    if (fired) return;
    fired = true;
    destroy();
    onPause();
  }

  function destroy(): void {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  }

  // Primary scroll source (window)
  const scrollSource = options.scrollSource ?? window;
  const windowHandler = () => {
    const scrollY =
      "scrollY" in scrollSource
        ? (scrollSource as { scrollY: number }).scrollY
        : 0;
    if (scrollY > threshold) trigger();
  };
  scrollSource.addEventListener("scroll", windowHandler, { passive: true });
  cleanups.push(() =>
    scrollSource.removeEventListener("scroll", windowHandler),
  );

  // Container scroll (desktop split-view)
  if (options.container) {
    const container = options.container;
    if (container.scrollHeight > container.clientHeight) {
      const containerHandler = () => {
        if (container.scrollTop > threshold) trigger();
      };
      container.addEventListener("scroll", containerHandler, { passive: true });
      cleanups.push(() =>
        container.removeEventListener("scroll", containerHandler),
      );
    }
  }

  return { destroy };
}
