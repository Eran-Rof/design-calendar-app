// Costing Module — project edit view.
// PlanFlowWidget (stage strip + project status badge) on top, then the
// header form, then CostingGrid, then VendorQuotePanel (toggled by selecting
// a grid row).

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { ALL_STATUSES, statusLabel, statusColor, navigate, getEditId } from "../helpers";
import type { CostingStatus, CostingProjectPatch } from "../types";
import CostingGrid from "../panels/CostingGrid";
import VendorQuotePanel from "../panels/VendorQuotePanel";
import PlanFlowWidget from "../panels/PlanFlowWidget";
import CompliancePanel from "../panels/CompliancePanel";
import ExportButton from "../../tanda/exports/ExportButton";
import { buildExportRows, COSTING_EXPORT_COLUMNS, buildExportFilename } from "../services/exportService";
import { sbLoad as sbLoadSvc } from "../../store/supabaseService";

// Same vocab as the rest of the suite (utils/constants.ts GENDERS) + Child.
const GENDER_OPTIONS = ["Men's", "Women's", "Boys", "Girls", "Child"];

interface BrandRow { id: string; name: string; color?: string }

export default function ProjectEditView() {
  const id = getEditId();
  const project = useCostingStore((s) => s.project);
  const lines   = useCostingStore((s) => s.lines);
  const vendorQuotes = useCostingStore((s) => s.vendorQuotes);
  const loading = useCostingStore((s) => s.loading);
  const error   = useCostingStore((s) => s.error);
  const load    = useCostingStore((s) => s.loadProject);
  const update  = useCostingStore((s) => s.updateProject);
  const clear   = useCostingStore((s) => s.clearActive);
  const setStageFilter = useCostingStore((s) => s.setStageFilter);

  const exportRows = React.useMemo(
    () => buildExportRows(lines, vendorQuotes),
    [lines, vendorQuotes],
  );

  const [form, setForm] = useState<CostingProjectPatch>({});
  const [saving, setSaving] = useState(false);
  const [brands, setBrands] = useState<BrandRow[]>([]);

  // Load brands from app_data on mount (same source the other apps use).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await sbLoadSvc("brands");
        if (cancelled) return;
        if (Array.isArray(rows)) setBrands(rows as BrandRow[]);
      } catch { /* swallow; field stays freeform */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!id) { clear(); return; }
    load(id);
    // Reset stage filter when switching projects so the new project's grid
    // starts unfiltered.
    setStageFilter(null);
  }, [id, load, clear, setStageFilter]);

  useEffect(() => {
    if (project) {
      setForm({
        project_name: project.project_name,
        brand: project.brand,
        gender_code: project.gender_code,
        sales_rep_id: project.sales_rep_id,
        customer_id: project.customer_id,
        request_date: project.request_date,
        due_date: project.due_date,
        projected_delivery_date: project.projected_delivery_date,
        status: project.status,
        notes: project.notes,
      });
    }
  }, [project]);

  if (!id) {
    return (
      <div style={{ padding: 24, color: "#E2E8F0", background: "#0F172A", minHeight: "100%" }}>
        <div>No project selected. <a href="#" onClick={(e) => { e.preventDefault(); navigate("list"); }} style={{ color: "#60A5FA" }}>← Back to list</a></div>
      </div>
    );
  }

  const onSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await update(id, form);
    } catch (e) {
      useCostingStore.getState().setNotice(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const setField = <K extends keyof CostingProjectPatch>(k: K, v: CostingProjectPatch[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate("list"); }} style={{ color: "#60A5FA", textDecoration: "none", fontSize: 13 }}>← Projects</a>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {project?.project_name || "Loading…"}
        </h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <ExportButton
            rows={exportRows as unknown as Record<string, unknown>[]}
            columns={COSTING_EXPORT_COLUMNS as unknown as never}
            filename={buildExportFilename(project)}
            sheetName="Costing"
          />
          <button onClick={onSave} disabled={saving || loading} style={{
            background: "#10B981", color: "#fff", border: "none",
            padding: "6px 16px", borderRadius: 4, cursor: saving ? "not-allowed" : "pointer",
            fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1,
          }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      {error && <div style={{ color: "#F87171", fontSize: 13, padding: 8, background: "#7F1D1D33", borderRadius: 4, marginBottom: 12 }}>{error}</div>}

      <PlanFlowWidget />

      <div style={{
        background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
        padding: "14px 16px", maxWidth: 880, display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)", gap: "10px 14px",
      }}>
        <Field label="Project name" span={2}>
          <input value={form.project_name || ""} onChange={(e) => setField("project_name", e.target.value)} style={inp} />
        </Field>
        <Field label="Brand">
          {brands.length > 0 ? (
            <select value={form.brand || ""} onChange={(e) => setField("brand", e.target.value || null)} style={inp}>
              <option value="">— select —</option>
              {brands.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          ) : (
            <input value={form.brand || ""} onChange={(e) => setField("brand", e.target.value)} style={inp} placeholder="(brands loading)" />
          )}
        </Field>
        <Field label="Gender">
          <select value={form.gender_code || ""} onChange={(e) => setField("gender_code", e.target.value || null)} style={inp}>
            <option value="">— select —</option>
            {GENDER_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>

        <Field label="Status">
          {(() => {
            const sc = statusColor((form.status || "draft") as CostingStatus);
            return (
              <select
                value={form.status || "draft"}
                onChange={(e) => setField("status", e.target.value as CostingStatus)}
                style={{ ...inp, background: sc.bg, color: sc.fg, border: `1px solid ${sc.border}`, fontWeight: 600 }}
              >
                {ALL_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            );
          })()}
        </Field>
        <Field label="Customer">
          <input value={form.customer_id || ""} onChange={(e) => setField("customer_id", e.target.value || null)} style={inp} placeholder="autocomplete coming" />
        </Field>
        <Field label="Sales rep">
          <input value={form.sales_rep_id || ""} onChange={(e) => setField("sales_rep_id", e.target.value || null)} style={inp} placeholder="autocomplete coming" />
        </Field>
        <div />

        <Field label="Request date">
          <input type="date" value={form.request_date || ""} onChange={(e) => setField("request_date", e.target.value || null)} style={dateInp} />
        </Field>
        <Field label="Due date">
          <input type="date" value={form.due_date || ""} onChange={(e) => setField("due_date", e.target.value || null)} style={dateInp} />
        </Field>
        <Field label="Projected delivery">
          <input type="date" value={form.projected_delivery_date || ""} onChange={(e) => setField("projected_delivery_date", e.target.value || null)} style={dateInp} />
        </Field>
        <div />

        <Field label="Notes" span={4}>
          <textarea value={form.notes || ""} onChange={(e) => setField("notes", e.target.value || null)} rows={2} style={{ ...inp, fontFamily: "inherit", resize: "vertical" }} />
        </Field>
      </div>

      <CostingGrid />

      <VendorQuotePanel />

      <CompliancePanel />
    </div>
  );
}

function Field({ label, span, children }: { label: string; span?: 1 | 2 | 3 | 4; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", gridColumn: span ? `span ${span}` : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

const inp: React.CSSProperties = {
  width: "100%", background: "#0F172A", color: "#E2E8F0",
  border: "1px solid #334155", borderRadius: 4, padding: "5px 8px", fontSize: 12,
  outline: "none",
};

// Date pickers need color-scheme: dark so the browser-native calendar icon +
// dropdown render in dark mode (otherwise the calendar button is invisible
// on the dark input background).
const dateInp: React.CSSProperties = {
  ...inp,
  colorScheme: "dark",
};
