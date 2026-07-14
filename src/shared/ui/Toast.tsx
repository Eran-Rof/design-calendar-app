// Bottom-center toast — single source of truth for ATS, planning,
// and tanda (PO WIP). Originally lived in
// src/inventory-planning/components/Toast.tsx; that file is now a
// thin re-export shim, and ATS / tanda were flipped from their own
// inline implementations.
//
// Usage pattern (matches the planning workbench):
//   const [toast, setToast] = useState<ToastMessage | null>(null);
//   ...
//   setToast({ text: "Saved 12 rows", kind: "success" });
//   ...
//   <Toast toast={toast} onDismiss={() => setToast(null)} />
//
// Sticky policy:
//   - explicit sticky=true / false from the caller wins
//   - otherwise success / error → sticky (click to dismiss),
//                  info → auto-dismiss after autoDismissMs
//
// For legacy `string | null` state shapes (ATS, tanda), wrap at the
// render site:
//   <Toast toast={msg ? { text: msg, kind: "success" } : null}
//          onDismiss={() => setMsg(null)} />

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
  // Optional action button rendered inside the toast (e.g. "Show them").
  // Clicking it fires onClick but does NOT dismiss the toast (dismiss is
  // the ✕ / body click). A toast carrying an action is sticky by default
  // so the button stays available.
  action?: { label: string; onClick: () => void };
}

export interface ToastProps {
  toast: ToastMessage | null;
  onDismiss: () => void;
  // Auto-dismiss after this many ms. Mirrors planning's 2000ms default.
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
  const isFinalState = toast?.sticky ?? (toast?.kind === "success" || toast?.kind === "error" || !!toast?.action);
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
      {toast.action && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toast.action!.onClick(); }}
          style={{
            flexShrink: 0,
            border: "1px solid rgba(255,255,255,0.6)",
            background: "rgba(255,255,255,0.15)",
            color: "#fff",
            fontWeight: 700,
            fontSize: 13,
            padding: "5px 12px",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {toast.action.label}
        </button>
      )}
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
