import React from "react";
import S from "../styles";

// A collection of small notification/feedback overlays that all render
// conditionally and share no state. Grouped here rather than one file each
// because each is tiny and the grouping is stable.

// Centered progress overlay for the live Xoro Open-SOs sync. Mirrors the
// UploadProgressOverlay format intentionally — same modal frame, same
// 10px gradient bar, same width — so the sync states across the app
// read as one consistent pattern. Bar is driven by pages walked (the
// only reliable denominator); records downloaded is shown standalone
// because Xoro silently caps the actual page size below per_page so
// totalPages × per_page over-states the true row count.
export interface XoroSyncProgress {
  step: string;
  pct: number;            // 0-100, indeterminate until saturation detected
  downloaded: number;     // unique SOs accumulated so far
  pagesDone: number;      // pages actually walked (independent of Xoro's TotalPages)
  totalPages: number;     // 0 = unknown (we no longer trust Xoro's TotalPages)
  // Multi-pass state. pass=1 is the initial walk; pass>1 means we're
  // retrying just the pages that failed in earlier passes.
  pass?: number;
  maxPasses?: number;
  retryingCount?: number;
  // Saturation-walk metrics. duplicatesSeen = SOs we re-encountered
  // (Xoro's pagination overlaps so we routinely re-fetch SOs we've
  // already got). Surfacing it makes the long sync feel less stalled
  // — the user can see "we just walked page 32 and got 0 new SOs,
  // sync is converging".
  duplicatesSeen?: number;
}

interface XoroSyncOverlayProps {
  progress: XoroSyncProgress | null;
  onCancel: () => void;
}

export const XoroSyncOverlay: React.FC<XoroSyncOverlayProps> = ({ progress, onCancel }) => {
  if (!progress) return null;
  // Saturation-walk display: we no longer know totalPages reliably, so
  // we show pages-walked and (where useful) duplicates skipped, which
  // tells the user the walk is converging toward 100% rather than just
  // grinding away aimlessly.
  const pageLabel = progress.totalPages > 0
    ? `Page ${progress.pagesDone} of ${progress.totalPages}`
    : progress.pagesDone > 0
      ? `${progress.pagesDone} page${progress.pagesDone === 1 ? "" : "s"} walked${progress.duplicatesSeen ? ` · ${progress.duplicatesSeen.toLocaleString()} duplicates skipped` : ""}`
      : "Walking…";
  const showPassHeader = (progress.pass ?? 1) > 1;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#1E293B", borderRadius: 14, padding: "28px 32px", width: 420, border: "1px solid #334155" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: "#F1F5F9", marginBottom: 8 }}>Syncing Open SOs from Xoro…</div>
        {showPassHeader && (
          <div style={{ fontSize: 12, color: "#FBBF24", fontWeight: 600, marginBottom: 6 }}>
            Pass {progress.pass} of {progress.maxPasses} — retrying {progress.retryingCount} page{progress.retryingCount === 1 ? "" : "s"}
          </div>
        )}
        <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 20 }}>{progress.step}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: "#60A5FA" }}>
            {progress.downloaded.toLocaleString()} <span style={{ color: "#64748B", fontSize: 13, fontWeight: 500 }}>SOs downloaded</span>
          </span>
          <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: "#94A3B8" }}>{pageLabel}</span>
        </div>
        <div style={{ background: "#0F172A", borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20 }}>
          <div style={{ height: "100%", borderRadius: 8, background: "linear-gradient(90deg,#0EA5E9,#3B82F6)", width: `${progress.pct}%`, transition: "width 0.3s ease" }} />
        </div>
        <button
          style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
          onClick={onCancel}
        >
          Cancel Sync
        </button>
      </div>
    </div>
  );
};

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
