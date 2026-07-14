// src/tanda/InternalFixedAssets.tsx
//
// P25 / M21 — Fixed-asset register, depreciation SCHEDULE, roll-forward, and a
// GL TIE-OUT that reconciles the register against the mirror GL.
//
// ⚠️ No GL is posted here. Tangerine's GL is a faithful 1:1 mirror of Xoro
// (journal_type 'xoro_gl_mirror'), and Xoro ALREADY books depreciation into the
// GL we mirror. This module records the register-side schedule and reconciles
// it to what Xoro booked (does the register agree?). A gated poster exists
// server-side for Xoro cutover but is OFF (fixed_asset_settings.posting_enabled).
//
//   • Register tab — add/edit assets (4 methods), full-row detail, per-asset
//     schedule (re)generation.
//   • Roll-forward tab — beginning NBV → additions → depreciation → disposals →
//     ending NBV, by month.
//   • GL Tie-out tab — register depreciation vs mirror GL 6319 / 1590 activity.

import { Fragment, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog, promptDialog } from "../shared/ui/warn";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const C = { bg: "#0F172A", panel: "#0b1220", card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6" };
const th: React.CSSProperties = { background: C.panel, color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const input: React.CSSProperties = { background: C.panel, color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const sel: React.CSSProperties = { ...input };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const chip = (b: string): React.CSSProperties => ({ background: b + "22", color: b, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" });
const linkCell: React.CSSProperties = { ...td, color: C.primary, cursor: "pointer", fontFamily: "monospace" };
const SC: Record<string, string> = { active: C.success, fully_depreciated: C.violet, disposed: C.textMuted };
const CAT_COLOR: Record<string, string> = { tie: C.success, register_ahead: C.warn, gl_ahead: C.primary, unmapped: C.danger };

const METHOD_LABEL: Record<string, string> = {
  straight_line: "Straight-line",
  declining_balance_200: "200% Declining",
  declining_balance_150: "150% Declining",
  units_of_production: "Units of production",
};

type Asset = {
  id: string; asset_code: string | null; name: string; description: string | null; category: string | null;
  acquisition_date: string; in_service_date: string | null; acquisition_cost_cents: number; salvage_value_cents: number;
  useful_life_months: number; method: string; units_total: number | null;
  accumulated_depreciation_cents: number; status: string; disposed_date: string | null;
  disposal_proceeds_cents: number | null; monthly_depreciation_cents: number;
};
type SchedRow = { period_date: string; amount_cents: number; accumulated_cents: number; book_value_cents: number; posted: boolean; source: string };
type TieRow = { period_month: string; reg_depr_cents: number; reg_depr_mapped_cents: number; gl_expense_cents: number; gl_accum_cents: number; diff_cents: number; category: string };

const d = (c: unknown) => { const n = Number(c ?? 0) / 100; return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
/** YYYY-MM-DD → MM/DD/YYYY. */
const usDate = (s: string | null | undefined) => { if (!s) return "—"; const [y, m, dd] = s.slice(0, 10).split("-"); return dd ? `${m}/${dd}/${y}` : `${m}/${y}`; };
/** YYYY-MM(-DD) → MM/YYYY. */
const usMonth = (s: string) => { const [y, m] = s.slice(0, 7).split("-"); return `${m}/${y}`; };

export default function InternalFixedAssets() {
  const [tab, setTab] = useState<"register" | "rollforward" | "tieout">("register");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Asset | null>(null);
  const [tie, setTie] = useState<{ rows: TieRow[]; totals: { reg_depr_cents: number; gl_expense_cents: number; diff_cents: number }; category_counts: Record<string, number>; posting_enabled: boolean } | null>(null);
  const emptyForm = { name: "", description: "", category: "", method: "straight_line", acquisition_date: "", in_service_date: "", cost: "", salvage: "", life: "", units_total: "" };
  const [f, setF] = useState(emptyForm);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/internal/fixed-assets").then((x) => x.json());
      setAssets(Array.isArray(r.assets) ? r.assets : []);
    } catch { /* */ } finally { setLoading(false); }
  }
  async function loadTie() {
    try { const r = await fetch("/api/internal/fixed-assets/tieout").then((x) => x.json()); setTie(r && Array.isArray(r.rows) ? r : null); } catch { /* */ }
  }
  useEffect(() => { void load(); void loadTie(); }, []);

  async function create() {
    if (!f.name.trim() || !f.acquisition_date || !(Number(f.life) > 0)) { notify("Name, acquisition date, and useful life (months) are required", "error"); return; }
    if (f.method === "units_of_production" && !(Number(f.units_total) > 0)) { notify("Total expected units is required for units-of-production", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/fixed-assets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: f.name.trim(), description: f.description.trim() || undefined, category: f.category.trim() || undefined,
          method: f.method, acquisition_date: f.acquisition_date, in_service_date: f.in_service_date || undefined,
          acquisition_cost_cents: Math.round((Number(f.cost) || 0) * 100), salvage_value_cents: Math.round((Number(f.salvage) || 0) * 100),
          useful_life_months: Number(f.life), units_total: f.method === "units_of_production" ? Number(f.units_total) : undefined,
        }),
      });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Asset created", "success"); setCreating(false); setF(emptyForm); await load();
    } catch (e) { notify("Create failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  async function generate(a: Asset) {
    setBusy(true);
    try {
      let units: number[] | undefined;
      if (a.method === "units_of_production") {
        const raw = await promptDialog(`Enter per-period units for ${a.asset_code}, comma-separated (starting the in-service month):`, { title: "Units of production", confirmText: "Generate" });
        if (raw == null) { setBusy(false); return; }
        units = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      }
      const r = await fetch("/api/internal/fixed-assets/generate-schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id, units }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Schedule generated", "success"); await Promise.all([load(), loadTie()]);
    } catch (e) { notify("Generate failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  async function dispose(a: Asset) {
    if (!(await confirmDialog(`Dispose ${a.asset_code}? The register marks it disposed; gain/loss GL posting stays deferred (Xoro is system of record).`, { title: "Dispose asset", danger: true, confirmText: "Dispose" }))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/internal/fixed-assets/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dispose" }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Disposed", "success"); await Promise.all([load(), loadTie()]);
    } catch (e) { notify("Failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  const nbv = (a: Asset) => a.acquisition_cost_cents - a.accumulated_depreciation_cents;

  const { sorted: sortedAssets, sortKey, sortDir, onHeaderClick } = useSort(assets, {
    persistKey: "tangerine:fixedassets:sort",
    accessors: {
      code: (a) => a.asset_code || "", name: (a) => a.name, method: (a) => a.method, acquired: (a) => a.acquisition_date,
      cost: (a) => a.acquisition_cost_cents, accum: (a) => a.accumulated_depreciation_cents, nbv: (a) => nbv(a), status: (a) => a.status,
    },
  });

  // Export (register).
  type ER = { code: string; name: string; method: string; acquired: string; cost: number; accum: number; nbv: number; status: string };
  const regRows: ER[] = assets.map((a) => ({ code: a.asset_code || "", name: a.name, method: METHOD_LABEL[a.method] || a.method, acquired: usDate(a.acquisition_date), cost: a.acquisition_cost_cents / 100, accum: a.accumulated_depreciation_cents / 100, nbv: nbv(a) / 100, status: a.status }));
  const regCols: ExportColumn<ER>[] = [{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "method", header: "Method" }, { key: "acquired", header: "Acquired" }, { key: "cost", header: "Cost", format: "currency_dollars" }, { key: "accum", header: "Accum Deprec", format: "currency_dollars" }, { key: "nbv", header: "Net Book Value", format: "currency_dollars" }, { key: "status", header: "Status" }];

  // ── Roll-forward: beginning NBV → additions → depreciation → disposals → ending, by month.
  const rollForward = useMemo(() => {
    const months = new Set<string>();
    const additions: Record<string, number> = {};
    const disposals: Record<string, number> = {};
    for (const a of assets) {
      const am = (a.in_service_date || a.acquisition_date || "").slice(0, 7);
      if (am) { months.add(am); additions[am] = (additions[am] || 0) + a.acquisition_cost_cents; }
      if (a.status === "disposed" && a.disposed_date) {
        const dm = a.disposed_date.slice(0, 7); months.add(dm);
        disposals[dm] = (disposals[dm] || 0) + (a.acquisition_cost_cents - a.accumulated_depreciation_cents);
      }
    }
    const depByMonth: Record<string, number> = {};
    for (const r of tie?.rows || []) { const m = r.period_month.slice(0, 7); months.add(m); depByMonth[m] = (depByMonth[m] || 0) + Number(r.reg_depr_cents || 0); }
    const ordered = [...months].sort();
    let begin = 0;
    return ordered.map((m) => {
      const add = additions[m] || 0, dep = depByMonth[m] || 0, dis = disposals[m] || 0;
      const end = begin + add - dep - dis;
      const row = { month: m, begin, add, dep, dis, end };
      begin = end;
      return row;
    });
  }, [assets, tie]);

  const rfCols: ExportColumn<Record<string, unknown>>[] = [
    { key: "month", header: "Period" }, { key: "begin", header: "Beginning NBV", format: "currency_dollars" }, { key: "add", header: "Additions", format: "currency_dollars" },
    { key: "dep", header: "Depreciation", format: "currency_dollars" }, { key: "dis", header: "Disposals", format: "currency_dollars" }, { key: "end", header: "Ending NBV", format: "currency_dollars" },
  ];
  const rfExport = rollForward.map((r) => ({ month: usMonth(r.month), begin: r.begin / 100, add: r.add / 100, dep: r.dep / 100, dis: r.dis / 100, end: r.end / 100 }));

  const tieCols: ExportColumn<Record<string, unknown>>[] = [
    { key: "period", header: "Period" }, { key: "reg", header: "Register Depr", format: "currency_dollars" }, { key: "gl", header: "GL 6319 Depr", format: "currency_dollars" },
    { key: "diff", header: "Diff", format: "currency_dollars" }, { key: "accum", header: "GL 1590 Activity", format: "currency_dollars" }, { key: "category", header: "Category" },
  ];
  const tieExport = (tie?.rows || []).map((r) => ({ period: usMonth(r.period_month), reg: r.reg_depr_cents / 100, gl: r.gl_expense_cents / 100, diff: r.diff_cents / 100, accum: r.gl_accum_cents / 100, category: r.category }));

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Fixed Assets</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>register · depreciation schedule · GL tie-out</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {tab === "register" && <ExportButton rows={regRows} columns={regCols} filename="fixed-assets" />}
          {tab === "rollforward" && <ExportButton rows={rfExport} columns={rfCols} filename="fixed-assets-rollforward" />}
          {tab === "tieout" && <ExportButton rows={tieExport} columns={tieCols} filename="fixed-assets-gl-tieout" />}
          {tab === "register" && <button style={btnP} onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New Asset"}</button>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {([["register", "Register"], ["rollforward", "Roll-forward"], ["tieout", "GL Tie-out"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btnS, ...(tab === k ? { color: C.primary, borderColor: C.primary, background: `${C.primary}18`, fontWeight: 700 } : {}) }}>{label}</button>
        ))}
      </div>

      {/* Cutover-gate banner (always visible — controllership note). */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderLeft: `3px solid ${tie?.posting_enabled ? C.warn : C.success}`, borderRadius: 6, padding: "8px 12px", marginBottom: 14, fontSize: 12, color: C.textSub }}>
        Depreciation GL posting is <b style={{ color: tie?.posting_enabled ? C.warn : C.success }}>{tie?.posting_enabled ? "ENABLED" : "OFF (cutover gate)"}</b>.
        {" "}Tangerine's GL mirrors Xoro, which already books depreciation — this module reconciles the register to what Xoro booked and posts nothing until Xoro cutover.
      </div>

      {tab === "register" && (
        <>
          {creating && (
            <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input style={{ ...input, minWidth: 180 }} placeholder="Asset name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <input style={{ ...input, width: "14ch" }} placeholder="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
              <select style={sel} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <label style={{ color: C.textMuted, fontSize: 12 }}>Acquired <input type="date" style={{ ...input, width: "15ch" }} value={f.acquisition_date} onChange={(e) => setF({ ...f, acquisition_date: e.target.value })} /></label>
              <label style={{ color: C.textMuted, fontSize: 12 }}>In service <input type="date" style={{ ...input, width: "15ch" }} value={f.in_service_date} onChange={(e) => setF({ ...f, in_service_date: e.target.value })} /></label>
              <input style={{ ...input, width: "11ch", textAlign: "right" }} placeholder="Cost $" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
              <input style={{ ...input, width: "10ch", textAlign: "right" }} placeholder="Salvage $" value={f.salvage} onChange={(e) => setF({ ...f, salvage: e.target.value })} />
              <input style={{ ...input, width: "10ch", textAlign: "right" }} placeholder="Life (mo)" value={f.life} onChange={(e) => setF({ ...f, life: e.target.value })} />
              {f.method === "units_of_production" && <input style={{ ...input, width: "12ch", textAlign: "right" }} placeholder="Total units" value={f.units_total} onChange={(e) => setF({ ...f, units_total: e.target.value })} />}
              <button style={btnP} disabled={busy} onClick={create}>Create</button>
            </div>
          )}
          {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
            <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 300px)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>
                  <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                  <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                  <SortableTh label="Method" sortKey="method" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                  <SortableTh label="Acquired" sortKey="acquired" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                  <SortableTh label="Cost" sortKey="cost" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
                  <SortableTh label="Accum" sortKey="accum" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
                  <SortableTh label="NBV" sortKey="nbv" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
                  <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
                  <th style={th}>Actions</th>
                </tr></thead>
                <tbody>
                  {assets.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={9}>No fixed assets yet.</td></tr>}
                  {sortedAssets.map((a) => (
                    <Fragment key={a.id}>
                      <tr>
                        <td style={linkCell} onClick={() => setDetail(a)} title="View schedule">{a.asset_code}</td>
                        <td style={{ ...td, color: C.primary, cursor: "pointer" }} onClick={() => setDetail(a)}>{a.name}{a.category ? <span style={{ color: C.textMuted, fontSize: 11 }}> · {a.category}</span> : ""}</td>
                        <td style={td}>{METHOD_LABEL[a.method] || a.method}</td>
                        <td style={td}>{usDate(a.acquisition_date)}</td>
                        <td style={tdNum}>{d(a.acquisition_cost_cents)}</td>
                        <td style={tdNum}>{d(a.accumulated_depreciation_cents)}</td>
                        <td style={{ ...tdNum, fontWeight: 600 }}>{d(nbv(a))}</td>
                        <td style={td}><span style={chip(SC[a.status] || C.textMuted)}>{a.status.replace("_", " ")}</span></td>
                        <td style={td}>
                          {a.status !== "disposed" && <button style={btnS} disabled={busy} onClick={() => generate(a)}>Generate schedule</button>}
                          {a.status !== "disposed" && <button style={{ ...btnS, marginLeft: 6 }} disabled={busy} onClick={() => dispose(a)}>Dispose</button>}
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>Click an asset code or name for its full depreciation schedule. “Generate schedule” rebuilds the register schedule deterministically — no GL is posted.</div>
        </>
      )}

      {tab === "rollforward" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Period</th><th style={{ ...th, textAlign: "right" }}>Beginning NBV</th><th style={{ ...th, textAlign: "right" }}>+ Additions</th>
              <th style={{ ...th, textAlign: "right" }}>− Depreciation</th><th style={{ ...th, textAlign: "right" }}>− Disposals</th><th style={{ ...th, textAlign: "right" }}>Ending NBV</th>
            </tr></thead>
            <tbody>
              {rollForward.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={6}>No activity yet — add assets and generate schedules.</td></tr>}
              {rollForward.map((r) => (
                <tr key={r.month}>
                  <td style={td}>{usMonth(r.month)}</td>
                  <td style={tdNum}>{d(r.begin)}</td>
                  <td style={{ ...tdNum, color: r.add ? C.success : C.textMuted }}>{d(r.add)}</td>
                  <td style={{ ...tdNum, color: r.dep ? C.warn : C.textMuted }}>{d(r.dep)}</td>
                  <td style={{ ...tdNum, color: r.dis ? C.danger : C.textMuted }}>{d(r.dis)}</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>{d(r.end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "tieout" && (
        <div>
          {tie && (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
              <span><span style={{ color: C.textMuted }}>Register depr: </span><b>{d(tie.totals.reg_depr_cents)}</b></span>
              <span><span style={{ color: C.textMuted }}>GL 6319 depr: </span><b>{d(tie.totals.gl_expense_cents)}</b></span>
              <span><span style={{ color: C.textMuted }}>Net diff: </span><b style={{ color: tie.totals.diff_cents === 0 ? C.success : C.warn }}>{d(tie.totals.diff_cents)}</b></span>
              {Object.entries(tie.category_counts).map(([k, v]) => <span key={k} style={chip(CAT_COLOR[k] || C.textMuted)}>{k.replace("_", " ")}: {v}</span>)}
            </div>
          )}
          <div style={{ overflowX: "auto", maxHeight: "calc(100vh - 320px)", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Period</th><th style={{ ...th, textAlign: "right" }}>Register Depr</th><th style={{ ...th, textAlign: "right" }}>GL 6319 Depr</th>
                <th style={{ ...th, textAlign: "right" }}>Diff</th><th style={{ ...th, textAlign: "right" }}>GL 1590 Activity</th><th style={th}>Category</th>
              </tr></thead>
              <tbody>
                {(!tie || tie.rows.length === 0) && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={6}>No depreciation activity found in the register or mirror GL.</td></tr>}
                {(tie?.rows || []).map((r) => (
                  <tr key={r.period_month}>
                    <td style={td}>{usMonth(r.period_month)}</td>
                    <td style={tdNum}>{d(r.reg_depr_cents)}</td>
                    <td style={tdNum}>{d(r.gl_expense_cents)}</td>
                    <td style={{ ...tdNum, color: r.diff_cents === 0 ? C.textMuted : C.warn }}>{d(r.diff_cents)}</td>
                    <td style={tdNum}>{d(r.gl_accum_cents)}</td>
                    <td style={td}><span style={chip(CAT_COLOR[r.category] || C.textMuted)}>{r.category.replace("_", " ")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>
            <b>tie</b> = register agrees with mirror GL · <b>register ahead</b> = register booked more than Xoro · <b>gl ahead</b> = Xoro booked more than the register (e.g. register not yet built) · <b>unmapped</b> = register depreciation exists but no GL account is mapped.
          </div>
        </div>
      )}

      {detail && <AssetDetailModal asset={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function AssetDetailModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [rows, setRows] = useState<SchedRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      try { const r = await fetch(`/api/internal/fixed-assets/${asset.id}`).then((x) => x.json()); if (live) setRows(Array.isArray(r.depreciation) ? r.depreciation : []); }
      catch { /* */ } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [asset.id]);

  const exportCols: ExportColumn<Record<string, unknown>>[] = [
    { key: "period", header: "Period" }, { key: "amount", header: "Depreciation", format: "currency_dollars" },
    { key: "accum", header: "Accumulated", format: "currency_dollars" }, { key: "nbv", header: "Book Value", format: "currency_dollars" }, { key: "posted", header: "Posted" },
  ];
  const exportRows = rows.map((r) => ({ period: usDate(r.period_date), amount: r.amount_cents / 100, accum: r.accumulated_cents / 100, nbv: r.book_value_cents / 100, posted: r.posted ? "yes" : "no" }));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(820px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxSizing: "border-box", background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 12, color: C.text }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "16px 20px 8px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>{asset.asset_code} — {asset.name}</h3>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span>method: <b style={{ color: C.textSub }}>{METHOD_LABEL[asset.method] || asset.method}</b></span>
              <span>cost: <b style={{ color: C.textSub }}>{d(asset.acquisition_cost_cents)}</b></span>
              <span>salvage: <b style={{ color: C.textSub }}>{d(asset.salvage_value_cents)}</b></span>
              <span>life: <b style={{ color: C.textSub }}>{asset.useful_life_months} mo</b></span>
              <span>in service: <b style={{ color: C.textSub }}>{usDate(asset.in_service_date || asset.acquisition_date)}</b></span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", color: C.textMuted, border: `1px solid ${C.cardBdr}`, borderRadius: 6, cursor: "pointer", fontSize: 14, padding: "4px 10px" }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
          {loading ? <div style={{ color: C.textMuted, padding: 20 }}>Loading schedule…</div> : rows.length === 0 ? (
            <div style={{ color: C.textMuted, padding: 20 }}>No schedule recorded yet. Use “Generate schedule” on the register row.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Period</th><th style={{ ...th, textAlign: "right" }}>Depreciation</th><th style={{ ...th, textAlign: "right" }}>Accumulated</th><th style={{ ...th, textAlign: "right" }}>Book Value</th><th style={th}>Posted</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={td}>{usDate(r.period_date)}</td>
                    <td style={tdNum}>{d(r.amount_cents)}</td>
                    <td style={tdNum}>{d(r.accumulated_cents)}</td>
                    <td style={tdNum}>{d(r.book_value_cents)}</td>
                    <td style={td}>{r.posted ? <span style={chip(C.success)}>posted</span> : <span style={{ color: C.textMuted }}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 20px", borderTop: `1px solid ${C.cardBdr}` }}>
          <ExportButton rows={exportRows} columns={exportCols} filename={`fa-schedule-${asset.asset_code}`} />
          <button style={btnS} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
