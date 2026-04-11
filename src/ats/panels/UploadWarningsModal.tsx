import React from "react";
import S from "../styles";
import type { ExcelData, UploadWarning } from "../types";

interface UploadWarningsModalProps {
  uploadWarnings: UploadWarning[] | null;
  pendingUploadData: ExcelData | null;
  saveUploadData: (data: ExcelData) => void;
  setUploadWarnings: (v: UploadWarning[] | null) => void;
  setPendingUploadData: (v: ExcelData | null) => void;
}

export const UploadWarningsModal: React.FC<UploadWarningsModalProps> = ({
  uploadWarnings, pendingUploadData, saveUploadData, setUploadWarnings, setPendingUploadData,
}) => {
  if (!uploadWarnings || !pendingUploadData) return null;

  return (
    <div style={S.modalOverlay}>
      <div style={{ ...S.modal, width: 560, border: "1px solid #F59E0B" }} onClick={e => e.stopPropagation()}>
        <div style={{ ...S.modalHeader, borderBottom: "1px solid #78350f" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(245,158,11,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚠</div>
            <div>
              <h2 style={{ ...S.modalTitle, color: "#FCD34D", margin: 0 }}>Review Data Issues</h2>
              <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 2 }}>
                {pendingUploadData.skus.length.toLocaleString()} SKUs · {pendingUploadData.pos.length.toLocaleString()} PO lines · {pendingUploadData.sos.length.toLocaleString()} SO lines parsed
              </div>
            </div>
          </div>
        </div>
        <div style={S.modalBody}>
          <p style={{ color: "#CBD5E1", fontSize: 13, marginBottom: 16 }}>
            The following issues were found in your files. Review them before deciding whether to proceed.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
            {uploadWarnings.map((w, i) => (
              <div key={i} style={{
                background: w.severity === "error" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                border: `1px solid ${w.severity === "error" ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
                borderRadius: 8, padding: "10px 14px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14 }}>{w.severity === "error" ? "✗" : "△"}</span>
                  <span style={{ color: w.severity === "error" ? "#FCA5A5" : "#FCD34D", fontWeight: 700, fontSize: 13 }}>{w.field}</span>
                  <span style={{ marginLeft: "auto", color: w.severity === "error" ? "#FCA5A5" : "#FCD34D", fontFamily: "monospace", fontSize: 12, fontWeight: 700 }}>
                    {w.affected.toLocaleString()} / {w.total.toLocaleString()}
                  </span>
                </div>
                <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.5, paddingLeft: 22 }}>{w.message}</div>
              </div>
            ))}
          </div>
          {pendingUploadData.columnNames && (
            <details style={{ marginBottom: 18 }}>
              <summary style={{ color: "#60A5FA", fontSize: 12, cursor: "pointer", userSelect: "none" }}>
                Show detected column names (click to expand)
              </summary>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {(["purchases", "orders"] as const).map(file => (
                  <div key={file} style={{ background: "#0F172A", borderRadius: 6, padding: "8px 12px", border: "1px solid #334155" }}>
                    <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontWeight: 600 }}>
                      {file === "purchases" ? "Purchases (PO) file" : "Orders (SO) file"}
                    </div>
                    <div style={{ color: "#94A3B8", fontSize: 11, fontFamily: "monospace", lineHeight: 1.8 }}>
                      {pendingUploadData.columnNames![file].join(" · ")}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              style={{ flex: 1, background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
              onClick={() => { setUploadWarnings(null); setPendingUploadData(null); }}
            >
              Cancel — Go Back
            </button>
            <button
              style={{ flex: 2, background: "#F59E0B", border: "none", color: "#0F172A", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 700 }}
              onClick={() => saveUploadData(pendingUploadData)}
            >
              Upload Anyway
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
