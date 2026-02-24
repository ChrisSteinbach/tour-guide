import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateCanary } from "./canary.js";
import type { Lang } from "../lang.js";

const testDir = join(tmpdir(), "canary-test-" + Date.now());

beforeAll(() => mkdirSync(testDir, { recursive: true }));
afterAll(() => rmSync(testDir, { recursive: true, force: true }));

function writeNdjson(
  filename: string,
  articles: { title: string; lat: number; lon: number }[],
): string {
  const path = join(testDir, filename);
  writeFileSync(path, articles.map((a) => JSON.stringify(a)).join("\n") + "\n");
  return path;
}

describe("validateCanary", () => {
  it("passes when all landmarks present with correct coordinates", async () => {
    const path = writeNdjson("good-en.json", [
      { title: "Some Other Article", lat: 10, lon: 20 },
      { title: "Eiffel Tower", lat: 48.858, lon: 2.294 },
      { title: "Statue of Liberty", lat: 40.689, lon: -74.044 },
      { title: "Sydney Opera House", lat: -33.857, lon: 151.215 },
    ]);

    const result = await validateCanary(path, "en");
    expect(result.passed).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.matched).toBe(3);
    expect(result.mismatches).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("still passes when a landmark is missing (subset extraction)", async () => {
    const path = writeNdjson("missing-en.json", [
      { title: "Eiffel Tower", lat: 48.858, lon: 2.294 },
      { title: "Sydney Opera House", lat: -33.857, lon: 151.215 },
    ]);

    const result = await validateCanary(path, "en");
    expect(result.passed).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.missing).toEqual([
      expect.stringContaining("Statue of Liberty"),
    ]);
  });

  it("fails when coordinates are too far off", async () => {
    const path = writeNdjson("bad-coords.json", [
      { title: "Eiffel Tower", lat: 49.0, lon: 2.5 }, // off by ~0.14°, ~0.21°
      { title: "Statue of Liberty", lat: 40.689, lon: -74.044 },
      { title: "Sydney Opera House", lat: -33.857, lon: 151.215 },
    ]);

    const result = await validateCanary(path, "en");
    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([
      expect.stringContaining("Eiffel Tower"),
    ]);
  });

  it("skips validation for languages with no landmarks", async () => {
    const path = writeNdjson("empty-lang.json", []);
    const result = await validateCanary(path, "xx" as Lang);
    expect(result.passed).toBe(true);
    expect(result.checked).toBe(0);
  });

  it("validates Swedish landmarks", async () => {
    const path = writeNdjson("good-sv.json", [
      { title: "Eiffeltornet", lat: 48.858, lon: 2.294 },
      { title: "Globen", lat: 59.294, lon: 18.083 },
    ]);

    const result = await validateCanary(path, "sv");
    expect(result.passed).toBe(true);
    expect(result.checked).toBe(2);
  });
});
