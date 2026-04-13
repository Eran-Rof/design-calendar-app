import React, { useState } from "react";
import {
  type WipTemplate, type User,
  WIP_CATEGORIES, MILESTONE_STATUSES, MILESTONE_STATUS_COLORS, milestoneUid,
} from "../../utils/tandaTypes";
import S from "../styles";
import { WipTemplateEditor } from "../detailPanel";

export interface TemplatesViewProps {
  user: User | null;
  pos: { VendorName?: string }[];
  wipTemplates: Record<string, WipTemplate[]>;
  setWipTemplates: (v: any) => void;
  tplVendor: string;
  setTplVendor: (v: string) => void;
  tplLocalEdits: { vendor: string; edits: WipTemplate[] } | null;
  setTplLocalEdits: (v: { vendor: string; edits: WipTemplate[] } | null) => void;
  tplUndoStack: WipTemplate[][];
  setTplUndoStack: (v: WipTemplate[][] | ((s: WipTemplate[][]) => WipTemplate[][])) => void;
  tplDragIdx: number | null;
  setTplDragIdx: (v: number | null) => void;
  tplDragOverIdx: number | null;
  setTplDragOverIdx: (v: number | null) => void;
  tplMovedIds: Set<string>;
  setTplMovedIds: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  templateVendorList: () => string[];
  vendorHasTemplate: (v: string) => boolean;
  getVendorTemplates: (vendor?: string) => WipTemplate[];
  saveVendorTemplates: (vendor: string, templates: WipTemplate[]) => void;
  deleteVendorTemplate: (vendor: string) => void;
  setConfirmModal: (v: any) => void;
}

export function TemplatesView({
  user, pos, wipTemplates, setWipTemplates,
  tplVendor, setTplVendor,
  tplLocalEdits, setTplLocalEdits,
  tplUndoStack, setTplUndoStack,
  tplDragIdx, setTplDragIdx,
  tplDragOverIdx, setTplDragOverIdx,
  tplMovedIds, setTplMovedIds,
  templateVendorList, vendorHasTemplate, getVendorTemplates,
  saveVendorTemplates, deleteVendorTemplate,
  setConfirmModal,
}: TemplatesViewProps) {
  const isAdmin = user?.role === "admin";
  const [tplTab, setTplTab_] = useState<string>("production");
  const vendorKeys = templateVendorList();
  // All unique vendors from POs (for adding new vendor templates)
  const poVendors = [...new Set(pos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
  const vendorsWithoutTemplate = poVendors.filter(v => !vendorHasTemplate(v));
  const currentTemplates = getVendorTemplates(tplVendor === "__default__" ? undefined : tplVendor);
  // Derive local editing state -- keyed by vendor so switching resets automatically
  const localTpl: WipTemplate[] = (tplLocalEdits?.vendor === tplVendor ? tplLocalEdits.edits : currentTemplates) ?? [];
  const tplDirty = tplLocalEdits?.vendor === tplVendor;
  const activeTplUndo = tplDirty ? tplUndoStack : [];

  function tplPushState(newEdits: WipTemplate[]) {
    setTplUndoStack(s => [...(tplDirty ? s : []), localTpl]);
    setTplLocalEdits({ vendor: tplVendor, edits: newEdits });
  }
  function tplUpdate(i: number, field: string, value: any) {
    const arr = [...localTpl]; arr[i] = { ...arr[i], [field]: value }; tplPushState(arr);
  }
  function tplUndo() {
    if (!activeTplUndo.length) return;
    const prev = activeTplUndo[activeTplUndo.length - 1];
    const remaining = activeTplUndo.length - 1;
    setTplUndoStack(s => s.slice(0, -1));
    if (remaining === 0) {
      setTplLocalEdits(null);
    } else {
      setTplLocalEdits({ vendor: tplVendor, edits: prev });
    }
    setTplMovedIds(new Set());
  }
  function tplSave() {
    saveVendorTemplates(tplVendor, localTpl);
    setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set());
  }
  const [showNewVendor, setShowNewVendor_] = useState<boolean>(false);

  return (
    <>
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={S.cardTitle}>Production Templates</h3>
        </div>

        {/* Vendor selector */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
          <span style={{ color: "#94A3B8", fontSize: 13 }}>Vendor:</span>
          <select style={{ ...S.select, flex: 1, maxWidth: 300 }} value={tplVendor} onChange={e => {
            const newVendor = e.target.value;
            if (tplDirty) {
              setConfirmModal({ title: "Unsaved Template Changes", message: "You have unsaved changes to the production template. Would you like to save or discard?", icon: "⚠️", confirmText: "💾 Save & Switch", confirmColor: "#2563EB", cancelText: "🗑 Discard & Switch", onConfirm: () => { saveVendorTemplates(tplLocalEdits!.vendor, tplLocalEdits!.edits); setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set()); setTplVendor(newVendor); }, onCancel: () => { setTplLocalEdits(null); setTplUndoStack([]); setTplMovedIds(new Set()); setTplVendor(newVendor); } });
            } else {
              setTplVendor(newVendor);
            }
          }}>
            <option value="__default__">Default Template</option>
            {vendorKeys.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          {isAdmin && (
            <button style={{ ...S.btnSecondary, fontSize: 12, padding: "6px 12px" }} onClick={() => setShowNewVendor_(true)}>
              + New Vendor Template
            </button>
          )}
          {isAdmin && tplVendor !== "__default__" && (
            <button style={{ ...S.btnSecondary, fontSize: 12, padding: "6px 12px", borderColor: "#EF4444", color: "#EF4444" }}
              onClick={() => setConfirmModal({ title: "Delete Template", message: `Delete template for "${tplVendor}"? POs will fall back to default template.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => { deleteVendorTemplate(tplVendor); setTplVendor("__default__"); } })}>
              Delete Template
            </button>
          )}
        </div>

        {/* New vendor template creation */}
        {showNewVendor && isAdmin && (
          <div style={{ background: "#0F172A", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <span style={{ color: "#94A3B8", fontSize: 12 }}>Vendor:</span>
              <select style={{ ...S.select, flex: 1 }} id="newTplVendor">
                {vendorsWithoutTemplate.length > 0
                  ? vendorsWithoutTemplate.map(v => <option key={v} value={v}>{v}</option>)
                  : <option value="">All vendors have templates</option>
                }
              </select>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
              <span style={{ color: "#94A3B8", fontSize: 12 }}>Copy from:</span>
              <select style={{ ...S.select, flex: 1 }} id="copyFromVendor">
                <option value="__default__">Default Template</option>
                {vendorKeys.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btnSecondary} onClick={() => setShowNewVendor_(false)}>Cancel</button>
              <button style={{ ...S.btnPrimary, width: "auto", padding: "8px 16px" }} onClick={() => {
                const vendorEl = document.getElementById("newTplVendor") as HTMLSelectElement;
                const copyEl = document.getElementById("copyFromVendor") as HTMLSelectElement;
                const vendorName = vendorEl?.value;
                const copyFrom = copyEl?.value || "__default__";
                if (!vendorName) return;
                const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom);
                const newTpls = source.map(t => ({ ...t, id: milestoneUid() }));
                saveVendorTemplates(vendorName, newTpls);
                setTplVendor(vendorName);
                setShowNewVendor_(false);
              }}>Create Template</button>
            </div>
          </div>
        )}

        {/* Template label */}
        <div style={{ marginBottom: 12, fontSize: 12, color: "#6B7280" }}>
          {tplVendor === "__default__"
            ? "Default template used for vendors without a custom template."
            : `Custom production template for ${tplVendor}.`}
        </div>

        {/* Template table */}
        {!isAdmin && <p style={{ color: "#F59E0B", fontSize: 12, marginBottom: 12 }}>View only — admin access required to edit.</p>}
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <button
              disabled={!activeTplUndo.length}
              onClick={tplUndo}
              style={{ background: "none", border: "1px solid #334155", color: activeTplUndo.length ? "#94A3B8" : "#334155", borderRadius: 6, cursor: activeTplUndo.length ? "pointer" : "default", padding: "5px 12px", fontSize: 12 }}
            >↩ Undo</button>
            <button
              disabled={!tplDirty}
              onClick={tplSave}
              style={{ background: tplDirty ? "#2563EB" : "#1E293B", border: "none", color: tplDirty ? "#fff" : "#475569", borderRadius: 6, cursor: tplDirty ? "pointer" : "default", padding: "5px 14px", fontSize: 12, fontWeight: 600 }}
            >Save</button>
            {tplDirty && <span style={{ color: "#F59E0B", fontSize: 11 }}>Unsaved changes</span>}
          </div>
        )}
        <div style={{ border: "1px solid #334155", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: (isAdmin ? "22px " : "") + "32px 1fr 140px 110px 90px" + (isAdmin ? " 40px" : ""), padding: "8px 14px", background: "#0F172A", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
            {isAdmin && <span />}
            <span>#</span><span>Phase</span><span>Category</span><span style={{ textAlign: "center" }}>Days Before DDP</span><span style={{ textAlign: "center" }}>Status</span>
            {isAdmin && <span />}
          </div>
          {localTpl.map((tpl, i) => {
            const isDragging = tplDragIdx === i;
            const isDropTarget = tplDragOverIdx === i && tplDragIdx !== null && tplDragIdx !== i;
            const isAbove = tplDragIdx !== null && tplDragIdx < i;
            const wasMoved = tplMovedIds.has(tpl.id);
            return (
            <div
              key={tpl.id}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (tplDragIdx !== null && tplDragIdx !== i) setTplDragOverIdx(i); }}
              onDragLeave={() => { if (tplDragOverIdx === i) setTplDragOverIdx(null); }}
              onDrop={e => {
                e.preventDefault();
                const from = parseInt(e.dataTransfer.getData("text/plain"));
                if (!isNaN(from) && from !== i) {
                  const arr = [...localTpl];
                  const [moved] = arr.splice(from, 1);
                  arr.splice(i, 0, moved);
                  tplPushState(arr);
                  setTplMovedIds((prev: Set<string>) => new Set(prev).add(moved.id));
                }
                setTplDragIdx(null); setTplDragOverIdx(null);
              }}
              style={{
                display: "grid",
                gridTemplateColumns: (isAdmin ? "22px " : "") + "32px 1fr 140px 110px 90px" + (isAdmin ? " 40px" : ""),
                padding: "8px 14px",
                fontSize: 13,
                alignItems: "center",
                opacity: isDragging ? 0.3 : 1,
                cursor: isAdmin ? (isDragging ? "grabbing" : "grab") : "default",
                transform: isDragging ? "scale(0.97)" : isDropTarget ? `translateY(${isAbove ? "4px" : "-4px"})` : "none",
                transition: "all 0.25s cubic-bezier(0.2, 0, 0, 1)",
                background: isDragging ? "rgba(251, 146, 60, 0.12)"
                  : isDropTarget ? "rgba(251, 146, 60, 0.15)"
                  : wasMoved ? "rgba(234, 88, 12, 0.18)"
                  : "transparent",
                borderTop: isDropTarget && isAbove ? "3px solid #F97316" : "1px solid #1E293B",
                borderBottom: isDropTarget && !isAbove ? "3px solid #F97316" : "none",
                borderLeft: wasMoved && !isDragging && !isDropTarget ? "3px solid #EA580C" : undefined,
                borderRadius: isDropTarget || wasMoved ? 4 : 0,
                boxShadow: isDragging ? "0 4px 16px rgba(249, 115, 22, 0.2)" : wasMoved ? "inset 0 0 0 1px rgba(234, 88, 12, 0.25)" : "none",
                position: "relative" as const,
                zIndex: isDragging ? 10 : isDropTarget ? 5 : 1,
              }}
            >
              {isAdmin && (
                <span
                  draggable
                  onDragStart={e => { setTplDragIdx(i); e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; (e.target as HTMLElement).style.cursor = "grabbing"; }}
                  onDragEnd={() => { setTplDragIdx(null); setTplDragOverIdx(null); }}
                  style={{ cursor: isDragging ? "grabbing" : "grab", color: isDragging ? "#F97316" : wasMoved ? "#EA580C" : "#475569", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, userSelect: "none", transition: "color 0.15s, transform 0.15s", transform: isDragging ? "scale(1.2)" : "none" }}
                >⠿</span>
              )}
              <span style={{ color: "#6B7280", fontSize: 11 }}>{i + 1}</span>
              {isAdmin ? (
                <input style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#D1D5DB", fontSize: 13, padding: "3px 8px", width: "100%", outline: "none", boxSizing: "border-box" }}
                  value={tpl.phase} onChange={e => tplUpdate(i, "phase", e.target.value)} />
              ) : <span style={{ color: "#D1D5DB" }}>{tpl.phase}</span>}
              {isAdmin ? (
                <select style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 12, padding: "3px 4px" }}
                  value={tpl.category} onChange={e => tplUpdate(i, "category", e.target.value)}>
                  {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : <span style={{ color: "#9CA3AF", fontSize: 12 }}>{tpl.category}</span>}
              {isAdmin ? (
                <input
                  type="text" inputMode="numeric" pattern="[0-9]*"
                  style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 13, padding: "3px 8px", textAlign: "center", width: "100%", outline: "none", boxSizing: "border-box" }}
                  value={tpl.daysBeforeDDP}
                  onClick={e => (e.target as HTMLInputElement).select()}
                  onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ""); tplUpdate(i, "daysBeforeDDP", v === "" ? 0 : parseInt(v)); }}
                />
              ) : <span style={{ color: "#9CA3AF", textAlign: "center" }}>{tpl.daysBeforeDDP}</span>}
              {isAdmin ? (
                <select style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, color: MILESTONE_STATUS_COLORS[tpl.status] || "#6B7280", fontSize: 11, padding: "3px 4px" }}
                  value={tpl.status} onChange={e => tplUpdate(i, "status", e.target.value)}>
                  {MILESTONE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : <span style={{ color: MILESTONE_STATUS_COLORS[tpl.status] || "#6B7280", textAlign: "center", fontSize: 11 }}>{tpl.status}</span>}
              {isAdmin && (
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <button style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 4, cursor: "pointer", padding: "2px 6px", fontSize: 10 }}
                    onClick={() => setConfirmModal({ title: "Delete Phase", message: `Delete "${tpl.phase}" from this template?`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => { const arr = localTpl.filter(t => t.id !== tpl.id); tplPushState(arr); } })}>✕</button>
                </div>
              )}
            </div>
          );
          })}
          {localTpl.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#6B7280", fontSize: 13 }}>No phases defined.</div>}
        </div>
        {isAdmin && (
          <WipTemplateEditor templates={localTpl} onSave={t => tplPushState(t)} />
        )}
      </div>
    </>
  );
}
