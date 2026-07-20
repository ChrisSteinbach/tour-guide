import { digestCacheKey, loadDigest } from "./digest-loader";
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

const TILE_ID = "18-36";

const ENTRIES: FarFieldEntry[] = [
  { title: "Statue of Liberty", lat: 40.6892, lon: -74.0445, weight: 240 },
  { title: "Green-Wood Cemetery", lat: 40.6577, lon: -73.9927, weight: 30 },
];

function encodedBody(): ArrayBuffer {
  const bytes = encodeFarField(ENTRIES);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const META = { count: 2, bytes: 48, hash: "def45678" };

describe("loadDigest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and decodes the digest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(encodedBody()),
      }),
    );

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
      META,
      undefined,
      makeDeps(),
    );

    expect(entries.map((e) => e.title)).toEqual([
      "Statue of Liberty",
      "Green-Wood Cemetery",
    ]);
  });

  it("requests the digest file for the specific cell", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(encodedBody()),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await loadDigest("/base/", "en", TILE_ID, META, undefined, makeDeps());

    expect(fetchSpy).toHaveBeenCalledWith(
      "/base/tiles/en/18-36.digest.bin",
      expect.anything(),
    );
  });

  it("serves a cached digest without hitting the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = new Map<string, unknown>([
      [digestCacheKey("en", TILE_ID), { hash: META.hash, buf: encodedBody() }],
    ]);

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
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
      [
        digestCacheKey("en", TILE_ID),
        { hash: "stale000", buf: new ArrayBuffer(4) },
      ],
    ]);

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
      META,
      undefined,
      makeDeps(store),
    );

    expect(entries).toHaveLength(2);
    expect(fetch).toHaveBeenCalled();
  });

  it("caches a freshly fetched digest under the published hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(encodedBody()),
      }),
    );
    const store = new Map<string, unknown>();

    await loadDigest("/base/", "en", TILE_ID, META, undefined, makeDeps(store));

    expect(store.get(digestCacheKey("en", TILE_ID))).toMatchObject({
      hash: META.hash,
    });
  });

  it("returns [] when the digest 404s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
      META,
      undefined,
      makeDeps(),
    );

    expect(entries).toEqual([]);
  });

  it("returns [] on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
      META,
      undefined,
      makeDeps(),
    );

    expect(entries).toEqual([]);
  });

  it("returns [] when the payload is corrupt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
      }),
    );

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
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
      loadDigest("/base/", "en", TILE_ID, META, controller.signal, makeDeps()),
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

    const entries = await loadDigest(
      "/base/",
      "en",
      TILE_ID,
      META,
      undefined,
      makeDeps(new Map(), null),
    );

    expect(entries).toHaveLength(2);
  });
});
