import React from "react";
import S from "../styles";

// A collection of small notification/feedback overlays that all render
// conditionally and share no state. Grouped here rather than one file each
// because each is tiny and the grouping is stable.

interface UploadProgressOverlayProps {
  uploadProgress: { step: string; pct: number } | null;
  cancelUpload: () => void;
}

export const UploadProgressOverlay: React.FC<UploadProgressOverlayProps> = ({ uploadProgress, cancelUpload }) => {
  if (!uploadProgress) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#1E293B", borderRadius: 14, padding: "28px 32px", width: 380, border: "1px solid #334155" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: "#F1F5F9", marginBottom: 8 }}>Uploading…</div>
        <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 20 }}>{uploadProgress.step}</div>
        <div style={{ background: "#0F172A", borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ height: "100%", borderRadius: 8, background: "linear-gradient(90deg,#10B981,#3B82F6)", width: `${uploadProgress.pct}%`, transition: "width 0.4s ease" }} />
        </div>
        <button
          style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
          onClick={cancelUpload}
        >
          Cancel Upload
        </button>
      </div>
    </div>
  );
};

interface SuccessToastProps {
  uploadSuccess: string | null;
  setUploadSuccess: (v: string | null) => void;
}

export const SuccessToast: React.FC<SuccessToastProps> = ({ uploadSuccess, setUploadSuccess }) => {
  if (!uploadSuccess) return null;
  return (
    <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", background: "#064e3b", border: "1px solid #10B981", borderRadius: 10, padding: "12px 24px", color: "#6ee7b7", fontSize: 14, fontWeight: 600, zIndex: 300, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 4px 24px rgba(0,0,0,0.4)" }}>
      <span style={{ fontSize: 18 }}>✓</span>
      {uploadSuccess}
      <button style={{ background: "none", border: "none", color: "#6ee7b7", cursor: "pointer", fontSize: 16, marginLeft: 8 }} onClick={() => setUploadSuccess(null)}>✕</button>
    </div>
  );
};

interface SyncErrorModalProps {
  syncError: { title: string; detail: string } | null;
  setSyncError: (v: { title: string; detail: string } | null) => void;
}

export const SyncErrorModal: React.FC<SyncErrorModalProps> = ({ syncError, setSyncError }) => {
  if (!syncError) return null;
  return (
    <div style={S.modalOverlay} onClick={() => setSyncError(null)}>
      <div style={{ ...S.modal, width: 460, border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
        <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚠</div>
            <h2 style={{ ...S.modalTitle, color: "#FCA5A5" }}>{syncError.title}</h2>
          </div>
          <button style={S.closeBtn} onClick={() => setSyncError(null)}>✕</button>
        </div>
        <div style={{ ...S.modalBody, paddingTop: 20 }}>
          <p style={{ color: "#F1F5F9", fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
            {syncError.detail}
          </p>
          <div style={{ background: "#0F172A", borderRadius: 8, padding: "10px 14px", marginBottom: 20, border: "1px solid #334155" }}>
            <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 600 }}>What to check</div>
            <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.8 }}>
              • Verify <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>VITE_XORO_API_KEY</span> and <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>VITE_XORO_API_SECRET</span> are set in Vercel<br />
              • Confirm Xoro API access is enabled for your account<br />
              • Check the browser console for the full error trace
            </div>
          </div>
          <button
            style={{ ...S.navBtnPrimary, width: "100%", justifyContent: "center", padding: "10px 0" }}
            onClick={() => setSyncError(null)}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};

interface UploadErrorModalProps {
  uploadError: string | null;
  setUploadError: (v: string | null) => void;
}

export const UploadErrorModal: React.FC<UploadErrorModalProps> = ({ uploadError, setUploadError }) => {
  if (!uploadError) return null;
  return (
    <div style={S.modalOverlay} onClick={() => setUploadError(null)}>
      <div style={{ ...S.modal, width: 440, border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
        <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚠</div>
            <h2 style={{ ...S.modalTitle, color: "#FCA5A5" }}>Upload Failed</h2>
          </div>
          <button style={S.closeBtn} onClick={() => setUploadError(null)}>✕</button>
        </div>
        <div style={{ ...S.modalBody, paddingTop: 20 }}>
          <p style={{ color: "#F1F5F9", fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>{uploadError}</p>
          <button style={{ ...S.navBtnPrimary, width: "100%", justifyContent: "center", padding: "10px 0" }} onClick={() => setUploadError(null)}>Dismiss</button>
        </div>
      </div>
    </div>
  );
};
