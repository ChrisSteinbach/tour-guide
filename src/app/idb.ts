// IndexedDB helpers — shared by query.ts and tile-loader.ts
//
// Single object store with versioned key prefixes:
//   triangulation-v3-{lang}                 main triangulation data
//   update-dismissed-triangulation-v3-{lang} dismissed-update hash
//   tile-index-v1-{lang}                    tile index JSON
//   tile-v1-{lang}-{id}                     individual tile data
//   tile-lru-v1-{lang}                      tile LRU eviction list
//
// Schema migration strategy: bump the version in the key prefix (e.g.
// v3 → v4) and update CURRENT_KEY_PREFIXES below. Old keys are cleaned
// up automatically on app startup by idbCleanupOldKeys.

export const IDB_NAME = "tour-guide";
export const IDB_STORE = "cache";

/** Current key prefixes. Update when bumping a schema version. */
export const CURRENT_KEY_PREFIXES = [
  "triangulation-v3-",
  "update-dismissed-triangulation-v3-",
  "tile-index-v1-",
  "tile-v1-",
  "tile-lru-v1-",
];

export interface CachedData {
  vertexPoints: Float64Array;
  vertexTriangles: Uint32Array;
  triangleVertices: Uint32Array;
  triangleNeighbors: Uint32Array;
  articles: string[]; // titles — lighter for structured clone than objects
  contentTag?: string;
}

export function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export function idbGet(
  db: IDBDatabase,
  key: string,
): Promise<CachedData | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as CachedData | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export function idbPut(
  db: IDBDatabase,
  key: string,
  value: CachedData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("Transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted"));
  });
}

export function idbGetString(
  db: IDBDatabase,
  key: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () =>
      resolve(typeof req.result === "string" ? req.result : undefined);
    req.onerror = () => resolve(undefined);
  });
}

export function idbPutString(
  db: IDBDatabase,
  key: string,
  value: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("Transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted"));
  });
}

export function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("Transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted"));
  });
}

/** Get any value from IDB (used for tile cache entries). */
export function idbGetAny<T>(
  db: IDBDatabase,
  key: string,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => resolve(undefined);
  });
}

/** Put any value into IDB (used for tile cache entries). */
export function idbPutAny(
  db: IDBDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("Transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted"));
  });
}

/**
 * Delete IDB keys that don't match any current version prefix.
 * Returns the number of keys deleted.
 */
export async function idbCleanupOldKeys(db: IDBDatabase): Promise<number> {
  const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new DOMException("getAllKeys failed"));
  });

  const orphaned = keys.filter(
    (key) =>
      typeof key === "string" &&
      !CURRENT_KEY_PREFIXES.some((p) => key.startsWith(p)),
  );

  if (orphaned.length === 0) return 0;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const key of orphaned) store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("Transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted"));
  });

  return orphaned.length;
}
