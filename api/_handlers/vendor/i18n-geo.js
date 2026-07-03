// api/vendor/i18n-geo
//
// GET — returns the caller's country (from the platform geo header) and a
// suggested default language for the vendor portal. Used by the language
// picker to default to "the country of the browser's location" on first visit,
// before any manual choice. Lightweight + unauthenticated: it only reflects the
// caller's own request origin (no secrets, no DB).
//
// resp: { country: "CN" | null, suggested_lang: "zh" }
//
// NOTE: COUNTRY_TO_LANG mirrors src/vendor/i18n/languages.ts — keep in sync if
// the supported-language set changes.

// ISO-3166 alpha-2 → default language code (only non-English defaults listed).
const COUNTRY_TO_LANG = {
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

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "private, max-age=86400");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const h = req.headers || {};
  // Vercel sets x-vercel-ip-country; fall back to common CDN headers.
  const raw = h["x-vercel-ip-country"] || h["x-country"] || h["cf-ipcountry"] || "";
  const country = (Array.isArray(raw) ? raw[0] : raw || "").toString().toUpperCase().slice(0, 2) || null;
  const suggested_lang = (country && COUNTRY_TO_LANG[country]) || "en";
  return res.status(200).json({ country, suggested_lang });
}
