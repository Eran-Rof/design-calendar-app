// Header-bar approval actions — status chip + valid-transition buttons.

import type { IpApprovalStatus, IpScenario } from "../types/scenarios";
import { canTransition } from "../services/approvalService";
import { S, PAL } from "../../components/styles";
import { promptDialog } from "../../../shared/ui/warn";

const STATUS_COLOR: Record<IpApprovalStatus, string> = {
  draft:     "#94A3B8",
  in_review: "#3B82F6",
  approved:  "#10B981",
  rejected:  "#EF4444",
  archived:  "#6B7280",
};

export interface ApprovalBarProps {
  scenario: IpScenario;
  onAction: (to: IpApprovalStatus, note: string | null) => Promise<void>;
  busy?: boolean;
}

export default function ApprovalBar({ scenario, onAction, busy }: ApprovalBarProps) {
  const candidates: IpApprovalStatus[] = ["in_review", "approved", "rejected", "archived", "draft"];
  const enabled = candidates.filter((to) => canTransition(scenario.status, to));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ color: PAL.textMuted, fontSize: 12 }}>Status:</span>
      <span style={{
        ...S.chip,
        background: STATUS_COLOR[scenario.status] + "33",
        color: STATUS_COLOR[scenario.status],
        padding: "4px 10px",
        fontSize: 12,
      }}>{scenario.status.replace(/_/g, " ")}</span>
      {enabled.length === 0 ? (
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>(terminal)</span>
      ) : (
        enabled.map((to) => (
          <button key={to}
                  style={to === "approved" ? S.btnPrimary : S.btnSecondary}
                  disabled={busy}
                  onClick={async () => {
                    const note = await promptDialog(
                      `Add a note for "${labelFor(to, scenario.status)}" (optional).`,
                      { title: labelFor(to, scenario.status), multiline: true, placeholder: "Optional note", confirmText: labelFor(to, scenario.status) },
                    );
                    // promptDialog returns null on cancel — abort to avoid a
                    // surprise transition.
                    if (note === null) return;
                    await onAction(to, note.trim() || null);
                  }}>
            {labelFor(to, scenario.status)}
          </button>
        ))
      )}
    </div>
  );
}

function labelFor(to: IpApprovalStatus, from?: IpApprovalStatus): string {
  switch (to) {
    case "draft":     return "Send back to draft";
    // approved → in_review is a REOPEN, not a forward "submit for review".
    case "in_review": return from === "approved" ? "Reopen" : "Submit for review";
    case "approved":  return "Approve";
    case "rejected":  return "Reject";
    case "archived":  return "Archive";
  }
}
