import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  viewsPath,
  monthlyDumpUrl,
  monthBefore,
  findViewsFile,
  loadViewsInto,
  ensureViewsFiles,
} from "./pageviews.js";

// --- Shared test infrastructure ---

const testDir = join(tmpdir(), "pageviews-test-" + Date.now());

beforeAll(() => mkdirSync(testDir, { recursive: true }));
afterAll(() => rmSync(testDir, { recursive: true, force: true }));

/** A fetchFn that fails the test if it's ever called. */
function noNetworkFetch(): typeof fetch {
  return (async (url: string) => {
    throw new Error("unexpected network call: " + url);
  }) as unknown as typeof fetch;
}

/** A fetchFn resolving a single GET with the given plain-text body. */
function bodyFetch(text: string): typeof fetch {
  return async () =>
    new Response(text, {
      headers: { "content-length": String(Buffer.byteLength(text)) },
    });
}

const identity = (s: NodeJS.ReadableStream): NodeJS.ReadableStream => s;

function readTsvGz(path: string): string[] {
  return gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n");
}

// ---------- Unit: monthBefore ----------

describe("monthBefore", () => {
  it("crosses a year boundary", () => {
    expect(monthBefore(new Date(Date.UTC(2026, 0, 15)), 1)).toBe("2025-12");
  });

  it("computes n months back within the same year", () => {
    expect(monthBefore(new Date(Date.UTC(2026, 6, 1)), 2)).toBe("2026-05");
  });
});

// ---------- Unit: monthlyDumpUrl ----------

describe("monthlyDumpUrl", () => {
  it("builds the exact dump URL for a month", () => {
    expect(monthlyDumpUrl("2026-06")).toBe(
      "https://dumps.wikimedia.org/other/pageview_complete/monthly/2026/2026-06/pageviews-202606-user.bz2",
    );
  });
});

// ---------- Unit: findViewsFile ----------

describe("findViewsFile", () => {
  it("returns null when the directory doesn't exist", () => {
    expect(findViewsFile("sv", join(testDir, "does-not-exist"))).toBeNull();
  });

  it("picks the newest month among several", () => {
    const dir = join(testDir, "find-newest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pageviews-202603-sv.tsv.gz"), "");
    writeFileSync(join(dir, "pageviews-202606-sv.tsv.gz"), "");
    writeFileSync(join(dir, "pageviews-202601-sv.tsv.gz"), "");

    expect(findViewsFile("sv", dir)).toBe(`${dir}/pageviews-202606-sv.tsv.gz`);
  });

  it("ignores other languages and non-matching filenames", () => {
    const dir = join(testDir, "find-ignore");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pageviews-202606-en.tsv.gz"), "");
    writeFileSync(join(dir, "pageviews-202606-sv.tsv.gz"), "");
    writeFileSync(join(dir, "not-a-views-file.txt"), "");
    writeFileSync(join(dir, "pageviews-202606-sv.tsv"), ""); // wrong extension

    expect(findViewsFile("sv", dir)).toBe(`${dir}/pageviews-202606-sv.tsv.gz`);
  });
});

// ---------- Integration: ensureViewsFiles ----------

describe("ensureViewsFiles", () => {
  it("rejects an invalid month format", async () => {
    await expect(
      ensureViewsFiles({
        langs: ["en"],
        month: "2026-6",
        dir: testDir,
        fetchFn: noNetworkFetch(),
      }),
    ).rejects.toThrow(/YYYY-MM/);
  });

  it("resolves immediately when every requested file already exists", async () => {
    const dir = join(testDir, "existing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(viewsPath("sv", "2026-06", dir), gzipSync(Buffer.from("")));
    writeFileSync(viewsPath("en", "2026-06", dir), gzipSync(Buffer.from("")));

    const result = await ensureViewsFiles({
      langs: ["sv", "en"],
      month: "2026-06",
      dir,
      fetchFn: noNetworkFetch(),
    });

    expect(result.downloaded).toBe(false);
    expect(result.month).toBe("2026-06");
    expect(result.paths.sv).toBe(viewsPath("sv", "2026-06", dir));
    expect(result.paths.en).toBe(viewsPath("en", "2026-06", dir));
  });

  it("falls back to an older month when newer ones 404 on HEAD probing", async () => {
    const dir = join(testDir, "probe");
    mkdirSync(dir, { recursive: true });
    // Pre-create the target month's file so no GET is needed once resolved.
    writeFileSync(viewsPath("sv", "2026-05", dir), gzipSync(Buffer.from("")));

    const now = new Date(Date.UTC(2026, 6, 1)); // July 2026
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method !== "HEAD") {
        throw new Error("unexpected non-HEAD request: " + url);
      }
      return url.includes("2026-05")
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await ensureViewsFiles({
      langs: ["sv"],
      dir,
      now,
      fetchFn,
    });

    expect(result.month).toBe("2026-05");
    expect(result.downloaded).toBe(false);
  });

  it("throws listing the tried URLs when no recent month is available", async () => {
    const now = new Date(Date.UTC(2026, 6, 1));
    const fetchFn = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;

    await expect(
      ensureViewsFiles({ langs: ["en"], dir: testDir, now, fetchFn }),
    ).rejects.toThrow(/2026-06[\s\S]*2026-05[\s\S]*2026-04/);
  });

  it("rejects on a failed download and leaves no partial files behind", async () => {
    const dir = join(testDir, "failed-get");
    const fetchFn = (async () =>
      new Response(null, {
        status: 403,
        statusText: "Forbidden",
      })) as unknown as typeof fetch;

    await expect(
      ensureViewsFiles({ langs: ["en"], month: "2026-06", dir, fetchFn }),
    ).rejects.toThrow("403");

    const finalPath = viewsPath("en", "2026-06", dir);
    expect(existsSync(finalPath)).toBe(false);
    expect(existsSync(`${finalPath}.tmp`)).toBe(false);
  });

  it("splits the dump into correct per-language TSVs", async () => {
    const dir = join(testDir, "split");
    const fixtureText = [
      // non-content page: null page_id, other wiki entirely
      "aa.wikibooks - null desktop 484 A25B42C34D22E30F22G32H27I25J28K27L24M17N13O14P13Q9R14S9T9U7V12W5X5Y2Z5[4]5^3",
      // quoted+escaped title, still null page_id, still another wiki
      'aa.wikibooks "File:\\"1812\\"_Napoleon_I_in_Russia,_With_an_introduction_by_R._Whiteing_(IA_cu31924024322418).pdf" null desktop 1 T1',
      // a lang that wasn't requested
      "de.wikipedia Berlin 333 desktop 10 A1",
      // requested lang's sibling project — must be skipped, not en.wikipedia
      "en.wikibooks SomePage 555 desktop 999 A1",
      // adjacent access-method rows for the same article — summed
      "en.wikipedia Eiffel_Tower 9232 desktop 300000 A1B2",
      "en.wikipedia Eiffel_Tower 9232 mobile-web 200000 A1B2",
      // a second, distinct en article
      "en.wikipedia Louvre 4444 desktop 100 A1",
      // quoted title on a kept row
      'en.wikipedia "Quoted:_Title" 7777 desktop 55 A1',
      // requested sv lang
      "sv.wikipedia Stockholm 111 desktop 42 A1",
    ].join("\n");

    const result = await ensureViewsFiles({
      langs: ["en", "sv"],
      month: "2026-06",
      dir,
      fetchFn: bodyFetch(fixtureText),
      decompress: identity,
    });

    expect(result.downloaded).toBe(true);
    expect(result.month).toBe("2026-06");

    expect(readTsvGz(result.paths.en)).toEqual([
      "9232\t500000",
      "4444\t100",
      "7777\t55",
    ]);
    expect(readTsvGz(result.paths.sv)).toEqual(["111\t42"]);
    expect(result.rowCounts?.en).toBe(3);
    expect(result.rowCounts?.sv).toBe(1);
  });

  it("preserves every row across gzip batch boundaries on large inputs", async () => {
    // Rows are batched into ~64 KiB gzip writes (the OOM fix for the real
    // ~25M-row dump); ~20k rows span several batches plus a final partial one.
    const dir = join(testDir, "batching");
    const rowCount = 20_000;
    const lines: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      lines.push(`en.wikipedia Article_${i} ${1000 + i} desktop ${i + 1} A1`);
    }

    const result = await ensureViewsFiles({
      langs: ["en"],
      month: "2026-06",
      dir,
      fetchFn: bodyFetch(lines.join("\n")),
      decompress: identity,
    });

    const rows = readTsvGz(result.paths.en);
    expect(rows.length).toBe(rowCount);
    expect(rows[0]).toBe("1000\t1");
    expect(rows[rowCount - 1]).toBe(`${1000 + rowCount - 1}\t${rowCount}`);
    expect(result.rowCounts?.en).toBe(rowCount);
  });

  it("still writes an empty file for a requested language with zero matching rows", async () => {
    const dir = join(testDir, "zero-rows");
    const fixtureText = ["en.wikipedia Eiffel_Tower 9232 desktop 300 A1"].join(
      "\n",
    );

    const result = await ensureViewsFiles({
      langs: ["en", "ja"],
      month: "2026-06",
      dir,
      fetchFn: bodyFetch(fixtureText),
      decompress: identity,
    });

    expect(existsSync(result.paths.ja)).toBe(true);
    expect(readTsvGz(result.paths.ja)).toEqual([""]);
    expect(result.rowCounts?.ja).toBe(0);
  });

  it("round-trips written files through loadViewsInto", async () => {
    const dir = join(testDir, "roundtrip");
    const fixtureText = [
      "en.wikipedia Eiffel_Tower 9232 desktop 300000 A1",
      "en.wikipedia Eiffel_Tower 9232 mobile-web 200000 A1",
      "en.wikipedia Louvre 4444 desktop 100 A1",
    ].join("\n");

    const result = await ensureViewsFiles({
      langs: ["en"],
      month: "2026-06",
      dir,
      fetchFn: bodyFetch(fixtureText),
      decompress: identity,
    });

    const views = new Map<number, number>();
    const rows = await loadViewsInto(result.paths.en, (pageId, v) => {
      views.set(pageId, (views.get(pageId) ?? 0) + v);
    });

    expect(rows).toBe(2);
    expect(views.get(9232)).toBe(500000);
    expect(views.get(4444)).toBe(100);
  });
});
