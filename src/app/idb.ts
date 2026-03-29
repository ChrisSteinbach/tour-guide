// IndexedDB helpers — used by tile-loader.ts
//
// Single object store with versioned key prefixes:
//   tile-index-v1-{lang}                    tile index JSON
//   tile-v1-{lang}-{id}                     individual tile data
//   tile-lru-v1-{lang}                      tile LRU eviction list
//
// Schema migration strategy: bump the version in the key prefix (e.g.
// v1 → v2) and update CURRENT_KEY_PREFIXES below. Old keys are cleaned
// up automatically on app startup by idbCleanupOldKeys.

export const IDB_NAME = "tour-guide";
export const IDB_STORE = "cache";

/** Current key prefixes. Update when bumping a schema version. */
export const CURRENT_KEY_PREFIXES = [
  "tile-index-v1-",
  "tile-v1-",
  "tile-lru-v1-",
];

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function idbOpen(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("IDB open failed:", req.error);
      dbPromise = null;
      resolve(null);
    };
  });
  return dbPromise;
}

// ---------- Generic transaction helpers ----------

/** Run a readonly request against the store and return its result. */
function idbRead<T>(
  db: IDBDatabase,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = fn(tx.objectStore(IDB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new DOMException("Request failed"));
  });
}

/** Run a readwrite transaction against the store. */
function idbWrite(
  db: IDBDatabase,
  fn: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new DOMException("Transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new DOMException("Transaction aborted"));
  });
}

// ---------- Public API ----------

export function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return idbWrite(db, (store) => {
    store.delete(key);
  });
}

/** Get any value from IDB (used for tile cache entries). */
export function idbGetAny<T>(
  db: IDBDatabase,
  key: string,
): Promise<T | undefined> {
  return idbRead(db, (store) => store.get(key)) as Promise<T | undefined>;
}

/** Put any value into IDB (used for tile cache entries). */
export function idbPutAny(
  db: IDBDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  return idbWrite(db, (store) => {
    store.put(value, key);
  });
}

/**
 * Delete IDB keys that don't match any current version prefix.
 * Returns the number of keys deleted.
 */
export async function idbCleanupOldKeys(db: IDBDatabase): Promise<number> {
  const keys = await idbRead<IDBValidKey[]>(db, (store) => store.getAllKeys());

  const orphaned = keys.filter(
    (key) =>
      typeof key === "string" &&
      !CURRENT_KEY_PREFIXES.some((p) => key.startsWith(p)),
  );

  if (orphaned.length === 0) return 0;

  await idbWrite(db, (store) => {
    for (const key of orphaned) store.delete(key);
  });

  return orphaned.length;
}
