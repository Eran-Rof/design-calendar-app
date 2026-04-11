import React, { useState, useEffect } from "react";
import { TH, appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { DEFAULT_TASK_TEMPLATES, STATUS_CONFIG } from "../utils/constants";
import { SB_URL, SB_KEY } from "../utils/supabase";
import { uid } from "../utils/dates";
import { DEFAULT_WIP_TEMPLATES_DC } from "./VendorManager";

// ─── ADD TASK MODAL ───────────────────────────────────────────────────────────

// ─── TASK MANAGER (Settings) ──────────────────────────────────────────────────
function TaskManager({ taskTemplates, setTaskTemplates, isAdmin, vendors, setVendors }) {
  // Task Manager = Template Manager: defines which phases auto-populate per vendor
  const [editing, setEditing] = useState(null); // null | "new" | template object
  const [form, setForm] = useState(null);

  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage task templates.</div>
    </div>
  );

  const templates = (taskTemplates && taskTemplates.length > 0) ? taskTemplates : DEFAULT_TASK_TEMPLATES;

  const [insertAfter, setInsertAfter] = useState<string>("__end__");

  // Get the effective previous task's daysBeforeDDP given a position value
  function prevDaysForPosition(pos, excludeId?) {
    const tpls = excludeId ? templates.filter(t => t.id !== excludeId) : templates;
    if (pos === "__start__") return null;
    if (pos === "__end__") return tpls[tpls.length - 1]?.daysBeforeDDP ?? null;
    return tpls.find(t => t.id === pos)?.daysBeforeDDP ?? null;
  }

  function startNew() {
    const lastTpl = templates[templates.length - 1];
    const defDuration = 30;
    const defDDP = lastTpl ? Math.max(0, lastTpl.daysBeforeDDP - defDuration) : 0;
    setForm({ id: uid(), phase: "", daysBeforeDDP: defDDP, durationDays: defDuration, status: "Not Started", notes: "" });
    setInsertAfter("__end__");
    setEditing("new");
  }

  function startEdit(tpl) {
    const idx = templates.findIndex(t => t.id === tpl.id);
    const prevTpl = idx > 0 ? templates[idx - 1] : null;
    const durationDays = prevTpl ? Math.max(0, prevTpl.daysBeforeDDP - tpl.daysBeforeDDP) : (tpl.durationDays ?? 30);
    const pos = idx === 0 ? "__start__" : templates[idx - 1].id;
    setForm({ ...tpl, durationDays });
    setInsertAfter(pos);
    setEditing(tpl.id);
  }

  function handlePositionChange(val) {
    setInsertAfter(val);
    if (!form) return;
    const prevD = prevDaysForPosition(val, editing !== "new" ? form.id : undefined);
    if (prevD !== null) {
      const dur = form.durationDays || 30;
      setForm(f => ({ ...f, daysBeforeDDP: Math.max(0, prevD - dur) }));
    }
  }

  function handleDurationChange(n) {
    const prevD = prevDaysForPosition(insertAfter, editing !== "new" ? form.id : undefined);
    const newDDP = prevD !== null ? Math.max(0, prevD - n) : form.daysBeforeDDP;
    setForm(f => ({ ...f, durationDays: n, daysBeforeDDP: newDDP }));
  }

  function handleDDPChange(n) {
    const prevD = prevDaysForPosition(insertAfter, editing !== "new" ? form.id : undefined);
    const newDur = prevD !== null ? Math.max(0, prevD - n) : form.durationDays;
    setForm(f => ({ ...f, daysBeforeDDP: n, durationDays: newDur }));
  }

  function saveForm() {
    if (!form.phase.trim()) return;
    const savedForm = { ...form, durationDays: form.durationDays ?? 0 };

    if (editing === "new") {
      let newTemplates;
      if (insertAfter === "__end__") newTemplates = [...templates, savedForm];
      else if (insertAfter === "__start__") newTemplates = [savedForm, ...templates];
      else {
        const idx = templates.findIndex(t => t.id === insertAfter);
        const arr = [...templates];
        arr.splice(idx + 1, 0, savedForm);
        newTemplates = arr;
      }
      setTaskTemplates(newTemplates);
      if (setVendors && vendors) {
        setVendors(vs => vs.map(v => ({
          ...v,
          leadOverrides: { ...(v.leadOverrides || v.lead || {}), [form.phase]: form.daysBeforeDDP }
        })));
      }
    } else {
      const oldIdx = templates.findIndex(t => t.id === form.id);
      const oldDays = templates[oldIdx]?.daysBeforeDDP ?? form.daysBeforeDDP;
      const delta = savedForm.daysBeforeDDP - oldDays;

      // Remove from old position, reinsert at new position
      let arr = templates.filter(t => t.id !== form.id);
      if (insertAfter === "__end__") arr = [...arr, savedForm];
      else if (insertAfter === "__start__") arr = [savedForm, ...arr];
      else {
        const insertIdx = arr.findIndex(t => t.id === insertAfter);
        arr.splice(insertIdx + 1, 0, savedForm);
      }

      // Cascade DDP delta to all tasks AFTER the edited one
      if (delta !== 0) {
        const editedNewIdx = arr.findIndex(t => t.id === form.id);
        arr = arr.map((t, i) => i > editedNewIdx ? { ...t, daysBeforeDDP: Math.max(0, t.daysBeforeDDP + delta) } : t);
      }

      setTaskTemplates(arr);
    }
    setEditing(null);
    setForm(null);
  }
  function deleteTemplate(id) {
    appConfirm("You are about to delete this task template. This action cannot be undone.", "Delete", () => setTaskTemplates(templates.filter(t => t.id !== id)));
  }
  function moveUp(idx) {
    if (idx === 0) return;
    const arr = [...templates];
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
    setTaskTemplates(arr);
  }
  function moveDown(idx) {
    if (idx === templates.length - 1) return;
    const arr = [...templates];
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
    setTaskTemplates(arr);
  }

  if (editing !== null) return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={() => { setEditing(null); setForm(null); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>← Back</button>
        <span style={S.sec}>{editing === "new" ? "New Task Template" : "Edit Task Template"}</span>
      </div>

      {/* Row 1: Phase name + Position */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <label style={S.lbl}>Phase / Task Name *</label>
          <input
            style={S.inp}
            value={form.phase}
            onChange={e => setForm(f => ({ ...f, phase: e.target.value }))}
            placeholder="e.g. Concept, Sampling, QC..."
          />
        </div>
        <div>
          <label style={S.lbl}>Position — Place After</label>
          <select style={S.inp} value={insertAfter} onChange={e => handlePositionChange(e.target.value)}>
            <option value="__start__">— Beginning (first task)</option>
            {templates.filter(t => t.id !== form.id).map(t => <option key={t.id} value={t.id}>After: {t.phase}</option>)}
            <option value="__end__">— End (last task)</option>
          </select>
        </div>
      </div>

      {/* Row 2: Days Before DDP + Days to Complete */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <label style={S.lbl}>Days Before DDP</label>
          <input
            type="number"
            min="0"
            style={S.inp}
            value={form.daysBeforeDDP}
            onChange={e => handleDDPChange(parseInt(e.target.value) || 0)}
          />
          {(() => {
            const prevD = prevDaysForPosition(insertAfter, editing !== "new" ? form.id : undefined);
            const tpls = editing !== "new" ? templates.filter(t => t.id !== form.id) : templates;
            const nextAfterPos = insertAfter === "__start__" ? tpls[0] : insertAfter === "__end__" ? null : tpls[tpls.findIndex(t => t.id === insertAfter) + 1];
            if (!prevD && !nextAfterPos) return null;
            return (
              <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>
                {prevD !== null ? `${prevD - form.daysBeforeDDP}d after prev` : ""}
                {prevD !== null && nextAfterPos ? " · " : ""}
                {nextAfterPos ? `${form.daysBeforeDDP - nextAfterPos.daysBeforeDDP}d before "${nextAfterPos.phase}"` : ""}
              </div>
            );
          })()}
        </div>
        <div>
          <label style={S.lbl}>Days to Complete Task</label>
          <input
            type="number"
            min="0"
            style={S.inp}
            value={form.durationDays ?? 0}
            onChange={e => handleDurationChange(parseInt(e.target.value) || 0)}
          />
          <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>
            Gap between this task's due date and the previous task's due date. Changing this auto-updates Days Before DDP and cascades to subsequent tasks on save.
          </div>
        </div>
      </div>

      {/* Row 3: Status + (spacer) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        <div>
          <label style={S.lbl}>Default Status</label>
          <select style={S.inp} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
            {Object.keys(STATUS_CONFIG).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div />
      </div>

      <label style={S.lbl}>Default Notes</label>
      <textarea
        style={{ ...S.inp, minHeight: 80, resize: "vertical" }}
        value={form.notes}
        onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
        placeholder="Optional default notes for this task..."
      />
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={() => { setEditing(null); setForm(null); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!form.phase.trim()} onClick={saveForm} style={{ ...S.btn, opacity: form.phase.trim() ? 1 : 0.4 }}>Save Template</button>
      </div>
    </div>
  );

  const [tmTab, setTmTab] = useState("design");
  const [wipTplsReadOnly, setWipTplsReadOnly] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        // SB_URL and SB_KEY imported from utils/supabase
        const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.wip_templates&select=value`, {
          headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
        });
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
          const parsed = JSON.parse(rows[0].value);
          if (Array.isArray(parsed) && parsed.length > 0) { setWipTplsReadOnly(parsed); return; }
        }
      } catch {}
      setWipTplsReadOnly(DEFAULT_WIP_TEMPLATES_DC);
    })();
  }, []);

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: `2px solid ${TH.border}` }}>
        <button onClick={() => setTmTab("design")} style={{ padding: "8px 16px", border: "none", borderBottom: tmTab === "design" ? `2px solid ${TH.primary}` : "2px solid transparent", marginBottom: -2, background: "none", color: tmTab === "design" ? TH.primary : TH.textMuted, fontWeight: tmTab === "design" ? 700 : 400, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
          Design (editable)
        </button>
        <button onClick={() => setTmTab("production")} style={{ padding: "8px 16px", border: "none", borderBottom: tmTab === "production" ? `2px solid ${TH.primary}` : "2px solid transparent", marginBottom: -2, background: "none", color: tmTab === "production" ? TH.primary : TH.textMuted, fontWeight: tmTab === "production" ? 700 : 400, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
          Production (read-only)
        </button>
      </div>

      {tmTab === "design" && (<>
      <div style={{ marginBottom: 12, padding: "10px 14px", background: TH.primary + "08", border: `1px solid ${TH.primary}22`, borderRadius: 8, fontSize: 12, color: TH.textMuted, lineHeight: 1.5 }}>
        <strong style={{ color: TH.text }}>Task Templates</strong> define which phases are auto-generated when a collection is created with a vendor. Vendors can override the default lead times. Order matters — tasks appear in this order on the timeline.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button onClick={startNew} style={S.btn}>+ Add Task Template</button>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {templates.map((tpl, idx) => (
          <div key={tpl.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 10 }}>
            {/* Reorder buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button onClick={() => moveUp(idx)} disabled={idx === 0} style={{ padding: "1px 6px", borderRadius: 4, border: `1px solid ${TH.border}`, background: "none", color: idx === 0 ? TH.border : TH.textMuted, cursor: idx === 0 ? "default" : "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: 1 }}>▲</button>
              <button onClick={() => moveDown(idx)} disabled={idx === templates.length - 1} style={{ padding: "1px 6px", borderRadius: 4, border: `1px solid ${TH.border}`, background: "none", color: idx === templates.length - 1 ? TH.border : TH.textMuted, cursor: idx === templates.length - 1 ? "default" : "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: 1 }}>▼</button>
            </div>
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: TH.primary + "15", color: TH.primary, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{idx + 1}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: TH.text }}>{tpl.phase}</div>
              <div style={{ fontSize: 11, color: TH.textMuted }}>
                {tpl.daysBeforeDDP}d before DDP
                {idx > 0 ? ` · ${templates[idx - 1].daysBeforeDDP - tpl.daysBeforeDDP}d from "${templates[idx - 1].phase}"` : ""}
                {tpl.durationDays ? ` · ${tpl.durationDays}d to complete` : ""}
                {" "}· Default: {tpl.status}
                {tpl.notes ? ` · "${tpl.notes.substring(0, 40)}${tpl.notes.length > 40 ? "…" : ""}"` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => startEdit(tpl)} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => deleteTemplate(tpl.id)} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Delete</button>
            </div>
          </div>
        ))}
        {templates.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No templates yet. Add a task template to define what phases are generated per vendor.</div>}
      </div>
      </>)}

      {tmTab === "production" && (<>
      <div style={{ marginBottom: 12, padding: "10px 14px", background: TH.primary + "08", border: `1px solid ${TH.primary}22`, borderRadius: 8, fontSize: 12, color: TH.textMuted, lineHeight: 1.5 }}>
        <strong style={{ color: TH.text }}>Production Milestone Templates</strong> are managed in the PO WIP app. This is a read-only view showing the current production milestone phases.
      </div>
      <div style={{ border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 140px 120px", background: TH.surfaceHi, padding: "7px 14px", fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `1px solid ${TH.border}` }}>
          <span>#</span><span>Phase</span><span style={{ textAlign: "center" }}>Category</span><span style={{ textAlign: "center" }}>Days Before DDP</span>
        </div>
        {wipTplsReadOnly.map((tpl, idx) => (
          <div key={tpl.id || idx} style={{ display: "grid", gridTemplateColumns: "40px 1fr 140px 120px", padding: "8px 14px", borderBottom: idx < wipTplsReadOnly.length - 1 ? `1px solid ${TH.border}` : "none", alignItems: "center", background: idx % 2 === 0 ? "#fff" : TH.surfaceHi }}>
            <span style={{ fontSize: 11, color: TH.textMuted }}>{idx + 1}</span>
            <span style={{ fontSize: 13, color: TH.text }}>{tpl.phase}</span>
            <span style={{ fontSize: 11, color: TH.textMuted, textAlign: "center" }}>{tpl.category}</span>
            <span style={{ fontSize: 13, color: TH.text, textAlign: "center" }}>{tpl.daysBeforeDDP}</span>
          </div>
        ))}
        {wipTplsReadOnly.length === 0 && <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No production templates found. Create them in the PO WIP app.</div>}
      </div>
      </>)}
    </div>
  );
}



export default TaskManager;
