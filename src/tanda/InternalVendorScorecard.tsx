// src/tanda/InternalVendorScorecard.tsx
//
// Nav-reachable wrapper around the existing <VendorScorecard> drill-through
// modal. The scorecard itself requires a vendor to be selected, so this panel
// presents a searchable vendor picker; choosing a vendor renders the existing
// VendorScorecard overlay (lead time, on-time %, purchases, invoices, POs).
//
// Lives under the 🏭 Vendors nav group as "Vendor Scorecard". Reuses the same
// component the 📊 button on each Vendor Master row already opens, so there is
// no duplicate scorecard logic — only an entry point.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import VendorScorecard from "./VendorScorecard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6",
};

type Vendor = { id: string; code: string | null; name: string };

export default function InternalVendorScorecard() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const r = await fetch("/api/internal/vendor-master?limit=5000");
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const data = (await r.json()) as Vendor[];
        if (!cancelled) setVendors(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const options = useMemo<SearchableSelectOption[]>(
    () =>
      vendors.map((v) => ({
        value: v.id,
        label: v.code ? `${v.code} — ${v.name}` : v.name,
      })),
    [vendors],
  );

  const exportColumns: ExportColumn<{ code: string; name: string }>[] = [
    { key: "code", header: "Vendor Code" },
    { key: "name", header: "Vendor Name" },
  ];
  const exportRows = vendors.map((v) => ({ code: v.code || "", name: v.name }));

  return (
    <div style={{ padding: 20, color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Vendor Scorecard</h2>
        <ExportButton rows={exportRows} filename="vendors" sheetName="Vendors" columns={exportColumns} />
      </div>
      <p style={{ margin: "0 0 16px", color: C.textMuted, fontSize: 13 }}>
        Pick a vendor to view its scorecard — lead time, on-time %, purchases, AP balance, invoices, and POs.
      </p>

      {error && (
        <div style={{ color: "#EF4444", marginBottom: 12, fontSize: 13 }}>Error: {error}</div>
      )}

      <div style={{ maxWidth: 480 }}>
        <SearchableSelect
          value={selectedId}
          onChange={(v) => { setSelectedId(v); setOpenId(v || null); }}
          options={options}
          placeholder={loading ? "Loading vendors…" : "Search vendors by code or name…"}
        />
      </div>

      {openId && <VendorScorecard vendorId={openId} onClose={() => { setOpenId(null); setSelectedId(null); }} />}
    </div>
  );
}
