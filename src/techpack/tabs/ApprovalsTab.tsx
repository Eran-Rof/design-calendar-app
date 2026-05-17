// Approvals tab extracted from TechPack.tsx. Renders the
// sequential-stage workflow: progress chips up top + one editable
// card per stage. Stages unlock left-to-right (every prior stage
// must be "Approved" before the next opens).
//
// The unlock rule lives in ../calc.ts (isApprovalStageUnlocked) so
// UI gating + any save-side gating stay in sync.

import type { TechPack, Approval } from "../types";
import { fmtDate, today } from "../utils";
import { isApprovalStageUnlocked } from "../calc";
import { emptyApprovals } from "../factories";
import { APPROVAL_STATUS_COLORS } from "../constants";
import S from "../styles";

export interface ApprovalsTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
}

export function ApprovalsTab({ tp, updateSelected }: ApprovalsTabProps) {
  // Backfill an empty approvals array with the canonical 5-stage
  // sequence so older tech packs still render the workflow correctly.
  const approvals = tp.approvals.length > 0 ? tp.approvals : emptyApprovals();

  const isStageUnlocked = (index: number) => isApprovalStageUnlocked(approvals, index);

  const updateAt = (idx: number, changes: Partial<Approval>) => {
    const updated = [...approvals];
    updated[idx] = { ...updated[idx], ...changes };
    updateSelected({ approvals: updated });
  };

  return (
    <>
      <h3 style={{ margin: "0 0 16px", color: "#F1F5F9", fontSize: 16 }}>Approval Workflow</h3>

      {/* Progress bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 20, padding: "0 8px" }}>
        {approvals.map((a, i) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", flex: 1 }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%",
              background: APPROVAL_STATUS_COLORS[a.status] + "33",
              border: `2px solid ${APPROVAL_STATUS_COLORS[a.status]}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, color: APPROVAL_STATUS_COLORS[a.status], fontWeight: 700, flexShrink: 0,
            }}>
              {a.status === "Approved" ? "✓" : a.status === "Rejected" ? "✕" : i + 1}
            </div>
            {i < approvals.length - 1 && (
              <div style={{ flex: 1, height: 2, background: a.status === "Approved" ? "#10B981" : "#334155", margin: "0 4px" }} />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20, padding: "0 8px" }}>
        {approvals.map(a => (
          <span key={a.id} style={{ fontSize: 10, color: "#6B7280", textAlign: "center", flex: 1 }}>{a.stage}</span>
        ))}
      </div>

      {/* Approval cards */}
      {approvals.map((a, idx) => {
        const unlocked = isStageUnlocked(idx);
        return (
          <div key={a.id} style={{
            background: unlocked ? "#0F172A" : "#0F172A88",
            borderRadius: 10, padding: 16, marginBottom: 10,
            border: `1px solid ${APPROVAL_STATUS_COLORS[a.status]}44`,
            opacity: unlocked ? 1 : 0.5,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "#F1F5F9", fontWeight: 700, fontSize: 15 }}>{a.stage}</span>
                <span style={{
                  ...S.badge,
                  background: APPROVAL_STATUS_COLORS[a.status] + "22",
                  color: APPROVAL_STATUS_COLORS[a.status],
                  border: `1px solid ${APPROVAL_STATUS_COLORS[a.status]}44`,
                }}>{a.status}</span>
              </div>
              {a.date && <span style={{ color: "#6B7280", fontSize: 12 }}>{fmtDate(a.date)}</span>}
            </div>

            <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={S.label}>Approver</label>
                <input
                  style={S.input}
                  value={a.approver}
                  disabled={!unlocked}
                  onChange={e => updateAt(idx, { approver: e.target.value })}
                  placeholder="Approver name"
                />
              </div>
            </div>

            <label style={S.label}>Comments</label>
            <textarea
              style={{ ...S.textarea, minHeight: 40, marginBottom: 10 }}
              value={a.comments}
              disabled={!unlocked}
              onChange={e => updateAt(idx, { comments: e.target.value })}
              placeholder="Add comments..."
            />

            {unlocked && a.status !== "Approved" && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  style={{ ...S.btnSmall, background: "#10B981", color: "#fff", border: "none" }}
                  onClick={() => updateAt(idx, { status: "Approved", date: today() })}
                >Approve</button>
                <button
                  style={{ ...S.btnSmall, background: "#EF4444", color: "#fff", border: "none" }}
                  onClick={() => updateAt(idx, { status: "Rejected", date: today() })}
                >Reject</button>
                <button
                  style={{ ...S.btnSmall, background: "#F59E0B", color: "#fff", border: "none" }}
                  onClick={() => updateAt(idx, { status: "Revision Required", date: today() })}
                >Request Revision</button>
                {a.status !== "Pending" && (
                  <button
                    style={{ ...S.btnSmall, background: "none", color: "#6B7280", border: "1px solid #334155" }}
                    onClick={() => updateAt(idx, { status: "Pending", date: null })}
                  >Reset</button>
                )}
              </div>
            )}
            {!unlocked && (
              <div style={{ color: "#6B7280", fontSize: 12, fontStyle: "italic" }}>
                Previous stage must be approved first
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
