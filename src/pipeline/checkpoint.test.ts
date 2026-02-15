import { boundsKey, regionsFingerprint, filterResumedRegions, deduplicateNdjsonFile, readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import type { CheckpointFile } from "./checkpoint.js";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------- boundsKey ----------

describe("boundsKey", () => {
  it("serializes bounds to comma-separated string", () => {
    expect(boundsKey({ south: -10, north: 0, west: 5.5, east: 15 })).toBe("-10,0,5.5,15");
  });

  it("is deterministic", () => {
    const b = { south: 48, north: 49, west: 2, east: 3 };
    expect(boundsKey(b)).toBe(boundsKey(b));
  });
});

// ---------- regionsFingerprint ----------

describe("regionsFingerprint", () => {
  it("returns a hex string", () => {
    const fp = regionsFingerprint([{ south: 0, north: 10, west: 0, east: 10 }]);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is order-independent", () => {
    const a = { south: 0, north: 10, west: 0, east: 10 };
    const b = { south: 10, north: 20, west: 0, east: 10 };
    expect(regionsFingerprint([a, b])).toBe(regionsFingerprint([b, a]));
  });

  it("changes when regions differ", () => {
    const a = regionsFingerprint([{ south: 0, north: 10, west: 0, east: 10 }]);
    const b = regionsFingerprint([{ south: 0, north: 10, west: 0, east: 20 }]);
    expect(a).not.toBe(b);
  });
});

// ---------- filterResumedRegions ----------

describe("filterResumedRegions", () => {
  it("removes completed regions", () => {
    const regions = [
      { south: 0, north: 10, west: 0, east: 10 },
      { south: 10, north: 20, west: 0, east: 10 },
      { south: 20, north: 30, west: 0, east: 10 },
    ];
    const completed = new Set(["0,10,0,10", "20,30,0,10"]);
    const remaining = filterResumedRegions(regions, completed);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({ south: 10, north: 20, west: 0, east: 10 });
  });

  it("returns all regions when none completed", () => {
    const regions = [{ south: 0, north: 10, west: 0, east: 10 }];
    const remaining = filterResumedRegions(regions, new Set());
    expect(remaining).toHaveLength(1);
  });

  it("returns empty array when all completed", () => {
    const regions = [{ south: 0, north: 10, west: 0, east: 10 }];
    const completed = new Set(["0,10,0,10"]);
    expect(filterResumedRegions(regions, completed)).toHaveLength(0);
  });
});

// ---------- writeCheckpoint / readCheckpoint ----------

describe("writeCheckpoint / readCheckpoint", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
  });

  it("round-trips a checkpoint", async () => {
    const cp: CheckpointFile = {
      version: 1,
      lang: "en",
      startedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T01:00:00Z",
      totalRegions: 648,
      completedRegions: ["0,10,0,10"],
      leafTiles: [{ south: 0, north: 10, west: 0, east: 10 }],
      failedTiles: [],
    };
    const filePath = join(dir, "cp.json");
    await writeCheckpoint(filePath, cp);
    const loaded = await readCheckpoint(filePath);
    expect(loaded).toEqual(cp);
  });

  it("returns null for missing file", async () => {
    const result = await readCheckpoint(join(dir, "nonexistent.json"));
    expect(result).toBeNull();
  });

  it("writes atomically via tmp file", async () => {
    const filePath = join(dir, "cp.json");
    const cp: CheckpointFile = {
      version: 1, lang: "en", startedAt: "", updatedAt: "",
      totalRegions: 1, completedRegions: [], leafTiles: [], failedTiles: [],
    };
    await writeCheckpoint(filePath, cp);
    // tmp file should not remain
    expect(existsSync(filePath + ".tmp")).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });
});

// ---------- deduplicateNdjsonFile ----------

describe("deduplicateNdjsonFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dedup-test-"));
  });

  it("removes duplicate titles", async () => {
    const filePath = join(dir, "articles.json");
    writeFileSync(filePath, [
      JSON.stringify({ title: "A", lat: 1, lon: 1, desc: "" }),
      JSON.stringify({ title: "B", lat: 2, lon: 2, desc: "" }),
      JSON.stringify({ title: "A", lat: 3, lon: 3, desc: "dup" }),
    ].join("\n") + "\n");

    const { total, unique } = await deduplicateNdjsonFile(filePath);
    expect(total).toBe(3);
    expect(unique).toBe(2);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).title).toBe("A");
    expect(JSON.parse(lines[1]).title).toBe("B");
  });

  it("handles truncated last line gracefully", async () => {
    const filePath = join(dir, "articles.json");
    writeFileSync(filePath,
      JSON.stringify({ title: "A", lat: 1, lon: 1, desc: "" }) + "\n" +
      '{"title":"B","lat":2,' // truncated
    );

    const { total, unique } = await deduplicateNdjsonFile(filePath);
    expect(total).toBe(2); // both lines counted
    expect(unique).toBe(1); // only A parsed successfully
  });

  it("handles empty file", async () => {
    const filePath = join(dir, "empty.json");
    writeFileSync(filePath, "");

    const { total, unique } = await deduplicateNdjsonFile(filePath);
    expect(total).toBe(0);
    expect(unique).toBe(0);
  });

  it("preserves first occurrence on duplicate", async () => {
    const filePath = join(dir, "articles.json");
    writeFileSync(filePath, [
      JSON.stringify({ title: "X", lat: 1, lon: 1, desc: "first" }),
      JSON.stringify({ title: "X", lat: 2, lon: 2, desc: "second" }),
    ].join("\n") + "\n");

    await deduplicateNdjsonFile(filePath);

    const content = readFileSync(filePath, "utf-8").trim();
    expect(JSON.parse(content).desc).toBe("first");
  });
});
