// src/tanda/InternalProcurementRecon.tsx
//
// P13 / C5 — Procurement Reconciliation Inbox + Open-Commitments report.
// Read-only dashboard of the procurement states that block a clean period close:
// open PO commitments by vendor, stale customs entries, unresolved 3-way matches,
// failed QC. Reads GET /api/internal/procurement/recon-inbox.

import { useEffect, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

type Commit = { vendor_id: string | null; vendor_name: string; open_count: number; remaining_cents: number };
type Customs = { id: string; entry_number: string; entry_date: string; total_duty_cents: number | string };
type TW = { id: string; vendor_invoice_number: string; invoice_date: string; total_cents: number | string; variance_cents: number | string; three_way_match_status: string; vendor?: { name?: string } | null };
type QC = { id: string; receipt_id: string; inspection_date: string; status: string };
type Data = {
  open_commitments: Commit[]; open_commitments_total_cents: number;
  stale_customs: Customs[]; three_way_issues: TW[]; qc_fails: QC[];
  summary: { open_commitment_vendors: number; stale_customs: number; three_way_issues: number; qc_fails: number };
};
const fmt = (c: number | string | null | undefined) => { const n = Number(c ?? 0); return `$${Math.trunc(n / 100).toLocaleString()}.${String(Math.round(n % 100)).padStart(2, "0")}`; };

function Section({ title, count, tone, children }: { title: string; count: number; tone: string; children: React.ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.cardBdr}`, fontWeight: 600, fontSize: 14 }}>
        {title} <span style={{ marginLeft: 8, fontSize: 12, color: count > 0 ? tone : C.textMuted }}>● {count}</span>
      </div>
      {children}
    </div>
  );
}

export default function InternalProcurementRecon() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/internal/procurement/recon-inbox");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setData(await r.json() as Data);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Procurement Reconciliation</h2>
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
      </div>
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {!loading && data && (
        <>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
            These states block a clean period close (period close pre-flight checks the same). Open commitments total: <b style={{ color: C.text }}>{fmt(data.open_commitments_total_cents)}</b>.
          </div>

          <Section title="Open commitments by vendor" count={data.summary.open_commitment_vendors} tone={C.primary}>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: 8 }}>
              <ExportButton rows={data.open_commitments.map((c) => ({ vendor: c.vendor_name, open_pos: c.open_count, remaining: c.remaining_cents })) as unknown as Array<Record<string, unknown>>}
                filename="open-commitments" sheetName="Open Commitments"
                columns={[{ key: "vendor", header: "Vendor" }, { key: "open_pos", header: "Open POs" }, { key: "remaining", header: "Remaining", format: "currency_cents" }] as ExportColumn<Record<string, unknown>>[]} />
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Vendor</th><th style={{ ...th, textAlign: "right" }}>Open POs</th><th style={{ ...th, textAlign: "right" }}>Remaining</th></tr></thead>
              <tbody>
                {data.open_commitments.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={3}>No open commitments.</td></tr>}
                {data.open_commitments.map((c) => (
                  <tr key={c.vendor_id || c.vendor_name}><td style={td}>{c.vendor_name}</td><td style={{ ...td, textAlign: "right" }}>{c.open_count}</td><td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(c.remaining_cents)}</td></tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Unresolved 3-way matches (variance / exception)" count={data.summary.three_way_issues} tone={C.danger}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Vendor</th><th style={th}>Invoice #</th><th style={th}>Date</th><th style={{ ...th, textAlign: "right" }}>Total</th><th style={{ ...th, textAlign: "right" }}>Variance</th><th style={th}>Status</th></tr></thead>
              <tbody>
                {data.three_way_issues.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>None.</td></tr>}
                {data.three_way_issues.map((t) => (
                  <tr key={t.id}><td style={td}>{t.vendor?.name || "—"}</td><td style={td}>{t.vendor_invoice_number}</td><td style={td}>{fmtDateDisplay(t.invoice_date)}</td><td style={{ ...td, textAlign: "right" }}>{fmt(t.total_cents)}</td><td style={{ ...td, textAlign: "right", color: C.warn }}>{fmt(t.variance_cents)}</td><td style={td}>{t.three_way_match_status}</td></tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Stale customs entries (>60d, no broker invoice)" count={data.summary.stale_customs} tone={C.warn}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Entry #</th><th style={th}>Entry date</th><th style={{ ...th, textAlign: "right" }}>Duty</th></tr></thead>
              <tbody>
                {data.stale_customs.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={3}>None.</td></tr>}
                {data.stale_customs.map((c) => (
                  <tr key={c.id}><td style={td}>{c.entry_number}</td><td style={td}>{c.entry_date}</td><td style={{ ...td, textAlign: "right" }}>{fmt(c.total_duty_cents)}</td></tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Failed QC inspections" count={data.summary.qc_fails} tone={C.warn}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Inspection date</th><th style={th}>Receipt</th><th style={th}>Status</th></tr></thead>
              <tbody>
                {data.qc_fails.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={3}>None.</td></tr>}
                {data.qc_fails.map((q) => (
                  <tr key={q.id}><td style={td}>{q.inspection_date}</td><td style={td}>{"—"}</td><td style={td}>{q.status}</td></tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}
