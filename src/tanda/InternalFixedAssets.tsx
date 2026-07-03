// src/tanda/InternalFixedAssets.tsx
//
// P25 / M21 — Fixed-asset register + straight-line depreciation. Create assets,
// run depreciation through a date (records the schedule; GL posting deferred),
// and dispose. Net book value = cost − accumulated depreciation.

import { Fragment, useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const C = { bg: "#0F172A", card: "#1E293B", cardBdr: "#334155", text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1", primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const chip = (b: string): React.CSSProperties => ({ background: b + "22", color: b, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 });
const SC: Record<string, string> = { active: C.success, fully_depreciated: C.violet, disposed: C.textMuted };

type Asset = { id: string; asset_code: string | null; name: string; category: string | null; acquisition_date: string; acquisition_cost_cents: number; salvage_value_cents: number; useful_life_months: number; accumulated_depreciation_cents: number; status: string; monthly_depreciation_cents: number };

export default function InternalFixedAssets() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: "", category: "", acquisition_date: "", cost: "", salvage: "", life: "" });

  async function load() { setLoading(true); try { const r = await fetch("/api/internal/fixed-assets").then((x) => x.json()); setAssets(Array.isArray(r.assets) ? r.assets : []); } catch { /* */ } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);

  async function create() {
    if (!f.name.trim() || !f.acquisition_date || !(Number(f.life) > 0)) { notify("Name, acquisition date, and useful life (months) are required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/fixed-assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name.trim(), category: f.category.trim() || undefined, acquisition_date: f.acquisition_date, acquisition_cost_cents: Math.round((Number(f.cost) || 0) * 100), salvage_value_cents: Math.round((Number(f.salvage) || 0) * 100), useful_life_months: Number(f.life) }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed");
      notify(j.message || "Asset created", "success"); setCreating(false); setF({ name: "", category: "", acquisition_date: "", cost: "", salvage: "", life: "" }); await load();
    } catch (e) { notify("Create failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }
  async function act(a: Asset, body: Record<string, unknown>, msg?: string) {
    if (msg && !(await confirmDialog(msg))) return;
    setBusy(true);
    try { const r = await fetch(`/api/internal/fixed-assets/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed"); notify(j.message || "Done", "success"); await load(); }
    catch (e) { notify("Failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }
  const nbv = (a: Asset) => a.acquisition_cost_cents - a.accumulated_depreciation_cents;

  // #5 Sortable columns.
  const { sorted: sortedAssets, sortKey, sortDir, onHeaderClick } = useSort(assets, {
    persistKey: "tangerine:fixedassets:sort",
    accessors: {
      code: (a) => a.asset_code || "",
      name: (a) => a.name,
      acquired: (a) => a.acquisition_date,
      cost: (a) => a.acquisition_cost_cents,
      monthly: (a) => a.monthly_depreciation_cents,
      accum: (a) => a.accumulated_depreciation_cents,
      nbv: (a) => nbv(a),
      status: (a) => a.status,
    },
  });

  type ER = { code: string; name: string; cost: number; accum: number; nbv: number; status: string };
  const rows: ER[] = assets.map((a) => ({ code: a.asset_code || "", name: a.name, cost: a.acquisition_cost_cents / 100, accum: a.accumulated_depreciation_cents / 100, nbv: nbv(a) / 100, status: a.status }));
  const cols: ExportColumn<ER>[] = [{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "cost", header: "Cost", format: "currency_dollars" }, { key: "accum", header: "Accum Deprec", format: "currency_dollars" }, { key: "nbv", header: "Net Book Value", format: "currency_dollars" }, { key: "status", header: "Status" }];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Fixed Assets</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>register + straight-line depreciation</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <ExportButton rows={rows} columns={cols} filename="fixed-assets" />
          <button style={btnP} onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New Asset"}</button>
        </div>
      </div>
      {creating && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, minWidth: 200 }} placeholder="Asset name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input style={{ ...input, width: "16ch" }} placeholder="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          <label style={{ color: C.textMuted, fontSize: 12 }}>Acquired <input type="date" style={{ ...input, width: "16ch" }} value={f.acquisition_date} onChange={(e) => setF({ ...f, acquisition_date: e.target.value })} /></label>
          <input style={{ ...input, width: "11ch", textAlign: "right" }} placeholder="Cost $" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
          <input style={{ ...input, width: "10ch", textAlign: "right" }} placeholder="Salvage $" value={f.salvage} onChange={(e) => setF({ ...f, salvage: e.target.value })} />
          <input style={{ ...input, width: "10ch", textAlign: "right" }} placeholder="Life (mo)" value={f.life} onChange={(e) => setF({ ...f, life: e.target.value })} />
          <button style={btnP} disabled={busy} onClick={create}>Create</button>
        </div>
      )}
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Acquired" sortKey="acquired" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Cost" sortKey="cost" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
            <SortableTh label="Monthly" sortKey="monthly" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
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
                  <td style={{ ...td, fontFamily: "monospace" }}>{a.asset_code}</td>
                  <td style={td}>{a.name}{a.category ? <span style={{ color: C.textMuted, fontSize: 11 }}> · {a.category}</span> : ""}</td>
                  <td style={td}>{a.acquisition_date}</td>
                  <td style={{ ...td, textAlign: "right" }}>${(a.acquisition_cost_cents / 100).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: "right", color: C.textMuted }}>${(a.monthly_depreciation_cents / 100).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: "right" }}>${(a.accumulated_depreciation_cents / 100).toFixed(2)}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>${(nbv(a) / 100).toFixed(2)}</td>
                  <td style={td}><span style={chip(SC[a.status] || C.textMuted)}>{a.status.replace("_", " ")}</span></td>
                  <td style={td}>
                    {a.status === "active" && <button style={btnS} disabled={busy} onClick={() => act(a, { action: "depreciate" })}>Depreciate→today</button>}
                    {a.status !== "disposed" && <button style={{ ...btnS, marginLeft: 6 }} disabled={busy} onClick={() => act(a, { action: "dispose" }, `Dispose ${a.asset_code}?`)}>Dispose</button>}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>“Depreciate→today” records the straight-line schedule through the current month. GL posting (DR Depreciation Expense / CR Accumulated Depreciation) is deferred.</div>
    </div>
  );
}
