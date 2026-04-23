import React, { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import type { UpcItemInput } from "../types";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = {
  padding: "7px 12px", fontSize: 13, color: TH.text,
  borderBottom: `1px solid ${TH.border}`,
};

// Column mapping for Excel import
interface ColMap { upc: number; style_no: number; color: number; size: number; description: number }
const DEFAULT_COL_MAP: ColMap = { upc: 0, style_no: 1, color: 2, size: 3, description: 4 };

export default function UpcMasterPanel() {
  const { upcItems, upcLoading, upcError, loadUpcItems, importUpcItems, deleteUpcItem } = useGS1Store();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview]   = useState<UpcItemInput[]>([]);
  const [colMap, setColMap]     = useState<ColMap>(DEFAULT_COL_MAP);
  const [headers, setHeaders]   = useState<string[]>([]);
  const [importMsg, setImportMsg] = useState("");
  const [search, setSearch]     = useState("");

  useEffect(() => { loadUpcItems(); }, []);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const buf = ev.target?.result;
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const data: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as string[][];
      if (data.length < 2) return;
      setHeaders(data[0].map(String));
      const rows: UpcItemInput[] = data.slice(1).map(row => ({
        upc: String(row[colMap.upc] ?? "").trim(),
        style_no: String(row[colMap.style_no] ?? "").trim(),
        color: String(row[colMap.color] ?? "").trim(),
        size: String(row[colMap.size] ?? "").trim(),
        description: String(row[colMap.description] ?? "").trim() || undefined,
      })).filter(r => r.upc && r.style_no);
      setPreview(rows);
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleImport() {
    if (preview.length === 0) return;
    try {
      const r = await importUpcItems(preview);
      setImportMsg(`✓ Imported ${r.inserted} UPCs`);
      setPreview([]);
      if (fileRef.current) fileRef.current.value = "";
      setTimeout(() => setImportMsg(""), 5000);
    } catch (err) {
      setImportMsg(`Error: ${(err as Error).message}`);
    }
  }

  const filtered = search
    ? upcItems.filter(u => `${u.style_no} ${u.color} ${u.upc} ${u.size}`.toLowerCase().includes(search.toLowerCase()))
    : upcItems;

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>UPC Item Master</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Import child UPCs by style / color / size. Used for pack BOM composition (Phase 2 receiving).
      </p>

      {/* Import section */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>Import from Excel / CSV</h3>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile}
            style={{ fontSize: 13, color: TH.text }} />
        </div>

        {headers.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: TH.textSub2, marginBottom: 8 }}>Column Mapping</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {(["upc", "style_no", "color", "size", "description"] as (keyof ColMap)[]).map(field => (
                <div key={field} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase" }}>{field}</label>
                  <select value={colMap[field]} onChange={e => setColMap(m => ({ ...m, [field]: parseInt(e.target.value) }))}
                    style={{ padding: "4px 8px", border: `1px solid ${TH.border}`, borderRadius: 4, fontSize: 12 }}>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Col ${i}`}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {preview.length > 0 && (
          <>
            <p style={{ fontSize: 12, color: TH.textMuted, marginBottom: 8 }}>Preview — {preview.length} rows</p>
            <div style={{ maxHeight: 200, overflowY: "auto", border: `1px solid ${TH.border}`, borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["UPC", "Style No", "Color", "Size", "Description"].map(h => (
                      <th key={h} style={{ ...TH_STYLE, position: "sticky", top: 0 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td style={TD_STYLE}>{r.upc}</td>
                      <td style={TD_STYLE}>{r.style_no}</td>
                      <td style={TD_STYLE}>{r.color}</td>
                      <td style={TD_STYLE}>{r.size}</td>
                      <td style={TD_STYLE}>{r.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={handleImport} disabled={upcLoading}
                style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {upcLoading ? "Importing…" : `Import ${preview.length} rows`}
              </button>
              <button onClick={() => { setPreview([]); if (fileRef.current) fileRef.current.value = ""; }}
                style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}>
                Clear
              </button>
              {importMsg && <span style={{ fontSize: 13, color: importMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>{importMsg}</span>}
            </div>
          </>
        )}

        <div style={{ marginTop: 16, padding: "10px 14px", background: "#FFFBEB", borderRadius: 6, border: "1px solid #FDE68A", fontSize: 12, color: "#92400E" }}>
          <strong>Xoro Sync (Phase 2 stub)</strong> — A "Sync from Xoro" button will appear here once Xoro API credentials are saved in Company Setup.
        </div>
      </div>

      {upcError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {upcError}
        </div>
      )}

      {/* UPC list */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "16px 20px", boxShadow: `0 1px 4px ${TH.shadow}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: TH.textSub }}>UPC Records ({upcItems.length})</h3>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search style / color / UPC…"
            style={{ padding: "6px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 220 }} />
        </div>

        {upcLoading
          ? <p style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</p>
          : filtered.length === 0
            ? <p style={{ color: TH.textMuted, fontSize: 13 }}>No UPC records. Import an Excel file above.</p>
            : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["UPC", "Style No", "Color", "Size", "Description", "Source", ""].map(h => (
                        <th key={h} style={TH_STYLE}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 500).map(u => (
                      <tr key={u.id} style={{ background: "#fff" }}>
                        <td style={{ ...TD_STYLE, fontFamily: "monospace" }}>{u.upc}</td>
                        <td style={TD_STYLE}>{u.style_no}</td>
                        <td style={TD_STYLE}>{u.color}</td>
                        <td style={TD_STYLE}>{u.size}</td>
                        <td style={{ ...TD_STYLE, color: TH.textMuted }}>{u.description}</td>
                        <td style={{ ...TD_STYLE, color: TH.textMuted, fontSize: 11 }}>{u.source_method}</td>
                        <td style={TD_STYLE}>
                          <button onClick={() => { if (confirm("Delete this UPC?")) deleteUpcItem(u.id); }}
                            style={{ background: "transparent", border: "none", cursor: "pointer", color: "#E02B10", fontSize: 12 }}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length > 500 && <p style={{ fontSize: 12, color: TH.textMuted, marginTop: 8 }}>Showing 500 of {filtered.length} — use search to narrow.</p>}
              </div>
            )
        }
      </div>
    </div>
  );
}
