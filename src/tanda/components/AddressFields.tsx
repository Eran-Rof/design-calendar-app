// src/tanda/components/AddressFields.tsx
//
// Structured address editor backing a jsonb column (vendors.address,
// customers.billing_address / shipping_address, factor_master.address,
// customer_locations.address). The value is a plain object { line1, line2,
// city, state, postal_code, country }; unknown keys on the incoming value are
// preserved.
//
// Country + State are now searchable DROPDOWNS sourced from country_master /
// state_master (operator ask). Going forward country is stored as its ISO-2
// code (e.g. "US") and state as its code (e.g. "CA"); legacy free-text values
// are tolerated — an unrecognised stored value is injected as a one-off option
// so it still shows and is never silently dropped. When the selected country
// has no states seeded in the master, the State field falls back to free text.
//
// The two masters are fetched once per page and shared across every mounted
// AddressFields instance via a module-level cache (a customer modal can render
// several address editors without N duplicate fetches).

import React, { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./SearchableSelect";

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal?: string;        // canonical key (matches the Xoro sync + live data)
  postal_code?: string;   // legacy — read as a fallback only
  country?: string;
  [k: string]: unknown;
};

type Country = { iso2: string; name: string };
type StateRow = { country_iso2: string; code: string; name: string };

const C = { cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8" };
const input: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box",
};
// Match the SearchableSelect input to the plain inputs around it (it defaults
// to the slightly-darker page bg otherwise).
const selectInput: React.CSSProperties = { ...input };

// ── Module-level caches: fetch each master once, share across instances ──────
let countriesCache: Country[] | null = null;
let countriesPromise: Promise<Country[]> | null = null;
const statesCache: Record<string, StateRow[]> = {};
const statesPromises: Record<string, Promise<StateRow[]>> = {};

function loadCountries(): Promise<Country[]> {
  if (countriesCache) return Promise.resolve(countriesCache);
  if (!countriesPromise) {
    countriesPromise = fetch("/api/internal/countries")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { countriesCache = Array.isArray(d) ? d : []; return countriesCache; })
      .catch(() => { countriesCache = []; return countriesCache; });
  }
  return countriesPromise;
}
function loadStates(iso2: string): Promise<StateRow[]> {
  if (!iso2) return Promise.resolve([]);
  if (statesCache[iso2]) return Promise.resolve(statesCache[iso2]);
  if (!statesPromises[iso2]) {
    statesPromises[iso2] = fetch(`/api/internal/states?country=${encodeURIComponent(iso2)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { statesCache[iso2] = Array.isArray(d) ? d : []; return statesCache[iso2]; })
      .catch(() => { statesCache[iso2] = []; return statesCache[iso2]; });
  }
  return statesPromises[iso2];
}

export default function AddressFields({
  label, value, onChange,
}: {
  label: string;
  value: Address;
  onChange: (next: Address) => void;
}) {
  const v = value || {};
  const set = (k: string, val: string) => onChange({ ...v, [k]: val });

  // AI postal-code fill (operator #7) — fills `postal` from the rest of the
  // address (US ZIP / ZIP+4 when determinable, else 5-digit; standard otherwise).
  const [postalBusy, setPostalBusy] = useState(false);
  const suggestPostal = async () => {
    if (postalBusy || !String(v.city ?? "").trim()) return;
    setPostalBusy(true);
    try {
      const r = await fetch("/api/internal/addresses/postal-suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line1: v.line1, city: v.city, state: v.state, country: v.country }),
      });
      const j = await r.json();
      if (r.ok && j.postal) onChange({ ...v, postal: String(j.postal) });
    } catch { /* ignore */ }
    finally { setPostalBusy(false); }
  };

  const [countries, setCountries] = useState<Country[]>(countriesCache ?? []);
  useEffect(() => {
    let cancel = false;
    void loadCountries().then((d) => { if (!cancel) setCountries(d); });
    return () => { cancel = true; };
  }, []);

  // Resolve the stored country (iso2 OR legacy name) to its iso2.
  const rawCountry = String(v.country ?? "");
  const matchedCountry = useMemo(
    () => countries.find((c) => c.iso2 === rawCountry.toUpperCase() || c.name.toLowerCase() === rawCountry.toLowerCase()),
    [countries, rawCountry],
  );
  const countryIso2 = matchedCountry?.iso2 || (/^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : "");
  const countryValue = matchedCountry?.iso2 || rawCountry;
  const countryOptions = useMemo(() => {
    const opts = countries.map((c) => ({ value: c.iso2, label: `${c.name} (${c.iso2})`, searchHaystack: `${c.name} ${c.iso2}` }));
    if (rawCountry && !matchedCountry && !opts.some((o) => o.value === rawCountry)) {
      opts.unshift({ value: rawCountry, label: rawCountry, searchHaystack: rawCountry });
    }
    return opts;
  }, [countries, rawCountry, matchedCountry]);

  // States for the resolved country (only seeded for US / CA today).
  const [states, setStates] = useState<StateRow[]>(countryIso2 ? (statesCache[countryIso2] ?? []) : []);
  useEffect(() => {
    let cancel = false;
    if (countryIso2) void loadStates(countryIso2).then((d) => { if (!cancel) setStates(d); });
    else setStates([]);
    return () => { cancel = true; };
  }, [countryIso2]);

  const rawState = String(v.state ?? "");
  const matchedState = useMemo(
    () => states.find((s) => s.code === rawState.toUpperCase() || s.name.toLowerCase() === rawState.toLowerCase()),
    [states, rawState],
  );
  const stateValue = matchedState?.code || rawState;
  const stateOptions = useMemo(() => {
    const opts = states.map((s) => ({ value: s.code, label: `${s.name} (${s.code})`, searchHaystack: `${s.name} ${s.code}` }));
    if (rawState && !matchedState && !opts.some((o) => o.value === rawState)) {
      opts.unshift({ value: rawState, label: rawState, searchHaystack: rawState });
    }
    return opts;
  }, [states, rawState, matchedState]);
  const hasStates = states.length > 0;

  // Switching country to a different one clears a now-mismatched state.
  const onCountryChange = (iso2: string) => {
    if (iso2 !== countryValue) onChange({ ...v, country: iso2, state: "" });
    else onChange({ ...v, country: iso2 });
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input style={{ ...input, gridColumn: "1 / -1" }} placeholder="Street address" value={String(v.line1 ?? "")} onChange={(e) => set("line1", e.target.value)} />
        <input style={{ ...input, gridColumn: "1 / -1" }} placeholder="Suite / unit (optional)" value={String(v.line2 ?? "")} onChange={(e) => set("line2", e.target.value)} />
        <input style={input} placeholder="City" value={String(v.city ?? "")} onChange={(e) => set("city", e.target.value)} />
        {hasStates ? (
          <SearchableSelect value={stateValue || null} onChange={(val) => set("state", val)} options={stateOptions} placeholder="State / province" inputStyle={selectInput} />
        ) : (
          <input style={input} placeholder="State / province" value={String(v.state ?? "")} onChange={(e) => set("state", e.target.value)} />
        )}
        <div style={{ display: "flex", gap: 4 }}>
          <input style={{ ...input, flex: 1 }} placeholder="Postal code" value={String(v.postal ?? v.postal_code ?? "")} onChange={(e) => set("postal", e.target.value)} />
          <button type="button" onClick={() => void suggestPostal()} disabled={postalBusy || !String(v.city ?? "").trim()}
            title="Use AI to fill the postal code from the rest of the address"
            style={{ background: "#0b1220", color: "#3B82F6", border: "1px solid #3B82F6", borderRadius: 4, padding: "0 8px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}>
            {postalBusy ? "…" : "AI"}
          </button>
        </div>
        <SearchableSelect value={countryValue || null} onChange={onCountryChange} options={countryOptions} placeholder="Country" inputStyle={selectInput} />
      </div>
    </div>
  );
}
