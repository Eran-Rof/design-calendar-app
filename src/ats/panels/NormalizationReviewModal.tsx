import React from "react";
import type { NormChange } from "../normalize";

interface NormalizationReviewModalProps {
  normChanges: NormChange[] | null;
  setNormChanges: (v: NormChange[] | null) => void;
  applyNormReview: () => void;
  dismissNormReview: () => void;
}

export const NormalizationReviewModal: React.FC<NormalizationReviewModalProps> = ({
  normChanges, setNormChanges, applyNormReview, dismissNormReview,
}) => {
  if (!normChanges || normChanges.length === 0) return null;
  const acceptedCount = normChanges.filter(c => c.accepted).length;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 250, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => {
        // Backdrop click permanently rejects everything in the modal — confirm
        // before acting so an accidental click doesn't silently kill a batch
        // the user meant to accept.
        if (window.confirm("Skip normalization for these SKUs? They'll stay in their raw form and won't be reviewed again.")) {
          dismissNormReview();
        }
      }}
    >
      <div
        style={{ background: "#1E293B", borderRadius: 14, width: 700, maxHeight: "80vh", display: "flex", flexDirection: "column", border: "1px solid #3B82F6" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(59,130,246,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{"✎"}</div>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#F1F5F9" }}>Review New SKUs</h2>
            <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 2 }}>
              {normChanges.length} new SKU{normChanges.length !== 1 ? "s" : ""} · {acceptedCount} accepted · your decision is remembered for future uploads
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              style={{ background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
              onClick={() => setNormChanges(normChanges.map(c => ({ ...c, accepted: true })))}
            >Accept All</button>
            <button
              style={{ background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
              onClick={() => setNormChanges(normChanges.map(c => ({ ...c, accepted: false })))}
            >Reject All</button>
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "12px 20px", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #334155" }}>
                <th style={{ padding: "8px 10px", textAlign: "center", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase", width: 40 }}></th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>Original</th>
                <th style={{ padding: "8px 10px", textAlign: "center", color: "#6B7280", fontSize: 10, width: 30 }}></th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>Normalized</th>
                <th style={{ padding: "8px 10px", textAlign: "left", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>Found In</th>
              </tr>
            </thead>
            <tbody>
              {normChanges.map((c, i) => (
                <tr
                  key={i}
                  style={{
                    borderBottom: "1px solid #1E293B",
                    background: c.accepted ? "rgba(16,185,129,0.06)" : "transparent",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    const updated = [...normChanges];
                    updated[i] = { ...c, accepted: !c.accepted };
                    setNormChanges(updated);
                  }}
                >
                  <td style={{ padding: "8px 10px", textAlign: "center" }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center",
                      border: c.accepted ? "none" : "1px solid #475569",
                      background: c.accepted ? "#10B981" : "transparent",
                      color: "#fff", fontSize: 12, fontWeight: 700,
                    }}>{c.accepted ? "✓" : ""}</div>
                  </td>
                  <td style={{ padding: "8px 10px", color: "#FCA5A5", fontFamily: "monospace", fontSize: 11, textDecoration: c.accepted ? "line-through" : "none", opacity: c.accepted ? 0.6 : 1 }}>{c.original}</td>
                  <td style={{ padding: "8px 10px", textAlign: "center", color: "#475569" }}>→</td>
                  <td style={{ padding: "8px 10px", color: "#6EE7B7", fontFamily: "monospace", fontSize: 11 }}>{c.normalized}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <div style={{ display: "flex", gap: 4 }}>
                      {c.sources.map(s => (
                        <span key={s} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", fontSize: 9, color: "#94A3B8", textTransform: "uppercase" }}>{s}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "14px 20px", borderTop: "1px solid #334155", display: "flex", gap: 10 }}>
          <button
            style={{ flex: 1, background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
            onClick={() => dismissNormReview()}
          >Skip All — Keep Original</button>
          <button
            style={{ flex: 2, background: "#3B82F6", border: "none", color: "#fff", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 700 }}
            onClick={() => applyNormReview()}
          >Apply {acceptedCount} Change{acceptedCount !== 1 ? "s" : ""}</button>
        </div>
      </div>
    </div>
  );
};
