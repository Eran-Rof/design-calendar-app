// PO WIP-style toast. Bottom-center, ✓ for success / ✕ for error,
// auto-dismisses. The parent holds the message string in state and
// renders <Toast> once; this matches how src/TandA.tsx does it.

import { useEffect } from "react";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  text: string;
  kind: ToastKind;
  // Optional explicit sticky flag — overrides the kind-based default.
  // Set true on info-kind messages that carry final totals worth
  // reading (e.g. an info-result with row counts) so the toast doesn't
  // auto-dismiss in 2s. Set false on success/error messages that are
  // just confirmations and should auto-dismiss like info toasts.
  sticky?: boolean;
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
  // Sticky toasts stay open until clicked. Default policy:
  //   - explicit sticky=true / false from the caller wins
  //   - otherwise success/error → sticky, info → auto-dismiss
  // The previous "(text contains DONE)" heuristic was retired — too
  // easy for an unrelated message containing the substring "DONE" to
  // become unintentionally sticky. Callers that want a sticky info
  // toast should set { kind: "info", sticky: true } explicitly.
  const isFinalState = toast?.sticky ?? (toast?.kind === "success" || toast?.kind === "error");
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
