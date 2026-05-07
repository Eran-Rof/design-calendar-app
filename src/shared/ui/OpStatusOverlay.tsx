// Centered modal overlay for long-running operations. Single shell
// for "we're doing X, here's what step we're on, here's how to cancel".
// Used by:
//   - planning's OperationStatusBar (indeterminate — no known total)
//   - ATS's UploadProgressOverlay (determinate — pct from upload step)
//   - ATS's XoroSyncOverlay (determinate + extra caption + top banner
//     for multi-pass retry headers; routes through the same shell via
//     the `caption` and `topBanner` slots)
//
// Visual: dark backdrop, slate panel (#1E293B), 14px-rounded card,
// gradient progress bar (green→blue, matches the brand gradient).
// Indeterminate mode renders an animated translateX stripe (compositor-
// only, so it keeps moving while the JS main thread is busy parsing
// a big XLSX or running a sync loop).

import type { ReactNode } from "react";

export interface OpStatusOverlayProps {
  // Short title (e.g. "Sales upload", "Syncing Open SOs from Xoro…").
  label: string;
  // Detail line below label. Falls back to "Working…" when blank.
  message?: string | null;
  // 0–100 for determinate progress. Omit for indeterminate (animated
  // stripe — used when no total is known up-front, e.g. saturation
  // walks or single-shot Excel parse).
  pct?: number;
  // Optional caption rendered between message and bar — e.g. XoroSync's
  // "12,348 SOs downloaded · Page 5 of 32".
  caption?: ReactNode;
  // Optional banner above the message — e.g. XoroSync's "Pass 2 of 3
  // — retrying 4 pages" header.
  topBanner?: ReactNode;
  // Cancel handler. When provided, button renders. canCancel toggles
  // the visual: red border = "this stops + reverts work", muted = "this
  // hides the modal but the work keeps going in the background".
  onCancel?: () => void;
  canCancel?: boolean;
  // Override the button label. Defaults: "Stop" (canCancel) / "Hide".
  cancelLabel?: string;
  // Optional width override (default 380). XoroSync uses 420 because
  // it shows more detail text.
  width?: number;
}

const PANEL_BG = "#1E293B";
const PANEL_BORDER = "#334155";
const TRACK_BG = "#0F172A";
const TEXT = "#F1F5F9";
const TEXT_MUTED = "#94A3B8";
const BAR_GRADIENT = "linear-gradient(90deg,#10B981,#3B82F6)"; // brand green→blue
const RED = "#EF4444";

export default function OpStatusOverlay({
  label,
  message,
  pct,
  caption,
  topBanner,
  onCancel,
  canCancel,
  cancelLabel,
  width = 380,
}: OpStatusOverlayProps) {
  const isIndeterminate = pct == null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: PANEL_BG, borderRadius: 14, padding: "28px 32px", width, maxWidth: "92vw", border: `1px solid ${PANEL_BORDER}`, boxSizing: "border-box" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: TEXT, marginBottom: 8 }}>{label}</div>
        {topBanner}
        <div style={{ fontSize: 13, color: TEXT_MUTED, marginBottom: caption ? 12 : 20, minHeight: 18, wordBreak: "break-word" as const }}>
          {message ?? "Working…"}
        </div>
        {caption && (
          <div style={{ marginBottom: 8 }}>{caption}</div>
        )}
        <div style={{ background: TRACK_BG, borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20, position: "relative", border: `1px solid ${PANEL_BORDER}` }}>
          {isIndeterminate ? (
            // Compositor-only animation — keeps moving while JS is busy.
            <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "35%", borderRadius: 8, background: BAR_GRADIENT, animation: "opStatusPulse 1.4s ease-in-out infinite", willChange: "transform" }} />
          ) : (
            <div style={{ height: "100%", borderRadius: 8, background: BAR_GRADIENT, width: `${Math.max(0, Math.min(100, pct))}%`, transition: "width 0.4s ease" }} />
          )}
        </div>
        {isIndeterminate && (
          <style>{`@keyframes opStatusPulse { 0% { transform: translateX(-100%); } 100% { transform: translateX(380%); } }`}</style>
        )}
        {onCancel && (
          <button
            style={{ background: "none", border: `1px solid ${canCancel ? RED : PANEL_BORDER}`, color: canCancel ? RED : TEXT_MUTED, borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
            onClick={onCancel}
            title={canCancel ? "Stop this and put things back the way they were" : "Hide this — work keeps going"}
          >
            {cancelLabel ?? (canCancel ? "Stop" : "Hide")}
          </button>
        )}
      </div>
    </div>
  );
}
