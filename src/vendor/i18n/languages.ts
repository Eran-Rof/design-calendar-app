// src/vendor/i18n/languages.ts
//
// Language catalogue + browser/geo default resolution for the vendor-portal
// AI translation feature. The portal ships in English; vendors can switch to
// any of these and the runtime engine (translateEngine.ts) AI-translates the
// live UI. The default selection is derived from the country of the browser's
// location (Vercel geo header), falling back to the browser's own locale.

export type Lang = {
  /** BCP-47-ish short code we pass to the translate endpoint + store. */
  code: string;
  /** Native label shown in the picker (kept untranslated). */
  native: string;
  /** English name of the language (for the AI prompt + a11y). */
  english: string;
};

// English first (the source language / "off" state), then the languages that
// matter most for ROF's vendor base (China + SE Asia + the Americas + Europe).
export const LANGUAGES: Lang[] = [
  { code: "en", native: "English",     english: "English" },
  { code: "zh", native: "中文（简体）", english: "Chinese (Simplified)" },
  { code: "zh-Hant", native: "中文（繁體）", english: "Chinese (Traditional)" },
  { code: "es", native: "Español",     english: "Spanish" },
  { code: "vi", native: "Tiếng Việt",  english: "Vietnamese" },
  { code: "hi", native: "हिन्दी",        english: "Hindi" },
  { code: "bn", native: "বাংলা",        english: "Bengali" },
  { code: "ur", native: "اردو",         english: "Urdu" },
  { code: "id", native: "Bahasa Indonesia", english: "Indonesian" },
  { code: "th", native: "ไทย",          english: "Thai" },
  { code: "ko", native: "한국어",        english: "Korean" },
  { code: "ja", native: "日本語",        english: "Japanese" },
  { code: "pt", native: "Português",    english: "Portuguese" },
  { code: "fr", native: "Français",     english: "French" },
  { code: "de", native: "Deutsch",      english: "German" },
  { code: "it", native: "Italiano",     english: "Italian" },
  { code: "tr", native: "Türkçe",       english: "Turkish" },
  { code: "ar", native: "العربية",       english: "Arabic" },
];

export const LANG_CODES = new Set(LANGUAGES.map((l) => l.code));
export const langByCode = (code: string): Lang | undefined =>
  LANGUAGES.find((l) => l.code === code);
export const englishName = (code: string): string =>
  langByCode(code)?.english || code;
/** RTL scripts — the engine flips `dir` on the root for these. */
export const RTL_LANGS = new Set(["ar", "ur"]);

// ISO-3166 alpha-2 country (Vercel x-vercel-ip-country) → default language.
// Only non-English defaults are listed; anything unmapped stays English.
export const COUNTRY_TO_LANG: Record<string, string> = {
  CN: "zh", SG: "zh",
  TW: "zh-Hant", HK: "zh-Hant", MO: "zh-Hant",
  VN: "vi",
  IN: "hi", BD: "bn", PK: "ur",
  ID: "id", TH: "th",
  KR: "ko", JP: "ja",
  PT: "pt", BR: "pt",
  FR: "fr", BE: "fr",
  DE: "de", AT: "de", CH: "de",
  IT: "it",
  TR: "tr",
  SA: "ar", AE: "ar", EG: "ar", QA: "ar", KW: "ar", JO: "ar", MA: "ar",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", EC: "es",
  GT: "es", DO: "es", VE: "es",
};

/** Map an ISO-2 country to a supported language code (or "en"). */
export function langForCountry(country: string | null | undefined): string {
  if (!country) return "en";
  const code = COUNTRY_TO_LANG[country.toUpperCase()];
  return code && LANG_CODES.has(code) ? code : "en";
}

/**
 * Best-effort default from the browser's own locale list (navigator.languages).
 * Used as the fallback when the geo lookup is unavailable. Matches the base
 * subtag (e.g. "es-MX" → "es"); special-cases Traditional Chinese regions.
 */
export function langFromNavigator(): string {
  if (typeof navigator === "undefined") return "en";
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const raw of list) {
    if (!raw) continue;
    const lc = raw.toLowerCase();
    if (lc.startsWith("zh")) {
      return /(hant|tw|hk|mo)/.test(lc) ? "zh-Hant" : "zh";
    }
    const base = lc.split("-")[0];
    if (LANG_CODES.has(base)) return base;
  }
  return "en";
}
