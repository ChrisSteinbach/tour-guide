import {
  idbPutAny,
  idbDelete,
  idbCleanupOldKeys,
  CURRENT_KEY_PREFIXES,
} from "./idb";

// ---------- Fake IDB ----------

/**
 * Minimal fake that simulates the IDB transaction lifecycle.
 * The real IDB fires oncomplete/onerror/onabort asynchronously after
 * the request is queued — queueMicrotask approximates this timing.
 */
function fakeDb(outcome: "complete" | "error" | "abort"): IDBDatabase {
  const quotaError = new DOMException("Quota exceeded", "QuotaExceededError");

  return {
    transaction: () => {
      const tx: Record<string, unknown> = {
        objectStore: () => ({ put: () => ({}), delete: () => ({}) }),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: outcome !== "complete" ? quotaError : null,
      };

      queueMicrotask(() => {
        const handler = tx[
          outcome === "complete"
            ? "oncomplete"
            : outcome === "error"
              ? "onerror"
              : "onabort"
        ] as (() => void) | null;
        handler?.();
      });

      return tx;
    },
  } as unknown as IDBDatabase;
}

// ---------- Tests ----------

describe("idbPutAny", () => {
  it("resolves on success", async () => {
    await expect(
      idbPutAny(fakeDb("complete"), "k", { x: 1 }),
    ).resolves.toBeUndefined();
  });

  it("rejects on error", async () => {
    await expect(idbPutAny(fakeDb("error"), "k", { x: 1 })).rejects.toThrow();
  });
});

describe("idbDelete", () => {
  it("resolves on success", async () => {
    await expect(idbDelete(fakeDb("complete"), "k")).resolves.toBeUndefined();
  });

  it("rejects on error", async () => {
    await expect(idbDelete(fakeDb("error"), "k")).rejects.toThrow();
  });
});

// ---------- Cleanup tests ----------

/** Fake DB that stores keys in memory so we can test cleanup logic. */
function fakeDbWithKeys(keys: string[]): {
  db: IDBDatabase;
  deleted: string[];
} {
  const deleted: string[] = [];

  const db = {
    transaction: (_store: string, mode?: string) => {
      const tx: Record<string, unknown> = {
        objectStore: () => ({
          getAllKeys: () => {
            const req: Record<string, unknown> = {
              result: [...keys],
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
            return req;
          },
          delete: (key: string) => {
            deleted.push(key);
            return {};
          },
        }),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };

      // Auto-complete readwrite transactions after deletes are issued
      if (mode === "readwrite") {
        queueMicrotask(() => (tx.oncomplete as (() => void) | null)?.());
      }

      return tx;
    },
  } as unknown as IDBDatabase;

  return { db, deleted };
}

describe("idbCleanupOldKeys", () => {
  it("deletes keys with old version prefixes", async () => {
    const { db, deleted } = fakeDbWithKeys([
      "triangulation-v3-en", // old (monolithic removed)
      "triangulation-v2-en", // old
      "triangulation-v1-en", // old
      "tile-v1-en-42", // current
      "tile-lru-v1-en", // current
    ]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(3);
    expect(deleted).toEqual([
      "triangulation-v3-en",
      "triangulation-v2-en",
      "triangulation-v1-en",
    ]);
  });

  it("returns 0 when all keys are current", async () => {
    const { db, deleted } = fakeDbWithKeys([
      "tile-index-v1-sv",
      "tile-v1-en-42",
      "tile-lru-v1-en",
    ]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("returns 0 for an empty store", async () => {
    const { db } = fakeDbWithKeys([]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(0);
  });

  it("deletes all keys when none match current prefixes", async () => {
    const { db, deleted } = fakeDbWithKeys([
      "triangulation-v1-en",
      "triangulation-v2-sv",
      "tile-v0-ja-1",
    ]);

    const count = await idbCleanupOldKeys(db);

    expect(count).toBe(3);
    expect(deleted).toEqual([
      "triangulation-v1-en",
      "triangulation-v2-sv",
      "tile-v0-ja-1",
    ]);
  });
});

describe("CURRENT_KEY_PREFIXES", () => {
  it("covers all documented key patterns", () => {
    const testKeys = ["tile-index-v1-sv", "tile-v1-en-42", "tile-lru-v1-en"];

    for (const key of testKeys) {
      const matched = CURRENT_KEY_PREFIXES.some((p) => key.startsWith(p));
      expect(matched).toBe(true);
    }
  });
});
