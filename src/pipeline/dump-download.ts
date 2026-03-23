/**
 * Download Wikipedia/Wikidata SQL dump files from dumps.wikimedia.org.
 *
 * Files are streamed to disk with progress callbacks.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Lang } from "../lang.js";
import { USER_AGENT } from "../user-agent.js";

/** Wrap fetch to include the required User-Agent header for Wikimedia. */
function wikimediaFetch(url: string | URL | Request): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": USER_AGENT } });
}

/** Derive wiki prefix from language code (e.g. "en" → "enwiki"). */
function wikiPrefix(lang: Lang): string {
  return `${lang}wiki`;
}

/** Dump tables we need. */
export const DUMP_TABLES = ["geo_tags", "page"] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];

/** Build the URL for a dump file. */
export function dumpUrl(lang: Lang, table: DumpTable): string {
  const wiki = wikiPrefix(lang);
  return `https://dumps.wikimedia.org/${wiki}/latest/${wiki}-latest-${table}.sql.gz`;
}

/** Build the local path for a dump file. */
export function dumpPath(
  lang: Lang,
  table: DumpTable,
  dir = "data/dumps",
): string {
  const wiki = wikiPrefix(lang);
  return `${dir}/${wiki}-latest-${table}.sql.gz`;
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms before first retry; doubles each attempt (default: 1000) */
  baseDelayMs?: number;
  /** Delay function, injectable for testing (default: real setTimeout) */
  delayFn?: (ms: number) => Promise<void>;
}

export interface DownloadOptions {
  /** Language to download dumps for */
  lang: Lang;
  /** Directory to store downloads (default: data/dumps) */
  dir?: string;
  /** Fetch function (injectable for testing) */
  fetchFn?: typeof fetch;
  /** Progress callback: (table, bytesDownloaded, totalBytes | null) */
  onProgress?: (
    table: DumpTable,
    downloaded: number,
    total: number | null,
  ) => void;
  /** Callback when a table download completes */
  onComplete?: (table: DumpTable, bytes: number) => void;
  /** Skip download if file already exists */
  skipExisting?: boolean;
  /** Retry options for transient network/server failures */
  retry?: RetryOptions;
}

export interface DownloadResult {
  table: DumpTable;
  path: string;
  bytes: number;
  skipped: boolean;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff for transient failures.
 *
 * Retries on network errors (DNS, TCP reset) and retryable HTTP statuses
 * (408, 429, 5xx). Returns immediately for success or non-retryable errors.
 */
export async function fetchWithRetry(
  url: string,
  fetchFn: typeof fetch,
  opts: RetryOptions = {},
): Promise<Response> {
  const { maxRetries = 3, baseDelayMs = 1000, delayFn = sleep } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await delayFn(baseDelayMs * 2 ** (attempt - 1));
    }

    try {
      const response = await fetchFn(url);
      if (response.ok || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/**
 * Download a single dump file with streaming and progress.
 */
export async function downloadDump(
  lang: Lang,
  table: DumpTable,
  opts: Omit<DownloadOptions, "lang"> = {},
): Promise<DownloadResult> {
  const {
    dir = "data/dumps",
    fetchFn = wikimediaFetch,
    onProgress,
    onComplete,
    skipExisting = false,
    retry,
  } = opts;

  const url = dumpUrl(lang, table);
  const path = dumpPath(lang, table, dir);

  // Skip if file exists and skipExisting is set
  if (skipExisting && existsSync(path)) {
    const bytes = statSync(path).size;
    return { table, path, bytes, skipped: true };
  }

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  const response = await fetchWithRetry(url, fetchFn, retry);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const totalBytes = response.headers.get("content-length");
  const total = totalBytes ? parseInt(totalBytes, 10) : null;

  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }

  const writer = createWriteStream(path);
  let downloaded = 0;

  // Convert web ReadableStream to Node.js Readable
  const nodeStream = Readable.fromWeb(response.body as WebReadableStream);

  nodeStream.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    if (onProgress) onProgress(table, downloaded, total);
  });

  await pipeline(nodeStream, writer);

  if (onComplete) onComplete(table, downloaded);
  return { table, path, bytes: downloaded, skipped: false };
}

/**
 * Download all dump files for a language.
 */
export async function downloadAllDumps(
  opts: DownloadOptions,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  for (const table of DUMP_TABLES) {
    const result = await downloadDump(opts.lang, table, opts);
    results.push(result);
  }
  return results;
}

/** Format byte count for display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
