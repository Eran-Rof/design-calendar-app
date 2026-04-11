import React from "react";
import S from "../styles";

interface UploadModalProps {
  showUpload: boolean;
  setShowUpload: (v: boolean) => void;
  invFile: File | null;
  setInvFile: (v: File | null) => void;
  purFile: File | null;
  setPurFile: (v: File | null) => void;
  ordFile: File | null;
  setOrdFile: (v: File | null) => void;
  invRef: React.RefObject<HTMLInputElement>;
  purRef: React.RefObject<HTMLInputElement>;
  ordRef: React.RefObject<HTMLInputElement>;
  handleFileUpload: (inv: File, pur: File | null, ord: File) => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  showUpload, setShowUpload,
  invFile, setInvFile, purFile, setPurFile, ordFile, setOrdFile,
  invRef, ordRef, handleFileUpload,
}) => {
  if (!showUpload) return null;

  const slots: Array<{
    label: string; sub: string; key: string;
    file: File | null; setFile: (f: File | null) => void;
    ref: React.RefObject<HTMLInputElement>; color: string;
  }> = [
    { label: "Inventory Snapshot",  sub: "On-hand quantities by SKU",           key: "inv", file: invFile, setFile: setInvFile, ref: invRef, color: "#10B981" },
    // Purchased Items Report removed — PO data always comes from PO WIP
    { label: "All Orders Report",    sub: "Sales orders by ship date (outgoing)", key: "ord", file: ordFile, setFile: setOrdFile, ref: ordRef, color: "#F59E0B" },
  ];

  const canProcess = Boolean(invFile && ordFile);

  return (
    <div style={S.modalOverlay} onClick={() => setShowUpload(false)}>
      <div style={{ ...S.modal, width: 560 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>Upload Excel Files</h2>
          <button style={S.closeBtn} onClick={() => setShowUpload(false)}>✕</button>
        </div>
        <div style={S.modalBody}>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginBottom: 20 }}>
            Upload all three Xoro report exports to compute Available to Sell. All files are required before processing.
          </p>

          {slots.map(slot => (
            <div key={slot.key} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: slot.color, flexShrink: 0 }} />
                <span style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 13 }}>{slot.label}</span>
                <span style={{ color: "#6B7280", fontSize: 12 }}>{slot.sub}</span>
              </div>
              <div
                style={{
                  ...S.dropZone,
                  padding: "14px 16px",
                  borderColor: slot.file ? slot.color : "#334155",
                  background: slot.file ? `${slot.color}10` : "transparent",
                  display: "flex", alignItems: "center", gap: 12,
                }}
                onClick={() => slot.ref.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) slot.setFile(f);
                }}
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>{slot.file ? "✓" : "↑"}</span>
                {slot.file ? (
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={{ color: slot.color, fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{slot.file.name}</div>
                    <div style={{ color: "#6B7280", fontSize: 11 }}>{(slot.file.size / 1024).toFixed(0)} KB</div>
                  </div>
                ) : (
                  <div style={{ flex: 1 }}>
                    <div style={{ color: "#D1D5DB", fontSize: 13 }}>Drop file or click to browse</div>
                    <div style={{ color: "#475569", fontSize: 11 }}>.xlsx</div>
                  </div>
                )}
                {slot.file && (
                  <button
                    style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                    onClick={e => { e.stopPropagation(); slot.setFile(null); }}
                  >✕</button>
                )}
                <input
                  ref={slot.ref}
                  type="file"
                  accept=".xlsx,.xls"
                  style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) slot.setFile(f); }}
                />
              </div>
            </div>
          ))}

          <button
            style={{
              ...S.navBtnPrimary,
              width: "100%", justifyContent: "center", padding: "11px 0", marginTop: 8, fontSize: 14,
              opacity: canProcess ? 1 : 0.4,
              cursor: canProcess ? "pointer" : "not-allowed",
            }}
            disabled={!canProcess}
            onClick={() => {
              if (invFile && ordFile) {
                setShowUpload(false);
                handleFileUpload(invFile, purFile, ordFile);
              }
            }}
          >
            {canProcess ? `Process Files →${!purFile ? " (PO data from PO WIP)" : ""}` : `Select required files (${[invFile, ordFile].filter(Boolean).length}/2 ready)`}
          </button>
        </div>
      </div>
    </div>
  );
};
