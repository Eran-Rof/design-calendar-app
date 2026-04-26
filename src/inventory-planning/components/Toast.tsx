// PO WIP-style toast. Bottom-center, ✓ for success / ✕ for error,
// auto-dismisses. The parent holds the message string in state and
// renders <Toast> once; this matches how src/TandA.tsx does it.

import { useEffect } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  text: string;
  kind: ToastKind;
}

export interface ToastProps {
  toast: ToastMessage | null;
  onDismiss: () => void;
  // Auto-dismiss after this many ms. Mirrors TandA's 2000ms default.
  autoDismissMs?: number;
}

const COLORS: Record<ToastKind, { bg: string; icon: string }> = {
  success: { bg: "#10B981", icon: "✓" },
  error:   { bg: "#EF4444", icon: "!" },
  info:    { bg: "#3B82F6", icon: "i" },
};

export default function Toast({ toast, onDismiss, autoDismissMs = 2000 }: ToastProps) {
  // Final-state messages (success/error/contains "DONE") stay until
  // the planner clicks to dismiss — these carry totals worth reading.
  // Transient info toasts dismiss in 2s as before.
  const isFinalState = toast?.kind === "success" || toast?.kind === "error" || (toast?.text ?? "").includes("DONE");
  useEffect(() => {
    if (!toast) return;
    if (isFinalState) return; // sticky until click
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [toast, isFinalState, autoDismissMs, onDismiss]);

  if (!toast) return null;
  const palette = COLORS[toast.kind];
  return (
    <div
      onClick={onDismiss}
      title={isFinalState ? "Click to dismiss" : ""}
      style={{
        position: "fixed",
        bottom: 32,
        left: "50%",
        transform: "translateX(-50%)",
        background: palette.bg,
        color: "#fff",
        padding: "12px 20px 12px 28px",
        borderRadius: 10,
        fontSize: 15,
        fontWeight: 700,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        zIndex: 400,
        cursor: "pointer",
        maxWidth: "80vw",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ flex: 1 }}>{palette.icon} {toast.text}</span>
      {isFinalState && (
        <span
          aria-label="Dismiss"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 4,
            background: "rgba(255,255,255,0.15)",
            fontSize: 14,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ✕
        </span>
      )}
    </div>
  );
}
