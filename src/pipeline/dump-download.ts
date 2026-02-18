/**
 * Download Wikipedia/Wikidata SQL dump files from dumps.wikimedia.org.
 *
 * Files are streamed to disk with progress callbacks.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Lang } from "../lang.js";

/** Map language codes to wiki prefixes. */
const WIKI_PREFIX: Record<Lang, string> = {
  en: "enwiki",
  sv: "svwiki",
  ja: "jawiki",
};

/** Dump tables we need. */
export const DUMP_TABLES = ["geo_tags", "page"] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];

/** Build the URL for a dump file. */
export function dumpUrl(lang: Lang, table: DumpTable): string {
  const wiki = WIKI_PREFIX[lang];
  return `https://dumps.wikimedia.org/${wiki}/latest/${wiki}-latest-${table}.sql.gz`;
}

/** Build the local path for a dump file. */
export function dumpPath(lang: Lang, table: DumpTable, dir = "data/dumps"): string {
  const wiki = WIKI_PREFIX[lang];
  return `${dir}/${wiki}-latest-${table}.sql.gz`;
}

export interface DownloadOptions {
  /** Language to download dumps for */
  lang: Lang;
  /** Directory to store downloads (default: data/dumps) */
  dir?: string;
  /** Fetch function (injectable for testing) */
  fetchFn?: typeof fetch;
  /** Progress callback: (table, bytesDownloaded, totalBytes | null) */
  onProgress?: (table: DumpTable, downloaded: number, total: number | null) => void;
  /** Callback when a table download completes */
  onComplete?: (table: DumpTable, bytes: number) => void;
  /** Skip download if file already exists */
  skipExisting?: boolean;
}

export interface DownloadResult {
  table: DumpTable;
  path: string;
  bytes: number;
  skipped: boolean;
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
    fetchFn = fetch,
    onProgress,
    onComplete,
    skipExisting = false,
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

  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const totalBytes = response.headers.get("content-length");
  const total = totalBytes ? parseInt(totalBytes, 10) : null;

  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }

  const writer = createWriteStream(path);
  let downloaded = 0;

  // Convert web ReadableStream to Node.js Readable
  const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);

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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
