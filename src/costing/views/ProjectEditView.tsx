// Costing Module — project edit view.
// PlanFlowWidget (stage strip + project status badge) on top, then the
// header form, then CostingGrid, then VendorQuotePanel (toggled by selecting
// a grid row).

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { ALL_STATUSES, statusLabel, navigate, getEditId } from "../helpers";
import type { CostingStatus, CostingProjectPatch } from "../types";
import CostingGrid from "../panels/CostingGrid";
import VendorQuotePanel from "../panels/VendorQuotePanel";
import PlanFlowWidget from "../panels/PlanFlowWidget";

export default function ProjectEditView() {
  const id = getEditId();
  const project = useCostingStore((s) => s.project);
  const loading = useCostingStore((s) => s.loading);
  const error   = useCostingStore((s) => s.error);
  const load    = useCostingStore((s) => s.loadProject);
  const update  = useCostingStore((s) => s.updateProject);
  const clear   = useCostingStore((s) => s.clearActive);
  const setStageFilter = useCostingStore((s) => s.setStageFilter);

  const [form, setForm] = useState<CostingProjectPatch>({});
  const [saving, setSaving] = useState(false);

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
      window.alert(`Save failed: ${(e as Error).message}`);
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
        <div style={{ marginLeft: "auto" }}>
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
        padding: 20, maxWidth: 760, display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)", gap: "14px 18px",
      }}>
        <Field label="Project name">
          <input value={form.project_name || ""} onChange={(e) => setField("project_name", e.target.value)} style={inp} />
        </Field>
        <Field label="Brand">
          <input value={form.brand || ""} onChange={(e) => setField("brand", e.target.value)} style={inp} placeholder="BOYS / GIRLS / MEN / WOMEN / …" />
        </Field>
        <Field label="Gender code">
          <input value={form.gender_code || ""} onChange={(e) => setField("gender_code", e.target.value)} style={inp} placeholder="B / G / M / W" />
        </Field>
        <Field label="Status">
          <select value={form.status || "draft"} onChange={(e) => setField("status", e.target.value as CostingStatus)} style={inp}>
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
        </Field>
        <Field label="Customer ID (uuid)">
          <input value={form.customer_id || ""} onChange={(e) => setField("customer_id", e.target.value || null)} style={inp} placeholder="Autocomplete arrives in Chunk 4" />
        </Field>
        <Field label="Sales rep ID (uuid)">
          <input value={form.sales_rep_id || ""} onChange={(e) => setField("sales_rep_id", e.target.value || null)} style={inp} placeholder="Autocomplete arrives in Chunk 4" />
        </Field>
        <Field label="Request date">
          <input type="date" value={form.request_date || ""} onChange={(e) => setField("request_date", e.target.value || null)} style={inp} />
        </Field>
        <Field label="Due date">
          <input type="date" value={form.due_date || ""} onChange={(e) => setField("due_date", e.target.value || null)} style={inp} />
        </Field>
        <Field label="Projected delivery">
          <input type="date" value={form.projected_delivery_date || ""} onChange={(e) => setField("projected_delivery_date", e.target.value || null)} style={inp} />
        </Field>
        <div />
        <Field label="Notes" wide>
          <textarea value={form.notes || ""} onChange={(e) => setField("notes", e.target.value || null)} rows={3} style={{ ...inp, fontFamily: "inherit" }} />
        </Field>
      </div>

      <CostingGrid />

      <VendorQuotePanel />

      <div style={{ marginTop: 24, padding: 14, background: "#1E293B", border: "1px dashed #334155", borderRadius: 6, color: "#94A3B8", fontSize: 12 }}>
        <b style={{ color: "#CBD5E1" }}>Coming in Chunk 7:</b>{" "}
        Compliance checklist per line · xlsx export of the BOYS-style sheet.
      </div>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", gridColumn: wide ? "1 / span 2" : undefined }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

const inp: React.CSSProperties = {
  width: "100%", background: "#0F172A", color: "#E2E8F0",
  border: "1px solid #334155", borderRadius: 4, padding: "6px 10px", fontSize: 13,
};
