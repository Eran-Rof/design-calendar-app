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

// Excel preview — lazy-loads SheetJS (~300KB gz) on demand, converts
// every worksheet to styled HTML, tab bar lets the vendor switch sheets.
//
// SheetJS Community strips cell formatting (bold/colors/fonts) — only
// SheetJS Pro preserves it. We compensate with our own base styles,
// zebra striping, a sticky-ish column-letter header, a row-number
// gutter, and best-effort column widths pulled from the workbook's
// "!cols" metadata.
interface ParsedSheet {
  name: string;
  rows: string[][];        // formatted display strings per cell
  colCount: number;
  colWidths: number[];     // CSS pixel widths, 0 = auto
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
}

function colLetter(n: number): string {
  // 0 -> A, 25 -> Z, 26 -> AA, …
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

function ExcelPreview({ signedUrl }: { signedUrl: string }) {
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [xlsxMod, buf] = await Promise.all([
          import("xlsx"),
          fetch(signedUrl).then((r) => {
            if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        const XLSX = xlsxMod.default || xlsxMod;
        const wb = XLSX.read(buf, { type: "array", cellDates: true, cellText: true, cellFormula: false });
        const parsed: ParsedSheet[] = wb.SheetNames.map((name: string) => {
          const sheet = wb.Sheets[name];
          const ref = sheet["!ref"] as string | undefined;
          if (!ref) return { name, rows: [], colCount: 0, colWidths: [], merges: [] };
          const range = XLSX.utils.decode_range(ref);
          const colCount = range.e.c - range.s.c + 1;
          const rows: string[][] = [];
          for (let r = range.s.r; r <= range.e.r; r++) {
            const row: string[] = [];
            for (let c = range.s.c; c <= range.e.c; c++) {
              const addr = XLSX.utils.encode_cell({ r, c });
              const cell = sheet[addr];
              // Prefer the pre-formatted display string `w`, fall back to raw value
              const v = cell ? (cell.w != null ? cell.w : cell.v) : null;
              row.push(v == null ? "" : String(v));
            }
            rows.push(row);
          }
          // Column widths — SheetJS stores character widths in !cols[i].wch;
          // rough conversion: 1 char ≈ 7px. Clamp 40–360.
          const colsMeta = (sheet["!cols"] || []) as Array<{ wch?: number; wpx?: number } | undefined>;
          const colWidths: number[] = [];
          for (let c = 0; c < colCount; c++) {
            const m = colsMeta[c];
            if (m?.wpx && Number.isFinite(m.wpx)) colWidths.push(Math.max(40, Math.min(360, Math.round(m.wpx))));
            else if (m?.wch && Number.isFinite(m.wch)) colWidths.push(Math.max(40, Math.min(360, Math.round(m.wch * 7 + 10))));
            else colWidths.push(0);
          }
          const merges = (sheet["!merges"] || []) as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
          return { name, rows, colCount, colWidths, merges };
        });
        if (!cancelled) { setSheets(parsed); setLoading(false); }
      } catch (e: unknown) {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [signedUrl]);

  const sheet = sheets[active];

  // Pre-compute which (r,c) are "skipped" because they're covered by a
  // merge started in another cell, and which cells carry colSpan/rowSpan.
  const mergeInfo = useMemo(() => {
    const skip = new Set<string>();
    const span = new Map<string, { colSpan: number; rowSpan: number }>();
    if (!sheet) return { skip, span };
    for (const m of sheet.merges) {
      const anchor = `${m.s.r},${m.s.c}`;
      span.set(anchor, { colSpan: m.e.c - m.s.c + 1, rowSpan: m.e.r - m.s.r + 1 });
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r === m.s.r && c === m.s.c) continue;
          skip.add(`${r},${c}`);
        }
      }
    }
    return { skip, span };
  }, [sheet]);

  if (loading) {
    return <div style={{ color: TH.textMuted, padding: 32, textAlign: "center", fontSize: 13 }}>Parsing workbook…</div>;
  }
  if (err) {
    return (
      <div style={{ color: TH.textMuted, padding: 32, textAlign: "center" }}>
        <div style={{ fontSize: 14, color: "#FCA5A5", marginBottom: 6 }}>Couldn't preview this file.</div>
        <div style={{ fontSize: 12 }}>{err}</div>
      </div>
    );
  }
  if (sheets.length === 0 || !sheet || sheet.rows.length === 0) {
    return <div style={{ color: TH.textMuted, padding: 32, textAlign: "center" }}>No data in this workbook.</div>;
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#F8FAFC", overflow: "hidden" }}>
      {sheets.length > 1 && (
        <div style={{ display: "flex", gap: 2, padding: "6px 8px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, overflowX: "auto", flexShrink: 0 }}>
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              onClick={() => setActive(i)}
              style={{
                padding: "4px 12px", fontSize: 12, borderRadius: 4,
                border: `1px solid ${i === active ? TH.primary : TH.border}`,
                background: i === active ? TH.primary : "transparent",
                color: i === active ? "#fff" : TH.textSub,
                cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >{s.name}</button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <table style={{
          borderCollapse: "separate",
          borderSpacing: 0,
          fontSize: 12,
          fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
          color: "#0F172A",
          background: "#fff",
          tableLayout: "fixed",
        }}>
          <thead>
            <tr>
              <th style={{ ...gutterTh, width: 40, minWidth: 40 }}></th>
              {Array.from({ length: sheet.colCount }).map((_, c) => {
                const w = sheet.colWidths[c] || 120;
                return (
                  <th key={c} style={{ ...headerTh, width: w, minWidth: w }}>
                    {colLetter(c)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rIdx) => (
              <tr key={rIdx}>
                <td style={gutterTd}>{rIdx + 1}</td>
                {row.map((cell, cIdx) => {
                  if (mergeInfo.skip.has(`${rIdx},${cIdx}`)) return null;
                  const anchor = mergeInfo.span.get(`${rIdx},${cIdx}`);
                  const numeric = cell !== "" && cell != null && !Number.isNaN(Number(cell.replace(/[$,]/g, "")));
                  return (
                    <td
                      key={cIdx}
                      colSpan={anchor?.colSpan}
                      rowSpan={anchor?.rowSpan}
                      style={{
                        ...bodyTd,
                        textAlign: numeric ? "right" : "left",
                        fontVariantNumeric: numeric ? "tabular-nums" : undefined,
                        background: rIdx % 2 === 0 ? "#fff" : "#F8FAFC",
                      }}
                    >{cell}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const gutterTh: React.CSSProperties = {
  position: "sticky", top: 0, left: 0, zIndex: 3,
  background: "#E2E8F0", borderRight: "1px solid #CBD5E1", borderBottom: "1px solid #CBD5E1",
  padding: "6px 8px", fontWeight: 700, color: "#475569", fontSize: 11,
};
const headerTh: React.CSSProperties = {
  position: "sticky", top: 0, zIndex: 2,
  background: "#E2E8F0", borderRight: "1px solid #CBD5E1", borderBottom: "1px solid #CBD5E1",
  padding: "6px 10px", fontWeight: 700, color: "#475569", fontSize: 11,
  textAlign: "center",
};
const gutterTd: React.CSSProperties = {
  position: "sticky", left: 0, zIndex: 1,
  background: "#E2E8F0", borderRight: "1px solid #CBD5E1", borderBottom: "1px solid #E2E8F0",
  padding: "4px 8px", fontWeight: 600, color: "#64748B", fontSize: 11,
  textAlign: "center", width: 40, minWidth: 40,
};
const bodyTd: React.CSSProperties = {
  borderRight: "1px solid #E2E8F0",
  borderBottom: "1px solid #E2E8F0",
  padding: "4px 10px",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  verticalAlign: "top",
};

// File viewer — in-app preview with Download fallback. PDFs render
// natively in the iframe, Excel/CSV go through SheetJS, others fall
// back to a Download prompt.
export function showFileViewer({
  signedUrl, filename,
}: { signedUrl: string; filename: string }): Promise<void> {
  return new Promise((resolve) => {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const isPdf = ext === "pdf";
    const isExcel = ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "csv";
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
            ) : isExcel ? (
              <ExcelPreview signedUrl={signedUrl} />
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
