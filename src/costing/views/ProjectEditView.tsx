// Costing Module — project edit view.
// PlanFlowWidget (stage strip + project status badge) on top, then the
// header form, then CostingGrid, then VendorQuotePanel (toggled by selecting
// a grid row).

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { navigate, getEditId } from "../helpers";
import type { CostingProjectPatch } from "../types";
import CostingGrid from "../panels/CostingGrid";
import PlanFlowWidget from "../panels/PlanFlowWidget";
import CompliancePanel from "../panels/CompliancePanel";
import CustomerPickerCell from "../panels/CustomerPickerCell";
import SalesRepPickerCell from "../panels/SalesRepPickerCell";
import { customerDisplayName, listPaymentTerms, type PaymentTermHit } from "../services/costingApi";
import ExportButton from "../../tanda/exports/ExportButton";
import { buildExportRows, COSTING_EXPORT_COLUMNS, buildExportFilename } from "../services/exportService";
import { sbLoad as sbLoadSvc } from "../../store/supabaseService";
import { tabStyle } from "./tabStyle";

// Same vocab as the rest of the suite (utils/constants.ts GENDERS) + Child.
const GENDER_OPTIONS = ["Men's", "Women's", "Boys", "Girls", "Child"];

interface BrandRow { id: string; name: string; color?: string }

// Facet tabs for the project editor (Tanda PO-detail fused-tab model). The
// Details form + PlanFlow strip stay persistent above the tabs as a page
// header; only the work surfaces below are tabbed. "All" stacks them.
type EditTab = "grid" | "compliance" | "all";
const EDIT_TABS: { key: EditTab; label: string }[] = [
  { key: "grid",       label: "Costing Grid" },
  { key: "compliance", label: "Compliance" },
  { key: "all",        label: "All" },
];

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
  const [tab, setTab] = useState<EditTab>("grid");
  const [saving, setSaving] = useState(false);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermHit[]>([]);
  // Tracks whether the local form differs from the project on the server —
  // drives the Discard button's enabled state.
  const dirty = !!project && Object.keys(form).some((k) => {
    const v1 = (form as Record<string, unknown>)[k];
    const v2 = (project as unknown as Record<string, unknown>)[k];
    return v1 !== v2;
  });

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

  // Load Tangerine payment terms for the project-level dropdown (Task 10).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listPaymentTerms();
        if (!cancelled && Array.isArray(rows)) setPaymentTerms(rows);
      } catch { /* swallow; dropdown just stays at "(select)" */ }
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
        payment_terms_id: project.payment_terms_id,
        payment_terms_name: project.payment_terms_name,
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

  // Debounced autosave — fires 800ms after the last field change so a
  // sequence of edits coalesces into one PUT. No Save button anymore.
  React.useEffect(() => {
    if (!id || !dirty) return;
    const t = window.setTimeout(async () => {
      setSaving(true);
      try { await update(id, form); }
      catch (e) { useCostingStore.getState().setNotice(`Auto-save failed: ${(e as Error).message}`); }
      finally { setSaving(false); }
    }, 800);
    return () => window.clearTimeout(t);
  }, [form, id, dirty, update]);

  const onDiscard = () => {
    if (!project) return;
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
      payment_terms_id: project.payment_terms_id,
      payment_terms_name: project.payment_terms_name,
    });
  };

  const setField = <K extends keyof CostingProjectPatch>(k: K, v: CostingProjectPatch[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  // Status is per LINE now (set in the grid), not per project — no project-level
  // status control or auto-advance here anymore.

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {project?.project_name || "Loading…"}
        </h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{
            fontSize: 11, color: saving ? "#FBBF24" : dirty ? "#94A3B8" : "#10B981",
            fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase",
          }}>
            {saving ? "Saving…" : dirty ? "Unsaved" : "✓ Saved"}
          </span>
          <ExportButton
            rows={exportRows as unknown as Record<string, unknown>[]}
            columns={COSTING_EXPORT_COLUMNS as unknown as never}
            filename={buildExportFilename(project)}
            sheetName="Costing"
          />
          <button
            onClick={onDiscard}
            disabled={!dirty || saving}
            style={{
              background: "transparent", color: dirty ? "#F87171" : "#475569",
              border: `1px solid ${dirty ? "#F87171" : "#334155"}`,
              padding: "6px 14px", borderRadius: 4,
              cursor: dirty ? "pointer" : "not-allowed",
              fontSize: 13, fontWeight: 600, opacity: dirty ? 1 : 0.55,
            }}
            title={dirty ? "Discard unsaved changes" : "No changes to discard"}
          >Discard</button>
        </div>
      </div>

      {error && <div style={{ color: "#F87171", fontSize: 13, padding: 8, background: "#7F1D1D33", borderRadius: 4, marginBottom: 12 }}>{error}</div>}

      {/* Details — always-visible page header (no "Details" label, not a tab). */}
      <div style={{
        background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
        padding: "14px 16px", marginBottom: 12, maxWidth: 880, display: "grid",
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

        <Field label="Customer">
          <CustomerPickerCell
            // Use the joined customer record's display name (name → company → code)
            // rather than the raw UUID so the operator sees something readable.
            value={customerDisplayName(project?.customer as never) || null}
            onPick={(c) => setField("customer_id", c.id)}
            onClear={() => setField("customer_id", null)}
            inputStyle={inp}
          />
        </Field>
        <Field label="Sales rep">
          <SalesRepPickerCell
            value={project?.sales_rep?.display_name || null}
            onPick={(r) => setField("sales_rep_id", r.id)}
            onClear={() => setField("sales_rep_id", null)}
            inputStyle={inp}
          />
        </Field>
        <Field label="Payment terms">
          <select
            value={form.payment_terms_id || ""}
            onChange={(e) => {
              const ptId = e.target.value || null;
              const pt = paymentTerms.find((p) => p.id === ptId) || null;
              // Stamp both the FK and the name snapshot in one update so the
              // grid's DDP detection (matches /DDP/i on payment_terms_name)
              // updates immediately.
              setForm((f) => ({
                ...f,
                payment_terms_id: ptId,
                payment_terms_name: pt ? pt.name : null,
              }));
            }}
            style={inp}
          >
            <option value="">(select)</option>
            {paymentTerms.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>

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

      {/* Collapsible stage strip — sits below the Details header. */}
      <PlanFlowWidget />

      {/* Facet tab strip — fused into the panel below (Tanda PO-detail model). */}
      <div style={{ display: "flex", gap: 2, marginTop: 0, marginBottom: 0 }}>
        {EDIT_TABS.map((t) => (
          <button key={t.key} style={tabStyle(t.key === tab)} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{
        border: "1px solid #334155", borderTop: "none", borderRadius: "0 0 10px 10px",
        background: "#1E293B", padding: 16,
      }}>

      {/* Costing Grid */}
      <div style={{ display: (tab === "grid" || tab === "all") ? "block" : "none" }}>
        <CostingGrid />
      </div>

      {/* Compliance */}
      <div style={{ display: (tab === "compliance" || tab === "all") ? "block" : "none" }}>
        <CompliancePanel />
      </div>

      </div>
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
