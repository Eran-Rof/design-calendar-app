import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import { formatSscc18Display } from "../services/gtinService";
import { exportSsccCsv } from "../services/labelExport";
import type { ManualCartonInput } from "../types";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = {
  padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}`,
};
const FIELD: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 };
const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", letterSpacing: "0.04em" };
const INPUT: React.CSSProperties = {
  padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6,
  fontSize: 13, color: TH.text, background: "#fff", outline: "none",
};

const EMPTY_FORM: ManualCartonInput = {
  upload_id: "",
  po_number: "",
  carton_no: "",
  channel: "",
  style_no: "",
  color: "",
  total_packs: undefined,
  total_units: undefined,
};

export default function CartonPanel() {
  const {
    allCartons, cartonLoading, cartonError, lastCreatedSscc,
    uploads, companySettings,
    loadAllCartons, loadUploads, loadCompanySettings,
    createManualSscc, clearLastCreatedSscc,
  } = useGS1Store();

  const [form, setForm] = useState<ManualCartonInput>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    loadAllCartons();
    loadUploads();
    if (!companySettings) loadCompanySettings();
  }, []);

  function set<K extends keyof ManualCartonInput>(field: K, value: ManualCartonInput[K]) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError("");
    clearLastCreatedSscc();
    try {
      await createManualSscc({
        ...form,
        upload_id:   form.upload_id   || undefined,
        po_number:   form.po_number   || undefined,
        carton_no:   form.carton_no   || undefined,
        channel:     form.channel     || undefined,
        style_no:    form.style_no    || undefined,
        color:       form.color       || undefined,
      });
      setForm(EMPTY_FORM);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const statusColor = (s: string) => {
    const map: Record<string, string> = { generated: "#276749", shipped: "#2B6CB0", received: "#553C9A", cancelled: TH.primary };
    return map[s] ?? TH.textMuted;
  };
  const statusBg = (s: string) => {
    const map: Record<string, string> = { generated: "#F0FFF4", shipped: "#EBF8FF", received: "#FAF5FF", cancelled: "#FFF5F5" };
    return map[s] ?? TH.surfaceHi;
  };

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Carton SSCC Labels</h2>
      <p style={{ margin: "0 0 24px", color: TH.textMuted, fontSize: 13 }}>
        Generate an SSCC-18 for a physical carton. SSCCs are assigned from your company&apos;s serial reference counter.
        For batch generation from a packing list, use the Label Batches tab.
      </p>

      {!companySettings && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
          Company Setup must be saved (with SSCC settings) before generating SSCCs.
        </div>
      )}

      {cartonError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {cartonError}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 24, alignItems: "start" }}>

        {/* ── Create form ─────────────────────────────────────────────────────── */}
        <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}` }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 15, color: TH.textSub }}>Create Carton</h3>

          {lastCreatedSscc && (
            <div style={{ background: "#F0FFF4", border: "1px solid #C6F6D5", borderRadius: 8, padding: "12px 16px", marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 4 }}>SSCC Generated:</div>
              <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 18, letterSpacing: "0.04em" }}>
                {lastCreatedSscc}
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 12, color: TH.textMuted, marginTop: 4 }}>
                {formatSscc18Display(lastCreatedSscc)}
              </div>
            </div>
          )}

          <form onSubmit={handleCreate}>
            <div style={FIELD}>
              <label style={LABEL}>Packing List Upload (optional)</label>
              <select style={INPUT} value={form.upload_id ?? ""} onChange={e => set("upload_id", e.target.value || undefined)}>
                <option value="">— None —</option>
                {uploads.map(u => (
                  <option key={u.id} value={u.id}>{u.file_name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={FIELD}>
                <label style={LABEL}>PO Number</label>
                <input style={INPUT} value={form.po_number ?? ""} onChange={e => set("po_number", e.target.value)} placeholder="e.g. PO-12345" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Carton No</label>
                <input style={INPUT} value={form.carton_no ?? ""} onChange={e => set("carton_no", e.target.value)} placeholder="e.g. 001" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Style No</label>
                <input style={INPUT} value={form.style_no ?? ""} onChange={e => set("style_no", e.target.value)} placeholder="e.g. 100227091BK" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Color</label>
                <input style={INPUT} value={form.color ?? ""} onChange={e => set("color", e.target.value)} placeholder="e.g. BLACK" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Channel</label>
                <input style={INPUT} value={form.channel ?? ""} onChange={e => set("channel", e.target.value)} placeholder="e.g. HAF" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Total Packs</label>
                <input style={INPUT} type="number" min={1} value={form.total_packs ?? ""}
                  onChange={e => set("total_packs", e.target.value ? parseInt(e.target.value) : undefined)} />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Total Units</label>
                <input style={INPUT} type="number" min={1} value={form.total_units ?? ""}
                  onChange={e => set("total_units", e.target.value ? parseInt(e.target.value) : undefined)} />
              </div>
            </div>

            {submitError && (
              <div style={{ fontSize: 12, color: TH.primary, marginBottom: 12 }}>{submitError}</div>
            )}

            <button
              type="submit"
              disabled={submitting || !companySettings}
              style={{
                width: "100%", background: "#276749", color: "#fff", border: "none",
                borderRadius: 8, padding: "10px 0", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}
            >
              {submitting ? "Generating SSCC…" : "Create Carton & Generate SSCC"}
            </button>
          </form>

          {/* SSCC format reference */}
          <div style={{ marginTop: 20, padding: "12px 14px", background: TH.surfaceHi, borderRadius: 8, fontSize: 11, color: TH.textMuted }}>
            <strong style={{ display: "block", marginBottom: 4, color: TH.textSub }}>SSCC-18 Format</strong>
            Extension digit + GS1 Prefix + Serial Reference + Check digit = 18 digits total<br />
            Scanned with AI (00) prefix in GS1-128 / QR systems.
          </div>
        </div>

        {/* ── Carton list ──────────────────────────────────────────────────────── */}
        <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${TH.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: 15, color: TH.textSub }}>Recent Cartons ({allCartons.length})</h3>
            {allCartons.length > 0 && (
              <button
                onClick={() => exportSsccCsv("all_cartons", allCartons)}
                style={{ background: "#553C9A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              >
                ↓ Export All CSV
              </button>
            )}
          </div>

          {cartonLoading
            ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>Loading…</p>
            : allCartons.length === 0
              ? (
                <div style={{ padding: 32, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
                  No cartons yet. Create one using the form, or generate a batch from the Label Batches tab.
                </div>
              )
              : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["SSCC", "Display (00)", "Style", "Color", "Channel", "PO #", "Carton #", "Packs", "Units", "Status", "Date"].map(h => (
                          <th key={h} style={TH_STYLE}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allCartons.map(c => (
                        <tr key={c.id}>
                          <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 11, fontWeight: 600 }}>{c.sscc}</td>
                          <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 11, color: TH.textMuted }}>{formatSscc18Display(c.sscc)}</td>
                          <td style={TD_STYLE}>{c.style_no ?? "—"}</td>
                          <td style={TD_STYLE}>{c.color ?? "—"}</td>
                          <td style={{ ...TD_STYLE, color: TH.textMuted }}>{(c as any).channel ?? "—"}</td>
                          <td style={{ ...TD_STYLE, color: TH.textMuted }}>{c.po_number ?? "—"}</td>
                          <td style={{ ...TD_STYLE, color: TH.textMuted }}>{c.carton_no ?? "—"}</td>
                          <td style={TD_STYLE}>{c.total_packs ?? "—"}</td>
                          <td style={TD_STYLE}>{c.total_units ?? "—"}</td>
                          <td style={TD_STYLE}>
                            <span style={{ background: statusBg(c.status), color: statusColor(c.status), fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10 }}>
                              {c.status}
                            </span>
                          </td>
                          <td style={{ ...TD_STYLE, color: TH.textMuted, fontSize: 11 }}>
                            {new Date(c.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          }
        </div>
      </div>
    </div>
  );
}
