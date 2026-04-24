import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import type { LabelTemplate, LabelTemplateInput, HumanReadableFields, PrinterType, LabelTemplateType } from "../types";

// ── Styles ─────────────────────────────────────────────────────────────────────
const SECTION: React.CSSProperties = {
  background: TH.surface, borderRadius: 10, padding: "20px 24px",
  boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20,
};
const FIELD: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 };
const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", letterSpacing: "0.04em" };
const INPUT: React.CSSProperties = { padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, color: TH.text, background: "#fff", outline: "none" };
const SELECT: React.CSSProperties = { ...INPUT };
const TH_STYLE: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase" };
const TD_STYLE: React.CSSProperties = { padding: "8px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

const PRINTER_LABELS: Record<PrinterType, string> = {
  pdf: "PDF (browser print)",
  zebra_zpl: "Zebra ZPL (download .zpl)",
  csv: "CSV (label software)",
};
const BARCODE_LABELS: Record<string, string> = {
  gtin14: "GS1-128 with AI (01) — GTIN-14",
  sscc18: "GS1-128 with AI (00) — SSCC-18",
  code128: "Code 128 (plain)",
};

const DEFAULT_FIELDS: HumanReadableFields = {
  show_style: true, show_color: true, show_scale: true, show_channel: true,
  show_po: true,    show_carton: true, show_units: true,
};

function blankForm(labelType: LabelTemplateType = "pack_gtin"): LabelTemplateInput {
  return {
    label_type:            labelType,
    template_name:         "",
    label_width:           "4",
    label_height:          "6",
    printer_type:          "pdf",
    barcode_format:        labelType === "sscc" ? "sscc18" : "gtin14",
    human_readable_fields: { ...DEFAULT_FIELDS },
    is_default:            false,
  };
}

function typeBadge(t: LabelTemplate): React.ReactNode {
  const map: Record<LabelTemplateType, { bg: string; color: string; label: string }> = {
    pack_gtin: { bg: "#EBF8FF", color: "#2B6CB0", label: "Pack GTIN" },
    sscc:      { bg: "#F0FFF4", color: "#276749", label: "SSCC" },
  };
  const s = map[t.label_type];
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: s.bg, color: s.color }}>{s.label}</span>;
}

export default function LabelTemplatesPanel() {
  const {
    labelTemplates, templateLoading, templateError,
    loadLabelTemplates, saveLabelTemplate, updateLabelTemplate,
    deleteLabelTemplate, setDefaultTemplate, seedDefaultTemplates,
  } = useGS1Store();

  const [editing, setEditing]   = useState<LabelTemplate | null>(null);
  const [form, setForm]         = useState<LabelTemplateInput>(blankForm());
  const [showNew, setShowNew]   = useState(false);
  const [saveMsg, setSaveMsg]   = useState("");
  const [newType, setNewType]   = useState<LabelTemplateType>("pack_gtin");

  useEffect(() => { loadLabelTemplates(); }, []);

  function openNew() {
    setEditing(null);
    setForm(blankForm(newType));
    setShowNew(true);
    setSaveMsg("");
  }

  function openEdit(t: LabelTemplate) {
    setEditing(t);
    setForm({
      label_type:            t.label_type,
      template_name:         t.template_name,
      label_width:           t.label_width   ?? "4",
      label_height:          t.label_height  ?? "6",
      printer_type:          t.printer_type,
      barcode_format:        t.barcode_format,
      human_readable_fields: t.human_readable_fields ?? { ...DEFAULT_FIELDS },
      is_default:            t.is_default,
    });
    setShowNew(true);
    setSaveMsg("");
  }

  function cancelForm() {
    setShowNew(false);
    setEditing(null);
    setSaveMsg("");
  }

  function setField<K extends keyof LabelTemplateInput>(k: K, v: LabelTemplateInput[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function setHrField(k: keyof HumanReadableFields, v: boolean) {
    setForm(f => ({ ...f, human_readable_fields: { ...f.human_readable_fields, [k]: v } }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveMsg("");
    try {
      if (editing) {
        await updateLabelTemplate(editing.id, form);
      } else {
        await saveLabelTemplate(form);
      }
      setSaveMsg("✓ Saved");
      setShowNew(false);
      setEditing(null);
    } catch (err) {
      setSaveMsg(`Error: ${(err as Error).message}`);
    }
  }

  async function handleDelete(t: LabelTemplate) {
    if (!confirm(`Delete template "${t.template_name}"?`)) return;
    await deleteLabelTemplate(t.id);
  }

  async function handleSetDefault(t: LabelTemplate) {
    await setDefaultTemplate(t.id, t.label_type);
  }

  async function handleSeedDefaults() {
    await seedDefaultTemplates();
    setSaveMsg("✓ Default templates created");
  }

  const hr = form.human_readable_fields ?? DEFAULT_FIELDS;
  const isGtin = form.label_type === "pack_gtin";
  const isSscc = form.label_type === "sscc";

  const gtinTemplates = labelTemplates.filter(t => t.label_type === "pack_gtin");
  const ssccTemplates = labelTemplates.filter(t => t.label_type === "sscc");

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Label Templates</h2>
          <p style={{ margin: 0, color: TH.textMuted, fontSize: 13 }}>
            Configure label layouts for Pack GTIN and SSCC carton labels. One template per type can be marked as default.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {labelTemplates.length === 0 && (
            <button onClick={handleSeedDefaults} disabled={templateLoading}
              style={{ background: TH.header, color: "#fff", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Create Defaults
            </button>
          )}
          {!showNew && (
            <button onClick={openNew}
              style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              + New Template
            </button>
          )}
        </div>
      </div>

      {templateError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {templateError}
        </div>
      )}

      {/* ── Create / Edit form ─────────────────────────────────────────────── */}
      {showNew && (
        <div style={{ ...SECTION, border: `2px solid ${TH.primary}` }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 15, color: TH.textSub, fontWeight: 600 }}>
            {editing ? `Edit "${editing.template_name}"` : "New Template"}
          </h3>
          <form onSubmit={handleSave}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={FIELD}>
                <label style={LABEL}>Label Type</label>
                <select style={SELECT} value={form.label_type}
                  onChange={e => { const v = e.target.value as LabelTemplateType; setField("label_type", v); setField("barcode_format", v === "sscc" ? "sscc18" : "gtin14"); }}
                  disabled={!!editing}>
                  <option value="pack_gtin">Pack GTIN</option>
                  <option value="sscc">SSCC Carton</option>
                </select>
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Template Name</label>
                <input style={INPUT} value={form.template_name} onChange={e => setField("template_name", e.target.value)} required placeholder="e.g. Standard 4×6 PDF" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Label Width (inches)</label>
                <input style={INPUT} value={form.label_width} onChange={e => setField("label_width", e.target.value)} placeholder="4" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Label Height (inches)</label>
                <input style={INPUT} value={form.label_height} onChange={e => setField("label_height", e.target.value)} placeholder="6" />
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Output Type</label>
                <select style={SELECT} value={form.printer_type} onChange={e => setField("printer_type", e.target.value as PrinterType)}>
                  {(Object.entries(PRINTER_LABELS) as [PrinterType, string][]).map(([v, l]) =>
                    <option key={v} value={v}>{l}</option>
                  )}
                </select>
              </div>
              <div style={FIELD}>
                <label style={LABEL}>Barcode Format</label>
                <select style={SELECT} value={form.barcode_format} onChange={e => setField("barcode_format", e.target.value)}>
                  {Object.entries(BARCODE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>

            {/* Human readable field checkboxes */}
            <div style={{ marginTop: 8, marginBottom: 16 }}>
              <div style={LABEL}>Human-Readable Fields to Show</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", marginTop: 8 }}>
                {isGtin && <>
                  <CheckRow label="Style No"  checked={hr.show_style}   onChange={v => setHrField("show_style", v)} />
                  <CheckRow label="Color"     checked={hr.show_color}   onChange={v => setHrField("show_color", v)} />
                  <CheckRow label="Scale"     checked={hr.show_scale}   onChange={v => setHrField("show_scale", v)} />
                  <CheckRow label="Channel"   checked={hr.show_channel} onChange={v => setHrField("show_channel", v)} />
                </>}
                {isSscc && <>
                  <CheckRow label="Style No"  checked={hr.show_style}   onChange={v => setHrField("show_style", v)} />
                  <CheckRow label="Color"     checked={hr.show_color}   onChange={v => setHrField("show_color", v)} />
                  <CheckRow label="PO Number" checked={hr.show_po}      onChange={v => setHrField("show_po", v)} />
                  <CheckRow label="Carton #"  checked={hr.show_carton}  onChange={v => setHrField("show_carton", v)} />
                  <CheckRow label="Total Units" checked={hr.show_units} onChange={v => setHrField("show_units", v)} />
                </>}
              </div>
            </div>

            <div style={FIELD}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={form.is_default} onChange={e => setField("is_default", e.target.checked)} style={{ width: 15, height: 15 }} />
                <span style={{ fontSize: 13 }}>Set as default for {form.label_type === "pack_gtin" ? "Pack GTIN" : "SSCC"} labels</span>
              </label>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button type="submit" disabled={templateLoading}
                style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                {templateLoading ? "Saving…" : editing ? "Update Template" : "Save Template"}
              </button>
              <button type="button" onClick={cancelForm}
                style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
              {saveMsg && <span style={{ alignSelf: "center", fontSize: 13, fontWeight: 600, color: saveMsg.startsWith("Error") ? TH.primary : "#276749" }}>{saveMsg}</span>}
            </div>
          </form>
        </div>
      )}

      {/* ── GTIN templates list ───────────────────────────────────────────── */}
      <TemplateGroup
        title="Pack GTIN Label Templates"
        templates={gtinTemplates}
        loading={templateLoading}
        onEdit={openEdit}
        onDelete={handleDelete}
        onSetDefault={handleSetDefault}
      />

      {/* ── SSCC templates list ───────────────────────────────────────────── */}
      <TemplateGroup
        title="SSCC Carton Label Templates"
        templates={ssccTemplates}
        loading={templateLoading}
        onEdit={openEdit}
        onDelete={handleDelete}
        onSetDefault={handleSetDefault}
      />

      {labelTemplates.length === 0 && !templateLoading && !showNew && (
        <div style={{ textAlign: "center", color: TH.textMuted, fontSize: 13, padding: "40px 0" }}>
          No templates yet. Click <strong>Create Defaults</strong> for sensible starting points or <strong>+ New Template</strong> to build custom layouts.
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 13, height: 13 }} />
      {label}
    </label>
  );
}

function TemplateGroup({
  title, templates, loading,
  onEdit, onDelete, onSetDefault,
}: {
  title: string;
  templates: LabelTemplate[];
  loading: boolean;
  onEdit: (t: LabelTemplate) => void;
  onDelete: (t: LabelTemplate) => void;
  onSetDefault: (t: LabelTemplate) => void;
}) {
  const TH_STYLE: React.CSSProperties = {
    padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 600,
    color: TH.textSub2, background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`,
    textTransform: "uppercase",
  };
  const TD: React.CSSProperties = { padding: "8px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

  return (
    <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: `1px solid ${TH.border}` }}>
        <h3 style={{ margin: 0, fontSize: 14, color: TH.textSub, fontWeight: 600 }}>{title}</h3>
      </div>
      {loading && templates.length === 0
        ? <p style={{ padding: 16, color: TH.textMuted, fontSize: 13 }}>Loading…</p>
        : templates.length === 0
          ? <p style={{ padding: 16, color: TH.textMuted, fontSize: 13 }}>No templates yet.</p>
          : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Template Name", "Size", "Output", "Barcode", "Default", ""].map(h =>
                    <th key={h} style={TH_STYLE}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {templates.map(t => (
                  <tr key={t.id} style={{ background: t.is_default ? "#F0FFF4" : "transparent" }}>
                    <td style={TD}><strong>{t.template_name}</strong></td>
                    <td style={TD}>{t.label_width ? `${t.label_width}×${t.label_height}"` : "—"}</td>
                    <td style={TD}>{PRINTER_LABELS[t.printer_type] ?? t.printer_type}</td>
                    <td style={{ ...TD, fontSize: 11, color: TH.textMuted }}>
                      {BARCODE_LABELS[t.barcode_format] ?? t.barcode_format}
                    </td>
                    <td style={TD}>
                      {t.is_default
                        ? <span style={{ color: "#276749", fontWeight: 700, fontSize: 12 }}>✓ Default</span>
                        : <button onClick={() => onSetDefault(t)} style={{ fontSize: 11, border: `1px solid ${TH.border}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer", background: "transparent" }}>Set Default</button>
                      }
                    </td>
                    <td style={TD}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => onEdit(t)}
                          style={{ fontSize: 12, border: `1px solid ${TH.border}`, borderRadius: 4, padding: "3px 10px", cursor: "pointer", background: "transparent" }}>
                          Edit
                        </button>
                        <button onClick={() => onDelete(t)}
                          style={{ fontSize: 12, border: `1px solid ${TH.accentBdr}`, borderRadius: 4, padding: "3px 10px", cursor: "pointer", background: "transparent", color: TH.primary }}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      }
    </div>
  );
}
