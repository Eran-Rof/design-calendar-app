import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import { exportLabelsCsv, printLabelBatch } from "../services/labelExport";
import { formatGtin14Display } from "../services/gtinService";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

export default function LabelBatchPanel() {
  const {
    batches, currentBatch, batchLines, batchLoading, batchError,
    currentUpload, uploadBlocks, companySettings,
    loadBatches, loadCompanySettings, selectBatch, clearCurrentBatch,
    createBatchFromUpload, updateBatchStatus,
  } = useGS1Store();

  const [batchName, setBatchName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  useEffect(() => {
    loadBatches();
    if (!companySettings) loadCompanySettings();
  }, []);

  // Auto-populate batch name from upload
  useEffect(() => {
    if (currentUpload && !batchName) {
      const d = new Date().toISOString().slice(0, 10);
      setBatchName(`${currentUpload.file_name.replace(/\.[^.]+$/, "")}_${d}`);
    }
  }, [currentUpload]);

  async function handleCreateBatch(e: React.FormEvent) {
    e.preventDefault();
    if (!batchName.trim()) return;
    setCreating(true);
    setCreateMsg("");
    try {
      await createBatchFromUpload(batchName.trim());
      setCreateMsg("✓ Batch created");
      setBatchName("");
    } catch (err) {
      setCreateMsg(`Error: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  const totalLabels   = batchLines.reduce((s, l) => s + l.label_qty, 0);
  const uniqueGtins   = new Set(batchLines.map(l => l.pack_gtin)).size;

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Label Batches</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Create a printable label batch from a parsed packing list. Export as PDF (print) or CSV for label software.
      </p>

      {batchError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {batchError}
        </div>
      )}

      {/* Create batch from current upload */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>Create Batch from Current Upload</h3>

        {!currentUpload || uploadBlocks.length === 0 ? (
          <p style={{ fontSize: 13, color: TH.textMuted }}>
            No upload selected with parsed rows. Go to{" "}
            <button onClick={() => useGS1Store.getState().setActiveTab("upload")}
              style={{ border: "none", background: "none", color: TH.primary, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              Packing List →
            </button>{" "}
            and upload a file first.
          </p>
        ) : (
          <form onSubmit={handleCreateBatch} style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase" }}>Batch Name</label>
              <input value={batchName} onChange={e => setBatchName(e.target.value)} required
                style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 280 }} />
            </div>
            <div style={{ fontSize: 12, color: TH.textMuted, alignSelf: "center" }}>
              {uploadBlocks.length} blocks from {currentUpload.file_name}
            </div>
            <button type="submit" disabled={creating || !companySettings}
              style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {creating ? "Creating…" : "Create Batch"}
            </button>
            {createMsg && <span style={{ fontSize: 13, color: createMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>{createMsg}</span>}
          </form>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, alignItems: "start" }}>
        {/* Batch list */}
        <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${TH.border}` }}>
            <h3 style={{ margin: 0, fontSize: 14, color: TH.textSub }}>Batches ({batches.length})</h3>
          </div>
          {batchLoading && !currentBatch
            ? <p style={{ padding: 16, color: TH.textMuted, fontSize: 13 }}>Loading…</p>
            : batches.length === 0
              ? <p style={{ padding: 16, color: TH.textMuted, fontSize: 13 }}>No batches yet.</p>
              : batches.map(b => (
                <div key={b.id}
                  onClick={() => selectBatch(b)}
                  style={{
                    padding: "10px 16px", cursor: "pointer",
                    background: currentBatch?.id === b.id ? TH.accent : "transparent",
                    borderBottom: `1px solid ${TH.border}`,
                    borderLeft: currentBatch?.id === b.id ? `3px solid ${TH.primary}` : "3px solid transparent",
                  }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{b.batch_name}</div>
                  <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                    {new Date(b.generated_at).toLocaleDateString()} &nbsp;·&nbsp;
                    <span style={{ color: b.status === "printed" ? "#276749" : TH.textMuted }}>{b.status}</span>
                  </div>
                </div>
              ))
          }
        </div>

        {/* Batch detail */}
        <div>
          {!currentBatch ? (
            <div style={{ background: TH.surface, borderRadius: 10, padding: 24, boxShadow: `0 1px 4px ${TH.shadow}`, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
              Select a batch on the left to view and export.
            </div>
          ) : (
            <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "hidden" }}>
              {/* Header */}
              <div style={{ padding: "16px 20px", borderBottom: `1px solid ${TH.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{currentBatch.batch_name}</h3>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>
                    {batchLines.length} lines &nbsp;·&nbsp; {uniqueGtins} unique GTINs &nbsp;·&nbsp;
                    <strong style={{ color: TH.primary }}>{totalLabels.toLocaleString()} total labels</strong>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => printLabelBatch(currentBatch.batch_name, batchLines)}
                    style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                    🖨 Print Labels
                  </button>
                  <button onClick={() => exportLabelsCsv(currentBatch.batch_name, batchLines)}
                    style={{ background: TH.header, color: "#fff", border: "none", borderRadius: 7, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                    ↓ Export CSV
                  </button>
                  {currentBatch.status !== "printed" && (
                    <button onClick={() => updateBatchStatus(currentBatch.id, "printed")}
                      style={{ background: "transparent", border: `1px solid #276749`, color: "#276749", borderRadius: 7, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}>
                      Mark Printed
                    </button>
                  )}
                  <button onClick={clearCurrentBatch}
                    style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}>
                    ✕
                  </button>
                </div>
              </div>

              {/* Lines table */}
              {batchLoading
                ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>Loading lines…</p>
                : batchLines.length === 0
                  ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>No lines in this batch.</p>
                  : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            {["Style No", "Color", "Scale", "Pack GTIN", "GTIN Human", "Channel", "Labels to Print"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {batchLines.map(l => (
                            <tr key={l.id}>
                              <td style={TD_STYLE}>{l.style_no}</td>
                              <td style={TD_STYLE}>{l.color}</td>
                              <td style={{ ...TD_STYLE, fontWeight: 700 }}>{l.scale_code}</td>
                              <td style={{ ...TD_STYLE, fontFamily: "monospace", fontWeight: 600 }}>{l.pack_gtin}</td>
                              <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 11, color: TH.textMuted }}>{formatGtin14Display(l.pack_gtin)}</td>
                              <td style={{ ...TD_STYLE, color: TH.textMuted }}>{l.source_channel ?? "—"}</td>
                              <td style={{ ...TD_STYLE, fontWeight: 700, color: TH.primary, fontSize: 15 }}>{l.label_qty.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ background: TH.surfaceHi }}>
                            <td colSpan={6} style={{ ...TD_STYLE, fontWeight: 700, textAlign: "right", borderTop: `2px solid ${TH.border}` }}>Total Labels:</td>
                            <td style={{ ...TD_STYLE, fontWeight: 700, color: TH.primary, fontSize: 16, borderTop: `2px solid ${TH.border}` }}>
                              {totalLabels.toLocaleString()}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
