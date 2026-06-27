// src/tanda/InternalForm1099.tsx
//
// P25 / M20 — 1099-NEC worksheet. Vendors flagged 1099 with their YTD AP paid;
// flags those over the reportable threshold and any missing a Tax ID.

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = { bg: "#0F172A", card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };

type Row = { vendor_id: string; name: string; code: string | null; has_tax_id: boolean; paid_cents: number; reportable: boolean };
type Resp = { year: number; threshold_cents: number; rows: Row[]; summary: { vendors: number; reportable: number; missing_tax_id: number } };

export default function InternalForm1099() {
  const [year, setYear] = useState(2026);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() { setLoading(true); try { setData(await fetch(`/api/internal/form-1099?year=${year}`).then((r) => r.json())); } catch { /* */ } finally { setLoading(false); } }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [year]);

  type ER = { vendor: string; tax_id: string; paid: number; reportable: string };
  const rows: ER[] = (data?.rows || []).map((r) => ({ vendor: r.name, tax_id: r.has_tax_id ? "on file" : "MISSING", paid: r.paid_cents / 100, reportable: r.reportable ? "yes" : "" }));
  const cols: ExportColumn<ER>[] = [{ key: "vendor", header: "Vendor" }, { key: "tax_id", header: "Tax ID" }, { key: "paid", header: "Paid (YTD)", format: "currency_dollars" }, { key: "reportable", header: "1099?" }];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>1099 Worksheet</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>vendors flagged 1099 · paid ≥ $600 are reportable</span>
        <label style={{ color: C.textMuted, fontSize: 12, marginLeft: 10 }}>Year <input style={{ ...input, width: "8ch" }} value={year} onChange={(e) => setYear(Number(e.target.value) || 2026)} /></label>
        <div style={{ marginLeft: "auto" }}><ExportButton rows={rows} columns={cols} filename={`form-1099-${year}`} /></div>
      </div>
      {data && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          {[{ l: "1099 vendors", v: data.summary.vendors, c: C.primary }, { l: "Reportable (≥$600)", v: data.summary.reportable, c: C.success }, { l: "Missing Tax ID", v: data.summary.missing_tax_id, c: data.summary.missing_tax_id ? C.danger : C.textMuted }].map((t) => (
            <div key={t.l} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 14px" }}><div style={{ color: C.textMuted, fontSize: 12 }}>{t.l}</div><div style={{ color: t.c, fontSize: 22, fontWeight: 700 }}>{t.v}</div></div>
          ))}
        </div>
      )}
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Vendor</th><th style={th}>Tax ID</th><th style={{ ...th, textAlign: "right" }}>Paid (YTD)</th><th style={th}>1099?</th></tr></thead>
          <tbody>
            {(data?.rows || []).length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={4}>No vendors flagged as 1099. Tag vendors via the Vendor Master.</td></tr>}
            {(data?.rows || []).map((r) => (
              <tr key={r.vendor_id} style={{ opacity: r.reportable ? 1 : 0.6 }}>
                <td style={td}>{r.name}{r.code ? <span style={{ color: C.textMuted, fontSize: 11 }}> ({r.code})</span> : ""}</td>
                <td style={td}>{r.has_tax_id ? <span style={{ color: C.success }}>on file</span> : <span style={{ color: C.danger }}>MISSING</span>}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: r.reportable ? 600 : 400 }}>${(r.paid_cents / 100).toFixed(2)}</td>
                <td style={td}>{r.reportable ? <span style={{ color: C.success, fontWeight: 600 }}>yes</span> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>MVP: sums AP paid (cash basis) per 1099 vendor in the calendar year. Box mapping + e-file are deferred.</div>
    </div>
  );
}
