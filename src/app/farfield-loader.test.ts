import { farFieldCacheKey, loadFarField } from "./farfield-loader";
import { encodeFarField } from "../farfield";
import type { FarFieldEntry } from "../farfield";
import type { TileLoaderDeps } from "./tile-loader";

const fakeDb = {} as IDBDatabase;

function makeDeps(
  store: Map<string, unknown> = new Map(),
  db: IDBDatabase | null = fakeDb,
): TileLoaderDeps {
  return {
    openDb: () => Promise.resolve(db),
    getAny: <T>(_db: IDBDatabase, key: string) =>
      Promise.resolve(store.get(key) as T | undefined),
    putAny: (_db: IDBDatabase, key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    deleteKey: (_db: IDBDatabase, key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

const ENTRIES: FarFieldEntry[] = [
  { title: "Eiffel Tower", lat: 48.8584, lon: 2.2945, weight: 251 },
  { title: "Mount Galloway", lat: -49.683, lon: 178.783, weight: 12 },
];

function encodedBody(): ArrayBuffer {
  const bytes = encodeFarField(ENTRIES);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const META = { count: 2, bytes: 64, hash: "abc12345" };

describe("loadFarField", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and decodes the tier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(encodedBody()),
      }),
    );

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(),
    );

    expect(entries.map((e) => e.title)).toEqual([
      "Eiffel Tower",
      "Mount Galloway",
    ]);
  });

  it("serves a cached tier without hitting the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = new Map<string, unknown>([
      [farFieldCacheKey("en"), { hash: META.hash, buf: encodedBody() }],
    ]);

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(store),
    );

    expect(entries).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refetches when the published content hash has changed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(encodedBody()),
      }),
    );
    const store = new Map<string, unknown>([
      [farFieldCacheKey("en"), { hash: "stale000", buf: new ArrayBuffer(4) }],
    ]);

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(store),
    );

    expect(entries).toHaveLength(2);
    expect(fetch).toHaveBeenCalled();
  });

  it("caches a freshly fetched tier under the published hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(encodedBody()),
      }),
    );
    const store = new Map<string, unknown>();

    await loadFarField("/base/", "en", META, undefined, makeDeps(store));

    expect(store.get(farFieldCacheKey("en"))).toMatchObject({
      hash: META.hash,
    });
  });

  it("returns nothing when the index predates the tier", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const entries = await loadFarField(
      "/base/",
      "en",
      undefined,
      undefined,
      makeDeps(),
    );

    expect(entries).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades to a tile-only list when the tier 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(),
    );

    expect(entries).toEqual([]);
  });

  it("degrades to a tile-only list on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(),
    );

    expect(entries).toEqual([]);
  });

  it("degrades to a tile-only list when the payload is corrupt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
      }),
    );

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(),
    );

    expect(entries).toEqual([]);
  });

  it("propagates abort rather than degrading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadFarField("/base/", "en", META, controller.signal, makeDeps()),
    ).rejects.toThrow();
  });

  it("works without IndexedDB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(encodedBody()),
      }),
    );

    const entries = await loadFarField(
      "/base/",
      "en",
      META,
      undefined,
      makeDeps(new Map(), null),
    );

    expect(entries).toHaveLength(2);
  });
});
