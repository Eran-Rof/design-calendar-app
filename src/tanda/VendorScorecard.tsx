// src/tanda/VendorScorecard.tsx
//
// Chunk E — Vendor drill-through scorecard (operator item 1; purchasing/delivery).
//
// Wide fixed-overlay modal opened from the info button on each Vendor Master row.
// Fetches /api/internal/vendor-scorecard?vendor_id=… and renders:
//   • header: vendor name + code + status + country
//   • metric tiles: Vendor Health (overall score/100 + A–F grade, same source as
//     the Vendor Health module), avg lead time, % on-time (promised),
//     % on-time (required), AP balance, PO counts
//   • tabs: Invoices (AP) / POs   (each with status + grand totals + ExportButton)
//   • per-line drill: clicking a transaction row opens that exact record in a
//     NEW BROWSER TAB (/tangerine?m=<module>&q=<doc#>); the old in-modal
//     "Drill to:" bar / tile-drill / per-tab open-buttons were removed.
//   • filters: PO status, gender N/A (vendor side is purchasing)
//
// HONESTY: pct_ontime_required is returned null by the server (no distinct
// required-delivery date column exists on tanda_pos) and renders "—" with the
// server's "needs X" caption — never fabricated.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import ExportButton from "./exports/ExportButton";
import SearchableSelect from "./components/SearchableSelect";

// Deep-link a single transaction into its Tangerine module in a NEW TAB.
// The target panels filter to a single record via their ?q= (doc-number ilike /
// text) param, so the clicked line is the only row once the panel mounts.
function openRecordInNewTab(module: "purchase_orders" | "ap_invoices" | "journal_entries", q: string): void {
  if (typeof window === "undefined" || !q) return;
  const url = new URL(window.location.origin + "/tangerine");
  url.searchParams.set("m", module);
  url.searchParams.set("q", q);
  // No `noopener`: same-origin /tangerine drill. `noopener` gives the new tab an
  // empty sessionStorage, dropping the PLM session so Tangerine re-prompts for a
  // Microsoft sign-in. Keeping the opener lets it inherit the session.
  window.open(url.toString(), "_blank");
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type Invoice = {
  id: string; invoice_number: string; invoice_kind: string; gl_status: string;
  posting_date: string; due_date: string | null; description: string | null;
  total_amount_cents: number; paid_amount_cents: number; source: string;
};
type PO = {
  id: string; po_number: string; buyer_po: string | null; vendor: string | null;
  status: string; procurement_status: string | null;
  date_order: string | null; date_expected: string | null; date_expected_delivery: string | null;
  expected_landed_cost_cents: number | null; actual_landed_cost_cents: number | null;
};
type Scorecard = {
  header: { vendor_id: string; vendor_name: string; vendor_code: string | null; status: string | null; country: string | null };
  metrics: {
    avg_lead_time_days: number | null; pct_ontime_promised: number | null; pct_ontime_required: number | null;
    po_count: number; received_po_count: number; ap_balance_cents: number;
  };
  invoices: Invoice[];
  purchase_orders: PO[];
  notes: Record<string, string>;
};

// Per-vendor health (same source as the Vendor Health module —
// /api/internal/analytics/health-scores?vendor_id=…).
type Health = {
  overall_score: number; delivery_score: number; quality_score: number;
  compliance_score: number; financial_score: number; responsiveness_score: number;
};

function fmtCents(c: number | null | undefined): string {
  if (c == null) return "—";
  return (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function healthColor(s: number): string {
  if (s >= 80) return C.success;
  if (s >= 60) return C.warn;
  return C.danger;
}
function healthGrade(s: number): string {
  if (s >= 90) return "A";
  if (s >= 80) return "B";
  if (s >= 70) return "C";
  if (s >= 60) return "D";
  return "F";
}

const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 };
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 12 };
const tdR: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "SFMono-Regular, Menlo, monospace" };

function Metric({ label, value, caption, valueColor }: { label: string; value: string; caption?: string; valueColor?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: valueColor }}>{value}</div>
      {caption && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>{caption}</div>}
    </div>
  );
}

const drillArrow: React.CSSProperties = { color: C.primary, fontSize: 11, opacity: 0.7 };

// A clickable transaction line. Single- or double-click opens the underlying
// record in a NEW browser tab. Hover highlights the row to advertise the action.
function DrillRow({ children, onOpen, title, disabled = false }: { children: React.ReactNode; onOpen: () => void; title?: string; disabled?: boolean }) {
  return (
    <tr
      onClick={disabled ? undefined : onOpen}
      onDoubleClick={disabled ? undefined : onOpen}
      role={disabled ? undefined : "button"}
      tabIndex={disabled ? undefined : 0}
      onKeyDown={disabled ? undefined : (e) => { if (e.key === "Enter") { e.preventDefault(); onOpen(); } }}
      title={disabled ? undefined : title}
      style={{ cursor: disabled ? "default" : "pointer", transition: "background 120ms" }}
      onMouseEnter={disabled ? undefined : (e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#0b1220"; }}
      onMouseLeave={disabled ? undefined : (e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
    >
      {children}
    </tr>
  );
}

export default function VendorScorecard({ vendorId, onClose }: { vendorId: string; onClose: () => void }) {
  const [data, setData] = useState<Scorecard | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"invoices" | "pos">("invoices");
  const [poStatus, setPoStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ vendor_id: vendorId });
      const r = await fetch(`/api/internal/vendor-scorecard?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setData(await r.json() as Scorecard);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [vendorId]);

  useEffect(() => { void load(); }, [load]);

  // Pull this vendor's health from the same source the Vendor Health module uses.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/analytics/health-scores?vendor_id=${encodeURIComponent(vendorId)}`);
        if (!r.ok) return;
        const j = await r.json() as { rows?: Health[] };
        if (!cancelled) setHealth(j.rows?.[0] ?? null);
      } catch { /* health is best-effort; scorecard still renders without it */ }
    })();
    return () => { cancelled = true; };
  }, [vendorId]);

  const poStatuses = useMemo(
    () => Array.from(new Set((data?.purchase_orders || []).map((p) => p.status).filter(Boolean))).sort(),
    [data],
  );
  const filteredPOs = useMemo(() => {
    const list = data?.purchase_orders || [];
    return poStatus ? list.filter((p) => p.status === poStatus) : list;
  }, [data, poStatus]);

  const invTotals = useMemo(() => {
    let total = 0, paid = 0;
    for (const i of (data?.invoices || [])) { total += i.total_amount_cents || 0; paid += i.paid_amount_cents || 0; }
    return { total, paid, open: total - paid };
  }, [data]);

  const poLandedTotal = useMemo(() => {
    let exp = 0, act = 0;
    for (const p of filteredPOs) { exp += p.expected_landed_cost_cents || 0; act += p.actual_landed_cost_cents || 0; }
    return { exp, act };
  }, [filteredPOs]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1100px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20 }}>
              {data?.header.vendor_name || "Vendor"} {data?.header.vendor_code ? <span style={{ color: C.textMuted, fontSize: 14 }}>({data.header.vendor_code})</span> : null}
            </h2>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              {data?.header.status || "—"}{data?.header.country ? ` · ${data.header.country}` : ""}
            </div>
          </div>
          <button onClick={onClose} style={{ background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

        {loading ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : !data ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted }}>No data.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
              <Metric
                label="Vendor Health"
                value={health == null ? "—" : `${health.overall_score} · ${healthGrade(health.overall_score)}`}
                valueColor={health == null ? undefined : healthColor(health.overall_score)}
                caption={health == null ? "no health signal yet" : "overall score / 100 · grade"}
              />
              <Metric label="Avg Lead Time" value={data.metrics.avg_lead_time_days == null ? "—" : `${data.metrics.avg_lead_time_days} d`} caption={data.notes.avg_lead_time_days} />
              <Metric label="% On-time (promised)" value={data.metrics.pct_ontime_promised == null ? "—" : `${data.metrics.pct_ontime_promised}%`} caption={data.notes.pct_ontime_promised} />
              <Metric label="% On-time (required)" value={data.metrics.pct_ontime_required == null ? "—" : `${data.metrics.pct_ontime_required}%`} caption={data.notes.pct_ontime_required} />
              <Metric label="AP Balance (open)" value={fmtCents(data.metrics.ap_balance_cents)} caption={data.notes.ap_balance_cents} />
              <Metric label="POs (received / total)" value={`${data.metrics.received_po_count} / ${data.metrics.po_count}`} />
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 12, alignItems: "center" }}>
              {([["invoices", `Invoices (${(data.invoices || []).length})`], ["pos", `POs (${filteredPOs.length})`]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)} style={{ background: "transparent", border: 0, borderBottom: tab === k ? `2px solid ${C.primary}` : "2px solid transparent", color: tab === k ? C.text : C.textMuted, padding: "8px 12px", fontSize: 13, fontWeight: tab === k ? 600 : 500, cursor: "pointer", marginBottom: -1 }}>{label}</button>
              ))}
              {tab === "pos" && (
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, paddingBottom: 6 }}>
                  <span style={{ fontSize: 10, color: C.textMuted }}>STATUS</span>
                  <SearchableSelect
                    value={poStatus || null}
                    onChange={setPoStatus}
                    options={[{ value: "", label: "(all)" }, ...poStatuses.map((s) => ({ value: s, label: s }))]}
                    placeholder="(all)"
                    inputStyle={{ background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "4px 8px", borderRadius: 4, fontSize: 12 }}
                  />
                </div>
              )}
            </div>

            {tab === "invoices" && (
              <div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
                  <ExportButton rows={(data.invoices || []) as unknown as Array<Record<string, unknown>>} filename={`vendor-${data.header.vendor_code || data.header.vendor_id}-ap-invoices`} sheetName="APInvoices" />
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>Invoice #</th><th style={th}>Posting date</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Total</th><th style={{ ...th, textAlign: "right" }}>Paid</th><th style={{ ...th, textAlign: "right" }}>Open</th></tr></thead>
                  <tbody>
                    {(data.invoices || []).map((i) => (
                      <DrillRow key={i.id} title={`Open invoice ${i.invoice_number} in a new tab`} onOpen={() => openRecordInNewTab("ap_invoices", i.invoice_number)}>
                        <td style={td}>{i.invoice_number} <span style={drillArrow}>↗</span></td>
                        <td style={td}>{fmtDateDisplay(i.posting_date)}</td>
                        <td style={td}>{i.gl_status}</td>
                        <td style={tdR}>{fmtCents(i.total_amount_cents)}</td>
                        <td style={tdR}>{fmtCents(i.paid_amount_cents)}</td>
                        <td style={tdR}>{fmtCents((i.total_amount_cents || 0) - (i.paid_amount_cents || 0))}</td>
                      </DrillRow>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td style={td} colSpan={3}>Grand total ({(data.invoices || []).length})</td>
                      <td style={tdR}>{fmtCents(invTotals.total)}</td>
                      <td style={tdR}>{fmtCents(invTotals.paid)}</td>
                      <td style={tdR}>{fmtCents(invTotals.open)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {tab === "pos" && (
              <div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
                  <ExportButton rows={filteredPOs as unknown as Array<Record<string, unknown>>} filename={`vendor-${data.header.vendor_code || data.header.vendor_id}-pos`} sheetName="PurchaseOrders" />
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr><th style={th}>PO #</th><th style={th}>Order date</th><th style={th}>Expected</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Exp. landed</th><th style={{ ...th, textAlign: "right" }}>Act. landed</th></tr></thead>
                  <tbody>
                    {filteredPOs.map((p) => (
                      <DrillRow key={p.id} title={p.po_number ? `Open PO ${p.po_number} in a new tab` : ""} onOpen={() => openRecordInNewTab("purchase_orders", p.po_number || "")} disabled={!p.po_number}>
                        <td style={td}>{p.po_number || "(draft)"} {p.po_number ? <span style={drillArrow}>↗</span> : null}</td>
                        <td style={td}>{p.date_order || "—"}</td>
                        <td style={td}>{p.date_expected || p.date_expected_delivery || "—"}</td>
                        <td style={td}>{p.status || "—"}</td>
                        <td style={tdR}>{fmtCents(p.expected_landed_cost_cents)}</td>
                        <td style={tdR}>{fmtCents(p.actual_landed_cost_cents)}</td>
                      </DrillRow>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td style={td} colSpan={4}>Grand total ({filteredPOs.length})</td>
                      <td style={tdR}>{fmtCents(poLandedTotal.exp)}</td>
                      <td style={tdR}>{fmtCents(poLandedTotal.act)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
