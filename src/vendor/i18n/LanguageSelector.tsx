// src/vendor/i18n/LanguageSelector.tsx
//
// Globe dropdown for the vendor-portal header. Lists every supported language
// by its native name and switches the live AI translation. Marked
// data-no-i18n so the engine never translates its own option labels; shows a
// subtle "translating…" pulse while a batch is in flight.

import { useLanguage } from "./LanguageContext";
import SearchableSelect from "../../tanda/components/SearchableSelect";

export default function LanguageSelector() {
  const { lang, setLang, languages } = useLanguage();
  return (
    <div data-no-i18n style={{ display: "flex", alignItems: "center", gap: 6 }} title="Language / 语言 / Idioma">
      <div style={{ width: 160 }}>
        <SearchableSelect
          value={lang}
          onChange={(v) => setLang(v)}
          options={languages.map((l) => ({ value: l.code, label: l.native }))}
          inputStyle={{
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 13,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        />
      </div>
    </div>
  );
}
