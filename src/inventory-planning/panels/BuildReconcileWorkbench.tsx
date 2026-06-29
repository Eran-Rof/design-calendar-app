// Build reconcile workbench at /planning/reconcile.
//
// Picks N saved builds, unions their recommendations, groups by
// vendor (per item-master.vendor_id), and exports one Excel sheet
// per (saved build × vendor). The sheet split preserves provenance
// — each tab is the buy plan for "this build, this vendor", which
// is what the user wants when handing off to vendor leads.
//
// Read-only against the planning runs the saved builds point at. No
// rebuild, no edit. The grid is for browsing and the Export button
// drops a workbook the planner can email.

import React, { useEffect, useMemo, useState } from "react";
import { S, PAL, formatDate } from "../components/styles";
import Toast, { type ToastMessage } from "../components/Toast";
import { scenarioRepo } from "../scenarios/services/scenarioRepo";
import type { IpScenario } from "../scenarios/types/scenarios";
import {
  loadReconcile,
  exportReconcileWorkbook,
  type ReconcileBuildOutput,
} from "../services/buildReconcileService";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../tanda/components/TablePrefs";
import { useSort } from "../../tanda/hooks/useSort";
import SortableTh from "../../tanda/components/SortableTh";

const TABLE_KEY = "ip.build_reconcile";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "build", label: "Build" },
  { key: "vendor", label: "Vendor" },
  { key: "skus", label: "SKUs" },
  { key: "total_qty", label: "Total qty" },
  { key: "total_cost", label: "Total cost" },
];

export default function BuildReconcileWorkbench() {
  const [savedBuilds, setSavedBuilds] = useState<IpScenario[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [outputs, setOutputs] = useState<ReconcileBuildOutput[]>([]);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  useEffect(() => { void loadSavedBuilds(); }, []);

  async function loadSavedBuilds() {
    setLoading(true);
    try {
      const all = await scenarioRepo.listScenarios();
      setSavedBuilds(all.filter((s) => s.scenario_type === "saved_build"));
    } catch (e) {
      setToast({ text: "Failed to load saved builds: " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function pickAll() {
    setPicked(new Set(savedBuilds.map((s) => s.id)));
  }
  function clearPicks() {
    setPicked(new Set());
    setOutputs([]);
  }

  async function onPreview() {
    if (picked.size === 0) {
      setToast({ text: "Pick at least one saved build", kind: "error" });
      return;
    }
    setComputing(true);
    try {
      // Preserve the order the user picked them in — stable across
      // re-renders so the workbook tabs come out in a predictable
      // order (matches the order the planner sees in the UI).
      const ordered = savedBuilds.filter((s) => picked.has(s.id)).map((s) => s.id);
      const results = await loadReconcile(ordered);
      setOutputs(results);
      const totalQty = results.reduce((acc, r) => acc + r.total_qty, 0);
      const totalRecs = results.reduce((acc, r) => acc + r.rec_count, 0);
      setToast({ text: `Loaded ${results.length} build${results.length === 1 ? "" : "s"} · ${totalRecs.toLocaleString()} buy lines · ${totalQty.toLocaleString()} total units`, kind: "success" });
    } catch (e) {
      setToast({ text: "Preview failed: " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setComputing(false);
    }
  }

  async function onExport() {
    if (outputs.length === 0) { setToast({ text: "Run preview first", kind: "error" }); return; }
    setExporting(true);
    try {
      exportReconcileWorkbook(outputs);
      setToast({ text: "Workbook downloaded", kind: "success" });
    } catch (e) {
      setToast({ text: "Export failed: " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setExporting(false);
    }
  }

  // Flat preview: list (build, vendor, sku-count, qty, cost) for the
  // sheets that will appear in the workbook. Lets the planner spot
  // unassigned vendors before exporting.
  const previewRows = useMemo(() => {
    const rows: Array<{ build: string; vendor: string; vendor_id: string | null; skus: number; qty: number; cost: number }> = [];
    for (const o of outputs) {
      for (const g of o.vendors) {
        rows.push({
          build: o.scenario.scenario_name,
          vendor: g.vendor_name,
          vendor_id: g.vendor_id,
          skus: g.rows.length,
          qty: g.total_qty,
          cost: g.total_cost,
        });
      }
    }
    return rows;
  }, [outputs]);

  const totalQty = previewRows.reduce((acc, r) => acc + r.qty, 0);
  const totalCost = previewRows.reduce((acc, r) => acc + r.cost, 0);

  // Additive per-column sort over the export preview rows. Column keys map to
  // the build/vendor/skus/qty/cost fields (qty/cost are the "Total qty/cost"
  // columns). Until a header is clicked the rows keep their build→vendor order.
  const { sorted: sortedPreview, sortKey, sortDir, onHeaderClick } = useSort(previewRows, {
    persistKey: "ip:build_reconcile_preview:sort",
    accessors: {
      build: (r) => r.build,
      vendor: (r) => r.vendor,
      skus: (r) => r.skus,
      total_qty: (r) => r.qty,
      total_cost: (r) => r.cost,
    },
  });

  return (
    <div style={{ ...S.content, paddingTop: 16 }}>
      {toast && <Toast msg={toast} onDismiss={() => setToast(null)} />}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <strong style={{ color: PAL.text, fontSize: 16 }}>Build reconcile</strong>
            <div style={{ color: PAL.textDim, fontSize: 12, marginTop: 2 }}>
              Pick saved builds, preview combined buy recommendations grouped by vendor, then export — one Excel sheet per (build × vendor).
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <a href="/planning/wholesale" style={{ ...S.btnSecondary, textDecoration: "none" }}>← Wholesale</a>
            <a href="/planning/scenarios" style={{ ...S.btnSecondary, textDecoration: "none" }}>What-if</a>
          </div>
        </div>
      </div>

      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <strong style={{ color: PAL.text, fontSize: 14 }}>Saved builds</strong>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: PAL.textDim, fontSize: 12 }}>
              {picked.size}/{savedBuilds.length} picked
            </span>
            <button style={S.btnSecondary} onClick={pickAll} disabled={savedBuilds.length === 0}>Pick all</button>
            <button style={S.btnSecondary} onClick={clearPicks} disabled={picked.size === 0}>Clear</button>
            <button
              style={{ ...S.btnPrimary, opacity: picked.size === 0 ? 0.5 : 1 }}
              onClick={() => void onPreview()}
              disabled={picked.size === 0 || computing}
            >
              {computing ? "Loading…" : "Preview"}
            </button>
            <button
              style={{ ...S.btnPrimary, opacity: outputs.length === 0 ? 0.5 : 1 }}
              onClick={() => void onExport()}
              disabled={outputs.length === 0 || exporting}
              title="Download Excel: one sheet per (saved build × vendor)"
            >
              {exporting ? "Exporting…" : "Export Excel"}
            </button>
          </div>
        </div>
        {loading && <div style={{ color: PAL.textDim, fontSize: 12 }}>Loading saved builds…</div>}
        {!loading && savedBuilds.length === 0 && (
          <div style={{ color: PAL.textDim, fontSize: 12 }}>
            No saved builds yet. Open the Wholesale planning grid and click <strong style={{ color: PAL.text }}>Save build</strong> to capture one.
          </div>
        )}
        {!loading && savedBuilds.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 6, maxHeight: 280, overflowY: "auto" }}>
            {savedBuilds.map((s) => (
              <label
                key={s.id}
                style={{
                  display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 8px",
                  background: picked.has(s.id) ? `${PAL.accent}22` : PAL.panelAlt,
                  border: `1px solid ${picked.has(s.id) ? PAL.accent : PAL.borderFaint}`,
                  borderRadius: 6, cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={picked.has(s.id)}
                  onChange={() => togglePick(s.id)}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: PAL.text, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.scenario_name}
                  </div>
                  <div style={{ color: PAL.textDim, fontSize: 11, marginTop: 2 }}>
                    Saved {formatDate(s.created_at.slice(0, 10))}
                    {s.note ? ` · ${s.note.slice(0, 60)}${s.note.length > 60 ? "…" : ""}` : ""}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {outputs.length > 0 && (
        <div style={S.card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Preview — {previewRows.length} sheet{previewRows.length === 1 ? "" : "s"}</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ color: PAL.textDim, fontSize: 12 }}>
                Total qty <strong style={{ color: PAL.text }}>{totalQty.toLocaleString()}</strong>
                {totalCost > 0 && <> · cost <strong style={{ color: PAL.text }}>${totalCost.toFixed(2)}</strong></>}
              </div>
              <TablePrefsButton
                tableKey={TABLE_KEY}
                columns={ALL_COLUMNS}
                visibleColumns={visibleColumns}
                onToggle={toggleColumn}
                onReset={resetToDefault}
                onSetAll={setAllVisible}
              />
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: PAL.panelAlt }}>
                  <SortableTh label="Build" sortKey="build" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("build")} />
                  <SortableTh label="Vendor" sortKey="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("vendor")} />
                  <SortableTh label="SKUs" sortKey="skus" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("skus")} />
                  <SortableTh label="Total qty" sortKey="total_qty" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("total_qty")} />
                  <SortableTh label="Total cost" sortKey="total_cost" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} hidden={!visibleColumns.has("total_cost")} />
                </tr>
              </thead>
              <tbody>
                {sortedPreview.map((r, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${PAL.borderFaint}` }}>
                    <td style={td} hidden={!visibleColumns.has("build")}>{r.build}</td>
                    <td style={{ ...td, color: r.vendor_id ? PAL.text : PAL.yellow }} hidden={!visibleColumns.has("vendor")}>
                      {r.vendor}
                      {!r.vendor_id && <span style={{ marginLeft: 6, fontSize: 10, color: PAL.yellow }}>no master vendor</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }} hidden={!visibleColumns.has("skus")}>{r.skus.toLocaleString()}</td>
                    <td style={{ ...td, textAlign: "right" }} hidden={!visibleColumns.has("total_qty")}>{r.qty.toLocaleString()}</td>
                    <td style={{ ...td, textAlign: "right" }} hidden={!visibleColumns.has("total_cost")}>{r.cost > 0 ? `$${r.cost.toFixed(2)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ color: PAL.textDim, fontSize: 11, marginTop: 8 }}>
            Excel export creates one sheet per row above. SKUs without a vendor in the item master fall into a single "(unassigned)" sheet per build so the gap is visible — fix the master and re-preview if you need them routed.
          </div>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left", padding: "6px 10px", color: PAL.textDim, fontWeight: 600,
  fontSize: 11, borderBottom: `1px solid ${PAL.border}`, textTransform: "uppercase", letterSpacing: "0.5px",
};
const td: React.CSSProperties = {
  padding: "6px 10px", color: PAL.text,
};
