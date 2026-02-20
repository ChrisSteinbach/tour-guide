// Checkpoint utilities for resumable extraction
// Tracks completed regions so interrupted runs can pick up where they left off

import { createHash } from "node:crypto";

// ---------- Types ----------

type Bounds = { south: number; north: number; west: number; east: number };

export interface CheckpointFile {
  version: 1;
  lang: string;
  startedAt: string;
  updatedAt: string;
  totalRegions: number;
  completedRegions: string[];
  leafTiles: Bounds[];
  failedTiles: Bounds[];
}

// ---------- Pure functions ----------

export function boundsKey(b: Bounds): string {
  return `${b.south},${b.north},${b.west},${b.east}`;
}

export function regionsFingerprint(regions: Bounds[]): string {
  const keys = regions.map(boundsKey).sort();
  return createHash("sha256")
    .update(keys.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function filterResumedRegions(
  regions: Bounds[],
  completedKeys: Set<string>,
): Bounds[] {
  return regions.filter((r) => !completedKeys.has(boundsKey(r)));
}

// ---------- File I/O ----------

export async function writeCheckpoint(
  filePath: string,
  checkpoint: CheckpointFile,
): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmpPath = filePath + ".tmp";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export async function readCheckpoint(
  filePath: string,
): Promise<CheckpointFile | null> {
  const fs = await import("node:fs");
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as CheckpointFile;
  } catch {
    return null;
  }
}

// ---------- NDJSON deduplication ----------

export async function deduplicateNdjsonFile(
  filePath: string,
): Promise<{ total: number; unique: number }> {
  const fs = await import("node:fs");
  const readline = await import("node:readline");

  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;

  const input = fs.createReadStream(filePath, "utf-8");
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    try {
      const obj = JSON.parse(line) as { title?: string };
      const title = obj.title;
      if (title && !seen.has(title)) {
        seen.add(title);
        lines.push(line);
      }
    } catch {
      // Skip malformed lines (e.g. truncated by crash)
    }
  }

  fs.writeFileSync(filePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  return { total, unique: lines.length };
}
