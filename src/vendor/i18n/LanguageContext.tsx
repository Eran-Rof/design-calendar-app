// src/vendor/i18n/LanguageContext.tsx
//
// Vendor-portal language state. Holds the active language, drives the runtime
// TranslationEngine, and resolves the *default* language from the country of
// the browser's location (Vercel geo header via /api/vendor/i18n-geo), falling
// back to the browser locale, then English. A manual choice is sticky
// (localStorage) and always wins over the geo default.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LANGUAGES, langForCountry, langFromNavigator, LANG_CODES } from "./languages";
import { TranslationEngine } from "./translateEngine";

const STORE_KEY = "rof_vendor_lang";
const CHOSE_KEY = "rof_vendor_lang_chosen"; // "1" once the user picks manually

type Ctx = {
  lang: string;
  setLang: (code: string) => void;
  busy: boolean;
  languages: typeof LANGUAGES;
};
const LanguageCtx = createContext<Ctx | null>(null);

export function useLanguage(): Ctx {
  const c = useContext(LanguageCtx);
  if (!c) throw new Error("useLanguage must be used within <LanguageProvider>");
  return c;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const stored = (() => { try { return localStorage.getItem(STORE_KEY) || ""; } catch { return ""; } })();
  const [lang, setLangState] = useState<string>(stored && LANG_CODES.has(stored) ? stored : "en");
  const [busy, setBusy] = useState(false);
  const engineRef = useRef<TranslationEngine | null>(null);

  // Lazily build the engine once (browser only).
  if (!engineRef.current && typeof window !== "undefined") {
    engineRef.current = new TranslationEngine(setBusy);
  }

  // Apply the current language whenever it changes.
  useEffect(() => {
    engineRef.current?.setLang(lang);
  }, [lang]);

  // First load with no stored choice → derive default from geo country.
  useEffect(() => {
    const chose = (() => { try { return localStorage.getItem(CHOSE_KEY) === "1"; } catch { return false; } })();
    if (chose || stored) return; // respect an explicit prior choice
    let cancelled = false;
    (async () => {
      let def = "en";
      try {
        const r = await fetch("/api/vendor/i18n-geo");
        if (r.ok) {
          const j = await r.json();
          def = (j?.suggested_lang && LANG_CODES.has(j.suggested_lang)) ? j.suggested_lang : langForCountry(j?.country);
        }
      } catch { /* ignore */ }
      if (def === "en") def = langFromNavigator();
      if (!cancelled && def !== "en") {
        try { localStorage.setItem(STORE_KEY, def); } catch { /* ignore */ }
        setLangState(def);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLang = (code: string) => {
    if (!LANG_CODES.has(code)) return;
    try { localStorage.setItem(STORE_KEY, code); localStorage.setItem(CHOSE_KEY, "1"); } catch { /* ignore */ }
    setLangState(code);
  };

  const value = useMemo<Ctx>(() => ({ lang, setLang, busy, languages: LANGUAGES }), [lang, busy]);
  return <LanguageCtx.Provider value={value}>{children}</LanguageCtx.Provider>;
}
