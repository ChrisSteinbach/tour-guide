// Session-scoped tile-load log — records cache hits and network fetch
// outcomes (success/failure) for field diagnostics. Not persisted; the
// buffer resets on every page load by design.

export interface TileLoadRecord {
  /** Date.now() at the time the load settled. */
  at: number;
  lang: string;
  /** Tile id, e.g. "29-39". */
  id: string;
  source: "cache" | "network";
  ok: boolean;
  /** Duration in ms, measured with performance.now(). */
  ms: number;
  /** Raw (decompressed) size in bytes. Network success only. */
  bytes?: number;
  /** 1-based count of fetch attempts made. Network only. */
  attempts?: number;
  /** Failure only. */
  error?: string;
}

const MAX_LOG_ENTRIES = 100;

const log: TileLoadRecord[] = [];

/** Appends a record to the session log and emits a compact console line. */
export function recordTileLoad(record: TileLoadRecord): void {
  log.push(record);
  if (log.length > MAX_LOG_ENTRIES) {
    log.shift();
  }

  const tag = `[tile] ${record.lang}/${record.id}`;
  const ms = Math.round(record.ms);

  if (!record.ok) {
    const afterAttempts =
      record.attempts === undefined ? "" : ` after ${record.attempts} attempts`;
    console.warn(
      `${tag} ${record.source} FAILED in ${ms} ms${afterAttempts}: ${record.error ?? "unknown error"}`,
    );
    return;
  }

  if (record.source === "cache") {
    console.debug(`${tag} cache in ${ms} ms`);
    return;
  }

  const kb = Math.round((record.bytes ?? 0) / 1024);
  const attemptsSuffix =
    record.attempts === undefined ? "" : ` (${record.attempts} attempts)`;
  console.debug(`${tag} network ${kb} KB in ${ms} ms${attemptsSuffix}`);
}

/** Returns a snapshot of the current session log, oldest first. */
export function getTileLoadLog(): readonly TileLoadRecord[] {
  return log.slice();
}

/** Empties the session log. For tests. */
export function clearTileLoadLog(): void {
  log.length = 0;
}
