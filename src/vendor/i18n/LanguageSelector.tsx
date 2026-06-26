// src/vendor/i18n/LanguageSelector.tsx
//
// Globe dropdown for the vendor-portal header. Lists every supported language
// by its native name and switches the live AI translation. Marked
// data-no-i18n so the engine never translates its own option labels; shows a
// subtle "translating…" pulse while a batch is in flight.

import { useLanguage } from "./LanguageContext";

export default function LanguageSelector() {
  const { lang, setLang, busy, languages } = useLanguage();
  return (
    <div data-no-i18n style={{ display: "flex", alignItems: "center", gap: 6 }} title="Language / 语言 / Idioma">
      <span aria-hidden style={{ fontSize: 15, opacity: busy ? 0.5 : 0.9, transition: "opacity .2s" }}>🌐</span>
      <select
        aria-label="Select language"
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        style={{
          background: "rgba(255,255,255,0.12)",
          color: "#FFFFFF",
          border: "1px solid rgba(255,255,255,0.4)",
          borderRadius: 6,
          padding: "6px 8px",
          fontSize: 13,
          fontFamily: "inherit",
          cursor: "pointer",
          colorScheme: "dark",
          maxWidth: 160,
        }}
      >
        {languages.map((l) => (
          <option key={l.code} value={l.code} style={{ color: "#0f172a" }}>
            {l.native}
          </option>
        ))}
      </select>
    </div>
  );
}
