import { DEFAULT_LANG, SUPPORTED_LANGS } from "../lang";
import type { Lang } from "../lang";

/** localStorage key for the user's preferred language. */
export const LANG_STORAGE_KEY = "tour-guide-lang";

/**
 * Read the user's preferred language from localStorage, validating it against
 * SUPPORTED_LANGS. Unknown values and missing entries fall back to DEFAULT_LANG.
 *
 * Extracted from main.ts so it can be tested without booting composeApp.
 */
export function getStoredLang(storage: Pick<Storage, "getItem">): Lang {
  const stored = storage.getItem(LANG_STORAGE_KEY);
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return DEFAULT_LANG;
}
