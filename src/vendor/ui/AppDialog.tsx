// Imperative, promise-based replacement for window.alert / window.confirm.
// Renders a centered modal styled to match the vendor portal theme so
// users stop getting the browser's stock chrome on top of our UI.
//
// Usage:
//   await showAlert({ title: "Error", message: "Download failed", tone: "danger" });
//   const ok = await showConfirm({ title: "Discard?", message: "...", confirmLabel: "Discard" });

import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { TH } from "../theme";

// showFileViewer moved to src/utils/fileViewer so every app can use it.
// Re-exported here for backwards-compat with existing vendor imports.
export { showFileViewer } from "../../utils/fileViewer";

type Tone = "info" | "danger" | "warn" | "success";

interface DialogOpts {
  title?: string;
  message: ReactNode;
  tone?: Tone;
  confirmLabel?: string;
  cancelLabel?: string;
}

let mount: HTMLDivElement | null = null;
let root: Root | null = null;

function ensureMount(): Root {
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "app-dialog-root";
    document.body.appendChild(mount);
  }
  if (!root) root = createRoot(mount);
  return root;
}

function close() {
  if (root) root.render(null);
}

function toneColors(tone: Tone): { header: string; bar: string } {
  switch (tone) {
    case "danger":  return { header: "#B91C1C", bar: "#FCA5A5" };
    case "warn":    return { header: "#92400E", bar: "#FCD34D" };
    case "success": return { header: "#047857", bar: "#6EE7B7" };
    default:        return { header: TH.primary, bar: TH.primaryLt };
  }
}

function DialogView({
  opts, onOk, onCancel,
}: {
  opts: DialogOpts;
  onOk: () => void;
  onCancel: (() => void) | null;
}) {
  const t = opts.tone || "info";
  const { header, bar } = toneColors(t);
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(15, 23, 42, 0.55)",
      }}
      onClick={(e) => { if (onCancel && e.currentTarget === e.target) onCancel(); }}
    >
      <div style={{
        width: "min(520px, calc(100vw - 32px))",
        background: TH.surface,
        border: `1px solid ${TH.border}`,
        borderTop: `4px solid ${bar}`,
        borderRadius: 10,
        boxShadow: `0 12px 40px ${TH.shadowMd || "rgba(0,0,0,0.3)"}`,
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}>
        {opts.title && (
          <div style={{ padding: "14px 20px 10px", fontSize: 15, fontWeight: 700, color: header }}>
            {opts.title}
          </div>
        )}
        <div style={{
          padding: opts.title ? "0 20px 16px" : "18px 20px 16px",
          fontSize: 13, color: TH.text, lineHeight: 1.45, whiteSpace: "pre-wrap",
        }}>
          {opts.message}
        </div>
        <div style={{
          padding: "12px 20px", background: TH.surfaceHi,
          borderTop: `1px solid ${TH.border}`,
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: "7px 16px", borderRadius: 6,
                border: `1px solid ${TH.border}`,
                background: "none", color: TH.text,
                cursor: "pointer", fontSize: 13, fontFamily: "inherit",
              }}
            >
              {opts.cancelLabel || "Cancel"}
            </button>
          )}
          <button
            type="button"
            onClick={onOk}
            autoFocus
            style={{
              padding: "7px 18px", borderRadius: 6, border: "none",
              background: t === "danger" ? "#B91C1C" : TH.primary,
              color: "#FFFFFF", cursor: "pointer",
              fontSize: 13, fontWeight: 600, fontFamily: "inherit",
            }}
          >
            {opts.confirmLabel || "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function showAlert(opts: DialogOpts): Promise<void> {
  return new Promise((resolve) => {
    ensureMount().render(
      <DialogView
        opts={{ ...opts, cancelLabel: undefined }}
        onOk={() => { close(); resolve(); }}
        onCancel={null}
      />,
    );
  });
}

export function showConfirm(opts: DialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    ensureMount().render(
      <DialogView
        opts={opts}
        onOk={() => { close(); resolve(true); }}
        onCancel={() => { close(); resolve(false); }}
      />,
    );
  });
}

