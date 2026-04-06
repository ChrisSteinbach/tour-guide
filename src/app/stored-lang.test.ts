import { getStoredLang, LANG_STORAGE_KEY } from "./stored-lang";
import { DEFAULT_LANG } from "../lang";

function stubStorage(
  entries: Record<string, string> = {},
): Pick<Storage, "getItem"> {
  return {
    getItem: (key: string): string | null => entries[key] ?? null,
  };
}

describe("getStoredLang", () => {
  it("returns DEFAULT_LANG when localStorage has no entry", () => {
    const storage = stubStorage();

    expect(getStoredLang(storage)).toBe(DEFAULT_LANG);
  });

  it("returns DEFAULT_LANG when stored value is not a supported language", () => {
    const storage = stubStorage({ [LANG_STORAGE_KEY]: "xx" });

    expect(getStoredLang(storage)).toBe(DEFAULT_LANG);
  });

  it("returns DEFAULT_LANG when stored value is the empty string", () => {
    const storage = stubStorage({ [LANG_STORAGE_KEY]: "" });

    expect(getStoredLang(storage)).toBe(DEFAULT_LANG);
  });

  it("round-trips a valid stored language", () => {
    const storage = stubStorage({ [LANG_STORAGE_KEY]: "sv" });

    expect(getStoredLang(storage)).toBe("sv");
  });

  it("is case-sensitive: upper-case variants fall back to DEFAULT_LANG", () => {
    const storage = stubStorage({ [LANG_STORAGE_KEY]: "EN" });

    expect(getStoredLang(storage)).toBe(DEFAULT_LANG);
  });
});
