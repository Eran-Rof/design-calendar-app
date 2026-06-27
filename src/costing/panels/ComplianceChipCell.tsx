// ComplianceChipCell — inline grid cell that shows the line's current
// compliance requirements as compact pills + a dropdown to add another
// from the compliance master list. Already-added codes are filtered out
// of the dropdown so the operator can't add the same one twice.
//
// Picking "+ Add new…" opens a prompt; saves to the master and adds it
// to this line in one step.

import React from "react";
import { useCostingStore } from "../store/costingStore";
import type { CostingLineCompliance } from "../types";
import { promptDialog } from "../../shared/ui/warn";
import SearchableSelect from "../../tanda/components/SearchableSelect";

interface Props {
  lineId: string;
}

// Stable empty-array reference for the Zustand selector — fresh `[]`
// literal on each render triggers React error #185 (Zustand sees a
// new ref → re-render → new ref → infinite loop).
const EMPTY: CostingLineCompliance[] = [];

export default function ComplianceChipCell({ lineId }: Props) {
  const master         = useCostingStore((s) => s.masters.compliance);
  const compliance     = useCostingStore((s) => s.compliance[lineId] || EMPTY);
  const addCompliance  = useCostingStore((s) => s.addCompliance);
  const deleteCompliance = useCostingStore((s) => s.deleteCompliance);
  const addMaster      = useCostingStore((s) => s.addMaster);
  const setNotice      = useCostingStore((s) => s.setNotice);

  const have = new Set(compliance.map((r) => r.requirement_code));
  const available = master.filter((m) => !have.has(m.name));

  const onPick = async (raw: string) => {
    if (!raw) return;
    if (raw === "__add__") {
      const v = await promptDialog("Add new compliance requirement code:", { title: "New compliance code", required: true });
      if (!v || !v.trim()) return;
      const clean = v.trim().toUpperCase();
      await addMaster("compliance", clean);
      if (!have.has(clean)) await addCompliance(lineId, { requirement_code: clean });
      setNotice(`Added "${clean}" to compliance master + this line`, "info");
      return;
    }
    if (!have.has(raw)) await addCompliance(lineId, { requirement_code: raw });
  };

  const onRemove = (row: CostingLineCompliance) => {
    deleteCompliance(lineId, row.id);
  };

  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center",
      padding: "2px 4px", width: "100%", minHeight: 28,
    }}>
      {compliance.map((r) => (
        <span
          key={r.id}
          title={`${r.requirement_code} — ${r.status} (click × to remove)`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            background: statusBg(r.status), color: statusFg(r.status),
            border: `1px solid ${statusBorder(r.status)}`,
            borderRadius: 3, padding: "0 4px", fontSize: 9,
            fontWeight: 700, letterSpacing: ".02em",
            whiteSpace: "nowrap",
          }}
        >
          {r.requirement_code}
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(r); }}
            style={{
              background: "transparent", border: "none", color: "inherit",
              cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1,
              opacity: 0.7,
            }}
            title="Remove"
          >×</button>
        </span>
      ))}
      <div title="Add compliance requirement" style={{ maxWidth: 90 }}>
        <SearchableSelect
          value={null}
          onChange={(v) => { onPick(v); }}
          options={[
            ...available.map((m) => ({ value: m.name, label: m.name })),
            { value: "──────────", label: "──────────", disabled: true },
            { value: "__add__", label: "+ Add new…" },
          ]}
          placeholder="+ add"
          inputStyle={{
            background: "transparent", color: "#94A3B8",
            border: "1px dashed #475569", borderRadius: 3,
            padding: "0 2px", fontSize: 10, cursor: "pointer",
          }}
        />
      </div>
    </div>
  );
}

function statusBg(status: string): string {
  switch (status) {
    case "approved":  return "#065F4633";
    case "submitted": return "#1E40AF33";
    case "rejected":  return "#991B1B33";
    case "na":        return "#37415133";
    default:          return "#92400E33"; // required
  }
}
function statusFg(status: string): string {
  switch (status) {
    case "approved":  return "#6EE7B7";
    case "submitted": return "#93C5FD";
    case "rejected":  return "#FCA5A5";
    case "na":        return "#9CA3AF";
    default:          return "#FCD34D"; // required
  }
}
function statusBorder(status: string): string {
  switch (status) {
    case "approved":  return "#065F46";
    case "submitted": return "#1E40AF";
    case "rejected":  return "#991B1B";
    case "na":        return "#374151";
    default:          return "#92400E";
  }
}
