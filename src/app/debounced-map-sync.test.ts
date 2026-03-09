import { createDebouncedMapSync } from "./debounced-map-sync";

describe("createDebouncedMapSync", () => {
  it("calls syncMarkers after settleMs with visible articles", () => {
    vi.useFakeTimers();
    const synced: unknown[][] = [];
    const articles = ["a", "b", "c"];
    const mapSync = createDebouncedMapSync({
      settleMs: 150,
      getVisibleArticles: (range) => articles.slice(range.start, range.end),
      syncMarkers: (a) => synced.push(a),
    });

    mapSync.sync({ start: 0, end: 2 });
    expect(synced).toEqual([]);

    vi.advanceTimersByTime(150);
    expect(synced).toEqual([["a", "b"]]);
    vi.useRealTimers();
  });

  it("debounces: only the last sync fires", () => {
    vi.useFakeTimers();
    const synced: unknown[][] = [];
    const articles = ["a", "b", "c", "d"];
    const mapSync = createDebouncedMapSync({
      settleMs: 100,
      getVisibleArticles: (range) => articles.slice(range.start, range.end),
      syncMarkers: (a) => synced.push(a),
    });

    mapSync.sync({ start: 0, end: 1 });
    vi.advanceTimersByTime(50);
    mapSync.sync({ start: 1, end: 3 });
    vi.advanceTimersByTime(100);

    expect(synced).toEqual([["b", "c"]]);
    vi.useRealTimers();
  });

  it("skips sync when getVisibleArticles returns null", () => {
    vi.useFakeTimers();
    const synced: unknown[][] = [];
    const mapSync = createDebouncedMapSync({
      settleMs: 50,
      getVisibleArticles: () => null,
      syncMarkers: (a) => synced.push(a),
    });

    mapSync.sync({ start: 0, end: 5 });
    vi.advanceTimersByTime(50);
    expect(synced).toEqual([]);
    vi.useRealTimers();
  });

  it("cancel prevents pending sync from firing", () => {
    vi.useFakeTimers();
    const synced: unknown[][] = [];
    const mapSync = createDebouncedMapSync({
      settleMs: 100,
      getVisibleArticles: (range) => [range.start],
      syncMarkers: (a) => synced.push(a),
    });

    mapSync.sync({ start: 0, end: 1 });
    vi.advanceTimersByTime(50);
    mapSync.cancel();
    vi.advanceTimersByTime(100);
    expect(synced).toEqual([]);
    vi.useRealTimers();
  });
});
