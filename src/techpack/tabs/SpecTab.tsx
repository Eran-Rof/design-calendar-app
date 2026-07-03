// Spec Sheet tab extracted from TechPack.tsx. Two panels:
//   1. Style metadata form (designer / division / owner / version /
//      description / brand / season / active toggle).
//   2. Measurement grid — POM rows × size columns + per-cell value
//      editing. The size column add/remove + row factory all flow
//      through ../specOps.ts (already covered by 12 unit tests).
//
// The "+ Size Column" input toggle is parent-owned because it shares
// state with the spec-sheet detail panel; we receive it as props.

import type { TechPack, Measurement } from "../types";
import { SEASONS, DEFAULT_SIZES } from "../constants";
import {
  createMeasurementRow,
  addSizeToMeasurements,
  removeSizeFromMeasurements,
} from "../specOps";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

export interface SpecTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
  showAddSize: boolean;
  setShowAddSize: (b: boolean) => void;
  newSize: string;
  setNewSize: (s: string) => void;
}

export function SpecTab({
  tp,
  updateSelected,
  showAddSize,
  setShowAddSize,
  newSize,
  setNewSize,
}: SpecTabProps) {
  const sizes = tp.measurements.length > 0
    ? Object.keys(tp.measurements[0].sizes)
    : [...DEFAULT_SIZES];

  const updateMeasurement = (idx: number, changes: Partial<Measurement>) => {
    const updated = [...tp.measurements];
    updated[idx] = { ...updated[idx], ...changes };
    updateSelected({ measurements: updated });
  };

  return (
    <>
      {/* Style metadata editable fields */}
      <div style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px solid #334155" }}>
        <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 12 }}>Style Info</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>Designer</label>
            <input style={S.input} value={tp.designer || ""} onChange={e => updateSelected({ designer: e.target.value })} placeholder="Designer name" />
          </div>
          <div>
            <label style={S.label}>Division</label>
            <input style={S.input} value={tp.division || ""} onChange={e => updateSelected({ division: e.target.value })} placeholder="e.g. Young Mens" />
          </div>
          <div>
            <label style={S.label}>Owner</label>
            <input style={S.input} value={tp.owner || ""} onChange={e => updateSelected({ owner: e.target.value })} placeholder="e.g. ROF" />
          </div>
          <div>
            <label style={S.label}>Version</label>
            <input style={S.input} type="number" value={tp.version || 1} onChange={e => updateSelected({ version: parseInt(e.target.value) || 1 })} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 60px", gap: 12 }}>
          <div>
            <label style={S.label}>Description</label>
            <input style={S.input} value={tp.description || ""} onChange={e => updateSelected({ description: e.target.value })} placeholder="Style description..." />
          </div>
          <div>
            <label style={S.label}>Brand</label>
            <input style={S.input} value={tp.brand || ""} onChange={e => updateSelected({ brand: e.target.value })} />
          </div>
          <div>
            <label style={S.label}>Season</label>
            <SearchableSelect
              value={tp.season || null}
              onChange={v => updateSelected({ season: v })}
              options={SEASONS.map(s => ({ value: s, label: s }))}
              placeholder="Select..."
              inputStyle={{ ...S.select, width: "100%" }}
            />
          </div>
          <div>
            <label style={S.label}>Active</label>
            <button
              style={{
                ...S.btnSmall,
                background: tp.active !== false ? "#10B98122" : "#EF444422",
                color: tp.active !== false ? "#10B981" : "#EF4444",
                border: `1px solid ${tp.active !== false ? "#10B981" : "#EF4444"}44`,
                width: "100%",
                padding: "9px 0",
              }}
              onClick={() => updateSelected({ active: tp.active === false ? true : false })}
            >
              {tp.active !== false ? "Yes" : "No"}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Measurements</h3>
        <div style={{ display: "flex", gap: 8 }}>
          {showAddSize ? (
            <>
              <input
                style={{ ...S.input, width: 80, padding: "4px 8px", fontSize: 12 }}
                placeholder="Size"
                value={newSize}
                onChange={e => setNewSize(e.target.value)}
              />
              <button style={S.btnSmall} onClick={() => {
                if (!newSize.trim()) return;
                updateSelected({ measurements: addSizeToMeasurements(tp.measurements, newSize) });
                setNewSize("");
                setShowAddSize(false);
              }}>Add</button>
              <button
                style={{ ...S.btnSmall, background: "none", color: "#6B7280" }}
                onClick={() => setShowAddSize(false)}
              >Cancel</button>
            </>
          ) : (
            <button style={S.btnSmall} onClick={() => setShowAddSize(true)}>+ Size Column</button>
          )}
          <button
            style={S.btnSmall}
            onClick={() => updateSelected({ measurements: [...tp.measurements, createMeasurementRow(sizes)] })}
          >+ Measurement</button>
        </div>
      </div>

      {tp.measurements.length === 0 ? (
        <div style={{ ...S.emptyState, padding: 30 }}>
          <p style={{ color: "#6B7280", fontSize: 13 }}>No measurements yet. Add size columns and measurement points.</p>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Point of Measure</th>
                <th style={S.th}>Tolerance</th>
                {sizes.map(s => (
                  <th key={s} style={S.th}>
                    {s}
                    <button
                      style={{ ...S.iconBtnTiny, marginLeft: 4 }}
                      onClick={() => updateSelected({ measurements: removeSizeFromMeasurements(tp.measurements, s) })}
                    >✕</button>
                  </th>
                ))}
                <th style={S.th}>Del</th>
              </tr>
            </thead>
            <tbody>
              {tp.measurements.map((m, idx) => (
                <tr key={m.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                  <td style={S.td}>
                    <input
                      style={S.cellInput}
                      value={m.pointOfMeasure}
                      onChange={e => updateMeasurement(idx, { pointOfMeasure: e.target.value })}
                      placeholder="e.g. Chest"
                    />
                  </td>
                  <td style={S.td}>
                    <input
                      style={{ ...S.cellInput, width: 70 }}
                      value={m.tolerance}
                      onChange={e => updateMeasurement(idx, { tolerance: e.target.value })}
                    />
                  </td>
                  {sizes.map(s => (
                    <td key={s} style={S.td}>
                      <input
                        style={{ ...S.cellInput, width: 60, textAlign: "center" }}
                        value={m.sizes[s] || ""}
                        onChange={e => updateMeasurement(idx, { sizes: { ...m.sizes, [s]: e.target.value } })}
                      />
                    </td>
                  ))}
                  <td style={S.td}>
                    <button
                      style={S.iconBtnTiny}
                      onClick={() => updateSelected({ measurements: tp.measurements.filter(x => x.id !== m.id) })}
                    >Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
