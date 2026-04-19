// PO WIP-style toast. Bottom-center, ✓ for success / ✕ for error,
// auto-dismisses. The parent holds the message string in state and
// renders <Toast> once; this matches how src/TandA.tsx does it.

import { useEffect } from "react";

export type ToastKind = "success" | "error";

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
};

export default function Toast({ toast, onDismiss, autoDismissMs = 2400 }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [toast, autoDismissMs, onDismiss]);

  if (!toast) return null;
  const palette = COLORS[toast.kind];
  return (
    <div style={{
      position: "fixed",
      bottom: 32,
      left: "50%",
      transform: "translateX(-50%)",
      background: palette.bg,
      color: "#fff",
      padding: "12px 28px",
      borderRadius: 10,
      fontSize: 15,
      fontWeight: 700,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 400,
      pointerEvents: "none",
      maxWidth: "80vw",
    }}>
      {palette.icon} {toast.text}
    </div>
  );
}
