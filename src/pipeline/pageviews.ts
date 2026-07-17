/**
 * Wikimedia pageviews: per-article monthly view counts.
 *
 * Source: the pageview_complete monthly dumps — one bz2 file per month
 * covering ALL wikis (~6 GB), split by agent type (we use "-user", i.e.
 * human traffic). Lines are space-separated:
 *
 *   {wiki} {title} {page_id|null} {access_method} {monthly_total} {daily_breakdown}
 *   en.wikipedia Eiffel_Tower 9232 desktop 512345 A17102B16544...
 *
 * Titles are underscored (never contain spaces) and may be quoted when they
 * contain quotes. Lines are sorted by wiki code then title, so the
 * access-method rows (desktop / mobile-web / mobile-app) of one article are
 * adjacent. Non-content pages carry a "null" page ID.
 *
 * Because one file covers every language, we download it once and split it
 * into small per-language TSVs ({page_id}\t{views}, gzipped) that the
 * per-language extract step joins by page_id.
 */

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import type { Lang } from "../lang.js";

// ---------- Paths & months ----------

/** Directory where per-language views TSVs are stored. */
export const PAGEVIEWS_DIR = "data/pageviews";

/** Compact "YYYYMM" form of a "YYYY-MM" month. */
function compactMonth(month: string): string {
  return month.replace("-", "");
}

/** Per-language views file path, e.g. data/pageviews/pageviews-202606-sv.tsv.gz */
export function viewsPath(
  lang: Lang,
  month: string,
  dir = PAGEVIEWS_DIR,
): string {
  return `${dir}/pageviews-${compactMonth(month)}-${lang}.tsv.gz`;
}

/** URL of the monthly pageview_complete "user" dump for a "YYYY-MM" month. */
export function monthlyDumpUrl(month: string): string {
  const [year] = month.split("-");
  return `https://dumps.wikimedia.org/other/pageview_complete/monthly/${year}/${month}/pageviews-${compactMonth(month)}-user.bz2`;
}

/** "YYYY-MM" of the n-th month before the given date (n=1 → previous month). */
export function monthBefore(now: Date, n: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}`;
}

/**
 * Find the newest existing views file for a language, or null.
 * Files are named pageviews-YYYYMM-{lang}.tsv.gz, so a lexicographic sort
 * on the month component is a chronological sort.
 */
export function findViewsFile(lang: Lang, dir = PAGEVIEWS_DIR): string | null {
  if (!existsSync(dir)) return null;
  const pattern = new RegExp(`^pageviews-(\\d{6})-${lang}\\.tsv\\.gz$`);
  const months = readdirSync(dir)
    .map((name) => pattern.exec(name)?.[1])
    .filter((m): m is string => m !== undefined)
    .sort();
  const newest = months[months.length - 1];
  if (newest === undefined) return null;
  return `${dir}/pageviews-${newest}-${lang}.tsv.gz`;
}

// ---------- Reading per-language views files ----------

/**
 * Stream a per-language views TSV ({page_id}\t{views} per line, gzipped),
 * invoking `add` for each row. Rows for the same page_id may appear more
 * than once; callers should sum. Returns the number of rows read.
 */
export async function loadViewsInto(
  path: string,
  add: (pageId: number, views: number) => void,
): Promise<number> {
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let rows = 0;
  for await (const line of rl) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const pageId = Number(line.slice(0, tab));
    const views = Number(line.slice(tab + 1));
    if (!Number.isInteger(pageId) || !Number.isFinite(views)) continue;
    add(pageId, views);
    rows++;
  }
  return rows;
}

// ---------- Downloading & splitting the monthly dump ----------

export interface EnsureViewsOptions {
  /** Languages to produce views files for. */
  langs: readonly Lang[];
  /** Month to use ("YYYY-MM"). Default: newest complete month available. */
  month?: string;
  /** Directory for per-language TSVs (default: PAGEVIEWS_DIR). */
  dir?: string;
  /** Fetch function (injectable for testing). */
  fetchFn?: typeof fetch;
  /**
   * Decompressor for the downloaded stream (injectable for testing).
   * Default spawns lbzip2 -dc (parallel) or bzip2 -dc.
   */
  decompress?: (input: NodeJS.ReadableStream) => NodeJS.ReadableStream;
  onPhase?: (phase: string) => void;
  /** Download progress: (bytesDownloaded, totalBytes | null). */
  onProgress?: (downloaded: number, total: number | null) => void;
}

export interface EnsureViewsResult {
  /** Month the views files are for ("YYYY-MM"). */
  month: string;
  /** Path of the views file per requested language. */
  paths: Record<string, string>;
  /** Whether the monthly dump was downloaded (false = all files existed). */
  downloaded: boolean;
}

/**
 * Ensure per-language views TSVs exist for the given month, downloading and
 * splitting the monthly pageview_complete dump in a single streaming pass if
 * any are missing. Never persists the multi-GB dump itself.
 */
export function ensureViewsFiles(
  opts: EnsureViewsOptions,
): Promise<EnsureViewsResult> {
  void opts;
  return Promise.reject(new Error("not implemented yet"));
}
