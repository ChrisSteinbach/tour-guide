import {
  getStoredHighlights,
  HIGHLIGHTS_STORAGE_KEY,
  DEFAULT_FILTER,
} from "./stored-highlights";

function stubStorage(
  entries: Record<string, string> = {},
): Pick<Storage, "getItem"> {
  return {
    getItem: (key: string): string | null => entries[key] ?? null,
  };
}

describe("getStoredHighlights", () => {
  it("returns the default (highlights) when localStorage has no entry", () => {
    const storage = stubStorage();

    expect(getStoredHighlights(storage)).toBe(DEFAULT_FILTER);
    expect(DEFAULT_FILTER).toBe("highlights");
  });

  it("returns the default when the stored value is garbage", () => {
    const storage = stubStorage({ [HIGHLIGHTS_STORAGE_KEY]: "everything!" });

    expect(getStoredHighlights(storage)).toBe("highlights");
  });

  it("returns the default when the stored value is the empty string", () => {
    const storage = stubStorage({ [HIGHLIGHTS_STORAGE_KEY]: "" });

    expect(getStoredHighlights(storage)).toBe("highlights");
  });

  it("round-trips a stored 'all'", () => {
    const storage = stubStorage({ [HIGHLIGHTS_STORAGE_KEY]: "all" });

    expect(getStoredHighlights(storage)).toBe("all");
  });

  it("round-trips a stored 'highlights'", () => {
    const storage = stubStorage({ [HIGHLIGHTS_STORAGE_KEY]: "highlights" });

    expect(getStoredHighlights(storage)).toBe("highlights");
  });

  it("is case-sensitive: upper-case variants fall back to the default", () => {
    const storage = stubStorage({ [HIGHLIGHTS_STORAGE_KEY]: "ALL" });

    expect(getStoredHighlights(storage)).toBe("highlights");
  });
});
