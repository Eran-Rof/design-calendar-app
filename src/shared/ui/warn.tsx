// src/shared/ui/warn.tsx
//
// Canonical warning surface for the Tangerine ERP — a single source of truth so
// every panel's feedback + confirmations look the same as ATS and PO-WIP (TandA)
// instead of raw browser alert()/confirm() dialogs.
//
//   notify(text, kind?)          — toast (reuses the shared <Toast>, identical to
//                                  ATS/TandA: bottom-center, success/error/info).
//   confirmDialog(message, opts) — styled confirm modal (matches TandA's
//                                  confirmModal look: icon + title + colored
//                                  action button). Returns Promise<boolean>.
//   <WarnHost />                 — renders the toast + modal; mount ONCE at the
//                                  Tangerine root.
//
// Singleton store (react-hot-toast style) so any panel — or a nested sub-modal,
// or a plain async helper — can call notify()/confirmDialog() without threading
// state/props. One toast and one confirm at a time (latest wins), matching the
// existing single-toast behaviour in ATS/TandA.

import { useSyncExternalStore } from "react";
import Toast, { type ToastKind, type ToastMessage } from "./Toast";

export type { ToastKind };

export interface ConfirmOptions {
  title?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
  confirmColor?: string;
  /** Force the destructive (red) treatment regardless of the message text. */
  danger?: boolean;
  /** Optional list of items rendered in a scrollable monospace block (e.g. affected codes). */
  listItems?: string[];
}

interface ConfirmRequest extends Required<Pick<ConfirmOptions, "title" | "icon" | "confirmText" | "cancelText" | "confirmColor">> {
  message: string;
  listItems?: string[];
  resolve: (ok: boolean) => void;
}

interface WarnState {
  toast: ToastMessage | null;
  confirm: ConfirmRequest | null;
}

// ─── store ───────────────────────────────────────────────────────────────────
let state: WarnState = { toast: null, confirm: null };
const listeners = new Set<() => void>();

function emit() {
  // new object identity so useSyncExternalStore re-renders
  state = { ...state };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function getSnapshot() {
  return state;
}

// ─── public API ────────────────────────────────────────────────────────────--
/** Show a toast. `kind` defaults to "info". Mirrors ATS/TandA setToast(...). */
export function notify(text: string, kind: ToastKind = "info") {
  state.toast = { text, kind };
  emit();
}

const DANGER_RE = /^\s*(delete|remove|void|cancel|archive|disable|deactivate|inactivate|reopen|hard-close|soft-delete|unmatch|unapply|reverse|permanently)/i;

/**
 * Styled confirm. Resolves true on confirm, false on cancel / overlay / escape.
 * Destructive-sounding messages auto-get the red treatment unless overridden.
 *
 *   if (!(await confirmDialog("Delete account 6000?"))) return;
 */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const danger = opts.danger ?? DANGER_RE.test(message);
  return new Promise<boolean>((resolve) => {
    state.confirm = {
      message,
      title: opts.title ?? (danger ? "Please confirm" : "Confirm"),
      icon: opts.icon ?? (danger ? "⚠️" : "❓"),
      confirmText: opts.confirmText ?? (danger ? "Confirm" : "OK"),
      cancelText: opts.cancelText ?? "Cancel",
      confirmColor: opts.confirmColor ?? (danger ? "#EF4444" : "#3B82F6"),
      listItems: opts.listItems,
      resolve,
    };
    emit();
  });
}

// ─── host component ────────────────────────────────────────────────────────--
export function WarnHost() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const closeConfirm = (ok: boolean) => {
    s.confirm?.resolve(ok);
    state.confirm = null;
    emit();
  };

  return (
    <>
      <Toast toast={s.toast} onDismiss={() => { state.toast = null; emit(); }} />
      {s.confirm && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => closeConfirm(false)}
        >
          <div
            style={{ background: "#1E293B", borderRadius: 16, width: 420, maxWidth: "92vw", border: `1px solid ${s.confirm.confirmColor}44`, boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ background: `${s.confirm.confirmColor}15`, padding: "20px 24px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `${s.confirm.confirmColor}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{s.confirm.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#F1F5F9" }}>{s.confirm.title}</div>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <p style={{ color: "#D1D5DB", fontSize: 14, margin: "0 0 12px", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{s.confirm.message}</p>
              {s.confirm.listItems && s.confirm.listItems.length > 0 && (
                <div style={{ background: "#0F172A", borderRadius: 8, padding: "8px 12px", marginBottom: 16, maxHeight: 160, overflowY: "auto" }}>
                  {s.confirm.listItems.map((item) => (
                    <div key={item} style={{ fontSize: 12, color: "#60A5FA", fontFamily: "monospace", padding: "2px 0", borderBottom: "1px solid #1E293B" }}>{item}</div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: s.confirm.listItems ? 0 : 8 }}>
                <button
                  onClick={() => closeConfirm(false)}
                  style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}
                >
                  {s.confirm.cancelText}
                </button>
                <button
                  onClick={() => closeConfirm(true)}
                  style={{ flex: 1, padding: "10px 20px", borderRadius: 8, border: "none", background: `linear-gradient(135deg, ${s.confirm.confirmColor}, ${s.confirm.confirmColor}CC)`, color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700 }}
                >
                  {s.confirm.confirmText}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
