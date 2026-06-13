// src/tanda/InternalMfgReports.tsx
//
// Tangerine — Manufacturing Reports. Read-only aggregation over build orders +
// part inventory: open WIP (what's tied up mid-build), completed-build cost
// rollups, and parts valuation. Each section exports to xlsx.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

type BuildRow = {
  id: string; build_number: string; status: string;
  finished_sku: string | null; finished_desc: string | null;
  target_qty: number; completed_qty: number; created_at: string; updated_at: string;
  parts_cents: number; service_cents: number; style_cents: number; total_cents: number;
  finished_unit_cost_cents: number | null;
};
type PartVal = { code: string | null; name: string; on_hand_qty: number; value_cents: number };
type Report = {
  open_wip: BuildRow[]; completed: BuildRow[];
  parts_valuation: { total_value_cents: number; part_count: number; top: PartVal[] };
  open_wip_total_cents: number;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const STATUS_COLOR: Record<string, string> = { released: C.primary, issued: C.warn, in_progress: C.warn, completed: C.success };
const money = (c: number | null | undefined) => c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysSince = (iso: string) => { const d = (Date.now() - Date.parse(iso)) / 86400000; return Number.isFinite(d) ? Math.max(0, Math.round(d)) : 0; };

export default function InternalMfgReports() {
  const [rep, setRep] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/mfg-reports`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRep(await r.json() as Report);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const completedTotal = useMemo(() => (rep?.completed || []).reduce((s, b) => s + b.total_cents, 0), [rep]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Manufacturing Reports</h2>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>Open WIP, completed-build costs, and parts valuation.</p>
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}
      {loading || !rep ? <div style={{ padding: 20, color: C.textMuted }}>Loading…</div> : (
        <>
          {/* Summary cards */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
            <Card label="Open WIP value" value={money(rep.open_wip_total_cents)} sub={`${rep.open_wip.length} build(s) in progress`} />
            <Card label="Completed value (all time)" value={money(completedTotal)} sub={`${rep.completed.length} completed`} />
            <Card label="Parts on-hand value" value={money(rep.parts_valuation.total_value_cents)} sub={`${rep.parts_valuation.part_count} part(s)`} />
          </div>

          {/* Open WIP */}
          <Section title="Open WIP — builds in progress" exportRows={rep.open_wip.map((b) => ({ build_number: b.build_number, finished_sku: b.finished_sku, status: b.status, days_open: daysSince(b.created_at), parts_cents: b.parts_cents, service_cents: b.service_cents, style_cents: b.style_cents, total_cents: b.total_cents }))} exportName="mfg-open-wip" exportCols={WIP_COLS}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Build #</th><th style={th}>Finished Style</th><th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Days open</th>
                <th style={{ ...th, textAlign: "right" }}>Parts</th><th style={{ ...th, textAlign: "right" }}>Services</th>
                <th style={{ ...th, textAlign: "right" }}>Styles</th><th style={{ ...th, textAlign: "right" }}>WIP total</th>
              </tr></thead>
              <tbody>
                {rep.open_wip.length === 0 ? <tr><td style={{ ...td, color: C.textMuted }} colSpan={8}>No open builds.</td></tr>
                  : rep.open_wip.map((b) => (
                    <tr key={b.id}>
                      <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{b.build_number}</td>
                      <td style={td}>{b.finished_sku ?? "—"}</td>
                      <td style={td}><span style={{ color: STATUS_COLOR[b.status] }}>{b.status}</span></td>
                      <td style={{ ...td, textAlign: "right" }}>{daysSince(b.created_at)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.parts_cents)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.service_cents)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.style_cents)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{money(b.total_cents)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>

          {/* Completed builds */}
          <Section title="Completed builds — finished cost" exportRows={rep.completed.map((b) => ({ build_number: b.build_number, finished_sku: b.finished_sku, completed_qty: b.completed_qty, parts_cents: b.parts_cents, service_cents: b.service_cents, style_cents: b.style_cents, total_cents: b.total_cents, finished_unit_cost_cents: b.finished_unit_cost_cents, completed_at: b.updated_at }))} exportName="mfg-completed-builds" exportCols={COMPLETED_COLS}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Build #</th><th style={th}>Finished Style</th>
                <th style={{ ...th, textAlign: "right" }}>Qty</th>
                <th style={{ ...th, textAlign: "right" }}>Parts</th><th style={{ ...th, textAlign: "right" }}>Services</th>
                <th style={{ ...th, textAlign: "right" }}>Styles</th><th style={{ ...th, textAlign: "right" }}>Total</th>
                <th style={{ ...th, textAlign: "right" }}>Unit cost</th>
              </tr></thead>
              <tbody>
                {rep.completed.length === 0 ? <tr><td style={{ ...td, color: C.textMuted }} colSpan={8}>No completed builds yet.</td></tr>
                  : rep.completed.map((b) => (
                    <tr key={b.id}>
                      <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{b.build_number}</td>
                      <td style={td}>{b.finished_sku ?? "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>{b.completed_qty.toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.parts_cents)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.service_cents)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.style_cents)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(b.total_cents)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{money(b.finished_unit_cost_cents)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>

          {/* Parts valuation */}
          <Section title="Parts valuation — top by value" exportRows={rep.parts_valuation.top as unknown as Array<Record<string, unknown>>} exportName="mfg-parts-valuation" exportCols={PARTS_COLS}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Code</th><th style={th}>Part</th>
                <th style={{ ...th, textAlign: "right" }}>On hand</th><th style={{ ...th, textAlign: "right" }}>Value</th>
              </tr></thead>
              <tbody>
                {rep.parts_valuation.top.length === 0 ? <tr><td style={{ ...td, color: C.textMuted }} colSpan={4}>No parts on hand.</td></tr>
                  : rep.parts_valuation.top.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{p.code ?? "—"}</td>
                      <td style={td}>{p.name}</td>
                      <td style={{ ...td, textAlign: "right" }}>{p.on_hand_qty.toLocaleString()}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(p.value_cents)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}

const WIP_COLS = [
  { key: "build_number", header: "Build #" }, { key: "finished_sku", header: "Finished SKU" }, { key: "status", header: "Status" },
  { key: "days_open", header: "Days Open", format: "number" }, { key: "parts_cents", header: "Parts", format: "currency_cents" },
  { key: "service_cents", header: "Services", format: "currency_cents" }, { key: "style_cents", header: "Styles", format: "currency_cents" },
  { key: "total_cents", header: "WIP Total", format: "currency_cents" },
] as ExportColumn<Record<string, unknown>>[];
const COMPLETED_COLS = [
  { key: "build_number", header: "Build #" }, { key: "finished_sku", header: "Finished SKU" }, { key: "completed_qty", header: "Qty", format: "number" },
  { key: "parts_cents", header: "Parts", format: "currency_cents" }, { key: "service_cents", header: "Services", format: "currency_cents" },
  { key: "style_cents", header: "Styles", format: "currency_cents" }, { key: "total_cents", header: "Total", format: "currency_cents" },
  { key: "finished_unit_cost_cents", header: "Unit Cost", format: "currency_cents" }, { key: "completed_at", header: "Completed", format: "datetime" },
] as ExportColumn<Record<string, unknown>>[];
const PARTS_COLS = [
  { key: "code", header: "Code" }, { key: "name", header: "Part" }, { key: "on_hand_qty", header: "On Hand", format: "number" }, { key: "value_cents", header: "Value", format: "currency_cents" },
] as ExportColumn<Record<string, unknown>>[];

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "14px 18px", minWidth: 200 }}>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, margin: "4px 0" }}>{value}</div>
      <div style={{ fontSize: 12, color: C.textSub }}>{sub}</div>
    </div>
  );
}

function Section({ title, children, exportRows, exportName, exportCols }: { title: string; children: React.ReactNode; exportRows: Array<Record<string, unknown>>; exportName: string; exportCols: ExportColumn<Record<string, unknown>>[] }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        <ExportButton rows={exportRows} filename={exportName} sheetName={title.slice(0, 28)} columns={exportCols} />
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>{children}</div>
    </div>
  );
}
