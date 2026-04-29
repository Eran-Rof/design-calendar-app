// Run selector + "build forecast" button. A thin bar above the grid.
//
// A planner picks an active run, or creates a new one with a horizon.
// Building the forecast kicks off runForecastPass on the service.

import { useState } from "react";
import type { IpPlanningRun, IpPlanningRunStatus } from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { runForecastPass, type BuildFilter } from "../services/wholesaleForecastService";
import { S, PAL, formatDate } from "../components/styles";
import type { ToastMessage } from "../components/Toast";

export interface PlanningRunControlsProps {
  runs: IpPlanningRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onChange: () => Promise<void> | void;
  onToast: (t: ToastMessage) => void;
  // New runs the user creates from this bar get this scope. Default
  // 'wholesale' keeps Phase 1 unchanged; Phase 2 workbench passes 'ecom'.
  scope?: "wholesale" | "ecom" | "all";
  // Optional label shown on the action button — "Build forecast" for
  // wholesale, the ecom workbench renders its own build button and
  // passes `showBuild={false}` to avoid a duplicate.
  showBuild?: boolean;
  // Grid-derived filter. When any field is set, the Build button
  // scopes the build to the matching subset and re-labels itself
  // "Build (filtered)" so the planner knows it's not a full-run build.
  buildFilter?: BuildFilter | null;
}

export default function PlanningRunControls({
  runs, selectedRunId, onSelect, onChange, onToast,
  scope = "wholesale", showBuild = true, buildFilter = null,
}: PlanningRunControlsProps) {
  const [showNew, setShowNew] = useState(false);
  const [building, setBuilding] = useState(false);

  const selected = runs.find((r) => r.id === selectedRunId) ?? null;

  const filterActive = !!buildFilter && Object.values(buildFilter).some((v) => v != null && v !== "");

  async function buildForecast() {
    if (!selected) { onToast({ text: "Pick a run first", kind: "error" }); return; }
    setBuilding(true);
    try {
      const result = await runForecastPass(selected, filterActive ? { filter: buildFilter ?? undefined } : {});
      const lyCount = result.methods.ly_sales ?? 0;
      const lyNote = lyCount > 0 ? ` · ${lyCount} Same Period LY` : "";
      const filterNote = filterActive ? ` · filter excluded ${result.pairs_pruned_filter}` : "";
      const deadNote = result.pairs_pruned_dead > 0 ? ` · pruned ${result.pairs_pruned_dead} dead SKUs` : "";
      onToast({
        text: `Forecast built — ${result.forecast_rows_written} rows, ${result.recommendations_written} recs${lyNote}${deadNote}${filterNote}`,
        kind: "success",
      });
      await onChange();
    } catch (e) {
      onToast({
        text: "Forecast build failed — " + (e instanceof Error ? e.message : String(e)),
        kind: "error",
      });
    } finally {
      setBuilding(false);
    }
  }

  async function setStatus(status: IpPlanningRunStatus) {
    if (!selected) return;
    await wholesaleRepo.updatePlanningRun(selected.id, { status });
    await onChange();
  }

  return (
    <div style={{ ...S.card, marginBottom: 12 }}>
      <div style={S.toolbar}>
        <strong style={{ color: PAL.text, fontSize: 14 }}>Planning run</strong>
        <select style={S.select}
                value={selectedRunId ?? ""}
                onChange={(e) => onSelect(e.target.value)}>
          <option value="">— pick —</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.status} · {formatDate(r.horizon_start)}–{formatDate(r.horizon_end)}
            </option>
          ))}
        </select>
        <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New run</button>
        {selected && (
          <>
            {showBuild && (
              <button
                style={{
                  ...S.btnPrimary,
                  ...(filterActive ? { background: PAL.yellow, color: "#111" } : {}),
                }}
                onClick={buildForecast}
                disabled={building}
                title={filterActive
                  ? `Build only the rows matching the current grid filters: ${[
                      buildFilter?.customer_id ? "customer" : null,
                      buildFilter?.group_name ? `category=${buildFilter.group_name}` : null,
                      buildFilter?.sub_category_name ? `sub-cat=${buildFilter.sub_category_name}` : null,
                      buildFilter?.gender ? `gender=${buildFilter.gender}` : null,
                    ].filter(Boolean).join(", ")}`
                  : "Build forecast for every (customer, sku) pair in the run"}
              >
                {building ? "Building…" : (filterActive ? "Build (filtered)" : "Build forecast")}
              </button>
            )}
            {selected.status !== "active" && (
              <button style={S.btnSecondary} onClick={() => setStatus("active")}>Mark active</button>
            )}
            {selected.status !== "archived" && (
              <button style={S.btnSecondary} onClick={() => setStatus("archived")}>Archive</button>
            )}
          </>
        )}
      </div>
      {selected && (
        <div style={{ color: PAL.textMuted, fontSize: 12 }}>
          Snapshot {formatDate(selected.source_snapshot_date)}
          {selected.note ? ` · ${selected.note}` : ""}
        </div>
      )}
      {showNew && (
        <NewRunModal scope={scope}
                     onClose={() => setShowNew(false)}
                     onToast={onToast}
                     onCreated={async (id) => {
                       setShowNew(false);
                       onSelect(id);
                       onToast({ text: "Planning run created", kind: "success" });
                       await onChange();
                     }} />
      )}
    </div>
  );
}

function NewRunModal({ onClose, onCreated, onToast, scope }: {
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
  scope: "wholesale" | "ecom" | "all";
}) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const defaultStart = `${yyyy}-${mm}-01`;
  const endD = new Date(Date.UTC(yyyy, today.getUTCMonth() + 5, 0));
  const defaultEnd = endD.toISOString().slice(0, 10);

  const defaultName = scope === "ecom" ? `Ecom — ${yyyy}-${mm}` : scope === "all" ? `Combined — ${yyyy}-${mm}` : `Wholesale — ${yyyy}-${mm}`;
  const [name, setName] = useState(defaultName);
  const [horizonStart, setHorizonStart] = useState(defaultStart);
  const [horizonEnd, setHorizonEnd] = useState(defaultEnd);
  const [snapshot, setSnapshot] = useState(today.toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { onToast({ text: "Name is required", kind: "error" }); return; }
    if (horizonEnd < horizonStart) { onToast({ text: "Horizon end is before start", kind: "error" }); return; }
    setSaving(true);
    try {
      const r = await wholesaleRepo.createPlanningRun({
        name: name.trim(),
        planning_scope: scope,
        status: "draft",
        source_snapshot_date: snapshot,
        horizon_start: horizonStart,
        horizon_end: horizonEnd,
        forecast_method_preference: "ly_sales",
        wholesale_source_run_id: null,
        ecom_source_run_id: null,
        note: note.trim() || null,
        created_by: null,
      });
      await onCreated(r.id);
    } catch (e) {
      onToast({ text: "Couldn't create run — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New planning run</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={S.label}>Horizon start</label>
                <input type="date" style={{ ...S.input, width: "100%" }} value={horizonStart}
                       onChange={(e) => setHorizonStart(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Horizon end</label>
                <input type="date" style={{ ...S.input, width: "100%" }} value={horizonEnd}
                       onChange={(e) => setHorizonEnd(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Snapshot date</label>
                <input type="date" style={{ ...S.input, width: "100%" }} value={snapshot}
                       onChange={(e) => setSnapshot(e.target.value)} />
              </div>
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button style={S.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={S.btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Creating…" : "Create run"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
