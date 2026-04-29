// App-wide file preview modal. Import from anywhere:
//
//   import { showFileViewer } from "../utils/fileViewer";
//   showFileViewer({ signedUrl, filename });
//
// Renders a centered dark-chrome modal. PDFs load in a native iframe,
// Office docs (xlsx/xls/xlsm/docx/doc/pptx/ppt) go through Microsoft's
// public Office Online viewer (falls back to Google Docs Viewer after
// a timeout), CSVs parse client-side, anything else offers a Download
// fallback. Signed URLs must be publicly fetchable while their token
// is valid — Supabase Storage `createSignedUrl` satisfies that.

import { createRoot, type Root } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";

// Neutral palette so the modal looks identical whether the host app is
// dark-themed (vendor portal) or light-themed (internal PLM / TandA /
// etc.). Modals float over a dimmed backdrop, so matching host theme
// isn't required — a consistent dark-chrome preview is fine.
const C = {
  bg: "#0F172A",
  surface: "#1E293B",
  surfaceHi: "#334155",
  border: "#475569",
  text: "#F1F5F9",
  textSub: "#CBD5E1",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  primaryLt: "#60A5FA",
};

let mount: HTMLDivElement | null = null;
let root: Root | null = null;

function ensureMount(): Root {
  if (!mount) {
    mount = document.createElement("div");
    mount.id = "file-viewer-root";
    document.body.appendChild(mount);
  }
  if (!root) root = createRoot(mount);
  return root;
}

function close() {
  if (root) root.render(null);
}

// Office Online embed, with Google Docs Viewer as a fallback.
function OfficePreview({ signedUrl, filename }: { signedUrl: string; filename: string }) {
  const [fallback, setFallback] = useState<"ms" | "google">("ms");
  const [giveUp, setGiveUp] = useState(false);

  const src = useMemo(() => {
    const encoded = encodeURIComponent(signedUrl);
    return fallback === "ms"
      ? `https://view.officeapps.live.com/op/embed.aspx?src=${encoded}`
      : `https://docs.google.com/gview?url=${encoded}&embedded=true`;
  }, [signedUrl, fallback]);

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
        <div style={{ padding: "8px 12px", background: C.surfaceHi, borderTop: `1px solid ${C.border}`, color: C.textMuted, fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span>Preview slow? Try the other viewer:</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setFallback("ms")} style={previewBtn(fallback === "ms")}>Microsoft</button>
            <button onClick={() => setFallback("google")} style={previewBtn(fallback === "google")}>Google Docs</button>
          </div>
        </div>
      )}
    </div>
  );
}

function previewBtn(active: boolean): React.CSSProperties {
  return {
    padding: "3px 10px", borderRadius: 4, border: `1px solid ${active ? C.primary : C.border}`,
    background: active ? C.primary : "transparent",
    color: active ? "#fff" : C.textSub, cursor: "pointer",
    fontSize: 11, fontWeight: 600, fontFamily: "inherit",
  };
}

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

  if (loading) return <div style={{ color: C.textMuted, padding: 32, textAlign: "center", fontSize: 13 }}>Loading…</div>;
  if (err) return <div style={{ color: "#FCA5A5", padding: 32, textAlign: "center", fontSize: 12 }}>Couldn't read this file: {err}</div>;
  if (rows.length === 0) return <div style={{ color: C.textMuted, padding: 32, textAlign: "center" }}>Empty file.</div>;

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

function isImageExt(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic"].includes(ext);
}

export function showFileViewer({
  signedUrl, filename,
}: { signedUrl: string; filename: string }): Promise<void> {
  return new Promise((resolve) => {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const isPdf = ext === "pdf";
    const isOffice = ["xlsx", "xls", "xlsm", "docx", "doc", "pptx", "ppt"].includes(ext);
    const isCsv = ext === "csv";
    const isImage = isImageExt(ext);
    const isText = ["txt", "json", "md", "log"].includes(ext);

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
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: C.text,
        }}>
          <div style={{
            padding: "10px 16px", background: C.surfaceHi,
            borderBottom: `1px solid ${C.border}`,
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <div style={{ flex: 1, fontFamily: "Menlo, monospace", fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {filename}
            </div>
            <button
              onClick={triggerDownload}
              style={{
                padding: "6px 14px", borderRadius: 6, border: "none",
                background: C.primary, color: "#FFFFFF",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                fontFamily: "inherit",
              }}
            >⬇ Download</button>
            <button
              onClick={handleClose}
              aria-label="Close"
              style={{
                padding: "6px 12px", borderRadius: 6,
                border: `1px solid ${C.border}`, background: "transparent", color: C.text,
                cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              }}
            >Close</button>
          </div>
          <div style={{ flex: 1, background: C.bg, display: "flex", alignItems: "stretch", justifyContent: "stretch", minHeight: 0 }}>
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
            ) : isImage ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 16 }}>
                <img src={signedUrl} alt={filename} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "#fff", borderRadius: 6 }} />
              </div>
            ) : isText ? (
              <iframe
                src={signedUrl}
                style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
                title={filename}
              />
            ) : (
              <div style={{ flex: 1, textAlign: "center", color: C.textMuted, padding: 32, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
                <div style={{ fontSize: 14, color: C.text, marginBottom: 6 }}>
                  Preview not available for .{ext || "this"} files.
                </div>
                <div style={{ fontSize: 12, marginBottom: 18 }}>
                  Download the file to open it in its native app.
                </div>
                <button
                  onClick={triggerDownload}
                  style={{
                    padding: "8px 20px", borderRadius: 6, border: "none",
                    background: C.primary, color: "#FFFFFF",
                    cursor: "pointer", fontSize: 13, fontWeight: 600,
                    fontFamily: "inherit",
                  }}
                >⬇ Download</button>
              </div>
            )}
          </div>
        </div>
      </div>,
    );
  });
}
