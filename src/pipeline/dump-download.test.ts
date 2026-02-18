import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dumpUrl,
  dumpPath,
  downloadDump,
  downloadAllDumps,
  formatBytes,
  DUMP_TABLES,
} from "./dump-download.js";

describe("dumpUrl", () => {
  it("builds correct URL for Swedish geo_tags", () => {
    expect(dumpUrl("sv", "geo_tags")).toBe(
      "https://dumps.wikimedia.org/svwiki/latest/svwiki-latest-geo_tags.sql.gz",
    );
  });

  it("builds correct URL for English page", () => {
    expect(dumpUrl("en", "page")).toBe(
      "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-page.sql.gz",
    );
  });

  it("builds correct URL for Japanese page", () => {
    expect(dumpUrl("ja", "page")).toBe(
      "https://dumps.wikimedia.org/jawiki/latest/jawiki-latest-page.sql.gz",
    );
  });
});

describe("dumpPath", () => {
  it("builds correct local path", () => {
    expect(dumpPath("sv", "geo_tags")).toBe(
      "data/dumps/svwiki-latest-geo_tags.sql.gz",
    );
  });

  it("respects custom directory", () => {
    expect(dumpPath("en", "page", "/tmp/dumps")).toBe(
      "/tmp/dumps/enwiki-latest-page.sql.gz",
    );
  });
});

describe("downloadDump", () => {
  const testDir = join(tmpdir(), "dump-download-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function mockFetch(body: string, headers: Record<string, string> = {}): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;
  }

  it("downloads a file and reports progress", async () => {
    const content = "test dump content";
    const progressCalls: Array<{ downloaded: number; total: number | null }> = [];

    const result = await downloadDump("sv", "geo_tags", {
      dir: testDir,
      fetchFn: mockFetch(content, { "content-length": String(content.length) }),
      onProgress: (_table, downloaded, total) => {
        progressCalls.push({ downloaded, total });
      },
    });

    expect(result.table).toBe("geo_tags");
    expect(result.bytes).toBe(content.length);
    expect(result.skipped).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[0].total).toBe(content.length);
  });

  it("skips download when file exists and skipExisting is set", async () => {
    const path = dumpPath("sv", "geo_tags", testDir);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path, "existing content");

    const result = await downloadDump("sv", "geo_tags", {
      dir: testDir,
      skipExisting: true,
    });

    expect(result.skipped).toBe(true);
    expect(result.bytes).toBe("existing content".length);
  });

  it("throws on HTTP error", async () => {
    const failFetch = (async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
    })) as unknown as typeof fetch;

    await expect(
      downloadDump("sv", "geo_tags", {
        dir: testDir,
        fetchFn: failFetch,
      }),
    ).rejects.toThrow("404 Not Found");
  });
});

describe("downloadAllDumps", () => {
  const testDir = join(tmpdir(), "dump-all-test-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("downloads all tables", async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`table-${callCount}`));
            controller.close();
          },
        }),
      };
    }) as unknown as typeof fetch;

    const results = await downloadAllDumps({
      lang: "sv",
      dir: testDir,
      fetchFn: mockFetch,
    });

    expect(results).toHaveLength(DUMP_TABLES.length);
    expect(results.map((r) => r.table)).toEqual([...DUMP_TABLES]);
    for (const r of results) {
      expect(existsSync(r.path)).toBe(true);
    }
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(19 * 1024 * 1024)).toBe("19.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(2.4 * 1024 * 1024 * 1024)).toBe("2.4 GB");
  });
});
