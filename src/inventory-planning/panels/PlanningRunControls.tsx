// Run selector + "build forecast" button. A thin bar above the grid.
//
// A planner picks an active run, or creates a new one with a horizon.
// Building the forecast kicks off runForecastPass on the service.

import { useState } from "react";
import type { IpPlanningRun, IpPlanningRunStatus } from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { runForecastPass } from "../services/wholesaleForecastService";
import { S, PAL } from "../components/styles";

export interface PlanningRunControlsProps {
  runs: IpPlanningRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onChange: () => Promise<void> | void;
}

export default function PlanningRunControls({ runs, selectedRunId, onSelect, onChange }: PlanningRunControlsProps) {
  const [showNew, setShowNew] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = runs.find((r) => r.id === selectedRunId) ?? null;

  async function buildForecast() {
    if (!selected) { setError("Pick a run first"); return; }
    setBuilding(true); setBuildMsg(null); setError(null);
    try {
      const result = await runForecastPass(selected);
      setBuildMsg(
        `Wrote ${result.forecast_rows_written} forecast rows · ${result.recommendations_written} recommendations · ${result.pairs_considered} pairs.`,
      );
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
              {r.name} · {r.status} · {r.horizon_start ?? "?"}–{r.horizon_end ?? "?"}
            </option>
          ))}
        </select>
        <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New run</button>
        {selected && (
          <>
            <button style={S.btnPrimary} onClick={buildForecast} disabled={building}>
              {building ? "Building…" : "Build forecast"}
            </button>
            {selected.status !== "active" && (
              <button style={S.btnSecondary} onClick={() => setStatus("active")}>Mark active</button>
            )}
            {selected.status !== "archived" && (
              <button style={S.btnSecondary} onClick={() => setStatus("archived")}>Archive</button>
            )}
          </>
        )}
        {buildMsg && <span style={{ color: PAL.green, fontSize: 12 }}>{buildMsg}</span>}
        {error && <span style={{ color: PAL.red, fontSize: 12 }}>{error}</span>}
      </div>
      {selected && (
        <div style={{ color: PAL.textMuted, fontSize: 12 }}>
          Snapshot {selected.source_snapshot_date}
          {selected.note ? ` · ${selected.note}` : ""}
        </div>
      )}
      {showNew && (
        <NewRunModal onClose={() => setShowNew(false)}
                     onCreated={async (id) => { setShowNew(false); onSelect(id); await onChange(); }} />
      )}
    </div>
  );
}

function NewRunModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const defaultStart = `${yyyy}-${mm}-01`;
  const endD = new Date(Date.UTC(yyyy, today.getUTCMonth() + 5, 0));
  const defaultEnd = endD.toISOString().slice(0, 10);

  const [name, setName] = useState(`Wholesale — ${yyyy}-${mm}`);
  const [horizonStart, setHorizonStart] = useState(defaultStart);
  const [horizonEnd, setHorizonEnd] = useState(defaultEnd);
  const [snapshot, setSnapshot] = useState(today.toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await wholesaleRepo.createPlanningRun({
        name: name.trim() || "Wholesale plan",
        planning_scope: "wholesale",
        status: "draft",
        source_snapshot_date: snapshot,
        horizon_start: horizonStart,
        horizon_end: horizonEnd,
        note: note.trim() || null,
        created_by: null,
      });
      await onCreated(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            {error && <div style={{ color: PAL.red, fontSize: 12 }}>{error}</div>}
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
