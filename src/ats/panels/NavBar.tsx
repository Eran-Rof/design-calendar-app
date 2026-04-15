import React from "react";
import S from "../styles";
import type { ATSRow } from "../types";

interface NavBarProps {
  mergeHistory: Array<{ fromSku: string; toSku: string }>;
  undoLastMerge: () => void;
  clearAllAtsData: () => Promise<void>;
  onNavigateHome: () => Promise<void>;
  setShowUpload: (v: boolean) => void;
  uploadingFile: boolean;
  invFile: File | null;
  purFile: File | null;
  ordFile: File | null;
  exportToExcel: (rows: ATSRow[], periods: Array<{ endDate: string; label: string }>, atShip: boolean) => void;
  filtered: ATSRow[];
  displayPeriods: Array<{ endDate: string; label: string }>;
  atShip: boolean;
  onNegInven: () => void;
}

export const NavBar: React.FC<NavBarProps> = ({
  mergeHistory, undoLastMerge, clearAllAtsData, onNavigateHome, setShowUpload,
  uploadingFile, invFile, purFile, ordFile,
  exportToExcel, filtered, displayPeriods, atShip, onNegInven,
}) => (
  <nav style={S.nav}>
    <div style={S.navLeft}>
      <div style={S.navLogo}>ATS</div>
      <span style={S.navTitle}>ATS Report</span>
      <span style={S.navSub}>Available to Sell</span>
    </div>
    <div style={S.navRight}>
      {mergeHistory?.length > 0 && (
        <button
          style={{ ...S.navBtn, background: "#7C3AED", border: "1px solid #5B21B6", color: "#fff", fontWeight: 600 }}
          title={`Undo merge: ${mergeHistory[mergeHistory.length - 1]?.fromSku} → ${mergeHistory[mergeHistory.length - 1]?.toSku}`}
          onClick={undoLastMerge}
        >
          ↩ Undo Merge ({mergeHistory.length})
        </button>
      )}
      <button
        style={{ ...S.navBtn, background: "#7F1D1D", border: "1px solid #991B1B", color: "#FCA5A5", fontWeight: 600 }}
        onClick={async () => {
          if (window.confirm("Delete ALL uploaded ATS data (Excel, PO, merges) and start fresh?\n\nThis cannot be undone.")) {
            await clearAllAtsData();
          }
        }}
      >
        🗑 Clear Data
      </button>
      <button style={S.navBtn} onClick={() => setShowUpload(true)} disabled={uploadingFile}>
        {uploadingFile ? "Uploading…" : "Upload Excel"}
        {!uploadingFile && (invFile || purFile || ordFile) && (
          <span style={{ marginLeft: 6, background: "#10B981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
            {[invFile, ordFile].filter(Boolean).length}/2{purFile ? "+PO" : ""}
          </span>
        )}
      </button>
      <button
        style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}
        onClick={() => exportToExcel(filtered, displayPeriods.map(p => ({ endDate: p.endDate, label: p.label })), atShip)}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#1D6F42" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
        </svg>
        Export Excel
      </button>
      <button
        style={{ ...S.navBtn, background: "#7F1D1D", border: "1px solid #991B1B", color: "#FCA5A5", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}
        onClick={onNegInven}
        title="Select Neg ATS filter and download Neg Inventory report"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#991B1B" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="#FCA5A5" />
        </svg>
        Neg Inven
      </button>
      <button style={{ ...S.navBtn, cursor: "pointer" }} onClick={onNavigateHome}>← PLM Home</button>
    </div>
  </nav>
);

interface SyncProgressBannerProps {
  syncProgress: { step: string; pct: number; log: string[] } | null;
}

export const SyncProgressBanner: React.FC<SyncProgressBannerProps> = ({ syncProgress }) => {
  if (!syncProgress) return null;
  return (
    <div style={{ background: "#1E293B", borderBottom: "1px solid #334155", padding: "12px 24px" }}>
      <div style={{ maxWidth: 1600, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: "#F1F5F9", fontWeight: 600 }}>{syncProgress.step}</span>
          <span style={{ fontSize: 12, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{syncProgress.pct}%</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "#0F172A", overflow: "hidden", marginBottom: 8 }}>
          <div style={{ width: `${syncProgress.pct}%`, height: "100%", background: syncProgress.pct === 100 ? "linear-gradient(90deg, #6EE7B7, #047857)" : "linear-gradient(90deg, #93C5FD, #1D4ED8)", borderRadius: 4, transition: "width 0.3s" }} />
        </div>
        {syncProgress.log.length > 0 && (
          <div style={{ maxHeight: 120, overflowY: "auto", background: "#0F172A", borderRadius: 6, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", color: "#94A3B8", lineHeight: 1.6 }}>
            {syncProgress.log.map((l, i) => (
              <div key={i} style={{ color: l.includes("ERROR") ? "#EF4444" : l.includes("✅") ? "#10B981" : l.includes("FAILED") ? "#F59E0B" : "#94A3B8" }}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
