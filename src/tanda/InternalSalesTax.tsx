// src/tanda/InternalSalesTax.tsx
//
// M19 — Sales-Tax / VAT liability & filing support. READS the per-jurisdiction
// GL tax-payable accounts (2300/2302/2304/2306/2308/2310/2312/2314; 2301 is a
// clearing account) and reports filing-ready liability. Xoro is the system of
// record and already collected/posted the tax; this panel posts NOTHING to the
// GL and does NOT compute tax rates (that happens upstream in the sales channel;
// the separate P10 tax-rules/rate engine lives in InternalTax.tsx).
//
//   • Liability tab — current liability per jurisdiction (US states + EU/UK/Nordic),
//     collected vs remitted, net owed; drill to the underlying GL activity.
//   • Filing worklist tab — obligations by period/frequency: overdue / due / upcoming.
//   • Filings tab — recorded filings (draft → filed → paid) + record-a-filing form.

import { useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify } from "../shared/ui/warn";
import {
  formatCents,
  netDueCents,
  summarizeLiability,
  periodBounds,
  filingDueDateISO,
  type FilingFrequency,
} from "../lib/taxLiability";

const C = { bg: "#0F172A", panel: "#0b1220", card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6" };
const th: React.CSSProperties = { background: C.panel, color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const input: React.CSSProperties = { background: C.panel, color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const sel: React.CSSProperties = { ...input };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const chip = (b: string): React.CSSProperties => ({ background: b + "22", color: b, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" });
const flagChip: React.CSSProperties = { fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: C.textSub, background: C.panel, border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "1px 6px", letterSpacing: 0.5 };

const STATUS_COLOR: Record<string, string> = { overdue: C.danger, due: C.warn, upcoming: C.primary, filed: C.success, paid: C.violet, draft: C.textMuted };
const FREQ_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" };

/** YYYY-MM-DD → MM/DD/YYYY. */
const usDate = (s: string | null | undefined) => { if (!s) return "—"; const [y, m, dd] = s.slice(0, 10).split("-"); return dd ? `${m}/${dd}/${y}` : `${m}/${y}`; };
const $ = (cents: unknown) => formatCents(Number(cents ?? 0));

type Jurisdiction = { id: string; code: string; label: string; country_region: string | null; flag: string | null; gl_account_code: string | null; filing_frequency: FilingFrequency; grace_days: number; is_clearing: boolean; sort_order: number; notes: string | null };
type Summary = { jurisdiction_code: string; jurisdiction_label: string; country_region: string | null; flag: string | null; gl_account_code: string | null; filing_frequency: FilingFrequency; is_clearing: boolean; collected_cents: number; remitted_cents: number; net_due_cents: number; last_activity_date: string | null };
type WorkRow = { jurisdiction_code: string; jurisdiction_label: string; flag: string | null; filing_frequency: string; period_start: string; period_end: string; period_label: string; collected_cents: number; remitted_cents: number; net_due_cents: number; due_date: string; status: string; reference: string | null };
type Filing = { id: string; jurisdiction_code: string | null; jurisdiction_label: string | null; flag: string | null; period_start: string; period_end: string; tax_collected_cents: number; tax_remitted_cents: number; net_due_cents: number; status: string; filed_at: string | null; reference: string | null; notes: string | null };
type DrillRow = { je_id: string; posting_date: string; description: string | null; memo: string | null; debit_cents: number; credit_cents: number; source_module: string | null; source_id: string | null };

type DrillTarget = { code: string; label: string; from?: string; to?: string; periodLabel?: string };
type PrefillFiling = { code: string; period_start: string; period_end: string; collected: number; remitted: number };

export default function InternalSalesTax() {
  const [tab, setTab] = useState<"liability" | "worklist" | "filings">("liability");
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [work, setWork] = useState<{ today: string; rows: WorkRow[] } | null>(null);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [recording, setRecording] = useState<PrefillFiling | "blank" | null>(null);

  async function loadAll() {
    setLoading(true);
    try {
      const [t, w, f] = await Promise.all([
        fetch("/api/internal/tax").then((x) => x.json()),
        fetch("/api/internal/tax/worklist").then((x) => x.json()),
        fetch("/api/internal/tax/filings").then((x) => x.json()),
      ]);
      setJurisdictions(Array.isArray(t.jurisdictions) ? t.jurisdictions : []);
      setSummary(Array.isArray(t.summary) ? t.summary : []);
      setWork(w && Array.isArray(w.rows) ? w : { today: "", rows: [] });
      setFilings(Array.isArray(f.filings) ? f.filings : []);
    } catch { /* */ } finally { setLoading(false); }
  }
  useEffect(() => { void loadAll(); }, []);

  // ── Liability totals (exclude the clearing account from the headline). ──
  const real = summary.filter((s) => !s.is_clearing);
  const totals = summarizeLiability(real.map((s) => ({ jurisdiction_code: s.jurisdiction_code, collected_cents: s.collected_cents, remitted_cents: s.remitted_cents, net_due_cents: s.net_due_cents })));
  const biggest = real.reduce<Summary | null>((a, b) => (b.net_due_cents > (a?.net_due_cents ?? -Infinity) ? b : a), null);

  const workCounts = useMemo(() => {
    const c: Record<string, number> = { overdue: 0, due: 0, upcoming: 0, filed: 0, paid: 0 };
    for (const r of work?.rows || []) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [work]);

  // ── Exports ──
  const sumRows = summary.map((s) => ({ flag: s.flag || "", jurisdiction: s.jurisdiction_label, region: s.country_region || "", account: s.gl_account_code || "", frequency: FREQ_LABEL[s.filing_frequency] || s.filing_frequency, collected: s.collected_cents / 100, remitted: s.remitted_cents / 100, net: s.net_due_cents / 100, last: usDate(s.last_activity_date), clearing: s.is_clearing ? "yes" : "" }));
  const sumCols: ExportColumn<(typeof sumRows)[number]>[] = [{ key: "flag", header: "Flag" }, { key: "jurisdiction", header: "Jurisdiction" }, { key: "region", header: "Region" }, { key: "account", header: "GL Acct" }, { key: "frequency", header: "Frequency" }, { key: "collected", header: "Collected", format: "currency_dollars" }, { key: "remitted", header: "Remitted", format: "currency_dollars" }, { key: "net", header: "Net Owed", format: "currency_dollars" }, { key: "last", header: "Last Activity" }, { key: "clearing", header: "Clearing" }];

  const workExport = (work?.rows || []).map((r) => ({ flag: r.flag || "", jurisdiction: r.jurisdiction_label, period: r.period_label, frequency: FREQ_LABEL[r.filing_frequency] || r.filing_frequency, collected: r.collected_cents / 100, remitted: r.remitted_cents / 100, net: r.net_due_cents / 100, due: usDate(r.due_date), status: r.status }));
  const workCols: ExportColumn<(typeof workExport)[number]>[] = [{ key: "flag", header: "Flag" }, { key: "jurisdiction", header: "Jurisdiction" }, { key: "period", header: "Period" }, { key: "frequency", header: "Frequency" }, { key: "collected", header: "Collected", format: "currency_dollars" }, { key: "remitted", header: "Remitted", format: "currency_dollars" }, { key: "net", header: "Net Due", format: "currency_dollars" }, { key: "due", header: "Due Date" }, { key: "status", header: "Status" }];

  const filingExport = filings.map((f) => ({ flag: f.flag || "", jurisdiction: f.jurisdiction_label || "", period_start: usDate(f.period_start), period_end: usDate(f.period_end), collected: f.tax_collected_cents / 100, remitted: f.tax_remitted_cents / 100, net: f.net_due_cents / 100, status: f.status, filed: usDate(f.filed_at), reference: f.reference || "" }));
  const filingCols: ExportColumn<(typeof filingExport)[number]>[] = [{ key: "flag", header: "Flag" }, { key: "jurisdiction", header: "Jurisdiction" }, { key: "period_start", header: "Period Start" }, { key: "period_end", header: "Period End" }, { key: "collected", header: "Collected", format: "currency_dollars" }, { key: "remitted", header: "Remitted", format: "currency_dollars" }, { key: "net", header: "Net Due", format: "currency_dollars" }, { key: "status", header: "Status" }, { key: "filed", header: "Filed" }, { key: "reference", header: "Reference" }];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Sales Tax &amp; VAT</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>liability by jurisdiction · filing worklist · recorded filings</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {tab === "liability" && <ExportButton rows={sumRows} columns={sumCols} filename="tax-liability-by-jurisdiction" />}
          {tab === "worklist" && <ExportButton rows={workExport} columns={workCols} filename="tax-filing-worklist" />}
          {tab === "filings" && <ExportButton rows={filingExport} columns={filingCols} filename="tax-filings" />}
          {tab === "filings" && <button style={btnP} onClick={() => setRecording("blank")}>+ Record filing</button>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {([["liability", "Liability"], ["worklist", "Filing worklist"], ["filings", "Filings"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btnS, ...(tab === k ? { color: C.primary, borderColor: C.primary, background: `${C.primary}18`, fontWeight: 700 } : {}) }}>{label}</button>
        ))}
      </div>

      {/* Architecture note (controllership). */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `3px solid ${C.primary}`, borderRadius: 6, padding: "8px 12px", marginBottom: 14, fontSize: 12, color: C.textSub }}>
        Liability is read straight from the GL tax-payable accounts — tax was already collected and posted upstream in Xoro (the system of record), and this module posts nothing and does not compute tax rates.
        {" "}<b style={{ color: C.textSub }}>Collected</b> = credits to the payable account · <b style={{ color: C.textSub }}>Remitted</b> = debits (payments to the authority) · <b style={{ color: C.textSub }}>Net owed</b> = collected − remitted.
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <>
          {tab === "liability" && (
            <>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                <StatCard label="Total collected" value={$(totals.collected_cents)} />
                <StatCard label="Total remitted" value={$(totals.remitted_cents)} color={C.textSub} />
                <StatCard label="Net owed (all jurisdictions)" value={$(totals.net_due_cents)} color={totals.net_due_cents > 0 ? C.warn : C.success} big />
                <StatCard label="Largest unremitted" value={biggest ? `${biggest.jurisdiction_label} · ${$(biggest.net_due_cents)}` : "—"} color={C.danger} />
              </div>
              <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 340px)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={th}>Flag</th><th style={th}>Jurisdiction</th><th style={th}>Region</th><th style={th}>GL Acct</th><th style={th}>Frequency</th>
                    <th style={{ ...th, textAlign: "right" }}>Collected</th><th style={{ ...th, textAlign: "right" }}>Remitted</th><th style={{ ...th, textAlign: "right" }}>Net Owed</th><th style={th}>Last Activity</th>
                  </tr></thead>
                  <tbody>
                    {summary.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={9}>No tax jurisdictions configured.</td></tr>}
                    {summary.map((s) => (
                      <tr key={s.jurisdiction_code} onClick={() => setDrill({ code: s.jurisdiction_code, label: s.jurisdiction_label })} style={{ cursor: "pointer", opacity: s.is_clearing ? 0.6 : 1 }} title="View underlying GL activity">
                        <td style={td}><span style={flagChip}>{s.flag || "—"}</span></td>
                        <td style={{ ...td, color: C.primary, fontWeight: 600 }}>{s.jurisdiction_label}{s.is_clearing ? <span style={{ ...chip(C.textMuted), marginLeft: 6 }}>clearing</span> : null}</td>
                        <td style={{ ...td, color: C.textSub }}>{s.country_region || "—"}</td>
                        <td style={{ ...td, fontFamily: "monospace", color: C.textSub }}>{s.gl_account_code || "—"}</td>
                        <td style={td}>{FREQ_LABEL[s.filing_frequency] || s.filing_frequency}</td>
                        <td style={tdNum}>{$(s.collected_cents)}</td>
                        <td style={tdNum}>{$(s.remitted_cents)}</td>
                        <td style={{ ...tdNum, fontWeight: 700, color: s.net_due_cents > 0 ? C.warn : C.textMuted }}>{$(s.net_due_cents)}</td>
                        <td style={{ ...td, color: C.textMuted }}>{usDate(s.last_activity_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>Click any jurisdiction to drill into the GL lines that make up its liability. The clearing account (2301) nets to zero and is excluded from the headline totals.</div>
            </>
          )}

          {tab === "worklist" && (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                {(["overdue", "due", "upcoming"] as const).map((k) => <span key={k} style={chip(STATUS_COLOR[k])}>{k}: {workCounts[k] || 0}</span>)}
                {work?.today && <span style={{ color: C.textMuted, fontSize: 12, alignSelf: "center" }}>as of {usDate(work.today)}</span>}
              </div>
              <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 320px)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={th}>Flag</th><th style={th}>Jurisdiction</th><th style={th}>Period</th><th style={th}>Frequency</th>
                    <th style={{ ...th, textAlign: "right" }}>Collected</th><th style={{ ...th, textAlign: "right" }}>Remitted</th><th style={{ ...th, textAlign: "right" }}>Net Due</th>
                    <th style={th}>Due Date</th><th style={th}>Status</th><th style={th}>Action</th>
                  </tr></thead>
                  <tbody>
                    {(work?.rows || []).length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={10}>No filing obligations — no tax activity found.</td></tr>}
                    {(work?.rows || []).map((r, i) => (
                      <tr key={`${r.jurisdiction_code}-${r.period_start}-${i}`} onClick={() => setDrill({ code: r.jurisdiction_code, label: r.jurisdiction_label, from: r.period_start, to: r.period_end, periodLabel: r.period_label })} style={{ cursor: "pointer" }} title="View underlying GL activity">
                        <td style={td}><span style={flagChip}>{r.flag || "—"}</span></td>
                        <td style={{ ...td, color: C.primary, fontWeight: 600 }}>{r.jurisdiction_label}</td>
                        <td style={td}>{r.period_label}</td>
                        <td style={{ ...td, color: C.textSub }}>{FREQ_LABEL[r.filing_frequency] || r.filing_frequency}</td>
                        <td style={tdNum}>{$(r.collected_cents)}</td>
                        <td style={tdNum}>{$(r.remitted_cents)}</td>
                        <td style={{ ...tdNum, fontWeight: 600 }}>{$(r.net_due_cents)}</td>
                        <td style={{ ...td, color: C.textSub }}>{usDate(r.due_date)}</td>
                        <td style={td}><span style={chip(STATUS_COLOR[r.status] || C.textMuted)}>{r.status}</span></td>
                        <td style={td}>{(r.status === "overdue" || r.status === "due") && <button style={btnS} onClick={(e) => { e.stopPropagation(); setRecording({ code: r.jurisdiction_code, period_start: r.period_start, period_end: r.period_end, collected: r.collected_cents, remitted: r.remitted_cents }); }}>Record filing</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>Periods are built from each jurisdiction's filing frequency; the due date is the period end plus its statutory grace window. <b>Overdue</b> = past the deadline with no recorded filing. Click a row to see the GL lines; use “Record filing” to log a submission.</div>
            </>
          )}

          {tab === "filings" && (
            <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 300px)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <th style={th}>Flag</th><th style={th}>Jurisdiction</th><th style={th}>Period</th>
                  <th style={{ ...th, textAlign: "right" }}>Collected</th><th style={{ ...th, textAlign: "right" }}>Remitted</th><th style={{ ...th, textAlign: "right" }}>Net Due</th>
                  <th style={th}>Status</th><th style={th}>Filed</th><th style={th}>Reference</th>
                </tr></thead>
                <tbody>
                  {filings.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={9}>No filings recorded yet. Use “+ Record filing”.</td></tr>}
                  {filings.map((f) => (
                    <tr key={f.id}>
                      <td style={td}><span style={flagChip}>{f.flag || "—"}</span></td>
                      <td style={{ ...td, fontWeight: 600 }}>{f.jurisdiction_label || "—"}</td>
                      <td style={td}>{usDate(f.period_start)} – {usDate(f.period_end)}</td>
                      <td style={tdNum}>{$(f.tax_collected_cents)}</td>
                      <td style={tdNum}>{$(f.tax_remitted_cents)}</td>
                      <td style={{ ...tdNum, fontWeight: 600 }}>{$(f.net_due_cents)}</td>
                      <td style={td}><span style={chip(STATUS_COLOR[f.status] || C.textMuted)}>{f.status}</span></td>
                      <td style={{ ...td, color: C.textMuted }}>{usDate(f.filed_at)}</td>
                      <td style={{ ...td, color: C.textSub }}>{f.reference || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {drill && <DrillModal target={drill} onClose={() => setDrill(null)} />}
      {recording && <RecordFilingModal prefill={recording === "blank" ? null : recording} jurisdictions={jurisdictions} onClose={() => setRecording(null)} onSaved={() => { setRecording(null); void loadAll(); }} />}
    </div>
  );
}

function StatCard({ label, value, color, big }: { label: string; value: string; color?: string; big?: boolean }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "10px 14px", minWidth: 150 }}>
      <div style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: color || C.text, fontSize: big ? 22 : 16, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function DrillModal({ target, onClose }: { target: DrillTarget; onClose: () => void }) {
  const [rows, setRows] = useState<DrillRow[]>([]);
  const [totals, setTotals] = useState<{ collected_cents: number; remitted_cents: number; net_due_cents: number } | null>(null);
  const [account, setAccount] = useState<string>("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ jurisdiction: target.code });
        if (target.from) qs.set("from", target.from);
        if (target.to) qs.set("to", target.to);
        const r = await fetch(`/api/internal/tax/drill?${qs.toString()}`).then((x) => x.json());
        if (live) { setRows(Array.isArray(r.rows) ? r.rows : []); setTotals(r.totals || null); setAccount(r.account_code || ""); }
      } catch { /* */ } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [target]);

  const exportRows = rows.map((r) => ({ date: usDate(r.posting_date), description: r.description || "", memo: r.memo || "", collected: r.credit_cents / 100, remitted: r.debit_cents / 100, source: r.source_module || "" }));
  const exportCols: ExportColumn<(typeof exportRows)[number]>[] = [{ key: "date", header: "Date" }, { key: "description", header: "Description" }, { key: "memo", header: "Memo" }, { key: "collected", header: "Collected", format: "currency_dollars" }, { key: "remitted", header: "Remitted", format: "currency_dollars" }, { key: "source", header: "Source" }];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(920px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxSizing: "border-box", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, color: C.text }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 20px 8px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>{target.label} — GL activity</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span>account: <b style={{ color: C.textSub, fontFamily: "monospace" }}>{account || "—"}</b></span>
              <span>period: <b style={{ color: C.textSub }}>{target.periodLabel || (target.from ? `${usDate(target.from)} – ${usDate(target.to)}` : "all time")}</b></span>
              {totals && <span>net: <b style={{ color: totals.net_due_cents > 0 ? C.warn : C.textSub }}>{$(totals.net_due_cents)}</b></span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", color: C.textMuted, border: `1px solid ${C.cardBdr}`, borderRadius: 6, cursor: "pointer", fontSize: 14, padding: "4px 10px" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
          {loading ? <div style={{ color: C.textMuted, padding: 20 }}>Loading GL activity…</div> : rows.length === 0 ? (
            <div style={{ color: C.textMuted, padding: 20 }}>No GL activity on this account for the selected period.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Date</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Collected</th><th style={{ ...th, textAlign: "right" }}>Remitted</th><th style={th}>Source</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={td}>{usDate(r.posting_date)}</td>
                    <td style={{ ...td, color: C.textSub }}>{r.description || r.memo || "—"}</td>
                    <td style={{ ...tdNum, color: r.credit_cents ? C.success : C.textMuted }}>{r.credit_cents ? $(r.credit_cents) : "—"}</td>
                    <td style={{ ...tdNum, color: r.debit_cents ? C.warn : C.textMuted }}>{r.debit_cents ? $(r.debit_cents) : "—"}</td>
                    <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{r.source_module || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "10px 20px", borderTop: `1px solid ${C.cardBdr}` }}>
          <span style={{ fontSize: 12, color: C.textMuted }}>These are the posted GL lines on the jurisdiction's tax-payable account — the authoritative liability source.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <ExportButton rows={exportRows} columns={exportCols} filename={`tax-gl-${target.code}`} />
            <button style={btnS} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecordFilingModal({ prefill, jurisdictions, onClose, onSaved }: { prefill: PrefillFiling | null; jurisdictions: Jurisdiction[]; onClose: () => void; onSaved: () => void }) {
  const firstNonClearing = jurisdictions.find((j) => !j.is_clearing);
  const [code, setCode] = useState(prefill?.code || firstNonClearing?.code || "");
  const [periodStart, setPeriodStart] = useState(prefill?.period_start || "");
  const [periodEnd, setPeriodEnd] = useState(prefill?.period_end || "");
  const [collected, setCollected] = useState(prefill ? String(prefill.collected / 100) : "");
  const [remitted, setRemitted] = useState(prefill ? String(prefill.remitted / 100) : "");
  const [status, setStatus] = useState("filed");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const jur = jurisdictions.find((j) => j.code === code);

  // Default the period to the one containing today for the chosen frequency.
  function fillCurrentPeriod() {
    if (!jur) return;
    const p = periodBounds(jur.filing_frequency, new Date().toISOString().slice(0, 10));
    setPeriodStart(p.start); setPeriodEnd(p.end);
  }

  const dueHint = jur && periodEnd ? filingDueDateISO(periodEnd, jur.grace_days) : "";
  const net = netDueCents(Math.round((Number(collected) || 0) * 100), Math.round((Number(remitted) || 0) * 100));

  async function save() {
    if (!code) { notify("Choose a jurisdiction", "error"); return; }
    if (!periodStart || !periodEnd) { notify("Period start and end are required", "error"); return; }
    if (periodEnd < periodStart) { notify("Period end must be on/after period start", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/tax/filings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jurisdiction_code: code, period_start: periodStart, period_end: periodEnd,
          tax_collected_cents: Math.round((Number(collected) || 0) * 100),
          tax_remitted_cents: Math.round((Number(remitted) || 0) * 100),
          status, reference: reference.trim() || undefined, notes: notes.trim() || undefined,
        }),
      });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Filing recorded", "success"); onSaved();
    } catch (e) { notify("Record failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxSizing: "border-box", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, color: C.text }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px 8px" }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>Record a filing</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", color: C.textMuted, border: `1px solid ${C.cardBdr}`, borderRadius: 6, cursor: "pointer", fontSize: 14, padding: "4px 10px" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Jurisdiction
            <select style={sel} value={code} onChange={(e) => setCode(e.target.value)}>
              {jurisdictions.filter((j) => !j.is_clearing).map((j) => <option key={j.code} value={j.code}>{j.label} ({j.gl_account_code})</option>)}
            </select>
          </label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Period start
              <input type="date" style={{ ...input, width: "16ch" }} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Period end
              <input type="date" style={{ ...input, width: "16ch" }} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </label>
            <button style={btnS} onClick={fillCurrentPeriod} disabled={!jur}>Use current {jur ? FREQ_LABEL[jur.filing_frequency].toLowerCase() : ""} period</button>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Collected $
              <input style={{ ...input, width: "14ch", textAlign: "right" }} value={collected} onChange={(e) => setCollected(e.target.value)} placeholder="0.00" />
            </label>
            <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Remitted $
              <input style={{ ...input, width: "14ch", textAlign: "right" }} value={remitted} onChange={(e) => setRemitted(e.target.value)} placeholder="0.00" />
            </label>
            <div style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Net due<div style={{ color: net > 0 ? C.warn : C.textSub, fontWeight: 700, fontSize: 15, padding: "6px 0" }}>{$(net)}</div></div>
          </div>
          <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Status
            <select style={sel} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="draft">Draft (prepared)</option>
              <option value="filed">Filed (submitted to authority)</option>
              <option value="paid">Paid (remitted)</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Reference / confirmation #
            <input style={input} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="authority confirmation number" />
          </label>
          <label style={{ fontSize: 12, color: C.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>Notes
            <textarea style={{ ...input, minHeight: 54, resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          {dueHint && <div style={{ fontSize: 12, color: C.textMuted }}>Statutory due date for this period: <b style={{ color: C.textSub }}>{usDate(dueHint)}</b>.</div>}
          <div style={{ fontSize: 12, color: C.textMuted }}>Recording a filing is bookkeeping only — it does not post a GL remittance (Xoro/bank already books the payment).</div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 20px", borderTop: `1px solid ${C.cardBdr}` }}>
          <button style={btnS} onClick={onClose}>Cancel</button>
          <button style={btnP} disabled={busy} onClick={save}>Save filing</button>
        </div>
      </div>
    </div>
  );
}
