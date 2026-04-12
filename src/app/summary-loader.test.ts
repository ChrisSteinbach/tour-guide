import type { ArticleSummary } from "./wiki-api";
import type { SummaryLoaderDeps } from "./summary-loader";
import { createSummaryLoader } from "./summary-loader";

function makeSummary(title: string): ArticleSummary {
  return {
    title,
    extract: `About ${title}`,
    description: "",
    thumbnailUrl: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    pageUrl: `https://en.wikipedia.org/wiki/${title}`,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSummaryLoader", () => {
  it("fetches summaries and calls onSummary for each", async () => {
    const results: [string, ArticleSummary][] = [];
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: (title, summary) => results.push([title, summary]),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A", "B"], "en");
    await vi.waitFor(() => expect(results).toHaveLength(2));

    expect(results.map(([t]) => t)).toEqual(["A", "B"]);
    expect(deps.fetch).toHaveBeenCalledWith("A", "en");
    expect(deps.fetch).toHaveBeenCalledWith("B", "en");
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: 5 }, () => deferred<ArticleSummary>());
    let callIdx = 0;

    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(() => {
        const gate = gates[callIdx++];
        active++;
        maxActive = Math.max(maxActive, active);
        return gate.promise.finally(() => {
          active--;
        });
      }),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps, 2);

    loader.load(["A", "B", "C", "D", "E"], "en");

    // Wait for first two to start
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(2));
    expect(active).toBe(2);

    // Resolve first, should start third
    gates[0].resolve(makeSummary("A"));
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(3));

    // Resolve remaining
    for (let i = 1; i < 5; i++) gates[i].resolve(makeSummary(String(i)));
    await vi.waitFor(() => expect(deps.onSummary).toHaveBeenCalledTimes(5));

    expect(maxActive).toBe(2);
  });

  it("cancels previous batch when load is called again", async () => {
    const results: string[] = [];
    const gate = deferred<ArticleSummary>();

    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(() => gate.promise),
      onSummary: (title) => results.push(title),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A"], "en");
    // Cancel by loading a new batch
    loader.load(["B"], "en");

    gate.resolve(makeSummary("A"));
    // Give the promise chain time to settle
    await new Promise((r) => setTimeout(r, 10));

    // "A" should not have called onSummary since it was cancelled
    expect(results).not.toContain("A");
  });

  it("fetches all items in load(), not just the first 10", async () => {
    const titles = Array.from({ length: 15 }, (_, i) => `Article${i}`);
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps);

    loader.load(titles, "en");
    await vi.waitFor(() => expect(deps.onSummary).toHaveBeenCalledTimes(15));
    expect(deps.fetch).toHaveBeenCalledTimes(15);
  });

  it("request() does not re-fire onSummary on cache hit", async () => {
    const results: string[] = [];
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: (title) => results.push(title),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A"], "en");
    await vi.waitFor(() => expect(results).toHaveLength(1));

    // Request same article again — cache hit must not re-fire the
    // callback. Callers that need the cached value use get() explicitly.
    results.length = 0;
    loader.request("A", "en");
    expect(results).toEqual([]);
    expect(deps.fetch).toHaveBeenCalledTimes(1); // no extra fetch
    expect(loader.get("A")).toEqual(makeSummary("A"));
  });

  it("repeated request() over an already-enriched range fires zero extra callbacks", async () => {
    const results: string[] = [];
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: (title) => results.push(title),
    };
    const loader = createSummaryLoader(deps);

    const titles = ["A", "B", "C", "D", "E"];
    loader.load(titles, "en");
    await vi.waitFor(() => expect(results).toHaveLength(titles.length));

    // Simulate a second scroll settle over the same visible range:
    // every title is already cached, and none should re-enter onSummary.
    const before = results.length;
    for (const t of titles) loader.request(t, "en");
    expect(results.length - before).toBe(0);
    expect(deps.fetch).toHaveBeenCalledTimes(titles.length);
  });

  it("get() returns cached summary or undefined", async () => {
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps);

    expect(loader.get("A")).toBeUndefined();

    loader.load(["A"], "en");
    await vi.waitFor(() => expect(deps.onSummary).toHaveBeenCalled());

    expect(loader.get("A")).toEqual(makeSummary("A"));
  });

  it("gracefully handles fetch errors without blocking the queue", async () => {
    const results: string[] = [];
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => {
        if (title === "B") throw new Error("fail");
        return makeSummary(title);
      }),
      onSummary: (title) => results.push(title),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A", "B", "C"], "en");
    await vi.waitFor(() => expect(results).toHaveLength(2));

    expect(results).toEqual(["A", "C"]);
  });

  it("cancel() stops all in-flight work", async () => {
    const gate = deferred<ArticleSummary>();
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(() => gate.promise),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A"], "en");
    loader.cancel();

    gate.resolve(makeSummary("A"));
    await new Promise((r) => setTimeout(r, 10));

    expect(deps.onSummary).not.toHaveBeenCalled();
  });

  it("request() re-enqueues a title after cancel races fetch resolution", async () => {
    // Regression: if cancel() interleaves between fetch resolution and the
    // runFetch continuation microtask, an early-return on signal.aborted
    // must not leave the title stranded in `pending`. A subsequent
    // request() for the same title must still schedule a fresh fetch.
    const gate1 = deferred<ArticleSummary>();
    const gate2 = deferred<ArticleSummary>();
    let callIdx = 0;
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(() => {
        const idx = callIdx++;
        return idx === 0 ? gate1.promise : gate2.promise;
      }),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A"], "en");
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(1));

    // Resolve the first fetch and cancel before the continuation runs.
    // cancel() executes synchronously before the awaited continuation,
    // so the runFetch will observe signal.aborted === true.
    gate1.resolve(makeSummary("A"));
    loader.cancel();
    await Promise.resolve();
    await Promise.resolve();

    // Fresh request for the same title must schedule a new fetch — not
    // silently no-op because "A" is still considered pending.
    loader.request("A", "en");
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(2));

    gate2.resolve(makeSummary("A"));
    await vi.waitFor(() =>
      expect(deps.onSummary).toHaveBeenCalledWith("A", makeSummary("A")),
    );
  });

  it("does not duplicate fetches for the same title in a batch", async () => {
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A", "A", "A"], "en");
    await vi.waitFor(() => expect(deps.onSummary).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));

    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("clears cache when load() is called with a new batch", async () => {
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A"], "en");
    await vi.waitFor(() => expect(deps.onSummary).toHaveBeenCalledTimes(1));

    expect(loader.get("A")).toEqual(makeSummary("A"));

    // New load clears cache
    loader.load(["B"], "en");
    expect(loader.get("A")).toBeUndefined();
  });

  it("request() reprioritizes pending items to the front of the queue", async () => {
    const fetchOrder: string[] = [];
    const gates = new Map<
      string,
      ReturnType<typeof deferred<ArticleSummary>>
    >();
    for (const t of ["A", "B", "C", "D", "E"]) gates.set(t, deferred());

    const deps: SummaryLoaderDeps = {
      fetch: vi.fn((title) => {
        fetchOrder.push(title);
        return gates.get(title)!.promise;
      }),
      onSummary: vi.fn(),
    };
    // Concurrency 1 so queue order is deterministic
    const loader = createSummaryLoader(deps, 1);

    // load() queues A,B,C,D,E — A starts fetching immediately
    loader.load(["A", "B", "C", "D", "E"], "en");
    await vi.waitFor(() => expect(fetchOrder).toEqual(["A"]));

    // Simulate viewport settling on D and E (skipping B, C)
    loader.request("D", "en");
    loader.request("E", "en");

    // Resolve A — next fetch should be D (reprioritized), not B
    gates.get("A")!.resolve(makeSummary("A"));
    await vi.waitFor(() => expect(fetchOrder).toHaveLength(2));
    expect(fetchOrder[1]).toBe("E");

    // Resolve D — next should be E
    gates.get("E")!.resolve(makeSummary("E"));
    await vi.waitFor(() => expect(fetchOrder).toHaveLength(3));
    expect(fetchOrder[2]).toBe("D");
  });

  it("request() for a new item puts it at the front of the queue", async () => {
    const fetchOrder: string[] = [];
    const gates = new Map<
      string,
      ReturnType<typeof deferred<ArticleSummary>>
    >();
    for (const t of ["A", "B", "X"]) gates.set(t, deferred());

    const deps: SummaryLoaderDeps = {
      fetch: vi.fn((title) => {
        fetchOrder.push(title);
        return gates.get(title)!.promise;
      }),
      onSummary: vi.fn(),
    };
    const loader = createSummaryLoader(deps, 1);

    loader.load(["A", "B"], "en");
    await vi.waitFor(() => expect(fetchOrder).toEqual(["A"]));

    // Request a brand-new item not in the original batch
    loader.request("X", "en");

    // Resolve A — X should be fetched before B
    gates.get("A")!.resolve(makeSummary("A"));
    await vi.waitFor(() => expect(fetchOrder).toHaveLength(2));
    expect(fetchOrder[1]).toBe("X");
  });

  it("does not serve cached summary from a different language", async () => {
    const results: string[] = [];
    const deps: SummaryLoaderDeps = {
      fetch: vi.fn(async (title) => makeSummary(title)),
      onSummary: (title) => results.push(title),
    };
    const loader = createSummaryLoader(deps);

    loader.load(["A"], "en");
    await vi.waitFor(() => expect(results).toHaveLength(1));

    // Load with different language — should re-fetch, not serve en cache
    loader.load(["A"], "de");
    await vi.waitFor(() => expect(results).toHaveLength(2));

    // fetch called twice: once for en, once for de
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.fetch).toHaveBeenCalledWith("A", "en");
    expect(deps.fetch).toHaveBeenCalledWith("A", "de");
  });
});
