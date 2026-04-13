import { createEnrichScheduler } from "./enrich-scheduler";

describe("EnrichScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not enrich immediately on range change", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });

    expect(enriched).toEqual([]);
  });

  it("enriches after settle period", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(200);

    expect(enriched).toEqual(["Article 0", "Article 1", "Article 2"]);
  });

  it("resets timer when range changes before settling", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(150); // not settled yet
    scheduler.onRangeChange({ start: 5, end: 8 }); // scroll! reset timer

    vi.advanceTimersByTime(150); // 150ms after second change — still not settled
    expect(enriched).toEqual([]);

    vi.advanceTimersByTime(50); // 200ms after second change — now settled
    expect(enriched).toEqual(["Article 5", "Article 6", "Article 7"]);
  });

  it("skips articles that getTitle returns null for", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => (i === 1 ? null : `Article ${i}`),
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(200);

    expect(enriched).toEqual(["Article 0", "Article 2"]);
  });

  it("re-enriches on revisit (dedup is the summary loader's job)", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(200);

    // Scroll away and back
    scheduler.onRangeChange({ start: 10, end: 13 });
    vi.advanceTimersByTime(200);

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(200);

    // Articles 0-2 appear twice — the summary loader's cache deduplicates
    // at the HTTP level, so the enrich() call is cheap on revisit.
    const firstThree = enriched.filter((t) =>
      ["Article 0", "Article 1", "Article 2"].includes(t),
    );
    expect(firstThree).toEqual([
      "Article 0",
      "Article 1",
      "Article 2",
      "Article 0",
      "Article 1",
      "Article 2",
    ]);
  });

  it("cleans up on destroy", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    scheduler.destroy();
    vi.advanceTimersByTime(200);

    expect(enriched).toEqual([]);
  });
});
