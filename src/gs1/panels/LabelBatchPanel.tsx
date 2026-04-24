import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import { formatGtin14Display } from "../services/gtinService";
import {
  validateBatchForPrint, validateCartonsForPrint,
  generateBatchZpl, generateSsccBatchZpl,
  generateGtinCsvData, generateSsccCsvData,
  buildGtinPrintHtml, buildSsccPrintHtml,
  downloadTextFile, openPrintWindow,
  DEFAULT_GTIN_TEMPLATE, DEFAULT_SSCC_TEMPLATE,
} from "../services/labelGeneratorService";
import type { LabelMode, LabelTemplate } from "../types";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

export default function LabelBatchPanel() {
  const {
    batches, currentBatch, batchLines, cartons, batchLoading, batchError,
    currentUpload, uploadBlocks, companySettings,
    labelTemplates, printLogs, printLogsLoading,
    labelMode, setLabelMode,
    loadBatches, loadCompanySettings, selectBatch, clearCurrentBatch,
    createBatchFromUpload, updateBatchStatus, loadCartonsForBatch,
    loadLabelTemplates, loadPrintLogs, logPrintEvent,
  } = useGS1Store();

  const [batchName, setBatchName] = useState("");
  const [creating, setCreating]   = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  // Template selectors (local — not persisted)
  const [gtinTemplateId, setGtinTemplateId] = useState<string>("");
  const [ssccTemplateId, setSsccTemplateId] = useState<string>("");

  // Reprint form
  const [showReprint, setShowReprint]     = useState(false);
  const [reprintReason, setReprintReason] = useState("");
  const [reprintMethod, setReprintMethod] = useState<"pdf" | "zpl" | "csv">("pdf");

  // Validation errors
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  useEffect(() => {
    loadBatches();
    loadLabelTemplates();
    if (!companySettings) loadCompanySettings();
  }, []);

  // Auto-select default template when templates load
  useEffect(() => {
    const defaultGtin = labelTemplates.find(t => t.label_type === "pack_gtin" && t.is_default);
    const defaultSscc = labelTemplates.find(t => t.label_type === "sscc"      && t.is_default);
    if (defaultGtin && !gtinTemplateId) setGtinTemplateId(defaultGtin.id);
    if (defaultSscc && !ssccTemplateId) setSsccTemplateId(defaultSscc.id);
  }, [labelTemplates]);

  // Auto-populate batch name from upload
  useEffect(() => {
    if (currentUpload && !batchName) {
      const d = new Date().toISOString().slice(0, 10);
      setBatchName(`${currentUpload.file_name.replace(/\.[^.]+$/, "")}_${d}`);
    }
  }, [currentUpload]);

  async function handleSelectBatch(batch: typeof batches[0]) {
    setValidationErrors([]);
    setShowReprint(false);
    await selectBatch(batch);
    await Promise.all([loadCartonsForBatch(batch.id), loadPrintLogs(batch.id)]);
  }

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

  // ── Resolve active template ──────────────────────────────────────────────────

  function resolveGtinTemplate(): LabelTemplate {
    return labelTemplates.find(t => t.id === gtinTemplateId) ?? DEFAULT_GTIN_TEMPLATE;
  }
  function resolveSsccTemplate(): LabelTemplate {
    return labelTemplates.find(t => t.id === ssccTemplateId) ?? DEFAULT_SSCC_TEMPLATE;
  }

  // ── Print handlers ───────────────────────────────────────────────────────────

  function runPrint(method: "pdf" | "zpl" | "csv", isReprint: boolean, reason?: string) {
    if (!currentBatch) return;
    const batchId = currentBatch.id;
    const batchNameSafe = currentBatch.batch_name.replace(/[^a-z0-9]/gi, "_");

    // Validate everything before printing anything so errors from both
    // sections are shown together and neither section prints on failure.
    const gtinErrors = batchMode !== "sscc" && batchLines.length > 0 ? validateBatchForPrint(batchLines) : [];
    const ssccErrors = hasSSCC && cartons.length > 0 ? validateCartonsForPrint(cartons) : [];
    const allErrors  = [...gtinErrors, ...ssccErrors];
    if (allErrors.length > 0) { setValidationErrors(allErrors); return; }
    setValidationErrors([]);

    // GTIN labels
    if (batchMode !== "sscc" && batchLines.length > 0) {
      const template = resolveGtinTemplate();
      const totalLabels = batchLines.reduce((s, l) => s + l.label_qty, 0);
      if (method === "pdf") {
        openPrintWindow(buildGtinPrintHtml(currentBatch.batch_name, batchLines, template));
      } else if (method === "zpl") {
        downloadTextFile(`${batchNameSafe}_gtin_labels.zpl`, generateBatchZpl(batchLines, template), "text/plain");
      } else {
        downloadTextFile(`${batchNameSafe}_gtin_labels.csv`, generateGtinCsvData(batchLines), "text/csv");
      }
      logPrintEvent({ label_batch_id: batchId, label_type: "pack_gtin", print_method: method, labels_printed: totalLabels, status: isReprint ? "reprint" : "printed", reprint_reason: reason ?? null });
    }

    // SSCC labels
    if (hasSSCC && cartons.length > 0) {
      const template = resolveSsccTemplate();

      const totalCartons = cartons.length;
      if (method === "pdf") {
        openPrintWindow(buildSsccPrintHtml(currentBatch.batch_name, cartons, template));
      } else if (method === "zpl") {
        downloadTextFile(`${batchNameSafe}_sscc_labels.zpl`, generateSsccBatchZpl(cartons, template), "text/plain");
      } else {
        downloadTextFile(`${batchNameSafe}_sscc_cartons.csv`, generateSsccCsvData(cartons), "text/csv");
      }
      logPrintEvent({ label_batch_id: batchId, label_type: "sscc", print_method: method, labels_printed: totalCartons, status: isReprint ? "reprint" : "printed", reprint_reason: reason ?? null });
    }

    if (isReprint) {
      setShowReprint(false);
      setReprintReason("");
    }
    // Auto-mark batch as printed on first print
    if (!isReprint && currentBatch.status !== "printed") {
      updateBatchStatus(batchId, "printed");
    }
  }

  // ── Computed values ──────────────────────────────────────────────────────────

  const totalLabels  = batchLines.reduce((s, l) => s + l.label_qty, 0);
  const uniqueGtins  = new Set(batchLines.map(l => l.pack_gtin)).size;
  const totalCartons = cartons.length;
  const batchMode    = currentBatch?.label_mode ?? "pack_gtin";
  const hasSSCC      = batchMode === "sscc" || batchMode === "both";

  const gtinTemplateOptions = labelTemplates.filter(t => t.label_type === "pack_gtin");
  const ssccTemplateOptions = labelTemplates.filter(t => t.label_type === "sscc");

  const modeBadge = (mode: string): React.CSSProperties => {
    const map: Record<string, { bg: string; color: string }> = {
      pack_gtin: { bg: "#EBF8FF", color: "#2B6CB0" },
      sscc:      { bg: "#F0FFF4", color: "#276749" },
      both:      { bg: "#FAF5FF", color: "#553C9A" },
    };
    const s = map[mode] ?? { bg: TH.surfaceHi, color: TH.textMuted };
    return { background: s.bg, color: s.color, fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 10 };
  };

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Label Batches</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Create a printable batch from a parsed packing list. Export as PDF (browser print), ZPL (Zebra), or CSV.
      </p>

      {/* Invalid batch line warning */}
      {batchLines.filter(l => l.label_qty <= 0).length > 0 && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FCD34D", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400E", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 700 }}>⚠ {batchLines.filter(l => l.label_qty <= 0).length} batch line{batchLines.filter(l => l.label_qty <= 0).length > 1 ? "s" : ""} with label_qty ≤ 0</span>
          — These lines will be skipped during export. Fix the source packing list and regenerate the batch.
        </div>
      )}

      {batchError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {batchError}
        </div>
      )}

      {/* ── Create batch ───────────────────────────────────────────────────── */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>Create Batch from Current Upload</h3>
        {!currentUpload || uploadBlocks.length === 0 ? (
          <p style={{ fontSize: 13, color: TH.textMuted }}>
            No upload selected with parsed rows. Go to{" "}
            <button onClick={() => useGS1Store.getState().setActiveTab("upload")}
              style={{ border: "none", background: "none", color: TH.primary, cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              Packing List →
            </button>{" "}first.
          </p>
        ) : (
          <form onSubmit={handleCreateBatch} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", marginBottom: 8 }}>Label Type</div>
              <div style={{ display: "flex", gap: 10 }}>
                {(["pack_gtin", "sscc", "both"] as LabelMode[]).map(m => {
                  const labels: Record<LabelMode, string> = { pack_gtin: "GTIN Only", sscc: "SSCC Only", both: "GTIN + SSCC" };
                  const active = labelMode === m;
                  return (
                    <button key={m} type="button" onClick={() => setLabelMode(m)}
                      style={{ padding: "6px 16px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer",
                        border: `2px solid ${active ? TH.primary : TH.border}`,
                        background: active ? TH.accent : "#fff",
                        color: active ? TH.primary : TH.textSub }}>
                      {labels[m]}
                    </button>
                  );
                })}
              </div>
              {labelMode !== "pack_gtin" && (
                <div style={{ marginTop: 6, fontSize: 11, color: TH.textMuted }}>
                  SSCC-18 carton numbers will be generated and reserved atomically.
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
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
            </div>
          </form>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, alignItems: "start" }}>
        {/* ── Batch list ──────────────────────────────────────────────────── */}
        <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${TH.border}` }}>
            <h3 style={{ margin: 0, fontSize: 14, color: TH.textSub }}>Batches ({batches.length})</h3>
          </div>
          {batchLoading && !currentBatch
            ? <p style={{ padding: 16, color: TH.textMuted, fontSize: 13 }}>Loading…</p>
            : batches.length === 0
              ? <p style={{ padding: 16, color: TH.textMuted, fontSize: 13 }}>No batches yet.</p>
              : batches.map(b => (
                <div key={b.id} onClick={() => handleSelectBatch(b)}
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

        {/* ── Batch detail ─────────────────────────────────────────────────── */}
        <div>
          {!currentBatch ? (
            <div style={{ background: TH.surface, borderRadius: 10, padding: 24, boxShadow: `0 1px 4px ${TH.shadow}`, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
              Select a batch on the left to view and export.
            </div>
          ) : (
            <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "hidden" }}>
              {/* Batch header */}
              <div style={{ padding: "16px 20px", borderBottom: `1px solid ${TH.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <h3 style={{ margin: 0, fontSize: 16 }}>{currentBatch.batch_name}</h3>
                      <span style={modeBadge(batchMode)}>
                        {{ pack_gtin: "GTIN Only", sscc: "SSCC Only", both: "GTIN + SSCC" }[batchMode]}
                      </span>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 8, background: currentBatch.status === "printed" ? "#F0FFF4" : TH.surfaceHi, color: currentBatch.status === "printed" ? "#276749" : TH.textMuted, fontWeight: 600 }}>
                        {currentBatch.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: TH.textMuted }}>
                      {batchLines.length} lines · {uniqueGtins} GTINs ·{" "}
                      <strong style={{ color: TH.primary }}>{totalLabels.toLocaleString()} labels</strong>
                      {hasSSCC && totalCartons > 0 && <> · <strong style={{ color: "#276749" }}>{totalCartons.toLocaleString()} cartons</strong></>}
                    </div>
                  </div>
                  <button onClick={clearCurrentBatch}
                    style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "5px 12px", fontSize: 13, cursor: "pointer" }}>
                    ✕
                  </button>
                </div>
              </div>

              {/* ── Template selector ─────────────────────────────────────── */}
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${TH.border}`, background: TH.surfaceHi }}>
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
                  {batchMode !== "sscc" && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", marginBottom: 4 }}>GTIN Label Template</div>
                      <select value={gtinTemplateId}
                        onChange={e => setGtinTemplateId(e.target.value)}
                        style={{ padding: "5px 8px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 12, minWidth: 200 }}>
                        <option value="">— Built-in default —</option>
                        {gtinTemplateOptions.map(t => (
                          <option key={t.id} value={t.id}>{t.template_name} ({t.printer_type})</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {hasSSCC && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", marginBottom: 4 }}>SSCC Label Template</div>
                      <select value={ssccTemplateId}
                        onChange={e => setSsccTemplateId(e.target.value)}
                        style={{ padding: "5px 8px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 12, minWidth: 200 }}>
                        <option value="">— Built-in default —</option>
                        {ssccTemplateOptions.map(t => (
                          <option key={t.id} value={t.id}>{t.template_name} ({t.printer_type})</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {gtinTemplateOptions.length === 0 && ssccTemplateOptions.length === 0 && (
                    <span style={{ fontSize: 12, color: TH.textMuted }}>
                      Using built-in defaults. &nbsp;
                      <button onClick={() => useGS1Store.getState().setActiveTab("templates")}
                        style={{ border: "none", background: "none", color: TH.primary, cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                        Configure templates →
                      </button>
                    </span>
                  )}
                </div>
              </div>

              {/* ── Validation errors ──────────────────────────────────────── */}
              {validationErrors.length > 0 && (
                <div style={{ margin: "12px 20px 0", background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: TH.primary, marginBottom: 6 }}>Print validation failed:</div>
                  {validationErrors.map((e, i) => <div key={i} style={{ fontSize: 12, color: TH.primary }}>{e}</div>)}
                </div>
              )}

              {/* ── Print actions ──────────────────────────────────────────── */}
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${TH.border}`, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={() => { setValidationErrors([]); runPrint("pdf", false); }}
                  style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Print PDF
                </button>
                <button onClick={() => { setValidationErrors([]); runPrint("zpl", false); }}
                  style={{ background: TH.header, color: "#fff", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  ↓ Download ZPL
                </button>
                <button onClick={() => { setValidationErrors([]); runPrint("csv", false); }}
                  style={{ background: "#553C9A", color: "#fff", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  ↓ Download CSV
                </button>
                {currentBatch.status !== "printed" && (
                  <button onClick={() => updateBatchStatus(currentBatch.id, "printed")}
                    style={{ background: "transparent", border: `1px solid #276749`, color: "#276749", borderRadius: 7, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}>
                    Mark Printed
                  </button>
                )}
                <div style={{ flexGrow: 1 }} />
                <button onClick={() => { setShowReprint(v => !v); setValidationErrors([]); }}
                  style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: showReprint ? 600 : 400 }}>
                  ↺ Reprint…
                </button>
              </div>

              {/* ── Reprint form ───────────────────────────────────────────── */}
              {showReprint && (
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${TH.border}`, background: "#FFFBEB" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: TH.text, marginBottom: 10 }}>Reprint</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", marginBottom: 4 }}>Output Method</div>
                      <select value={reprintMethod} onChange={e => setReprintMethod(e.target.value as "pdf"|"zpl"|"csv")}
                        style={{ padding: "6px 8px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }}>
                        <option value="pdf">PDF (browser print)</option>
                        <option value="zpl">ZPL file (Zebra)</option>
                        <option value="csv">CSV file</option>
                      </select>
                    </div>
                    <div style={{ flexGrow: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", marginBottom: 4 }}>Reason (optional)</div>
                      <input value={reprintReason} onChange={e => setReprintReason(e.target.value)}
                        placeholder="e.g. labels damaged, wrong printer"
                        style={{ width: "100%", padding: "6px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }} />
                    </div>
                    <button onClick={() => { setValidationErrors([]); runPrint(reprintMethod, true, reprintReason || undefined); }}
                      style={{ background: "#D69E2E", color: "#fff", border: "none", borderRadius: 7, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                      Reprint
                    </button>
                    <button onClick={() => setShowReprint(false)}
                      style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "8px 12px", fontSize: 13, cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* ── Lines table ────────────────────────────────────────────── */}
              {batchLoading
                ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>Loading lines…</p>
                : batchLines.length === 0
                  ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>No lines in this batch.</p>
                  : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            {[
                              "Style No", "Color", "Scale",
                              ...(batchMode !== "sscc" ? ["Pack GTIN", "GTIN Human"] : []),
                              "Channel", "Cartons",
                              ...(hasSSCC ? ["SSCC First", "SSCC Last"] : []),
                            ].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {batchLines.map(l => (
                            <tr key={l.id}>
                              <td style={TD_STYLE}>{l.style_no}</td>
                              <td style={TD_STYLE}>{l.color}</td>
                              <td style={{ ...TD_STYLE, fontWeight: 700 }}>{l.scale_code}</td>
                              {batchMode !== "sscc" && <>
                                <td style={{ ...TD_STYLE, fontFamily: "monospace", fontWeight: 600 }}>{l.pack_gtin}</td>
                                <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 11, color: TH.textMuted }}>{formatGtin14Display(l.pack_gtin)}</td>
                              </>}
                              <td style={{ ...TD_STYLE, color: TH.textMuted }}>{l.source_channel ?? "—"}</td>
                              <td style={{ ...TD_STYLE, fontWeight: 700, color: TH.primary, fontSize: 15 }}>{l.label_qty.toLocaleString()}</td>
                              {hasSSCC && <>
                                <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 11 }}>{l.sscc_first ?? "—"}</td>
                                <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 11 }}>{l.sscc_last ?? "—"}</td>
                              </>}
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ background: TH.surfaceHi }}>
                            <td colSpan={hasSSCC ? (batchMode !== "sscc" ? 8 : 6) : (batchMode !== "sscc" ? 6 : 4)}
                              style={{ ...TD_STYLE, fontWeight: 700, textAlign: "right", borderTop: `2px solid ${TH.border}` }}>
                              Total:
                            </td>
                            <td style={{ ...TD_STYLE, fontWeight: 700, color: TH.primary, fontSize: 15, borderTop: `2px solid ${TH.border}` }}>
                              {totalLabels.toLocaleString()}
                            </td>
                            {hasSSCC && <td colSpan={2} style={{ ...TD_STYLE, borderTop: `2px solid ${TH.border}` }} />}
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )
              }

              {/* ── Print log ──────────────────────────────────────────────── */}
              <PrintLogSection logs={printLogs} loading={printLogsLoading} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Print log section ─────────────────────────────────────────────────────────

function PrintLogSection({ logs, loading }: { logs: import("../types").LabelPrintLog[]; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!loading && logs.length === 0) return null;

  const METHOD_LABEL: Record<string, string> = { pdf: "PDF", zpl: "ZPL", csv: "CSV", zebra_zpl: "ZPL" };
  const STATUS_STYLE: Record<string, React.CSSProperties> = {
    printed: { color: "#276749", fontWeight: 700 },
    reprint: { color: "#D69E2E", fontWeight: 700 },
    failed:  { color: TH.primary, fontWeight: 700 },
  };

  return (
    <div style={{ borderTop: `1px solid ${TH.border}` }}>
      <button onClick={() => setExpanded(v => !v)}
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "12px 20px", width: "100%", background: TH.surfaceHi, border: "none", cursor: "pointer", fontSize: 13, color: TH.textSub, fontWeight: 600, textAlign: "left" }}>
        <span>{expanded ? "▾" : "▸"}</span>
        Print History ({logs.length} event{logs.length !== 1 ? "s" : ""})
      </button>
      {expanded && (
        loading
          ? <p style={{ padding: "8px 20px", color: TH.textMuted, fontSize: 13 }}>Loading…</p>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Date", "Type", "Method", "Labels", "Status", "Reason"].map(h =>
                    <th key={h} style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, textAlign: "left", textTransform: "uppercase" }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id}>
                    <td style={{ padding: "6px 12px", fontSize: 12, borderBottom: `1px solid ${TH.border}` }}>
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: "6px 12px", fontSize: 12, borderBottom: `1px solid ${TH.border}` }}>
                      {log.label_type === "pack_gtin" ? "GTIN" : "SSCC"}
                    </td>
                    <td style={{ padding: "6px 12px", fontSize: 12, borderBottom: `1px solid ${TH.border}` }}>
                      {METHOD_LABEL[log.print_method ?? ""] ?? log.print_method ?? "—"}
                    </td>
                    <td style={{ padding: "6px 12px", fontSize: 12, fontWeight: 600, borderBottom: `1px solid ${TH.border}` }}>
                      {log.labels_printed.toLocaleString()}
                    </td>
                    <td style={{ padding: "6px 12px", fontSize: 12, borderBottom: `1px solid ${TH.border}`, ...(STATUS_STYLE[log.status] ?? {}) }}>
                      {log.status}
                    </td>
                    <td style={{ padding: "6px 12px", fontSize: 12, color: TH.textMuted, borderBottom: `1px solid ${TH.border}` }}>
                      {log.reprint_reason ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}
    </div>
  );
}
