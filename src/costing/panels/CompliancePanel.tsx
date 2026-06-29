// Costing Module — Compliance checklist per line.
//
// Rendered as a collapsible section below the costing grid. Only shows when
// a line is selected (matches the VendorQuotePanel pattern). The 5 default
// requirement codes (CPSIA, PROP65, FLAMMABILITY, LABEL_FIBER_CONTENT, COO)
// can be added in one click via the "Seed defaults" button; operator can
// also add custom codes.

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { appConfirm } from "../../utils/theme";
import type { CostingComplianceStatus, CostingLineCompliance } from "../types";
import SearchableSelect from "../../tanda/components/SearchableSelect";

const DEFAULT_CODES = ["CPSIA", "PROP65", "FLAMMABILITY", "LABEL_FIBER_CONTENT", "COO"];

const STATUS_OPTIONS: { value: CostingComplianceStatus; label: string; color: { bg: string; fg: string } }[] = [
  { value: "na",        label: "N/A",       color: { bg: "#E5E7EB", fg: "#374151" } },
  { value: "required",  label: "Required",  color: { bg: "#FEF3C7", fg: "#92400E" } },
  { value: "submitted", label: "Submitted", color: { bg: "#DBEAFE", fg: "#1E40AF" } },
  { value: "approved",  label: "Approved",  color: { bg: "#DCFCE7", fg: "#166534" } },
  { value: "rejected",  label: "Rejected",  color: { bg: "#FEE2E2", fg: "#991B1B" } },
];

const statusColorMap = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.color]));

export default function CompliancePanel() {
  const selectedLineId = useCostingStore((s) => s.selectedLineId);
  const lines          = useCostingStore((s) => s.lines);
  const compliance     = useCostingStore((s) => s.compliance);
  const loadCompliance   = useCostingStore((s) => s.loadCompliance);
  const addCompliance    = useCostingStore((s) => s.addCompliance);
  const updateCompliance = useCostingStore((s) => s.updateCompliance);
  const deleteCompliance = useCostingStore((s) => s.deleteCompliance);
  const setSelectedLine  = useCostingStore((s) => s.setSelectedLine);

  const [newCode, setNewCode] = useState("");
  const [seeding, setSeeding] = useState(false);

  const line = lines.find((l) => l.id === selectedLineId) || null;
  const rows = selectedLineId ? compliance[selectedLineId] || [] : [];

  useEffect(() => {
    if (selectedLineId && !compliance[selectedLineId]) {
      loadCompliance(selectedLineId);
    }
  }, [selectedLineId, compliance, loadCompliance]);

  if (!selectedLineId || !line) return null;

  const onAdd = async (code: string) => {
    if (!code.trim()) return;
    await addCompliance(selectedLineId, { requirement_code: code.trim().toUpperCase() });
    setNewCode("");
  };

  const onSeedDefaults = async () => {
    setSeeding(true);
    const existing = new Set(rows.map((r) => r.requirement_code));
    for (const code of DEFAULT_CODES) {
      if (existing.has(code)) continue;
      await addCompliance(selectedLineId, { requirement_code: code });
    }
    setSeeding(false);
  };

  const onStatusChange = (row: CostingLineCompliance, next: CostingComplianceStatus) => {
    const patch: { status: CostingComplianceStatus; completed_at?: string | null } = { status: next };
    if (next === "approved") patch.completed_at = new Date().toISOString();
    if (next === "required" || next === "na") patch.completed_at = null;
    updateCompliance(selectedLineId, row.id, patch);
    // Auto-close the panel after a status pick — operator ask. They can
    // re-open by clicking the row again. X button (header) also closes.
    setSelectedLine(null);
  };

  const lineLabel = line.style_code || line.style_name || "(unnamed line)";

  return (
    <div style={{
      marginTop: 20, background: "#1E293B", border: "1px solid #334155",
      borderRadius: 8, padding: "16px 20px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#E2E8F0", letterSpacing: ".04em", textTransform: "uppercase" }}>
          Compliance · {lineLabel}
        </h3>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {rows.length === 0 && (
            <button
              onClick={onSeedDefaults}
              disabled={seeding}
              style={btn("#10B981")}
            >
              {seeding ? "Seeding…" : "+ Seed CPSIA / PROP65 / FLAMMABILITY / FIBER / COO"}
            </button>
          )}
          <button
            onClick={() => setSelectedLine(null)}
            title="Close panel"
            style={{
              background: "transparent", color: "#94A3B8",
              border: "1px solid #334155", borderRadius: 4,
              width: 24, height: 24, padding: 0, cursor: "pointer",
              fontSize: 14, lineHeight: "20px", fontWeight: 700,
            }}
          >×</button>
        </div>
      </div>

      {rows.length === 0 && (
        <div style={{ padding: 16, textAlign: "center", color: "#94A3B8", fontSize: 12 }}>
          No compliance requirements yet. Use "Seed defaults" above for the standard apparel set, or add a custom code below.
        </div>
      )}

      {rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#0F172A" }}>
              <Th>Requirement</Th>
              <Th>Status</Th>
              <Th>Notes</Th>
              <Th>Attachment</Th>
              <Th>Completed</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sc = statusColorMap[r.status] || statusColorMap.required;
              return (
                <tr key={r.id} style={{ borderTop: "1px solid #334155" }}>
                  <Td>
                    <code style={{ background: "#0F172A", color: "#E2E8F0", padding: "2px 6px", borderRadius: 3, fontSize: 11 }}>
                      {r.requirement_code}
                    </code>
                  </Td>
                  <Td>
                    <SearchableSelect
                      value={r.status}
                      onChange={(v) => onStatusChange(r, v as CostingComplianceStatus)}
                      options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      inputStyle={{ ...inp, background: sc.bg, color: sc.fg, fontWeight: 600 }}
                    />
                  </Td>
                  <Td>
                    <input
                      type="text"
                      defaultValue={r.notes || ""}
                      placeholder="—"
                      onBlur={(e) => { if ((e.target.value || null) !== r.notes) updateCompliance(selectedLineId, r.id, { notes: e.target.value || null }); }}
                      style={inp}
                    />
                  </Td>
                  <Td>
                    <input
                      type="url"
                      defaultValue={r.attachment_url || ""}
                      placeholder="https://…"
                      onBlur={(e) => { if ((e.target.value || null) !== r.attachment_url) updateCompliance(selectedLineId, r.id, { attachment_url: e.target.value || null }); }}
                      style={inp}
                    />
                  </Td>
                  <Td>
                    <span style={{ color: r.completed_at ? "#94A3B8" : "#475569", fontSize: 11 }}>
                      {r.completed_at ? r.completed_at.slice(0, 10) : "—"}
                    </span>
                  </Td>
                  <Td>
                    <button
                      onClick={() => appConfirm(`Remove ${r.requirement_code}?`, "Remove", () => deleteCompliance(selectedLineId, r.id))}
                      style={{ background: "transparent", color: "#EF4444", border: "1px solid #EF4444", padding: "2px 8px", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                    >×</button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onAdd(newCode); }}
          placeholder="Add custom requirement code (e.g. CALIFORNIA_PROP65)"
          style={{ ...inp, flex: 1 }}
        />
        <button onClick={() => onAdd(newCode)} disabled={!newCode.trim()} style={btn("#3B82F6")}>
          + Add requirement
        </button>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ textAlign: "left", padding: "6px 10px", fontWeight: 600, fontSize: 10, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em" }}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "6px 10px", color: "#E2E8F0", verticalAlign: "top" }}>{children}</td>;
}

const inp: React.CSSProperties = {
  background: "#0F172A", color: "#E2E8F0",
  border: "1px solid #334155", borderRadius: 4,
  padding: "4px 8px", fontSize: 12, width: "100%",
};

function btn(color: string): React.CSSProperties {
  return {
    background: color, color: "#fff", border: "none",
    padding: "5px 12px", borderRadius: 4, cursor: "pointer",
    fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
  };
}
