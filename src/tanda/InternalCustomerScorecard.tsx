// src/tanda/InternalCustomerScorecard.tsx
//
// Nav-reachable wrapper around the existing <CustomerScorecard> drill-through
// modal. The scorecard requires a customer to be selected, so this panel
// presents a searchable customer picker; choosing a customer renders the
// existing CustomerScorecard overlay (balance, purchases, margin, dilution,
// commission, invoices, SOs, JE).
//
// Lives under the Customers nav group as "Customer Scorecard". Reuses the
// same component the drill button on each Customer Master row already opens, so
// there is no duplicate scorecard logic — only an entry point.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import CustomerScorecard from "./CustomerScorecard";
import { displayCustomerCode } from "../shared/customers/displayCustomerCode";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6",
};

type Customer = { id: string; customer_code: string | null; code: string | null; name: string };

export default function InternalCustomerScorecard() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const r = await fetch("/api/internal/customer-master?limit=5000");
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const data = (await r.json()) as Customer[];
        if (!cancelled) setCustomers(data);
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
      customers.map((c) => {
        const code = displayCustomerCode(c.customer_code ?? c.code ?? null);
        return { value: c.id, label: code ? `${code} — ${c.name}` : c.name };
      }),
    [customers],
  );

  const exportColumns: ExportColumn<{ code: string; name: string }>[] = [
    { key: "code", header: "Customer Code" },
    { key: "name", header: "Customer Name" },
  ];
  const exportRows = customers.map((c) => ({
    code: displayCustomerCode(c.customer_code ?? c.code ?? null) || "",
    name: c.name,
  }));

  return (
    <div style={{ padding: 20, color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Customer Scorecard</h2>
        <ExportButton rows={exportRows} filename="customers" sheetName="Customers" columns={exportColumns} />
      </div>
      <p style={{ margin: "0 0 16px", color: C.textMuted, fontSize: 13 }}>
        Pick a customer to view its scorecard — balance, purchases, margin, dilution, commission, invoices, SOs, and JE.
      </p>

      {error && (
        <div style={{ color: "#EF4444", marginBottom: 12, fontSize: 13 }}>Error: {error}</div>
      )}

      <div style={{ maxWidth: 480 }}>
        <SearchableSelect
          value={selectedId}
          onChange={(v) => { setSelectedId(v); setOpenId(v || null); }}
          options={options}
          placeholder={loading ? "Loading customers…" : "Search customers by code or name…"}
        />
      </div>

      {openId && <CustomerScorecard customerId={openId} onClose={() => { setOpenId(null); setSelectedId(null); }} />}
    </div>
  );
}
