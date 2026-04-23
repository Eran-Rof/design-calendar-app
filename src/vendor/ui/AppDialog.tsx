// Imperative, promise-based replacement for window.alert / window.confirm.
// Renders a centered modal styled to match the vendor portal theme so
// users stop getting the browser's stock chrome on top of our UI.
//
// Usage:
//   await showAlert({ title: "Error", message: "Download failed", tone: "danger" });
//   const ok = await showConfirm({ title: "Discard?", message: "...", confirmLabel: "Discard" });

import { createRoot, type Root } from "react-dom/client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TH } from "../theme";

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

// Office-like preview — renders the file through Microsoft's public
// Office Online viewer (view.officeapps.live.com). MS's server fetches
// the signed URL and returns an iframe that looks like real Excel /
// Word / PowerPoint, preserving fonts, colors, conditional formatting
// and cell merges that SheetJS community strips.
//
// Requires the URL to be publicly fetchable (HTTPS, no auth wall). Our
// Supabase signed URLs satisfy that while the token is valid.
//
// MS sometimes fails to load a file (rate limiting, unsupported
// variant). After a timeout we switch the iframe to Google Docs
// Viewer which provides an independent preview backend.
function OfficePreview({ signedUrl, filename }: { signedUrl: string; filename: string }) {
  const [fallback, setFallback] = useState<"ms" | "google">("ms");
  const [giveUp, setGiveUp] = useState(false);

  const src = useMemo(() => {
    const encoded = encodeURIComponent(signedUrl);
    return fallback === "ms"
      ? `https://view.officeapps.live.com/op/embed.aspx?src=${encoded}`
      : `https://docs.google.com/gview?url=${encoded}&embedded=true`;
  }, [signedUrl, fallback]);

  // 15 s safety net: if the iframe hasn't loaded a rendered view, swap
  // to the other backend. Both backends fire `load` even when they're
  // still displaying their own spinner, so this isn't foolproof, but
  // it catches the case where MS 404s the signed URL entirely.
  useEffect(() => {
    setGiveUp(false);
    const t = setTimeout(() => setGiveUp(true), 15000);
    return () => clearTimeout(t);
  }, [fallback]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#fff", minHeight: 0 }}>
      <iframe
        src={src}
        title={filename}
        style={{ flex: 1, border: "none", width: "100%", minHeight: 0, background: "#fff" }}
      />
      {giveUp && (
        <div style={{ padding: "8px 12px", background: TH.surfaceHi, borderTop: `1px solid ${TH.border}`, color: TH.textMuted, fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span>Preview slow? Try the other viewer:</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => setFallback("ms")}
              style={previewBtn(fallback === "ms")}
            >Microsoft</button>
            <button
              onClick={() => setFallback("google")}
              style={previewBtn(fallback === "google")}
            >Google Docs</button>
          </div>
        </div>
      )}
    </div>
  );
}

function previewBtn(active: boolean): React.CSSProperties {
  return {
    padding: "3px 10px", borderRadius: 4, border: `1px solid ${active ? TH.primary : TH.border}`,
    background: active ? TH.primary : "transparent",
    color: active ? "#fff" : TH.textSub, cursor: "pointer",
    fontSize: 11, fontWeight: 600, fontFamily: "inherit",
  };
}

// CSV preview kept lightweight (no need to round-trip through MS for a
// plain text file). Uses SheetJS to parse + renders our simple styled
// table. Suppress the `useMemo` import warning when no longer needed.
function CsvPreview({ signedUrl }: { signedUrl: string }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const txt = await fetch(signedUrl).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        });
        if (cancelled) return;
        // Minimal CSV parser — handles quoted values with commas/newlines.
        const out: string[][] = [];
        let row: string[] = [];
        let cur = "";
        let inQ = false;
        for (let i = 0; i < txt.length; i++) {
          const ch = txt[i];
          if (inQ) {
            if (ch === '"' && txt[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') { inQ = false; }
            else cur += ch;
          } else {
            if (ch === '"') inQ = true;
            else if (ch === ",") { row.push(cur); cur = ""; }
            else if (ch === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
            else if (ch === "\r") { /* skip */ }
            else cur += ch;
          }
        }
        if (cur || row.length) { row.push(cur); out.push(row); }
        if (!cancelled) { setRows(out); setLoading(false); }
      } catch (e: unknown) {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [signedUrl]);

  if (loading) return <div style={{ color: TH.textMuted, padding: 32, textAlign: "center", fontSize: 13 }}>Loading…</div>;
  if (err) return <div style={{ color: "#FCA5A5", padding: 32, textAlign: "center", fontSize: 12 }}>Couldn't read this file: {err}</div>;
  if (rows.length === 0) return <div style={{ color: TH.textMuted, padding: 32, textAlign: "center" }}>Empty file.</div>;

  const colCount = Math.max(...rows.map((r) => r.length));
  return (
    <div style={{ flex: 1, overflow: "auto", background: "#fff", minHeight: 0 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, color: "#0F172A", width: "100%", tableLayout: "auto" }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i === 0 ? "#F1F5F9" : i % 2 === 0 ? "#fff" : "#F8FAFC" }}>
              {Array.from({ length: colCount }).map((_, c) => (
                <td key={c} style={{ border: "1px solid #E2E8F0", padding: "4px 10px", whiteSpace: "nowrap", fontWeight: i === 0 ? 700 : 400 }}>
                  {r[c] || ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// File viewer — in-app preview with Download fallback. PDFs render
// natively in the iframe, Excel/CSV go through SheetJS, others fall
// back to a Download prompt.
export function showFileViewer({
  signedUrl, filename,
}: { signedUrl: string; filename: string }): Promise<void> {
  return new Promise((resolve) => {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const isPdf = ext === "pdf";
    const isOffice = ext === "xlsx" || ext === "xls" || ext === "xlsm"
      || ext === "docx" || ext === "doc" || ext === "pptx" || ext === "ppt";
    const isCsv = ext === "csv";
    const handleClose = () => { close(); resolve(); };
    const triggerDownload = () => {
      const a = document.createElement("a");
      a.href = signedUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    ensureMount().render(
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => { if (e.currentTarget === e.target) handleClose(); }}
        style={{
          position: "fixed", inset: 0, zIndex: 9999,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(15, 23, 42, 0.65)",
        }}
      >
        <div style={{
          width: "min(1100px, calc(100vw - 48px))",
          height: "min(820px, calc(100vh - 48px))",
          background: TH.surface,
          border: `1px solid ${TH.border}`,
          borderRadius: 10,
          boxShadow: `0 16px 48px rgba(0,0,0,0.4)`,
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
          <div style={{
            padding: "10px 16px", background: TH.surfaceHi,
            borderBottom: `1px solid ${TH.border}`,
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <div style={{ flex: 1, fontFamily: "Menlo, monospace", fontSize: 13, color: TH.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {filename}
            </div>
            <button
              onClick={triggerDownload}
              style={{
                padding: "6px 14px", borderRadius: 6, border: "none",
                background: TH.primary, color: "#FFFFFF",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                fontFamily: "inherit",
              }}
            >
              ⬇ Download
            </button>
            <button
              onClick={handleClose}
              aria-label="Close"
              style={{
                padding: "6px 12px", borderRadius: 6,
                border: `1px solid ${TH.border}`, background: "none", color: TH.text,
                cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              }}
            >
              Close
            </button>
          </div>
          <div style={{ flex: 1, background: "#1e293b", display: "flex", alignItems: "stretch", justifyContent: "stretch", minHeight: 0 }}>
            {isPdf ? (
              <iframe
                src={signedUrl}
                style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
                title={filename}
              />
            ) : isOffice ? (
              <OfficePreview signedUrl={signedUrl} filename={filename} />
            ) : isCsv ? (
              <CsvPreview signedUrl={signedUrl} />
            ) : (
              <div style={{ flex: 1, textAlign: "center", color: TH.textMuted, padding: 32, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
                <div style={{ fontSize: 14, color: TH.text, marginBottom: 6 }}>
                  Preview not available for .{ext || "this"} files.
                </div>
                <div style={{ fontSize: 12, marginBottom: 18 }}>
                  Download the file to open it in its native app.
                </div>
                <button
                  onClick={triggerDownload}
                  style={{
                    padding: "8px 20px", borderRadius: 6, border: "none",
                    background: TH.primary, color: "#FFFFFF",
                    cursor: "pointer", fontSize: 13, fontWeight: 600,
                    fontFamily: "inherit",
                  }}
                >
                  ⬇ Download
                </button>
              </div>
            )}
          </div>
        </div>
      </div>,
    );
  });
}
