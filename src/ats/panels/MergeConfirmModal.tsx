import React from "react";

interface PendingMerge {
  fromSku: string;
  toSku: string;
  similarity: number;
}

interface MergeConfirmModalProps {
  pendingMerge: PendingMerge | null;
  isAdmin: boolean;
  commitMerge: (fromSku: string, toSku: string) => void;
  setPendingMerge: (v: PendingMerge | null) => void;
}

export const MergeConfirmModal: React.FC<MergeConfirmModalProps> = ({
  pendingMerge, isAdmin, commitMerge, setPendingMerge,
}) => {
  if (!pendingMerge) return null;
  const { fromSku, toSku, similarity } = pendingMerge;
  const pct = Math.round(similarity * 100);
  const isLow = similarity < 0.8;
  const canConfirm = !isLow || isAdmin;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => setPendingMerge(null)}
    >
      <div
        style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 12, padding: 28, maxWidth: 480, width: "90%", boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 20, fontWeight: 700, color: "#F1F5F9", marginBottom: 6 }}>
          {isLow ? "⚠️ Low Similarity Warning" : "Merge SKUs?"}
        </div>
        <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 20, lineHeight: 1.6 }}>
          Merging <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>{fromSku}</span> into <span style={{ color: "#10B981", fontFamily: "monospace" }}>{toSku}</span>.
          <br />
          All quantities (On Hand, On PO, On Order) and date projections will be summed.
          The merged row keeps <span style={{ color: "#10B981", fontFamily: "monospace" }}>{toSku}</span>'s identifier.
        </div>
        <div style={{ background: "#0F172A", borderRadius: 8, padding: "10px 14px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 13, color: "#64748B" }}>SKU similarity</div>
          <div style={{ flex: 1, height: 6, background: "#1E293B", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: isLow ? "#EF4444" : "#10B981", borderRadius: 3, transition: "width 0.3s" }} />
          </div>
          <div style={{ fontWeight: 700, fontSize: 15, color: isLow ? "#EF4444" : "#10B981", minWidth: 40 }}>{pct}%</div>
        </div>
        {isLow && (
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 20, fontSize: 13, color: "#FCA5A5" }}>
            {canConfirm
              ? "These SKUs look different. As an admin you can still proceed."
              : "Admin approval required to merge SKUs with less than 80% similarity."}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={() => setPendingMerge(null)}
            style={{ padding: "8px 18px", borderRadius: 7, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontSize: 13 }}
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => canConfirm && commitMerge(fromSku, toSku)}
            style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: canConfirm ? "#10B981" : "#1E3A2A", color: canConfirm ? "#fff" : "#4B5563", cursor: canConfirm ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}
          >
            Merge SKUs
          </button>
        </div>
      </div>
    </div>
  );
};
