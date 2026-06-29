import React from "react";
import S from "../styles";
import SharedToast from "../../shared/ui/Toast";
import OpStatusOverlay from "../../shared/ui/OpStatusOverlay";

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
    <OpStatusOverlay
      label="Uploading…"
      message={uploadProgress.step}
      pct={uploadProgress.pct}
      onCancel={cancelUpload}
      canCancel
      cancelLabel="Cancel Upload"
    />
  );
};

// Adapter over the shared Toast so callers keep the legacy
// (uploadSuccess, setUploadSuccess) shape — the underlying state
// in atsTypes is still `uploadSuccess: string | null`. Visual is
// now the shared bright-green toast (matches planning + tanda).
// The 6-second auto-dismiss in useExcelUpload still drives final
// removal; passing kind="success" makes the toast click-dismissable
// in case the user wants to clear it sooner.
interface SuccessToastProps {
  uploadSuccess: string | null;
  setUploadSuccess: (v: string | null) => void;
}

export const SuccessToast: React.FC<SuccessToastProps> = ({ uploadSuccess, setUploadSuccess }) => (
  <SharedToast
    toast={uploadSuccess ? { text: uploadSuccess, kind: "success" } : null}
    onDismiss={() => setUploadSuccess(null)}
  />
);

interface UploadErrorModalProps {
  uploadError: string | null;
  setUploadError: (v: string | null) => void;
}

export const UploadErrorModal: React.FC<UploadErrorModalProps> = ({ uploadError, setUploadError }) => {
  if (!uploadError) return null;
  return (
    <div style={S.modalOverlay} onClick={() => setUploadError(null)}>
      <div style={{ ...S.modal, width: "min(440px, 95vw)", border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
        <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
