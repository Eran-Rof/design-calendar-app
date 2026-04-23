import React, { useEffect, useRef, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

function ConfidenceBadge({ score }: { score: number | null }) {
  if (score == null) return <span style={{ color: TH.textMuted, fontSize: 11 }}>—</span>;
  const color = score >= 70 ? "#276749" : score >= 40 ? "#92400E" : TH.primary;
  const bg    = score >= 70 ? "#F0FFF4" : score >= 40 ? "#FFFBEB" : "#FFF5F5";
  return (
    <span style={{ background: bg, color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10 }}>
      {score.toFixed(0)}%
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    uploaded: { bg: "#EBF8FF", color: "#2B6CB0" },
    parsing:  { bg: "#FFFBEB", color: "#92400E" },
    parsed:   { bg: "#F0FFF4", color: "#276749" },
    error:    { bg: "#FFF5F5", color: TH.primary },
  };
  const s = map[status] ?? { bg: TH.surfaceHi, color: TH.textMuted };
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10 }}>
      {status}
    </span>
  );
}

export default function PackingListUploadPanel() {
  const {
    uploads, currentUpload, uploadBlocks, parseIssues, pendingRows,
    uploadLoading, uploadError,
    loadUploads, processUpload, selectUpload,
    companySettings, loadCompanySettings,
    generateGtinsForPendingRows,
    bomBuilding, buildBomsForUpload,
    setActiveTab,
  } = useGS1Store();

  const fileRef = useRef<HTMLInputElement>(null);
  const [genMsg,  setGenMsg]  = useState("");
  const [bomMsg,  setBomMsg]  = useState("");
  const [gtinsGenerated, setGtinsGenerated] = useState(false);

  useEffect(() => {
    loadUploads();
    if (!companySettings) loadCompanySettings();
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await processUpload(file);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleGenerateGtins() {
    setGenMsg(""); setBomMsg(""); setGtinsGenerated(false);
    try {
      await generateGtinsForPendingRows();
      const count = new Set(pendingRows.map(r => `${r.styleNo}|${r.color}|${r.scaleCode}`)).size;
      setGenMsg(`✓ GTINs generated for ${count} unique style/color/scale combinations.`);
      setGtinsGenerated(true);
    } catch (err) {
      setGenMsg(`Error: ${(err as Error).message}`);
    }
  }

  async function handleBuildBoms() {
    setBomMsg("");
    try {
      const s = await buildBomsForUpload();
      setBomMsg(`✓ BOMs built: ${s.complete} complete, ${s.incomplete} incomplete, ${s.errors} errors`);
    } catch (err) {
      setBomMsg(`Error: ${(err as Error).message}`);
    }
  }

  const blocksBySheet = uploadBlocks.reduce<Record<string, typeof uploadBlocks>>((acc, b) => {
    (acc[b.sheet_name] ??= []).push(b);
    return acc;
  }, {});

  const totalLabels = uploadBlocks.reduce((s, b) => s + (b.pack_qty ?? 0), 0);
  const errorCount  = parseIssues.filter(i => i.severity === "error").length;
  const warnCount   = parseIssues.filter(i => i.severity === "warning").length;

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Packing List Upload</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Upload a .xls or .xlsx packing list. The parser extracts style / color / scale / channel / qty blocks.
      </p>

      {!companySettings && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
          Company Setup must be saved before generating GTINs from this upload.
        </div>
      )}

      {uploadError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {uploadError}
        </div>
      )}

      {/* Upload widget */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>Upload New Packing List</h3>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls"
            onChange={handleFile} disabled={uploadLoading}
            style={{ fontSize: 13, color: TH.text }} />
          {uploadLoading && (
            <span style={{ fontSize: 13, color: TH.textMuted, fontStyle: "italic" }}>Parsing workbook…</span>
          )}
        </div>
        <p style={{ fontSize: 12, color: TH.textMuted, marginTop: 8, marginBottom: 0 }}>
          Supported: .xlsx, .xls &nbsp;|&nbsp; Multiple worksheets OK &nbsp;|&nbsp; Block-style layouts OK
        </p>
      </div>

      {/* Current upload result */}
      {currentUpload && (
        <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 15, color: TH.textSub }}>{currentUpload.file_name}</h3>
              <StatusBadge status={currentUpload.parse_status} />
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: TH.textMuted }}>
              {currentUpload.parse_summary && (
                <>
                  <div>{currentUpload.parse_summary.sheets_processed} sheets &nbsp;·&nbsp; {currentUpload.parse_summary.blocks_found} rows &nbsp;·&nbsp; {currentUpload.parse_summary.total_labels.toLocaleString()} total labels</div>
                  {currentUpload.parse_summary.issues_count > 0 && (
                    <div style={{ color: errorCount > 0 ? TH.primary : "#92400E" }}>
                      {errorCount} errors &nbsp;·&nbsp; {warnCount} warnings
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Generate GTINs + Build BOMs actions */}
          {uploadBlocks.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <button onClick={handleGenerateGtins} disabled={!companySettings || uploadLoading}
                  style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  1. Generate GTINs for All Parsed Rows
                </button>
                <button
                  onClick={handleBuildBoms}
                  disabled={!gtinsGenerated || bomBuilding}
                  style={{ background: "#276749", color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: gtinsGenerated ? 1 : 0.4 }}>
                  {bomBuilding ? "Building BOMs…" : "2. Build BOMs from Scale + UPC Master"}
                </button>
                <button onClick={() => setActiveTab("labels")}
                  style={{ background: TH.header, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  → Create Label Batch
                </button>
              </div>
              {genMsg && (
                <span style={{ fontSize: 13, color: genMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>
                  {genMsg}
                </span>
              )}
              {bomMsg && (
                <span style={{ fontSize: 13, color: bomMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>
                  {bomMsg}
                </span>
              )}
            </div>
          )}

          {/* Parse issues */}
          {parseIssues.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 13, color: TH.textSub }}>Parse Issues ({parseIssues.length})</h4>
              <div style={{ maxHeight: 150, overflowY: "auto", border: `1px solid ${TH.border}`, borderRadius: 6 }}>
                {parseIssues.map(issue => (
                  <div key={issue.id} style={{
                    padding: "6px 12px",
                    borderBottom: `1px solid ${TH.border}`,
                    background: issue.severity === "error" ? "#FFF5F5" : issue.severity === "warning" ? "#FFFBEB" : "#fff",
                    fontSize: 12,
                  }}>
                    <span style={{ fontWeight: 600, color: issue.severity === "error" ? TH.primary : issue.severity === "warning" ? "#92400E" : "#2B6CB0", marginRight: 8 }}>
                      [{issue.severity.toUpperCase()}]
                    </span>
                    {issue.sheet_name && <span style={{ color: TH.textMuted, marginRight: 6 }}>[{issue.sheet_name}]</span>}
                    {issue.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Parsed blocks by sheet */}
          {Object.keys(blocksBySheet).length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 8px", fontSize: 13, color: TH.textSub }}>
                Parsed Rows ({uploadBlocks.length}) — {totalLabels.toLocaleString()} total labels
              </h4>
              {Object.entries(blocksBySheet).map(([sheet, blocks]) => (
                <div key={sheet} style={{ marginBottom: 12 }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: TH.textMuted, margin: "0 0 4px" }}>Sheet: {sheet} ({blocks.length} rows)</p>
                  <div style={{ border: `1px solid ${TH.border}`, borderRadius: 6, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          {["Style No", "Color", "Channel", "Scale", "Qty (labels)", "Confidence", "Status"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {blocks.map(b => (
                          <tr key={b.id}>
                            <td style={TD_STYLE}>{b.style_no ?? "—"}</td>
                            <td style={TD_STYLE}>{b.color ?? "—"}</td>
                            <td style={TD_STYLE}>{b.channel ?? "—"}</td>
                            <td style={{ ...TD_STYLE, fontWeight: 700 }}>{b.scale_code ?? "—"}</td>
                            <td style={{ ...TD_STYLE, fontWeight: 700, color: TH.primary }}>{b.pack_qty ?? 0}</td>
                            <td style={TD_STYLE}><ConfidenceBadge score={b.confidence_score} /></td>
                            <td style={TD_STYLE}><StatusBadge status={b.parse_status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Upload history */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "16px 20px", boxShadow: `0 1px 4px ${TH.shadow}` }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>Upload History</h3>
        {uploadLoading && !currentUpload
          ? <p style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</p>
          : uploads.length === 0
            ? <p style={{ color: TH.textMuted, fontSize: 13 }}>No uploads yet.</p>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["File Name", "Status", "Blocks", "Labels", "Date", ""].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {uploads.map(u => (
                    <tr key={u.id} style={{ cursor: "pointer" }} onClick={() => selectUpload(u)}>
                      <td style={TD_STYLE}>{u.file_name}</td>
                      <td style={TD_STYLE}><StatusBadge status={u.parse_status} /></td>
                      <td style={TD_STYLE}>{u.parse_summary?.blocks_found ?? "—"}</td>
                      <td style={TD_STYLE}>{u.parse_summary?.total_labels?.toLocaleString() ?? "—"}</td>
                      <td style={{ ...TD_STYLE, color: TH.textMuted, fontSize: 12 }}>{new Date(u.uploaded_at).toLocaleDateString()}</td>
                      <td style={TD_STYLE}>
                        <button onClick={e => { e.stopPropagation(); selectUpload(u); }}
                          style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 5, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
        }
      </div>
    </div>
  );
}
