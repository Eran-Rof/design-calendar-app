import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { STATUS_CONFIG } from "../utils/constants";
import { uid, getBrand, formatDate, formatDT, addDays, diffDays, addDaysForPhase, diffDaysForPhase, isPostPO, parseLocalDate, toDateStr, dayWeight } from "../utils/dates";
import { cascadeDates } from "../utils/helpers";
import { Modal } from "./Modal";
import Avatar from "./Avatar";
import { NoteInput, buildAttachmentPage } from "./NoteInput";
import ImageUploader from "./ImageUploader";
import SkuManager from "./SkuManager";
import { DateInput } from "./DateInput";

function TaskEditModal({
  task,
  team,
  collections,
  allTasks,
  onSave,
  onQuietSave,
  onSaveCascade,
  onDelete,
  onClose,
  vendors,
  currentUser,
  onSkuChange,
  customerList,
  orderTypes,
  genders: genderList,
  undoConfirm,
  onUndoConfirm,
}) {
  const [f, setF] = useState({
    ...task,
    history: task.history || [],
    images: task.images || [],
  });
  const [tab, setTab] = useState("details");
  const [cascadeWarn, setCascadeWarn] = useState(null);
  const [selectedAttachments, setSelectedAttachments] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const collKey = `${task.brand}||${task.collection}`;
  const collData = collections[collKey] || {};
  const skus = collData.skus || [];
  const brand = getBrand(task.brand) || { id: "unknown", name: "Unknown", color: "#6B7280", short: "?" };
  const canEdit =
    currentUser.role === "admin" ||
    currentUser.permissions?.edit_all ||
    (currentUser.permissions?.edit_own &&
      task.assigneeId === currentUser.teamMemberId);

  function handleStatusChange(newStatus) {
    if (!canEdit) return;
    const entry = {
      id: uid(),
      field: "status",
      from: f.status,
      to: newStatus,
      changedBy: currentUser.name,
      at: new Date().toISOString(),
    };
    setF((x) => ({
      ...x,
      status: newStatus,
      history: [...(x.history || []), entry],
    }));
  }
  function handleAssign(memberId) {
    if (!canEdit) return;
    const prev = team.find((m) => m.id === f.assigneeId)?.name || "Unassigned";
    const next = team.find((m) => m.id === memberId)?.name || "Unassigned";
    const entry = {
      id: uid(),
      field: "assignee",
      from: prev,
      to: next,
      changedBy: currentUser.name,
      at: new Date().toISOString(),
    };
    setF((x) => ({
      ...x,
      assigneeId: memberId,
      history: [...(x.history || []), entry],
    }));
  }

  function handleDueChange(newDue) {
    if (!canEdit) return;
    // Only update the local form — cascade and DDP warning happen on Save
    setF((x) => ({ ...x, due: newDue }));
  }

  function handleSave() {
    const { updatedTasks, ddpChanged, newDDP, oldDDP, affectedCount } =
      cascadeDates(allTasks, collKey, task.id, f.due);

    // Build history entries for ALL changed fields
    const now = new Date().toISOString();
    const newEntries = [];
    const track = (field, from, to) => {
      if (String(from || "") !== String(to || "")) {
        newEntries.push({ id: uid(), field, from: String(from || "—"), to: String(to || "—"), changedBy: currentUser.name, at: now });
      }
    };
    const fmtDate = (d) => d ? formatDate(d) : "—";
    track("due date", fmtDate(task.due), fmtDate(f.due));
    // status and assignee are already tracked real-time by handleStatusChange / handleAssign — skip here to avoid duplicates
    track("vendor", task.vendorName, f.vendorName);
    track("order type", task.orderType, f.orderType);
    track("category", task.category, f.category);
    track("season", task.season, f.season);
    track("customer", task.customer, f.customer);
    // Notes are already tracked real-time when added (NoteInput auto-saves) — skip here to avoid duplicates
    const dateChanged = f.due !== task.due;
    const fWithHistory = newEntries.length > 0
      ? { ...f, history: [...(f.history || []), ...newEntries] }
      : f;

    if (ddpChanged) {
      // Show DDP warning — user decides how to handle before committing
      const collTasks = allTasks
        .filter((t) => `${t.brand}||${t.collection}` === collKey)
        .sort((a, b) => new Date(a.due) - new Date(b.due));
      setCascadeWarn({
        updatedTasks,
        newDDP,
        oldDDP,
        affectedCount,
        newDue: f.due,
        collTasks,
        fWithHistory,
      });
    } else if (dateChanged) {
      // Date changed but DDP unaffected — apply cascade and save atomically
      const merged = updatedTasks.map((t) =>
        t.id === fWithHistory.id ? { ...t, ...fWithHistory } : t
      );
      onSaveCascade(merged);
    } else {
      // No date change — simple single-task save
      onSave(fWithHistory);
    }
  }

  function proportionalResize(collTasks, changedTaskId, newDue) {
    // Resize pre-Production tasks proportionally so DDP stays the same
    const sorted = [...collTasks].sort(
      (a, b) => new Date(a.due) - new Date(b.due)
    );
    const ddpTask = sorted.find((t) => t.phase === "DDP");
    const ddpDate = ddpTask?.due;
    if (!ddpDate) return allTasks;
    const prodIdx = sorted.findIndex((t) => t.phase === "Production");
    const prePhases = prodIdx >= 0 ? sorted.slice(0, prodIdx) : sorted;
    const postPhases = prodIdx >= 0 ? sorted.slice(prodIdx) : [];
    // Find the changed task in prePhases
    const changedPreIdx = prePhases.findIndex((t) => t.id === changedTaskId);
    if (changedPreIdx < 0) return allTasks; // changed task is production or later — no proportional resize
    // Original span: first pre-task to production
    const origFirst = new Date(prePhases[0].due);
    const origProd =
      prodIdx >= 0 ? new Date(sorted[prodIdx].due) : new Date(ddpDate);
    const origSpan = diffDays(
      origProd.toISOString().split("T")[0],
      prePhases[0].due
    );
    // New span: newDue replaces the changed task; scale all pre-prod tasks to keep same ratios
    // Anchor: keep first task fixed at its current date, stretch/compress around the changed task
    // Strategy: compute ratio of changedTask in span, solve for new total span
    const origChangedOffset = diffDays(
      prePhases[changedPreIdx].due,
      prePhases[0].due
    );
    const newChangedOffset = diffDays(newDue, prePhases[0].due);
    const scale =
      origChangedOffset > 0 ? newChangedOffset / origChangedOffset : 1;
    const resizedPre = prePhases.map((t, i) => {
      if (i === 0) return t; // anchor first task
      const origOffset = diffDays(t.due, prePhases[0].due);
      const newOffset = Math.round(origOffset * scale);
      return { ...t, due: addDays(prePhases[0].due, newOffset) };
    });
    const resizedIds = new Set(resizedPre.map((t) => t.id));
    return allTasks.map((t) => {
      if (`${t.brand}||${t.collection}` !== collKey) return t;
      const r = resizedPre.find((x) => x.id === t.id);
      if (r) return r;
      return t;
    });
  }

  const assignee = team.find((m) => m.id === f.assigneeId) || null;
  const pd = team.find((m) => m.id === f.pdId) || null;
  const designer = team.find((m) => m.id === f.designerId) || null;
  const graphic = team.find((m) => m.id === f.graphicId) || null;
  const vendor = vendors.find((v) => v.id === f.vendorId) || null;

  const tabs = [
    { id: "details", label: "Details" },
    {
      id: "images",
      label: `Attachments${f.images?.length ? " (" + f.images.length + ")" : ""}`,
    },
    { id: "skus", label: `SKUs${skus.length ? " (" + skus.length + ")" : ""}` },
    {
      id: "history",
      label: `History${f.history?.length ? " (" + f.history.length + ")" : ""}`,
    },
  ];

  return (
    <>
      <Modal
        title={`${task.phase} — ${task.collection}`}
        onClose={onClose}
        extraWide
      >
        {/* Undo confirm banner — top of card */}
        {undoConfirm && undoConfirm.taskId === task.id && (
          <div style={{ padding: "12px 16px", background: "#FFF3CD", border: "1px solid #FFC107", borderRadius: 10, marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#856404" }}>↩ Undo last change to this card?</div>
            {undoConfirm.description && (
              <div style={{ fontSize: 12, color: "#92400E" }}>About to undo: <em>{undoConfirm.description}</em></div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => onUndoConfirm(true)} style={{ padding: "6px 18px", borderRadius: 6, border: "none", background: TH.primary, color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700 }}>Yes, Undo</button>
              <button onClick={() => onUndoConfirm(false)} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.textSub, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 22,
            padding: "12px 16px",
            background: TH.surfaceHi,
            borderRadius: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: brand.color,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 13, color: TH.textMuted }}>
              {brand.name} · {task.season} · {task.category}
              {vendor ? ` · ${vendor.name}` : ""}
            </span>
          </div>
          {f.customer && (
            <span
              style={{
                fontSize: 12,
                color: TH.primary,
                background: TH.primary + "15",
                padding: "2px 10px",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              {f.customer}
            </span>
          )}
          {f.orderType && (
            <span
              style={{
                fontSize: 12,
                color: TH.textSub2,
                background: TH.surfaceHi,
                border: `1px solid ${TH.border}`,
                padding: "2px 10px",
                borderRadius: 10,
              }}
            >
              {f.orderType}
            </span>
          )}
          {!canEdit && (
            <span
              style={{
                fontSize: 11,
                color: "#6D28D9",
                background: "#F5F3FF",
                border: "1px solid #C4B5FD",
                padding: "2px 8px",
                borderRadius: 8,
              }}
            >
              👁 View Only
            </span>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,1fr)",
            gap: 10,
            marginBottom: 22,
          }}
        >
          {[
            ["DDP Date", "ddpDate", TH.primary],
            ["Cust Ship Date", "customerShipDate", "#065F46"],
            ["Cancel Date", "cancelDate", "#B91C1C"],
          ].map(([label, key, color]) => (
            <div
              key={key}
              style={{
                background: TH.surfaceHi,
                borderRadius: 8,
                padding: "10px 14px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: TH.textMuted,
                  marginBottom: 4,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color }}>
                {formatDate(f[key] || task[key])}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 2,
            marginBottom: 22,
            borderBottom: `1px solid ${TH.border}`,
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "8px 16px",
                borderRadius: "8px 8px 0 0",
                border: "none",
                cursor: "pointer",
                background: tab === t.id ? TH.surfaceHi : "transparent",
                color: tab === t.id ? TH.text : TH.textMuted,
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: tab === t.id ? 600 : 400,
                borderBottom:
                  tab === t.id
                    ? `2px solid ${TH.primary}`
                    : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "details" && (
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}
          >
            <div>
              <label style={S.lbl}>Status</label>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 14,
                }}
              >
                {Object.keys(STATUS_CONFIG).map((st) => (
                  <button
                    key={st}
                    onClick={() => handleStatusChange(st)}
                    disabled={!canEdit}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 16,
                      border: `1px solid ${
                        f.status === st ? STATUS_CONFIG[st].dot : TH.border
                      }`,
                      background:
                        f.status === st ? STATUS_CONFIG[st].bg : "transparent",
                      color:
                        f.status === st
                          ? STATUS_CONFIG[st].color
                          : TH.textMuted,
                      cursor: canEdit ? "pointer" : "default",
                      fontFamily: "inherit",
                      fontSize: 12,
                    }}
                  >
                    {st}
                  </button>
                ))}
              </div>
              <label style={S.lbl}>Due Date</label>
              <DateInput
                style={S.inp}
                value={f.due}
                onChange={(v) => handleDueChange(v)}
                disabled={!canEdit}
              />
              {/* Days from previous task */}
              {(() => {
                const sortedColl = allTasks
                  .filter((t) => `${t.brand}||${t.collection}` === collKey)
                  .sort((a, b) => new Date(a.due) - new Date(b.due));
                const thisIdx = sortedColl.findIndex((t) => t.id === task.id);
                const prevTask = thisIdx > 0 ? sortedColl[thisIdx - 1] : null;
                if (!prevTask) return null;
                const currentGap = diffDaysForPhase(f.due, prevTask.due, f.phase);
                const isCalDays = isPostPO(f.phase);
                return (
                  <div style={{ marginBottom: 14 }}>
                    <label style={S.lbl}>{isCalDays ? "Calendar" : "Business"} Days from Previous Task</label>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      {/* Number display + custom ▲▼ buttons (native spinner is unreliable with 0.5-day business days) */}
                      <div style={{ display: "flex", alignItems: "center", gap: 0, border: `1px solid ${TH.primary}44`, borderRadius: 8, overflow: "hidden", background: TH.primary + "06" }}>
                        <input
                          type="number"
                          disabled={!canEdit}
                          value={currentGap}
                          min={0}
                          step={isCalDays ? 1 : 0.5}
                          onChange={(e) => {
                            const n = parseFloat(e.target.value);
                            if (isNaN(n) || n < 0) return;
                            const newDue = addDaysForPhase(prevTask.due, n, f.phase);
                            handleDueChange(newDue);
                          }}
                          style={{
                            ...S.inp,
                            marginBottom: 0,
                            width: 70,
                            textAlign: "center",
                            fontWeight: 700,
                            fontSize: 15,
                            color: TH.primary,
                            border: "none",
                            borderRadius: 0,
                            background: "transparent",
                            // hide native spinner arrows
                            MozAppearance: "textfield",
                          } as any}
                        />
                        <div style={{ display: "flex", flexDirection: "column", borderLeft: `1px solid ${TH.primary}44` }}>
                          <button
                            disabled={!canEdit}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (isCalDays) {
                                handleDueChange(addDays(f.due, 1));
                              } else {
                                const d = parseLocalDate(f.due);
                                d.setDate(d.getDate() + 1);
                                while (dayWeight(d) === 0) d.setDate(d.getDate() + 1);
                                handleDueChange(toDateStr(d));
                              }
                            }}
                            style={{ background: "transparent", border: "none", color: TH.primary, cursor: "pointer", padding: "2px 7px", fontSize: 10, lineHeight: 1, borderBottom: `1px solid ${TH.primary}44` }}
                          >▲</button>
                          <button
                            disabled={!canEdit || currentGap <= 0}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (isCalDays) {
                                const n = Math.max(0, currentGap - 1);
                                handleDueChange(addDaysForPhase(prevTask.due, n, f.phase));
                              } else {
                                const d = parseLocalDate(f.due);
                                d.setDate(d.getDate() - 1);
                                while (dayWeight(d) === 0) d.setDate(d.getDate() - 1);
                                const result = toDateStr(d);
                                if (result >= prevTask.due) handleDueChange(result);
                              }
                            }}
                            style={{ background: "transparent", border: "none", color: currentGap <= 0 ? TH.textMuted : TH.primary, cursor: currentGap <= 0 ? "not-allowed" : "pointer", padding: "2px 7px", fontSize: 10, lineHeight: 1 }}
                          >▼</button>
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: TH.textMuted,
                          lineHeight: 1.4,
                        }}
                      >
                        {isCalDays ? "calendar days" : "business days"} after{" "}
                        <span style={{ fontWeight: 700, color: TH.textSub2 }}>
                          {prevTask.phase}
                        </span>
                        <br />
                        <span style={{ fontSize: 11 }}>
                          (due {formatDate(prevTask.due)})
                        </span>
                        {!isCalDays && (
                          <><br /><span style={{ fontSize: 10, color: TH.textMuted }}>Mon–Thu=1d, Fri=0.5d</span></>
                        )}
                      </div>
                    </div>
                    {currentGap < 0 && (
                      <div
                        style={{
                          marginTop: 5,
                          fontSize: 11,
                          color: "#B91C1C",
                          fontWeight: 600,
                        }}
                      >
                        ⚠️ This task is scheduled before the previous task
                      </div>
                    )}
                  </div>
                );
              })()}

              <label style={S.lbl}>Notes</label>
              {/* Existing notes log */}
              {(() => {
                const notesList = Array.isArray(f.notes) ? f.notes :
                  (f.notes ? [{ id: "legacy", text: f.notes, by: "—", at: null }] : []);
                return notesList.length > 0 ? (
                  <div style={{ marginBottom: 10, maxHeight: 220, overflowY: "auto", border: `1px solid ${TH.border}`, borderRadius: 8, background: TH.surfaceHi }}>
                    {notesList.map((n, i) => (
                      <div key={n.id || i} style={{ padding: "10px 14px", borderBottom: i < notesList.length - 1 ? `1px solid ${TH.border}` : "none" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: TH.primary }}>{n.by}</span>
                          {n.at && <span style={{ fontSize: 10, color: TH.textMuted }}>{new Date(n.at).toLocaleString()}</span>}
                        </div>
                        <div style={{ fontSize: 13, color: TH.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{n.text}</div>
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}
              {/* New note input */}
              {canEdit && (
                <NoteInput onAdd={(text) => {
                  const newNote = { id: uid(), text, by: currentUser?.name || "User", at: new Date().toISOString() };
                  const existing = Array.isArray(f.notes) ? f.notes : (f.notes ? [{ id: "legacy", text: f.notes, by: "—", at: null }] : []);
                  const updatedNotes = [...existing, newNote];
                  // Auto-save note immediately + add to history
                  const histEntry = { id: uid(), field: "note added", from: "", to: text.substring(0, 80), changedBy: currentUser?.name || "User", at: new Date().toISOString() };
                  const updatedTask = { ...f, notes: updatedNotes, history: [...(f.history || []), histEntry] };
                  setF(updatedTask); // Update local state
                  (onQuietSave || onSave)(updatedTask); // quiet save — do not close modal
                }} />
              )}
            </div>
            <div>
              <label style={S.lbl}>Assign To</label>
              <div style={{ marginBottom: 14 }}>
                <select
                  disabled={!canEdit}
                  value={f.assigneeId || ""}
                  onChange={e => handleAssign(e.target.value || null)}
                  style={{
                    ...S.inp,
                    marginBottom: 0,
                    borderColor: f.assigneeId
                      ? (team.find(m => m.id === f.assigneeId)?.color || TH.border)
                      : TH.border,
                    color: f.assigneeId
                      ? (team.find(m => m.id === f.assigneeId)?.color || TH.text)
                      : TH.textMuted,
                    fontWeight: f.assigneeId ? 600 : 400,
                    opacity: canEdit ? 1 : 0.6,
                  }}
                >
                  <option value="">— Unassigned —</option>
                  {team.map(m => (
                    <option key={m.id} value={m.id}>{m.name} · {m.role}</option>
                  ))}
                </select>
              </div>
              {(pd || designer || graphic) && (
                <div>
                  <label style={S.lbl}>Collection Team</label>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {[
                      ["PD", pd],
                      ["Designer", designer],
                      ["Graphic", graphic],
                    ]
                      .filter(([, m]) => m)
                      .map(([role, m]) => (
                        <div
                          key={role}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <Avatar member={m} size={24} />
                          <div>
                            <div style={{ fontSize: 11, color: TH.text }}>
                              {m.name}
                            </div>
                            <div style={{ fontSize: 10, color: TH.textMuted }}>
                              {role}
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "images" && (
          <div>
            {/* Select mode toolbar */}
            {(f.images || []).length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                {!selectMode ? (
                  <button
                    onClick={() => { setSelectMode(true); setSelectedAttachments(new Set()); }}
                    style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}
                  >
                    ☑️ Select Attachments
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        const all = new Set((f.images || []).map(i => i.id));
                        setSelectedAttachments(prev => prev.size === all.size ? new Set() : all);
                      }}
                      style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.primary, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 }}
                    >
                      {selectedAttachments.size === (f.images || []).length ? "Deselect All" : "Select All"}
                    </button>
                    <button
                      onClick={() => { setSelectMode(false); setSelectedAttachments(new Set()); }}
                      style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}
                    >
                      Cancel
                    </button>
                    {selectedAttachments.size > 0 && (
                      <>
                        <span style={{ fontSize: 12, color: TH.textMuted, marginLeft: 4 }}>{selectedAttachments.size} selected</span>
                        <button
                          onClick={() => {
                            const selected = (f.images || []).filter(i => selectedAttachments.has(i.id));
                            const url = buildAttachmentPage({ ...f, images: selected }, task, collData, brand, "link");
                            navigator.clipboard.writeText(url).then(() => alert("Link copied to clipboard!")).catch(() => {
                              prompt("Copy this link:", url);
                            });
                          }}
                          style={{ padding: "5px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}
                        >
                          🔗 Copy Link
                        </button>
                        <button
                          onClick={() => {
                            const selected = (f.images || []).filter(i => selectedAttachments.has(i.id));
                            const url = buildAttachmentPage({ ...f, images: selected }, task, collData, brand, "open");
                            window.open(url, "_blank");
                          }}
                          style={{ padding: "5px 14px", borderRadius: 7, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}
                        >
                          🖨️ Open & Print
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Image uploader with selection overlay when in select mode */}
            {selectMode ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                {(f.images || []).map(img => {
                  const isSelected = selectedAttachments.has(img.id);
                  const isImage = img.name?.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) || img.src?.startsWith("data:image") || img.src?.includes("supabase");
                  const ext = (img.name || "").split(".").pop()?.toUpperCase() || "FILE";
                  const fileIcons = { PDF: "📄", AI: "🎨", EPS: "🎨", PSD: "🖼️", SVG: "🔷" };
                  return (
                    <div
                      key={img.id}
                      onClick={() => {
                        setSelectedAttachments(prev => {
                          const next = new Set(prev);
                          if (next.has(img.id)) next.delete(img.id); else next.add(img.id);
                          return next;
                        });
                      }}
                      style={{
                        position: "relative", width: 80, height: 80, borderRadius: 8, overflow: "hidden",
                        border: `2px solid ${isSelected ? TH.primary : TH.border}`,
                        cursor: "pointer", flexShrink: 0,
                        background: TH.surfaceHi,
                        boxShadow: isSelected ? `0 0 0 2px ${TH.primary}44` : "none",
                      }}
                    >
                      {isImage
                        ? <img src={img.src} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: isSelected ? 1 : 0.6 }} />
                        : <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 22, opacity: isSelected ? 1 : 0.6 }}>{fileIcons[ext] || "📎"}<div style={{ fontSize: 9, color: TH.textMuted, marginTop: 2 }}>{ext}</div></div>
                      }
                      {/* Checkmark */}
                      <div style={{
                        position: "absolute", top: 4, right: 4,
                        width: 18, height: 18, borderRadius: "50%",
                        background: isSelected ? TH.primary : "rgba(255,255,255,0.8)",
                        border: `2px solid ${isSelected ? TH.primary : "#ccc"}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, color: "#fff", fontWeight: 700,
                      }}>
                        {isSelected ? "✓" : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <ImageUploader
                images={f.images || []}
                onChange={(v) => canEdit && set("images", v)}
                label="Attachments"
              />
            )}
          </div>
        )}
        {tab === "skus" && (
          <div>
            <div
              style={{ fontSize: 12, color: TH.textMuted, marginBottom: 14 }}
            >
              SKUs are shared collection-wide. Changes save immediately.
            </div>
            <SkuManager
              skus={skus}
              onChange={(newSkus) => {
                if (!canEdit) return;
                onSkuChange(collKey, newSkus);
                // Add SKU change to task history (quiet save — do not close modal)
                const skuHistEntry = { id: uid(), field: "SKUs updated", from: `${skus.length} SKUs`, to: `${newSkus.length} SKUs`, changedBy: currentUser?.name || "User", at: new Date().toISOString() };
                const updatedWithHist = { ...f, history: [...(f.history || []), skuHistEntry] };
                setF(updatedWithHist);
                (onQuietSave || onSave)(updatedWithHist);
              }}
              brand={task.brand}
              category={task.category}
              availableSizes={collData.availableSizes}
            />
          </div>
        )}

        {tab === "history" && (
          <div>
            {(!f.history || f.history.length === 0) && (
              <div style={{ textAlign: "center", color: TH.textMuted, padding: "32px", fontSize: 13 }}>
                No changes recorded yet.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...(f.history || [])].reverse().map((h) => {
                const FIELD_ICONS = { "due date": "📅", "status": "🔄", "assignee": "👤", "vendor": "🏭", "note added": "📝", "order type": "📦", "category": "🗂️", "season": "🌿", "customer": "🏪" };
                const icon = FIELD_ICONS[h.field] || "✏️";
                const isNoteAdded = h.field === "note added";
                const accentColor = h.field === "due date" ? "#1D4ED8" : h.field === "status" ? "#059669" : h.field === "note added" ? "#7C3AED" : TH.primary;
                return (
                  <div key={h.id} style={{ background: TH.surfaceHi, borderRadius: 10, padding: "12px 16px", borderLeft: `3px solid ${accentColor}55` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 14 }}>{icon}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: accentColor, textTransform: "capitalize" }}>{h.field}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: TH.textSub }}>{h.changedBy}</span>
                        <span style={{ fontSize: 10, color: TH.textMuted }}>{formatDT(h.at)}</span>
                      </div>
                    </div>
                    {isNoteAdded ? (
                      <div style={{ fontSize: 12, color: TH.textSub, background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 6, padding: "6px 10px", fontStyle: "italic" }}>
                        "{h.to}"
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                        <span style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "2px 8px", borderRadius: 5, color: "#991B1B", textDecoration: "line-through" }}>{h.from || "—"}</span>
                        <span style={{ color: TH.textMuted, fontSize: 14 }}>→</span>
                        <span style={{ background: "#F0FDF4", border: "1px solid #86EFAC", padding: "2px 8px", borderRadius: 5, color: "#166534", fontWeight: 600 }}>{h.to || "—"}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 26,
            paddingTop: 18,
            borderTop: `1px solid ${TH.border}`,
          }}
        >
          {canEdit ? (
            <button
              onClick={() => appConfirm("You are about to delete this task. This action cannot be undone.", "Delete", () => onDelete(task.id))}
              style={{
                background: "none",
                border: "none",
                color: "#B91C1C",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "inherit",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              Delete task
            </button>
          ) : (
            <div />
          )}
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={() => {
                onClose();
              }}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            {canEdit && (
              <button onClick={handleSave} style={S.btn}>
                Save Changes
              </button>
            )}
          </div>
        </div>
      </Modal>

      {cascadeWarn && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2100,
            padding: 16,
          }}
        >
          <div
            style={{
              background: "#FFFFFF",
              border: `1px solid ${TH.accentBdr}`,
              borderRadius: 16,
              padding: 32,
              maxWidth: 500,
              width: "100%",
              boxShadow: "0 40px 100px rgba(0,0,0,0.4)",
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: TH.text,
                marginBottom: 12,
              }}
            >
              ⚠️ DDP Date Will Change
            </div>
            <div
              style={{
                fontSize: 13,
                color: TH.textMuted,
                lineHeight: 1.65,
                marginBottom: 20,
              }}
            >
              This change affects{" "}
              <strong>{cascadeWarn.affectedCount} tasks</strong> and would push
              the <strong>DDP date</strong> from&nbsp;
              <strong style={{ color: TH.primary }}>
                {formatDate(cascadeWarn.oldDDP)}
              </strong>{" "}
              to&nbsp;
              <strong style={{ color: "#B91C1C" }}>
                {formatDate(cascadeWarn.newDDP)}
              </strong>
              .<br />
              <br />
              How would you like to handle this?
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={() => {
                  const fw = cascadeWarn.fWithHistory || f;
                  const merged = cascadeWarn.updatedTasks.map((t) =>
                    t.id === fw.id ? { ...t, ...fw } : t
                  );
                  onSaveCascade(merged);
                  setCascadeWarn(null);
                  onClose();
                }}
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  border: "none",
                  background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`,
                  color: "#fff",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                ✓ Accept New DDP Date —{" "}
                <span style={{ fontWeight: 400 }}>
                  {formatDate(cascadeWarn.newDDP)}
                </span>
              </button>
              <button
                onClick={() => {
                  const fw = cascadeWarn.fWithHistory || f;
                  const resized = proportionalResize(
                    cascadeWarn.collTasks,
                    task.id,
                    cascadeWarn.newDue
                  );
                  const merged = resized.map((t) =>
                    t.id === fw.id ? { ...t, ...fw } : t
                  );
                  onSaveCascade(merged);
                  setCascadeWarn(null);
                  onClose();
                }}
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  border: `2px solid ${TH.primary}`,
                  background: TH.primary + "10",
                  color: TH.primary,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                ⚖️ Proportionally Resize Task Durations —{" "}
                <span style={{ fontWeight: 400 }}>
                  keep DDP {formatDate(cascadeWarn.oldDDP)}
                </span>
              </button>
              <button
                onClick={() => {
                  // Keep DDP as-is: only save the changed task's fields, no cascade
                  const fw = cascadeWarn.fWithHistory || f;
                  onSave(fw);
                  setCascadeWarn(null);
                  onClose();
                }}
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  border: `2px solid #065F46`,
                  background: "#ECFDF5",
                  color: "#065F46",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                📌 Keep DDP as-is —{" "}
                <span style={{ fontWeight: 400 }}>
                  only update this task's date
                </span>
              </button>
              <button
                onClick={() => {
                  // Revert the date change in the form
                  setF((x) => ({ ...x, due: task.due }));
                  setCascadeWarn(null);
                }}
                style={{
                  padding: "10px 20px",
                  borderRadius: 10,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                }}
              >
                Cancel — keep original date
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


export default TaskEditModal;
