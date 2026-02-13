export const SUPPORTED_LANGS = ["en", "sv", "ja"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: Lang = "en";
export const LANG_NAMES: Record<Lang, string> = { en: "English", sv: "Svenska", ja: "日本語" };
