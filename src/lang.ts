export const SUPPORTED_LANGS = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "ru",
  "zh",
  "pt",
  "pl",
  "nl",
  "ko",
  "ar",
  "sv",
  "ja",
] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: Lang = "en";
export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  ru: "Русский",
  zh: "中文",
  pt: "Português",
  pl: "Polski",
  nl: "Nederlands",
  ko: "한국어",
  ar: "العربية",
  sv: "Svenska",
  ja: "日本語",
};
