import { idbPut, idbPutString, idbPutAny, idbDelete } from "./idb";
import type { CachedData } from "./idb";

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

const DUMMY_DATA: CachedData = {
  vertexPoints: new Float64Array(0),
  vertexTriangles: new Uint32Array(0),
  triangleVertices: new Uint32Array(0),
  triangleNeighbors: new Uint32Array(0),
  articles: [],
};

// ---------- Tests ----------

describe("idbPut", () => {
  it("resolves on successful transaction", async () => {
    await expect(
      idbPut(fakeDb("complete"), "k", DUMMY_DATA),
    ).resolves.toBeUndefined();
  });

  it("rejects with tx.error on onerror", async () => {
    await expect(idbPut(fakeDb("error"), "k", DUMMY_DATA)).rejects.toThrow(
      "Quota exceeded",
    );
  });

  it("rejects on abort (quota scenario)", async () => {
    await expect(idbPut(fakeDb("abort"), "k", DUMMY_DATA)).rejects.toThrow(
      "Quota exceeded",
    );
  });
});

describe("idbPutString", () => {
  it("resolves on success", async () => {
    await expect(
      idbPutString(fakeDb("complete"), "k", "v"),
    ).resolves.toBeUndefined();
  });

  it("rejects on error", async () => {
    await expect(idbPutString(fakeDb("error"), "k", "v")).rejects.toThrow();
  });
});

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
