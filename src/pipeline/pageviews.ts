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

import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LANGS } from "../lang.js";
import type { Lang } from "../lang.js";
import { fetchWithRetry, formatBytes } from "./dump-download.js";
import { USER_AGENT } from "../user-agent.js";

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
  /** Clock used to probe recent months when `month` isn't given (default: new Date()). */
  now?: Date;
}

export interface EnsureViewsResult {
  /** Month the views files are for ("YYYY-MM"). */
  month: string;
  /** Path of the views file per requested language. */
  paths: Record<string, string>;
  /** Whether the monthly dump was downloaded (false = all files existed). */
  downloaded: boolean;
  /** Rows written per language (only present for languages split this run). */
  rowCounts?: Record<string, number>;
}

/** Wrap fetch to include the required User-Agent header for Wikimedia. */
function wikimediaFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, { ...init, headers: { "User-Agent": USER_AGENT } });
}

let lbzip2Available: boolean | undefined;

function isErrnoException(err: Error): err is NodeJS.ErrnoException {
  return "code" in err;
}

/** Probe once whether the parallel lbzip2 binary is installed; cached. */
function hasLbzip2(): boolean {
  if (lbzip2Available === undefined) {
    const probe = spawnSync("lbzip2", ["--version"], { stdio: "ignore" });
    const err = probe.error;
    lbzip2Available = !(err && isErrnoException(err) && err.code === "ENOENT");
  }
  return lbzip2Available;
}

/**
 * Decompress a bz2 stream by shelling out to lbzip2 (parallel, faster) when
 * available, falling back to bzip2. Child errors and non-zero exits surface
 * as errors on the returned stream.
 */
function defaultDecompress(
  input: NodeJS.ReadableStream,
): NodeJS.ReadableStream {
  const bin = hasLbzip2() ? "lbzip2" : "bzip2";
  const child = spawn(bin, ["-dc"], { stdio: ["pipe", "pipe", "inherit"] });

  input.on("error", (err: Error) => child.stdin.destroy(err));
  input.pipe(child.stdin);

  child.on("error", (err) => child.stdout.destroy(err));
  child.on("exit", (code, signal) => {
    if (code !== 0) {
      child.stdout.destroy(
        new Error(
          `${bin} exited with code ${String(code)}${signal ? ` (signal ${signal})` : ""}`,
        ),
      );
    }
  });

  return child.stdout;
}

/**
 * Resolve which month's dump to use: the explicit `month` if given
 * (validated as "YYYY-MM"), otherwise the newest of the last 3 months
 * confirmed to exist via a HEAD request.
 */
async function resolveMonth(
  opts: EnsureViewsOptions,
  fetchFn: typeof fetch,
): Promise<string> {
  if (opts.month !== undefined) {
    if (!/^\d{4}-\d{2}$/.test(opts.month)) {
      throw new Error(`Invalid month: "${opts.month}" (expected YYYY-MM)`);
    }
    return opts.month;
  }

  const now = opts.now ?? new Date();
  const tried: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const month = monthBefore(now, n);
    const url = monthlyDumpUrl(month);
    const response = await fetchFn(url, { method: "HEAD" });
    if (response.ok) return month;
    tried.push(url);
  }
  throw new Error(
    `No monthly pageviews dump found in the last 3 months. Tried:\n${tried.join("\n")}`,
  );
}

interface ViewsWriter {
  gzip: ReturnType<typeof createGzip>;
  file: ReturnType<typeof createWriteStream>;
  tmpPath: string;
  rows: number;
  /** Rows batched up until the next BATCH_BYTES-sized gzip write. */
  pending: string[];
  pendingBytes: number;
  /** First error either stream emitted; checked at every batch flush. */
  error?: Error;
}

/**
 * Batch size for gzip writes. The split emits tens of millions of tiny rows;
 * writing them individually queues faster than zlib drains and balloons the
 * heap (writable buffering is per-write, not per-byte), so rows are joined
 * into ~64 KiB chunks and backpressure (write() → false / 'drain') is honored.
 */
const BATCH_BYTES = 64 * 1024;

/** Queue one row on a writer, flushing to the gzip stream at batch size. */
async function writeRow(
  w: ViewsWriter,
  pageId: number,
  views: number,
): Promise<void> {
  const row = `${pageId}\t${views}\n`;
  w.pending.push(row);
  w.pendingBytes += row.length;
  w.rows++;
  if (w.pendingBytes >= BATCH_BYTES) await flushPending(w);
}

/** Write the batched rows to the gzip stream, awaiting 'drain' when asked. */
async function flushPending(w: ViewsWriter): Promise<void> {
  const earlyError = w.error;
  if (earlyError) throw earlyError;
  if (w.pendingBytes === 0) return;
  const chunk = w.pending.join("");
  w.pending = [];
  w.pendingBytes = 0;
  if (!w.gzip.write(chunk)) {
    await once(w.gzip, "drain");
  }
  const lateError = w.error;
  if (lateError) throw lateError;
}

/**
 * Ensure per-language views TSVs exist for the given month, downloading and
 * splitting the monthly pageview_complete dump in a single streaming pass if
 * any are missing. Never persists the multi-GB dump itself.
 */
export async function ensureViewsFiles(
  opts: EnsureViewsOptions,
): Promise<EnsureViewsResult> {
  const {
    langs,
    dir = PAGEVIEWS_DIR,
    fetchFn = wikimediaFetch,
    decompress = defaultDecompress,
    onPhase,
    onProgress,
  } = opts;

  const month = await resolveMonth(opts, fetchFn);

  const paths: Record<string, string> = {};
  for (const lang of langs) paths[lang] = viewsPath(lang, month, dir);

  const missingLangs = langs.filter((lang) => !existsSync(paths[lang]));
  if (missingLangs.length === 0) {
    return { month, paths, downloaded: false };
  }

  const wikiToLang = new Map<string, Lang>(
    missingLangs.map((lang): [string, Lang] => [`${lang}.wikipedia`, lang]),
  );
  const writers = new Map<Lang, ViewsWriter>();

  function getWriter(lang: Lang): ViewsWriter {
    let w = writers.get(lang);
    if (!w) {
      const tmpPath = `${paths[lang]}.tmp`;
      const file = createWriteStream(tmpPath);
      const gzip = createGzip();
      gzip.pipe(file);
      w = { gzip, file, tmpPath, rows: 0, pending: [], pendingBytes: 0 };
      const writer = w;
      const onError = (err: Error) => {
        writer.error ??= err;
      };
      file.on("error", onError);
      gzip.on("error", onError);
      writers.set(lang, w);
    }
    return w;
  }

  try {
    await mkdir(dir, { recursive: true });
    onPhase?.(`Downloading and splitting pageviews dump for ${month}`);

    const url = monthlyDumpUrl(month);
    const response = await fetchWithRetry(url, fetchFn);
    if (!response.ok) {
      throw new Error(
        `Failed to download ${url}: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error(`No response body for ${url}`);
    }

    const totalHeader = response.headers.get("content-length");
    const total = totalHeader ? parseInt(totalHeader, 10) : null;

    const nodeStream = Readable.fromWeb(response.body as WebReadableStream);
    let downloadedBytes = 0;
    nodeStream.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      onProgress?.(downloadedBytes, total);
    });

    const rl = createInterface({
      input: decompress(nodeStream),
      crlfDelay: Infinity,
    });

    // Rows for one article's access methods are adjacent in the dump, so a
    // running (lang, pageId) key with a sum is enough — no big map needed.
    let currentLang: Lang | null = null;
    let currentPageId = 0;
    let currentSum = 0;

    const emitRun = async (): Promise<void> => {
      if (currentLang === null) return;
      await writeRow(getWriter(currentLang), currentPageId, currentSum);
    };

    for await (const line of rl) {
      // Real rows are a few hundred bytes; anything huge is garbage, and
      // running regexes over giant strings forces costly flattening.
      if (!line || line.length > 4096) continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const lang = wikiToLang.get(line.slice(0, sp));
      if (lang === undefined) continue;

      const f = line.split(" ");
      if (f.length < 6) continue;

      const pageIdStr = f[f.length - 4];
      if (!/^\d+$/.test(pageIdStr)) continue; // "null" or malformed
      const pageId = Number(pageIdStr);

      const count = Number(f[f.length - 2]);
      if (!Number.isInteger(count) || count <= 0) continue;

      if (lang === currentLang && pageId === currentPageId) {
        currentSum += count;
      } else {
        await emitRun();
        currentLang = lang;
        currentPageId = pageId;
        currentSum = count;
      }
    }
    await emitRun();

    // Every missing language gets a file, even with zero matching rows —
    // its presence marks the month as processed.
    for (const lang of missingLangs) getWriter(lang);
    for (const w of writers.values()) await flushPending(w);

    await Promise.all(
      [...writers.values()].map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            w.file.on("error", reject);
            w.gzip.on("error", reject);
            w.file.on("finish", resolve);
            w.gzip.end();
          }),
      ),
    );

    await Promise.all(
      [...writers.entries()].map(([lang, w]) => rename(w.tmpPath, paths[lang])),
    );
  } catch (err) {
    await Promise.allSettled(
      [...writers.values()].map((w) => rm(w.tmpPath, { force: true })),
    );
    throw err;
  }

  const rowCounts: Record<string, number> = {};
  for (const [lang, w] of writers) rowCounts[lang] = w.rows;

  return { month, paths, downloaded: true, rowCounts };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(
    args
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [key, ...rest] = a.slice(2).split("=");
        return [key, rest.length ? rest.join("=") : "true"];
      }),
  );

  const langs = (
    flags.langs ? flags.langs.split(",") : [...SUPPORTED_LANGS]
  ) as Lang[];

  for (const lang of langs) {
    if (!SUPPORTED_LANGS.includes(lang)) {
      console.error(
        `Unsupported language: ${lang}. Supported: ${SUPPORTED_LANGS.join(", ")}`,
      );
      process.exit(1);
    }
  }

  const dir = flags.dir ?? PAGEVIEWS_DIR;

  console.error(`\nEnsuring pageviews files for ${langs.join(", ")}\n`);

  const start = Date.now();

  const result = await ensureViewsFiles({
    langs,
    month: flags.month,
    dir,
    onPhase: (phase) => console.error(`\n→ ${phase}`),
    onProgress: (downloaded, total) => {
      const totalStr = total ? ` / ${formatBytes(total)}` : "";
      process.stderr.write(`\r  ${formatBytes(downloaded)}${totalStr}    `);
    },
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(
    `\n\nDone in ${elapsed}s — month ${result.month} (${
      result.downloaded ? "downloaded and split" : "already up to date"
    })`,
  );
  for (const lang of langs) {
    const rows = result.rowCounts?.[lang];
    const rowsInfo =
      rows !== undefined ? `, ${rows.toLocaleString()} rows` : "";
    console.error(`  ${lang}: ${result.paths[lang]}${rowsInfo}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
