import { createEnrichScheduler } from "./enrich-scheduler";

describe("EnrichScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("does not cancel in-flight enrichment when range changes", () => {
    const cancelCalls: number[] = [];
    let callCount = 0;
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: () => {},
      cancel: () => cancelCalls.push(++callCount),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(200); // settles, enriches 0-2

    scheduler.onRangeChange({ start: 10, end: 13 }); // scroll away
    expect(cancelCalls).toEqual([]); // in-flight requests should complete
  });

  it("calls cancel on reset", () => {
    const cancelCalls: number[] = [];
    let callCount = 0;
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: () => {},
      cancel: () => cancelCalls.push(++callCount),
    });

    scheduler.onRangeChange({ start: 0, end: 3 });
    vi.advanceTimersByTime(200);

    scheduler.reset();
    expect(cancelCalls).toEqual([1]);
  });

  it("does not re-enrich already enriched articles", () => {
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

    // Articles 0-2 should appear only once
    const firstThree = enriched.filter((t) =>
      ["Article 0", "Article 1", "Article 2"].includes(t),
    );
    expect(firstThree).toEqual(["Article 0", "Article 1", "Article 2"]);
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

  it("resets enriched set on reset", () => {
    const enriched: string[] = [];
    const scheduler = createEnrichScheduler({
      settleMs: 200,
      getTitle: (i) => `Article ${i}`,
      enrich: (title) => enriched.push(title),
    });

    scheduler.onRangeChange({ start: 0, end: 2 });
    vi.advanceTimersByTime(200);
    expect(enriched).toEqual(["Article 0", "Article 1"]);

    scheduler.reset();

    scheduler.onRangeChange({ start: 0, end: 2 });
    vi.advanceTimersByTime(200);
    // Should re-enrich after reset
    expect(enriched).toEqual([
      "Article 0",
      "Article 1",
      "Article 0",
      "Article 1",
    ]);
  });
});
