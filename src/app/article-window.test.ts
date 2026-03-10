import { createArticleWindow, type ArticleProvider } from "./article-window";
import type { NearbyArticle } from "./types";

function makeArticle(index: number): NearbyArticle {
  return {
    title: `Article ${index}`,
    lat: 0,
    lon: 0,
    distanceM: index * 100,
  };
}

/** A simple provider that returns articles from a pre-built array. */
function fakeProvider(articles: NearbyArticle[]): ArticleProvider {
  return {
    fetchRange: async (start, end) => ({
      articles: articles.slice(start, Math.min(end, articles.length)),
      totalAvailable: articles.length,
    }),
  };
}

describe("ArticleWindow", () => {
  // ── Basic reads ────────────────────────────────────────────

  it("returns undefined before any data is loaded", () => {
    const window = createArticleWindow(fakeProvider([]), {
      windowSize: 100,
    });
    expect(window.getArticle(0)).toBeUndefined();
  });

  it("returns articles after ensureRange loads them", async () => {
    const articles = Array.from({ length: 20 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
    });

    await window.ensureRange(0, 10);

    expect(window.getArticle(0)?.title).toBe("Article 0");
    expect(window.getArticle(9)?.title).toBe("Article 9");
  });

  it("returns undefined for indices outside the loaded window", async () => {
    const articles = Array.from({ length: 20 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
    });

    await window.ensureRange(0, 10);

    expect(window.getArticle(15)).toBeUndefined();
  });

  // ── Forward expansion ──────────────────────────────────────

  it("expands forward when ensureRange requests more data", async () => {
    const articles = Array.from({ length: 50 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
    });

    await window.ensureRange(0, 10);
    await window.ensureRange(5, 20);

    expect(window.getArticle(19)?.title).toBe("Article 19");
  });

  it("does not re-fetch already loaded range", async () => {
    const articles = Array.from({ length: 20 }, (_, i) => makeArticle(i));
    let fetchCount = 0;
    const provider: ArticleProvider = {
      fetchRange: async (start, end) => {
        fetchCount++;
        return {
          articles: articles.slice(start, Math.min(end, articles.length)),
          totalAvailable: articles.length,
        };
      },
    };
    const window = createArticleWindow(provider, { windowSize: 100 });

    await window.ensureRange(0, 10);
    await window.ensureRange(0, 10); // same range

    expect(fetchCount).toBe(1);
  });

  it("fetches only the missing portion when expanding", async () => {
    const articles = Array.from({ length: 30 }, (_, i) => makeArticle(i));
    const fetchedRanges: [number, number][] = [];
    const provider: ArticleProvider = {
      fetchRange: async (start, end) => {
        fetchedRanges.push([start, end]);
        return {
          articles: articles.slice(start, Math.min(end, articles.length)),
          totalAvailable: articles.length,
        };
      },
    };
    const window = createArticleWindow(provider, { windowSize: 100 });

    await window.ensureRange(0, 10);
    await window.ensureRange(5, 20);

    // Second fetch should only request [10, 20), not [0, 20)
    expect(fetchedRanges).toEqual([
      [0, 10],
      [10, 20],
    ]);
  });

  // ── Eviction ───────────────────────────────────────────────

  it("evicts oldest articles when window exceeds windowSize", async () => {
    const articles = Array.from({ length: 200 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 50,
    });

    await window.ensureRange(0, 50);
    expect(window.getArticle(0)?.title).toBe("Article 0");

    // Load more, pushing past the window size
    await window.ensureRange(40, 80);

    // Old articles should be evicted
    expect(window.getArticle(0)).toBeUndefined();
    // New articles should be present
    expect(window.getArticle(79)?.title).toBe("Article 79");
  });

  it("can re-fetch evicted articles by scrolling back", async () => {
    const articles = Array.from({ length: 200 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 50,
    });

    await window.ensureRange(0, 50);
    await window.ensureRange(40, 80); // evicts early articles

    expect(window.getArticle(0)).toBeUndefined();

    await window.ensureRange(0, 20); // scroll back up
    expect(window.getArticle(0)?.title).toBe("Article 0");
  });

  // ── totalKnown ─────────────────────────────────────────────

  it("reports totalKnown as 0 before any fetch", () => {
    const window = createArticleWindow(fakeProvider([]), {
      windowSize: 100,
    });
    expect(window.totalKnown()).toBe(0);
  });

  it("updates totalKnown after fetch", async () => {
    const articles = Array.from({ length: 75 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
    });

    await window.ensureRange(0, 10);
    expect(window.totalKnown()).toBe(75);
  });

  // ── Reset ──────────────────────────────────────────────────

  it("clears all data on reset", async () => {
    const articles = Array.from({ length: 20 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
    });

    await window.ensureRange(0, 10);
    window.reset();

    expect(window.getArticle(0)).toBeUndefined();
    expect(window.totalKnown()).toBe(0);
  });

  // ── Callback ───────────────────────────────────────────────

  it("fires onWindowChange when data loads", async () => {
    const articles = Array.from({ length: 20 }, (_, i) => makeArticle(i));
    const changes: Array<{ start: number; end: number }> = [];
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
      onWindowChange: (start, end) => changes.push({ start, end }),
    });

    await window.ensureRange(0, 10);

    expect(changes).toEqual([{ start: 0, end: 10 }]);
  });

  // ── Edge cases ─────────────────────────────────────────────

  it("handles request beyond available data gracefully", async () => {
    const articles = Array.from({ length: 5 }, (_, i) => makeArticle(i));
    const window = createArticleWindow(fakeProvider(articles), {
      windowSize: 100,
    });

    await window.ensureRange(0, 20);

    expect(window.getArticle(4)?.title).toBe("Article 4");
    expect(window.getArticle(5)).toBeUndefined();
    expect(window.totalKnown()).toBe(5);
  });

  it("handles concurrent ensureRange calls without duplicating data", async () => {
    const articles = Array.from({ length: 30 }, (_, i) => makeArticle(i));
    let fetchCount = 0;
    const provider: ArticleProvider = {
      fetchRange: async (start, end) => {
        fetchCount++;
        return {
          articles: articles.slice(start, Math.min(end, articles.length)),
          totalAvailable: articles.length,
        };
      },
    };
    const window = createArticleWindow(provider, { windowSize: 100 });

    // Two identical requests at the same time — second awaits first, then skips
    await Promise.all([window.ensureRange(0, 15), window.ensureRange(0, 15)]);

    expect(fetchCount).toBe(1);
    expect(window.getArticle(14)?.title).toBe("Article 14");
  });

  it("serializes overlapping-but-different concurrent requests", async () => {
    const articles = Array.from({ length: 30 }, (_, i) => makeArticle(i));
    const fetchedRanges: [number, number][] = [];
    const provider: ArticleProvider = {
      fetchRange: async (start, end) => {
        fetchedRanges.push([start, end]);
        return {
          articles: articles.slice(start, Math.min(end, articles.length)),
          totalAvailable: articles.length,
        };
      },
    };
    const window = createArticleWindow(provider, { windowSize: 100 });

    // Two overlapping but different ranges fired concurrently
    await Promise.all([window.ensureRange(0, 10), window.ensureRange(5, 20)]);

    // First fetches [0,10), second awaits it then fetches only the gap [10,20)
    expect(fetchedRanges).toEqual([
      [0, 10],
      [10, 20],
    ]);
    // Both ranges are fully loaded
    expect(window.getArticle(0)?.title).toBe("Article 0");
    expect(window.getArticle(19)?.title).toBe("Article 19");
  });
});
