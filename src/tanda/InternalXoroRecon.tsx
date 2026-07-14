// src/tanda/InternalXoroRecon.tsx
//
// Tangerine — Xoro Monthly Recon (Accounting). Divergence-aware month-by-month
// trial-balance reconciliation of the Tangerine GL (the Xoro 1:1 mirror + the
// documented channel_reclass splits) against the full Xoro GL, categorised so a
// month-close check reads green when every break is accounted for.
//
// Reads v_xoro_recon_monthly_summary (month × category rollup) for the month
// grid and v_xoro_tangerine_tb_recon (non-clean detail) for the drill-down.
// Categories + meaning: src/lib/xoroReconCategory.ts (unit-tested), mirrored 1:1
// by the SQL view (migration 20260991000000). #xoro-recon-monthly-v2.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseClient } from "../utils/supabase";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import {
  RECON_CATEGORY_META,
  isCloseBlocking,
  type ReconCategory,
} from "../lib/xoroReconCategory";

type SummaryRow = {
  month: string;
  break_category: ReconCategory;
  account_months: number;
  abs_variance: number;
  net_variance: number;
  is_open_period: boolean;
};
type DetailRow = {
  month: string;
  gl_code: string;
  gl_name: string | null;
  xoro_net_debit: number;
  tang_net_debit: number;
  mirror_net_debit: number;
  reclass_net_debit: number;
  xoro_unmirrored_debit: number;
  variance: number;
  abs_variance: number;
  residual_core: number;
  statement: "P&L" | "BS";
  break_category: ReconCategory;
};

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", link: "#3B82F6",
  ok: "#10B981", info: "#3B82F6", warn: "#F59E0B", bad: "#EF4444", muted: "#64748B",
};
const toneColor = (tone: "ok" | "info" | "warn" | "bad" | "muted") =>
  ({ ok: C.ok, info: C.info, warn: C.warn, bad: C.bad, muted: C.muted }[tone]);

const th: React.CSSProperties = { background: C.bg, color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const num: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "Consolas, monospace", whiteSpace: "nowrap" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const usd = (n: number) => {
  const v = Number(n) || 0;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const CAT_ORDER: ReconCategory[] = ["clean", "intentional_divergence", "excluded_by_design", "unmapped", "missing_txn", "unexplained"];

const EXPORT_COLS: ExportColumn[] = [
  { key: "month_label", header: "Period" },
  { key: "gl_code", header: "Account" },
  { key: "gl_name", header: "Name" },
  { key: "statement", header: "Statement" },
  { key: "break_category", header: "Category" },
  { key: "xoro_net_debit", header: "Xoro net debit", format: "number", digits: 2 },
  { key: "tang_net_debit", header: "Tangerine net debit", format: "number", digits: 2 },
  { key: "reclass_net_debit", header: "of which reclass", format: "number", digits: 2 },
  { key: "xoro_unmirrored_debit", header: "of which unmirrored", format: "number", digits: 2 },
  { key: "variance", header: "Variance", format: "number", digits: 2 },
  { key: "residual_core", header: "Residual (core)", format: "number", digits: 2 },
];

export default function InternalXoroRecon() {
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [detail, setDetail] = useState<DetailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selMonth, setSelMonth] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const [s, d] = await Promise.all([
      supabaseClient.from("v_xoro_recon_monthly_summary").select("*"),
      supabaseClient.from("v_xoro_tangerine_tb_recon").select(
        "month,gl_code,gl_name,xoro_net_debit,tang_net_debit,mirror_net_debit,reclass_net_debit,xoro_unmirrored_debit,variance,abs_variance,residual_core,statement,break_category",
      ).neq("break_category", "clean").order("month", { ascending: false }).order("abs_variance", { ascending: false }),
    ]);
    if (s.error) { setErr(s.error.message); setLoading(false); return; }
    if (d.error) { setErr(d.error.message); setLoading(false); return; }
    setSummary((s.data || []) as SummaryRow[]);
    setDetail((d.data || []) as DetailRow[]);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Months (desc) with per-category counts.
  const months = useMemo(() => {
    const byMonth = new Map<string, { open: boolean; cats: Map<ReconCategory, SummaryRow> }>();
    for (const r of summary) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, { open: r.is_open_period, cats: new Map() });
      byMonth.get(r.month)!.cats.set(r.break_category, r);
    }
    return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, v]) => ({ month, open: v.open, cats: v.cats }));
  }, [summary]);

  // Closed-period headline (what a month-close check actually gates on).
  const closed = useMemo(() => {
    let clean = 0, intentional = 0, blocking = 0, blockingAbs = 0;
    for (const r of summary) {
      if (r.is_open_period) continue;
      if (r.break_category === "clean") clean += r.account_months;
      else if (r.break_category === "intentional_divergence") intentional += r.account_months;
      if (isCloseBlocking(r.break_category)) { blocking += r.account_months; blockingAbs += r.abs_variance; }
    }
    return { clean, intentional, blocking, blockingAbs };
  }, [summary]);

  const rowsForTable = useMemo(() => {
    const rows = selMonth ? detail.filter((r) => r.month === selMonth) : detail;
    return rows.map((r) => ({ ...r, month_label: fmtMonth(r.month) }));
  }, [detail, selMonth]);

  const green = closed.blocking === 0;

  return (
    <div style={{ padding: 20, maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
        <h2 style={{ color: C.text, margin: 0, fontSize: 18 }}>Xoro Monthly Recon</h2>
        <button type="button" onClick={() => void load()} style={{ background: C.card, color: C.text, border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Refresh</button>
        <ExportButton rows={rowsForTable as unknown as Record<string, unknown>[]} columns={EXPORT_COLS} filename="xoro-monthly-recon" />
      </div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
        Tangerine's GL is a 1:1 mirror of Xoro plus documented, net-zero channel splits. Each account-month is
        categorised so a close check reads green when every break is accounted for. Only <b>unexplained</b> and
        <b> open-period</b> gaps count against a close — reclass splits are intentional, and open-period gaps self-heal on the nightly Xoro GL sync.
      </div>
      {err && <div style={{ color: C.bad, marginBottom: 10 }}>Failed to load: {err}</div>}
      {loading ? (
        <div style={{ color: C.textMuted }}>Loading…</div>
      ) : (
        <>
          {/* Closed-period headline */}
          <div style={{ background: C.card, border: `1px solid ${green ? C.ok : C.bad}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
            <div style={{ color: green ? C.ok : C.bad, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
              {green ? "● Closed months reconcile — no close-blocking breaks" : `● ${closed.blocking} close-blocking account-month(s) in closed periods (${usd(closed.blockingAbs)})`}
            </div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>
              Closed periods: <b style={{ color: C.text }}>{closed.clean.toLocaleString()}</b> clean ·{" "}
              <b style={{ color: C.info }}>{closed.intentional.toLocaleString()}</b> intentional divergence ·{" "}
              <b style={{ color: green ? C.text : C.bad }}>{closed.blocking.toLocaleString()}</b> to investigate. Current open month is excluded — its gaps self-heal on the nightly Xoro GL sync.
            </div>
          </div>

          {/* Month grid */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ padding: "10px 12px", color: C.text, fontWeight: 700, fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
              By month — click a row to filter the breaks below{selMonth ? ` (showing ${fmtMonth(selMonth)}) ` : ""}
              {selMonth && <button type="button" onClick={() => setSelMonth(null)} style={{ marginLeft: 8, background: "transparent", color: C.link, border: "none", cursor: "pointer", fontSize: 12 }}>clear</button>}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>
                  <th style={th}>Period</th>
                  {CAT_ORDER.map((c) => <th key={c} style={{ ...th, textAlign: "right" }}>{RECON_CATEGORY_META[c].label}</th>)}
                  <th style={{ ...th, textAlign: "right" }}>Investigate $</th>
                </tr></thead>
                <tbody>
                  {months.map((m) => {
                    const blockingAbs = CAT_ORDER.filter(isCloseBlocking).reduce((s, c) => s + (m.cats.get(c)?.abs_variance || 0), 0);
                    const sel = selMonth === m.month;
                    return (
                      <tr key={m.month} onClick={() => setSelMonth(sel ? null : m.month)} style={{ cursor: "pointer", background: sel ? "#243044" : undefined }}>
                        <td style={{ ...td, whiteSpace: "nowrap", color: C.link, fontWeight: 600 }}>
                          {fmtMonth(m.month)}{m.open && <span style={{ color: C.warn, fontSize: 11, marginLeft: 6 }}>open</span>}
                        </td>
                        {CAT_ORDER.map((c) => {
                          const cell = m.cats.get(c);
                          const meta = RECON_CATEGORY_META[c];
                          return (
                            <td key={c} style={{ ...num, color: cell ? toneColor(meta.tone) : C.muted }}>
                              {cell ? cell.account_months.toLocaleString() : "·"}
                            </td>
                          );
                        })}
                        <td style={{ ...num, color: blockingAbs > 0.01 ? C.bad : C.textMuted }}>{blockingAbs > 0.01 ? usd(blockingAbs) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Breaks detail */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 12px", color: C.text, fontWeight: 700, fontSize: 13, borderBottom: `1px solid ${C.cardBdr}` }}>
              Breaks — every non-clean account-month{selMonth ? ` in ${fmtMonth(selMonth)}` : ""} ({rowsForTable.length.toLocaleString()})
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>
                  <th style={th}>Period</th><th style={th}>Account</th><th style={th}>Category</th>
                  <th style={{ ...th, textAlign: "right" }}>Xoro</th>
                  <th style={{ ...th, textAlign: "right" }}>Tangerine</th>
                  <th style={{ ...th, textAlign: "right" }}>Variance</th>
                  <th style={th}>Accounted for by</th>
                </tr></thead>
                <tbody>
                  {rowsForTable.length === 0 ? (
                    <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>No breaks — every account-month is clean.</td></tr>
                  ) : rowsForTable.map((r) => {
                    const meta = RECON_CATEGORY_META[r.break_category];
                    const accounted = r.break_category === "intentional_divergence" ? `reclass ${usd(r.reclass_net_debit)}`
                      : r.break_category === "missing_txn" ? `unmirrored ${usd(r.xoro_unmirrored_debit)}`
                      : r.break_category === "unexplained" ? `residual ${usd(r.residual_core)}` : "—";
                    return (
                      <tr key={`${r.month}-${r.gl_code}`}>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>{r.month_label}</td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span style={{ color: C.link, fontFamily: "Consolas, monospace", fontWeight: 600 }}>{r.gl_code}</span>
                          <span style={{ color: C.textMuted, marginLeft: 8 }}>{r.gl_name}</span>
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          <span style={{ color: toneColor(meta.tone), fontWeight: 600 }}>● {meta.label}</span>
                        </td>
                        <td style={num}>{usd(r.xoro_net_debit)}</td>
                        <td style={num}>{usd(r.tang_net_debit)}</td>
                        <td style={{ ...num, color: r.break_category === "unexplained" ? C.bad : C.text }}>{usd(r.variance)}</td>
                        <td style={{ ...td, color: C.textMuted, whiteSpace: "nowrap" }}>{accounted}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
