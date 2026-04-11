import React, { useState } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { STATUS_CONFIG } from "../utils/constants";
import { uid, getBrand, formatDate, addDays, diffDays } from "../utils/dates";
import { Modal } from "./Modal";
import DateInput from "./DateInput";

function AddTaskModal({ tasks, vendors, team, collections, onSave, onClose }: { tasks: any[]; vendors: any[]; team: any[]; collections: any; onSave: any; onClose: any }) {
  const collOptions: string[] = [...new Set(tasks.map((t) => `${t.brand}||${t.collection}`))];
  const todayStr = new Date().toISOString().split("T")[0];

  const [form, setForm] = useState({
    collKey: collOptions[0] || "",
    phase: "",
    due: todayStr,
    status: "Not Started",
    assigneeId: "",
    notes: "",
    insertAfter: "__end__",
    daysBeforeDDP: 0,
    daysToComplete: 0,
  });
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Tasks in selected collection sorted by due date
  const collTasks = form.collKey
    ? [...tasks.filter(t => `${t.brand}||${t.collection}` === form.collKey)]
        .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
    : [];

  // Reference task for DDP/metadata
  const refTask = (() => {
    if (!form.collKey) return null;
    const [brand, collection] = form.collKey.split("||");
    return tasks.find(t => t.brand === brand && t.collection === collection) || null;
  })();

  // Previous task based on insertAfter position
  const prevTask = form.insertAfter === "__start__"
    ? null
    : form.insertAfter === "__end__"
    ? collTasks[collTasks.length - 1] || null
    : collTasks.find(t => t.id === form.insertAfter) || null;

  // When position changes: auto-fill due + recompute linked fields
  function handlePositionChange(val) {
    let autoDue = form.due;
    if (val === "__start__" && collTasks.length > 0) {
      autoDue = addDays(collTasks[0].due, -14);
    } else if (val === "__end__" && collTasks.length > 0) {
      autoDue = addDays(collTasks[collTasks.length - 1].due, 14);
    } else {
      const idx = collTasks.findIndex(t => t.id === val);
      const prev = collTasks[idx];
      const next = collTasks[idx + 1];
      autoDue = prev && next
        ? addDays(prev.due, Math.max(1, Math.round(diffDays(next.due, prev.due) / 2)))
        : prev ? addDays(prev.due, 14) : form.due;
    }
    const newPrev = val === "__start__" ? null : val === "__end__" ? collTasks[collTasks.length - 1] : collTasks.find(t => t.id === val);
    const ddp = refTask?.ddpDate;
    setForm(f => ({
      ...f,
      insertAfter: val,
      due: autoDue,
      daysBeforeDDP: ddp ? diffDays(ddp, autoDue) : f.daysBeforeDDP,
      daysToComplete: newPrev ? diffDays(autoDue, newPrev.due) : 0,
    }));
  }

  // When due date changes: recompute daysBeforeDDP + daysToComplete
  function handleDueChange(v) {
    const ddp = refTask?.ddpDate;
    setForm(f => ({
      ...f,
      due: v,
      daysBeforeDDP: ddp ? diffDays(ddp, v) : f.daysBeforeDDP,
      daysToComplete: prevTask ? diffDays(v, prevTask.due) : f.daysToComplete,
    }));
  }

  // When daysBeforeDDP changes: recompute due + daysToComplete
  function handleDDPDaysChange(n) {
    const ddp = refTask?.ddpDate;
    if (!ddp) return;
    const newDue = addDays(ddp, -n);
    setForm(f => ({
      ...f,
      daysBeforeDDP: n,
      due: newDue,
      daysToComplete: prevTask ? diffDays(newDue, prevTask.due) : f.daysToComplete,
    }));
  }

  // When daysToComplete changes: recompute due + daysBeforeDDP
  function handleDaysToCompleteChange(n) {
    if (!prevTask) return;
    const newDue = addDays(prevTask.due, n);
    const ddp = refTask?.ddpDate;
    setForm(f => ({
      ...f,
      daysToComplete: n,
      due: newDue,
      daysBeforeDDP: ddp ? diffDays(ddp, newDue) : f.daysBeforeDDP,
    }));
  }

  function handleSave() {
    if (!form.collKey || !form.phase.trim() || !form.due) return;
    const [brand, collection] = form.collKey.split("||");
    const base = {
      brand, collection,
      status: form.status,
      assigneeId: form.assigneeId || null,
      notes: form.notes,
      season: refTask?.season || "",
      year: refTask?.year || new Date().getFullYear(),
      gender: refTask?.gender || "",
      category: refTask?.category || "",
      vendorId: refTask?.vendorId || null,
      ddpDate: refTask?.ddpDate || "",
      deliveryDate: refTask?.deliveryDate || "",
      customerShipDate: refTask?.customerShipDate || "",
      customer: refTask?.customer || "",
      orderType: refTask?.orderType || "",
      channelType: refTask?.channelType || "",
      images: [], skus: [], history: [],
    };
    onSave({ id: uid(), ...base, phase: form.phase, due: form.due, originalDue: form.due, isCustomTask: true });
  }

  const ddp = refTask?.ddpDate;
  const canSave = !!form.collKey && !!form.phase.trim() && !!form.due;

  return (
    <Modal title="Add Task to Timeline" onClose={onClose}>
      <div>
        {/* Collection — full width */}
        <label style={S.lbl}>Collection</label>
        <select style={S.inp} value={form.collKey} onChange={e => {
          setF("collKey", e.target.value);
          setF("insertAfter", "__end__");
        }}>
          <option value="">-- Select Collection --</option>
          {collOptions.map(k => {
            const [brand, coll] = k.split("||");
            return <option key={k} value={k}>{getBrand(brand)?.short} — {coll}</option>;
          })}
        </select>

        {/* Row 1: Phase Name | Position */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={S.lbl}>Phase / Task Name *</label>
            <input
              style={S.inp}
              value={form.phase}
              onChange={e => setF("phase", e.target.value)}
              placeholder="e.g. Proto Review, Lab Dip…"
            />
          </div>
          <div>
            <label style={S.lbl}>Position — Place After</label>
            <select style={S.inp} value={form.insertAfter} onChange={e => handlePositionChange(e.target.value)}>
              {collTasks.length === 0
                ? <option value="__end__">— (no tasks yet) —</option>
                : <>
                    <option value="__start__">— Before all tasks —</option>
                    {collTasks.map(t => <option key={t.id} value={t.id}>{t.phase} ({formatDate(t.due)})</option>)}
                    <option value="__end__">— After all tasks —</option>
                  </>
              }
            </select>
          </div>
        </div>

        {/* Row 2: Due Date | Days Before DDP */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={S.lbl}>Due Date</label>
            <DateInput style={{ ...S.inp, marginBottom: 0 }} value={form.due} onChange={handleDueChange} />
            {prevTask && (
              <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>
                {diffDays(form.due, prevTask.due)}d after "{prevTask.phase}"
              </div>
            )}
          </div>
          <div>
            <label style={S.lbl}>
              Days Before DDP
              {!ddp && <span style={{ color: TH.textMuted, fontWeight: 400, textTransform: "none" }}> — no DDP set</span>}
            </label>
            <input
              type="number" min="0"
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.daysBeforeDDP}
              disabled={!ddp}
              onChange={e => handleDDPDaysChange(parseInt(e.target.value) || 0)}
            />
            {ddp && (
              <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>
                DDP: {formatDate(ddp)}
              </div>
            )}
          </div>
        </div>

        {/* Row 3: Days to Complete | Status */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={S.lbl}>
              Days to Complete Task
              {prevTask && <span style={{ color: TH.textMuted, fontWeight: 400, textTransform: "none" }}> from "{prevTask.phase}"</span>}
            </label>
            <input
              type="number" min="0"
              style={{ ...S.inp, marginBottom: 0 }}
              value={form.daysToComplete}
              disabled={!prevTask}
              onChange={e => handleDaysToCompleteChange(parseInt(e.target.value) || 0)}
            />
            {!prevTask && <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 4 }}>Select a position first</div>}
          </div>
          <div>
            <label style={S.lbl}>Status</label>
            <select style={{ ...S.inp, marginBottom: 0 }} value={form.status} onChange={e => setF("status", e.target.value)}>
              {Object.keys(STATUS_CONFIG).map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Row 4: Assignee */}
        <label style={S.lbl}>Assignee</label>
        <select style={S.inp} value={form.assigneeId} onChange={e => setF("assigneeId", e.target.value)}>
          <option value="">-- None --</option>
          {team.map(m => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
        </select>

        <label style={S.lbl}>Notes</label>
        <textarea style={{ ...S.inp, height: 72, resize: "vertical" } as any} value={form.notes} onChange={e => setF("notes", e.target.value)} placeholder="Optional notes…" />

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 6 }}>
          <button onClick={onClose} style={{ padding: "9px 22px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textSub, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave} style={{ ...S.btn, opacity: canSave ? 1 : 0.5 }}>Add Task</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── IMAGE GALLERY MODAL ──────────────────────────────────────────────────────

export default AddTaskModal;
