import React from "react";
import { type Milestone, WIP_CATEGORIES, MILESTONE_STATUSES, MILESTONE_STATUS_COLORS, milestoneUid, itemQty, normalizeSize, fmtDate, fmtCurrency } from "../../utils/tandaTypes";
import S from "../styles";
import { MilestoneDateInput } from "./MilestoneDateInput";
import type { DetailPanelCtx } from "../detailPanel";

/**
 * Production Milestones tab body. Renders nothing unless `detailMode` is
 * "milestones" or "all". Extracted from detailPanel.tsx.
 */
export function MilestonesTab({ ctx }: { ctx: DetailPanelCtx }): React.ReactElement | null {
  const {
    selected, detailMode, milestones, vendorHasTemplate, user, ensureMilestones,
    regenerateMilestones, setConfirmModal, collapsedCats, setCollapsedCats,
    acceptedBlocked, setAcceptedBlocked, setBlockedModal, expandedVariants,
    setExpandedVariants, cascadeDueDateChange, saveMilestone, editingNote,
    setEditingNote, msNoteText, setMsNoteText, addingPhase, setAddingPhase,
    newPhaseForm, setNewPhaseForm, addHistory,
  } = ctx;

  if (!selected) return null;
  if (!(detailMode === "milestones" || detailMode === "all")) return null;

  const items = selected.Items ?? selected.PoLineArr ?? [];

  // Matrix rows (base+color combos) — same calc the PO/Matrix tab uses, kept
  // local to this tab so we don't have to thread it through ctx.
  const matrixRows = (() => {
    const byKey: Record<string, { base: string; color: string; desc: string; qty: number; price: number }> = {};
    const rows: { base: string; color: string; desc: string; qty: number; price: number }[] = [];
    items.forEach((item: any) => {
      const sku = item.ItemNumber ?? "";
      const parts = sku.split("-");
      const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
      const base = parts[0] || sku;
      const key = `${base}-${color}`;
      if (!byKey[key]) {
        byKey[key] = { base, color, desc: item.Description ?? "", qty: 0, price: item.UnitPrice ?? 0 };
        rows.push(byKey[key]);
      }
      byKey[key].qty += itemQty(item);
    });
    return rows;
  })();

  const poNum = selected.PoNumber ?? "";
  const poMs = milestones[poNum] || [];
  const ddp = selected.DateExpectedDelivery;
  const vendorN = selected.VendorName ?? "";
  const hasVendorTpl = vendorHasTemplate(vendorN);
  const grouped: Record<string, Milestone[]> = {};
  poMs.forEach(m => { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push(m); });

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={S.sectionLabel}>Production Milestones</div>
        <div style={{ display: "flex", gap: 6 }}>
          {poMs.length === 0 && ddp && hasVendorTpl && (
            <button style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }} onClick={() => ensureMilestones(selected)}>
              Generate Milestones
            </button>
          )}
          {poMs.length > 0 && (
            <button style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }} onClick={() => {
              setConfirmModal({ title: "Regenerate Milestones", message: "Regenerate milestones? Your statuses, dates, and notes will be preserved.", icon: "🔄", confirmText: "Regenerate", confirmColor: "#3B82F6", onConfirm: () => regenerateMilestones(selected) });
            }}>
              Regenerate
            </button>
          )}
        </div>
      </div>
      {poMs.length === 0 && !ddp && <p style={{ color: "#6B7280", fontSize: 13 }}>No expected delivery date — cannot generate milestones.</p>}
      {poMs.length === 0 && ddp && hasVendorTpl && <p style={{ color: "#6B7280", fontSize: 13 }}>No milestones yet. Click "Generate Milestones" to create them.</p>}
      {WIP_CATEGORIES.filter(cat => grouped[cat]?.length).map(cat => {
        const catMs = (grouped[cat] || []).sort((a, b) => {
          if (a.expected_date && b.expected_date) { const d = a.expected_date.localeCompare(b.expected_date); if (d !== 0) return d; }
          if (a.expected_date && !b.expected_date) return -1;
          if (!a.expected_date && b.expected_date) return 1;
          return a.sort_order - b.sort_order;
        });
        const catComplete = catMs.filter(m => m.status === "Complete").length;
        const activeCats = WIP_CATEGORIES.filter(c => grouped[c]?.length);
        const firstIncompleteCat = activeCats.find(c => grouped[c].some(m => m.status !== "Complete" && m.status !== "N/A"));
        const defaultCollapsed = cat !== firstIncompleteCat;
        const key = cat + poNum;
        const collapsed = collapsedCats[key] !== undefined ? collapsedCats[key] : defaultCollapsed;

        const cascade = (() => {
          const info = { blocked: false, upstreamDelay: 0, delayedCat: "" };
          const catIdx = activeCats.indexOf(cat);
          for (let p = 0; p < catIdx; p++) {
            const prevCat = activeCats[p];
            const prevMs = grouped[prevCat] || [];
            const prevDone = prevMs.every(m => m.status === "Complete" || m.status === "N/A");
            if (!prevDone) {
              info.blocked = true;
              const maxLate = prevMs.reduce((max, m) => {
                if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
                const daysLate = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
                return daysLate > 0 ? Math.max(max, daysLate) : max;
              }, 0);
              if (maxLate > info.upstreamDelay) { info.upstreamDelay = maxLate; info.delayedCat = prevCat; }
            }
          }
          return info;
        })();

        return (
          <div key={cat} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: cascade.blocked ? "#1A1520" : "#0F172A", borderRadius: collapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none", borderLeft: cascade.blocked ? "3px solid #F59E0B" : "3px solid transparent" }}
              onClick={() => {
                const catKey = cat + poNum;
                if (collapsed && cascade.blocked && !acceptedBlocked.has(catKey)) {
                  setBlockedModal({ cat, delayedCat: cascade.delayedCat, daysLate: cascade.upstreamDelay, onConfirm: () => {
                    setAcceptedBlocked(prev => new Set(prev).add(catKey));
                    setCollapsedCats(prev => ({ ...prev, [catKey]: false }));
                  }});
                  return;
                }
                setCollapsedCats(prev => ({ ...prev, [catKey]: !collapsed }));
              }}>
              <span style={{ color: "#6B7280", fontSize: 12 }}>{collapsed ? "▶" : "▼"}</span>
              <span style={{ color: catComplete === catMs.length ? "#10B981" : "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, transition: "color 0.5s" }}>{cat}{catComplete === catMs.length ? " ✓" : ""}</span>
              {cascade.blocked && (
                <span style={{ fontSize: 10, color: "#F59E0B", fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "#F59E0B18", border: "1px solid #F59E0B33" }}>
                  ⚠ Blocked by {cascade.delayedCat}{cascade.upstreamDelay > 0 ? ` (${cascade.upstreamDelay}d late)` : ""}
                </span>
              )}
              <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{catComplete}/{catMs.length}</span>
            </div>
            {!collapsed && (
              <div style={{ background: "#0F172A", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.5fr 130px 26px 120px 120px 55px 32px", gap: 6, padding: "5px 14px", background: "#1E293B" }}>
                  <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Milestone</span>
                  <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Due Date</span>
                  <span />
                  <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Status</span>
                  <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Status Date</span>
                  <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Days</span>
                  <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>📝</span>
                </div>
                {catMs.map(m => {
                  const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000) : null;
                  const daysColor = m.status === "Complete" ? "#10B981" : m.status === "N/A" ? "#6B7280" : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                  const projectedDate = cascade.upstreamDelay > 0 && m.expected_date && m.status !== "Complete" && m.status !== "N/A"
                    ? new Date(new Date(m.expected_date).getTime() + cascade.upstreamDelay * 86400000).toISOString().slice(0, 10) : null;
                  const statusDateVal = (m.status_dates || {})[m.status] || m.status_date || null;
                  const delayDays = statusDateVal && m.expected_date
                    ? Math.ceil((new Date(statusDateVal).getTime() - new Date(m.expected_date).getTime()) / 86400000)
                    : 0;
                  const variantOpen = expandedVariants.has(m.id);
                  const variantStatuses = m.variant_statuses || {};
                  const hasMismatch = Object.values(variantStatuses).some(v => v.status !== m.status);
                  return (
                    <div key={m.id} style={{ display: "contents" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.5fr 130px 26px 120px 120px 55px 32px", gap: 6, padding: "8px 14px", borderTop: "1px solid #1E293B", alignItems: "center", background: cascade.blocked && m.status !== "Complete" && m.status !== "N/A" ? "#F59E0B08" : "transparent" }}>
                      <span style={{ color: "#D1D5DB", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {m.phase}
                        {delayDays > 0 && (
                          <span style={{ fontSize: 10, background: "#7F1D1D", color: "#FCA5A5", borderRadius: 4, padding: "1px 5px", fontWeight: 600, whiteSpace: "nowrap" }}>
                            ⚠ {delayDays}d delayed
                          </span>
                        )}
                        {hasMismatch && (
                          <span style={{ fontSize: 10, background: "#78350F", color: "#FDE68A", borderRadius: 4, padding: "1px 5px", fontWeight: 600, whiteSpace: "nowrap" }}>
                            ⚠ Color mismatch
                          </span>
                        )}
                      </span>
                      <div style={{ textAlign: "center" }}>
                        <MilestoneDateInput
                          value={m.expected_date || ""}
                          onCommit={v => cascadeDueDateChange(m, v)}
                          style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: projectedDate ? "#F59E0B" : "#9CA3AF", fontSize: 12, padding: "4px 6px", width: "100%", boxSizing: "border-box", outline: "none" }}
                        />
                        {projectedDate && <div style={{ fontSize: 9, color: "#F59E0B", marginTop: 1 }}>→ {fmtDate(projectedDate)}</div>}
                      </div>
                      <button
                        title="Color/variant statuses"
                        data-variant-toggle
                        onClick={() => setExpandedVariants(prev => { const next = new Set(prev); variantOpen ? next.delete(m.id) : next.add(m.id); return next; })}
                        style={{ width: 22, height: 22, borderRadius: "50%", border: `1px solid ${variantOpen ? "#60A5FA" : hasMismatch ? "#FDE68A" : "#334155"}`, background: variantOpen ? "#1D4ED8" : hasMismatch ? "#78350F" : "#0F172A", color: variantOpen ? "#fff" : hasMismatch ? "#FDE68A" : "#6B7280", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, padding: 0, flexShrink: 0 }}
                      >{variantOpen ? "−" : "+"}</button>
                      <select style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 12, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
                        value={m.status}
                        onChange={e => {
                          const newStatus = e.target.value;
                          const oldStatus = m.status;
                          const dates = { ...(m.status_dates || {}) };
                          const doSave = (d: Record<string, string>) => {
                            const today2 = new Date().toISOString().split("T")[0];
                            if (newStatus !== "Not Started" && !d[newStatus]) d[newStatus] = today2;
                            const statusDate = d[newStatus] || null;
                            const existingVariants = { ...(m.variant_statuses || {}) };
                            const syncedVariants: Record<string, { status: string; status_date: string | null }> = {};
                            Object.keys(existingVariants).forEach(key => {
                              if (existingVariants[key].status === oldStatus) {
                                syncedVariants[key] = { status: newStatus, status_date: statusDate };
                              } else {
                                syncedVariants[key] = existingVariants[key];
                              }
                            });
                            saveMilestone({ ...m, status: newStatus, status_date: statusDate, status_dates: Object.keys(d).length > 0 ? d : null, variant_statuses: Object.keys(syncedVariants).length > 0 ? syncedVariants : m.variant_statuses, updated_at: new Date().toISOString(), updated_by: user?.name || "" });
                          };
                          const proceed = () => {
                            if (oldStatus === "Complete" && dates[oldStatus]) {
                              setConfirmModal({ title: "Clear Complete Date", message: `Clear the "Complete" date (${dates[oldStatus]})?`, icon: "📅", confirmText: "Clear Date", confirmColor: "#F59E0B", cancelText: "Keep Date", onConfirm: () => { delete dates[oldStatus]; doSave(dates); }, onCancel: () => doSave(dates) });
                              return;
                            }
                            doSave(dates);
                          };
                          const overrideCount = Object.values(m.variant_statuses || {}).filter(v => v.status !== oldStatus).length;
                          if (overrideCount > 0) {
                            setConfirmModal({
                              title: "Color/Variant Overrides Will Be Kept",
                              message: `${overrideCount} color variant${overrideCount === 1 ? " has" : "s have"} a status different from the phase. Changing the phase status to "${newStatus}" will NOT change those variants — they will remain as set. Continue?`,
                              icon: "⚠️",
                              confirmText: "Continue",
                              confirmColor: "#F59E0B",
                              cancelText: "Cancel",
                              onConfirm: proceed,
                            });
                            return;
                          }
                          proceed();
                        }}>
                        {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                      </select>
                      <input type="date" style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: (m.status_dates || {})[m.status] ? "#60A5FA" : "#334155", fontSize: 12, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
                        title={`Date for "${m.status}" status`}
                        value={(m.status_dates || {})[m.status] || m.status_date || ""}
                        onChange={e => {
                          const val = e.target.value || null;
                          const dates = { ...(m.status_dates || {}) };
                          if (val) dates[m.status] = val; else delete dates[m.status];
                          const existingVariants = { ...(m.variant_statuses || {}) };
                          const syncedVariants: Record<string, { status: string; status_date: string | null }> = {};
                          Object.keys(existingVariants).forEach(key => {
                            if (existingVariants[key].status === m.status) {
                              syncedVariants[key] = { status: m.status, status_date: val };
                            } else {
                              syncedVariants[key] = existingVariants[key];
                            }
                          });
                          saveMilestone({ ...m, status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null, variant_statuses: Object.keys(syncedVariants).length > 0 ? syncedVariants : m.variant_statuses, updated_at: new Date().toISOString(), updated_by: user?.name || "" });
                        }} />
                      <span style={{ color: daysColor, fontWeight: 600, textAlign: "right", fontSize: 12 }}>
                        {m.status === "Complete" ? "Done" : m.status === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)}d late` : daysRem === 0 ? "Today" : `${daysRem}d`}
                      </span>
                      <span style={{ textAlign: "center", cursor: "pointer", fontSize: 14, opacity: (m.note_entries?.length || m.notes) ? 1 : 0.4, position: "relative" }} title={m.notes || "Add note"} onClick={e => { e.stopPropagation(); setEditingNote(editingNote === m.id ? null : m.id); setMsNoteText(""); }}>📝{(m.note_entries?.length ?? 0) > 0 && <span style={{ position: "absolute", top: -4, right: -6, fontSize: 8, background: "#3B82F6", color: "#fff", borderRadius: "50%", width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{m.note_entries!.length}</span>}</span>
                    </div>
                    {variantOpen && (
                      <div data-variant-panel style={{ padding: "8px 14px 10px 14px", borderTop: "1px solid #1E293B", background: "#0A1220" }}>
                        <div style={{ fontSize: 10, color: "#60A5FA", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Color / Variant Statuses</div>
                        {matrixRows.length === 0 ? (
                          <div style={{ fontSize: 12, color: "#4B5563", fontStyle: "italic" }}>No line items on this PO</div>
                        ) : (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                              <thead>
                                <tr>
                                  {["Base Part","Description","Color","Status","Status Date","Qty","PO Cost","Total Cost"].map(h => (
                                    <th key={h} style={{ padding: "6px 10px", textAlign: h === "Qty" || h === "PO Cost" || h === "Total Cost" ? "right" : "left", color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #334155", whiteSpace: "nowrap" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {matrixRows.map((row) => {
                                  const key = `${row.base}-${row.color}`;
                                  const vEntry = variantStatuses[key] || { status: m.status, status_date: statusDateVal };
                                  const vMismatch = vEntry.status !== m.status;
                                  return (
                                    <tr key={key} style={{ borderBottom: "1px solid #1E293B", background: vMismatch ? "#78350F22" : "transparent" }}>
                                      <td style={{ padding: "5px 10px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, whiteSpace: "nowrap" }}>{row.base}</td>
                                      <td style={{ padding: "5px 10px", color: "#9CA3AF", fontSize: 11 }}>{row.desc || "—"}</td>
                                      <td style={{ padding: "5px 10px", color: vMismatch ? "#FDE68A" : "#D1D5DB", whiteSpace: "nowrap" }}>
                                        {row.color || "—"}
                                        {vMismatch && <span style={{ fontSize: 10, color: "#F59E0B", marginLeft: 6 }}>⚠</span>}
                                      </td>
                                      <td style={{ padding: "5px 10px" }}>
                                        <select
                                          value={vEntry.status}
                                          style={{ background: "#1E293B", border: `1px solid ${vMismatch ? "#F59E0B44" : "#334155"}`, borderRadius: 6, color: MILESTONE_STATUS_COLORS[vEntry.status] || "#6B7280", fontSize: 11, padding: "3px 5px", width: "100%", boxSizing: "border-box" as const }}
                                          onChange={e => {
                                            const today2 = new Date().toISOString().split("T")[0];
                                            const newV = { ...variantStatuses, [key]: { status: e.target.value, status_date: vEntry.status_date || today2 } };
                                            saveMilestone({ ...m, variant_statuses: newV, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                          }}
                                        >
                                          {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
                                        </select>
                                      </td>
                                      <td style={{ padding: "5px 10px" }}>
                                        <input
                                          type="date"
                                          value={vEntry.status_date || ""}
                                          style={{ background: "#1E293B", border: `1px solid ${vEntry.status_date ? "#60A5FA44" : "#334155"}`, borderRadius: 6, color: vEntry.status_date ? "#60A5FA" : "#334155", fontSize: 11, padding: "3px 5px", width: "100%", boxSizing: "border-box" as const }}
                                          onChange={e => {
                                            const newV = { ...variantStatuses, [key]: { status: vEntry.status, status_date: e.target.value || null } };
                                            saveMilestone({ ...m, variant_statuses: newV, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                          }}
                                        />
                                      </td>
                                      <td style={{ padding: "5px 10px", textAlign: "right", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{row.qty}</td>
                                      <td style={{ padding: "5px 10px", textAlign: "right", color: "#9CA3AF", fontFamily: "monospace" }}>{fmtCurrency(row.price, selected.CurrencyCode)}</td>
                                      <td style={{ padding: "5px 10px", textAlign: "right", color: "#10B981", fontWeight: 600, fontFamily: "monospace" }}>{fmtCurrency(row.qty * row.price, selected.CurrencyCode)}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                              <tfoot>
                                <tr style={{ borderTop: "2px solid #334155" }}>
                                  <td colSpan={5} style={{ padding: "8px 10px", color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                                  <td style={{ padding: "8px 10px", textAlign: "right", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>{matrixRows.reduce((s, r) => s + r.qty, 0)}</td>
                                  <td style={{ padding: "8px 10px" }} />
                                  <td style={{ padding: "8px 10px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(matrixRows.reduce((s, r) => s + r.qty * r.price, 0), selected.CurrencyCode)}</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                    {editingNote === m.id && (() => {
                      const entries = m.note_entries || [];
                      const legacy = m.notes && entries.length === 0 ? [{ text: m.notes, user: m.updated_by || "—", date: m.updated_at || "" }] : [];
                      const allNotes = [...legacy, ...entries];
                      return (
                        <div style={{ padding: "8px 14px 10px", borderTop: "1px solid #1E293B", background: "#1A2332" }}>
                          {allNotes.length > 0 && (
                            <div style={{ marginBottom: 8, maxHeight: 120, overflowY: "auto" }}>
                              {allNotes.map((n, i) => {
                                const timeAgo = n.date ? (() => { const ms = Date.now() - new Date(n.date).getTime(); const mins = Math.floor(ms / 60000); if (mins < 60) return `${mins}m ago`; const hrs = Math.floor(mins / 60); if (hrs < 24) return `${hrs}h ago`; return `${Math.floor(hrs / 24)}d ago`; })() : "";
                                return (
                                  <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: i < allNotes.length - 1 ? "1px solid #0F172A" : "none" }}>
                                    <div style={{ flex: 1, fontSize: 12, color: "#D1D5DB", lineHeight: 1.4 }}>{n.text}</div>
                                    <div style={{ flexShrink: 0, textAlign: "right" }}>
                                      <div style={{ fontSize: 10, color: "#60A5FA", fontWeight: 600 }}>{n.user}</div>
                                      <div style={{ fontSize: 9, color: "#4B5563" }}>{timeAgo}</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 6 }}>
                            <input value={msNoteText} onChange={e => setMsNoteText(e.target.value)} placeholder="Add a note..." onKeyDown={e => {
                              if (e.key === "Enter" && msNoteText.trim()) {
                                const newEntry = { text: msNoteText.trim(), user: user?.name || "—", date: new Date().toISOString() };
                                saveMilestone({ ...m, note_entries: [...entries, newEntry], notes: [...allNotes.map(n => n.text), msNoteText.trim()].join(" | "), updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                setMsNoteText("");
                              }
                            }} style={{ flex: 1, background: "#0F172A", border: "1px solid #334155", borderRadius: 6, color: "#D1D5DB", fontSize: 12, padding: "6px 10px", fontFamily: "inherit", outline: "none" }} />
                            <button onClick={() => {
                              if (!msNoteText.trim()) return;
                              const newEntry = { text: msNoteText.trim(), user: user?.name || "—", date: new Date().toISOString() };
                              saveMilestone({ ...m, note_entries: [...entries, newEntry], notes: [...allNotes.map(n => n.text), msNoteText.trim()].join(" | "), updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                              setMsNoteText("");
                            }} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#3B82F6", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Add</button>
                          </div>
                        </div>
                      );
                    })()}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {poMs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {!addingPhase ? (
            <button onClick={() => setAddingPhase(true)} style={{ ...S.btnSecondary, fontSize: 11, padding: "5px 12px" }}>+ Add Custom Phase</button>
          ) : (() => {
            const catPhases = poMs.filter(m => m.category === newPhaseForm.category).sort((a, b) => a.sort_order - b.sort_order);
            return (
            <div style={{ background: "#0F172A", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Phase Name</label>
                  <input value={newPhaseForm.name} onChange={e => setNewPhaseForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Client Approval" style={{ ...S.input, marginBottom: 0, fontSize: 12, padding: "6px 10px" }} />
                </div>
                <div style={{ width: 150 }}>
                  <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Category</label>
                  <select value={newPhaseForm.category} onChange={e => setNewPhaseForm(f => ({ ...f, category: e.target.value, afterPhase: "" }))} style={{ ...S.select, width: "100%", fontSize: 12, padding: "6px 8px" }}>
                    {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ width: 140 }}>
                  <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Due Date</label>
                  <input type="date" value={newPhaseForm.dueDate} onChange={e => setNewPhaseForm(f => ({ ...f, dueDate: e.target.value }))} style={{ ...S.input, marginBottom: 0, fontSize: 12, padding: "5px 8px" }} />
                </div>
                <div style={{ width: 180 }}>
                  <label style={{ color: "#6B7280", fontSize: 10, display: "block", marginBottom: 3, textTransform: "uppercase" }}>Insert After</label>
                  <select value={newPhaseForm.afterPhase} onChange={e => setNewPhaseForm(f => ({ ...f, afterPhase: e.target.value }))} style={{ ...S.select, width: "100%", fontSize: 12, padding: "6px 8px" }}>
                    <option value="">— At beginning —</option>
                    {catPhases.map(p => <option key={p.id} value={p.id}>{p.phase}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => { setAddingPhase(false); setNewPhaseForm({ name: "", category: "Pre-Production", dueDate: "", afterPhase: "" }); }} style={{ ...S.btnSecondary, fontSize: 11, padding: "7px 12px" }}>Cancel</button>
                <button onClick={() => {
                  if (!newPhaseForm.name.trim()) return;
                  const allCatMs = poMs.filter(m => m.category === newPhaseForm.category).sort((a, b) => a.sort_order - b.sort_order);
                  let sortOrder: number;
                  let insertRef = "";
                  let autoDueDate = newPhaseForm.dueDate || "";

                  if (newPhaseForm.afterPhase) {
                    const afterIdx = allCatMs.findIndex(m => m.id === newPhaseForm.afterPhase);
                    if (afterIdx >= 0) {
                      const afterSort = allCatMs[afterIdx].sort_order;
                      const nextSort = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1].sort_order : afterSort + 100;
                      sortOrder = afterSort + (nextSort - afterSort) / 2;
                      insertRef = " (after " + allCatMs[afterIdx].phase + ")";
                      if (!autoDueDate) {
                        const afterDate = allCatMs[afterIdx].expected_date;
                        const nextM = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1] : null;
                        const nextDate = nextM?.expected_date;
                        if (afterDate && nextDate) {
                          const mid = new Date((new Date(afterDate).getTime() + new Date(nextDate).getTime()) / 2);
                          autoDueDate = mid.toISOString().slice(0, 10);
                        } else if (afterDate) {
                          const d = new Date(afterDate); d.setDate(d.getDate() + 7);
                          autoDueDate = d.toISOString().slice(0, 10);
                        }
                      }
                    } else { sortOrder = (allCatMs.length + 1) * 100; }
                  } else if (newPhaseForm.dueDate && allCatMs.length > 0) {
                    const dueMs = allCatMs.filter(m => m.expected_date);
                    const insertAfterIdx = dueMs.reduce((best, m, i) => m.expected_date && m.expected_date <= newPhaseForm.dueDate ? i : best, -1);
                    if (insertAfterIdx >= 0) {
                      const afterM = dueMs[insertAfterIdx];
                      const afterIdx = allCatMs.indexOf(afterM);
                      const afterSort = afterM.sort_order;
                      const nextSort = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1].sort_order : afterSort + 100;
                      sortOrder = afterSort + (nextSort - afterSort) / 2;
                      insertRef = " (by date, after " + afterM.phase + ")";
                    } else {
                      sortOrder = allCatMs[0].sort_order - 100;
                      insertRef = " (by date, at beginning)";
                    }
                  } else {
                    sortOrder = allCatMs.length > 0 ? allCatMs[allCatMs.length - 1].sort_order + 100 : 0;
                  }

                  const newM: Milestone = { id: milestoneUid(), po_number: poNum, phase: newPhaseForm.name.trim(), category: newPhaseForm.category, sort_order: sortOrder, days_before_ddp: 0, expected_date: autoDueDate || null, actual_date: null, status: "Not Started", status_date: null, status_dates: null, notes: "", note_entries: null, updated_at: new Date().toISOString(), updated_by: user?.name || "", variant_statuses: null };
                  saveMilestone(newM, true);
                  addHistory(poNum, `Custom phase added: "${newPhaseForm.name.trim()}" in ${newPhaseForm.category}${insertRef}`);
                  setNewPhaseForm({ name: "", category: "Pre-Production", dueDate: "", afterPhase: "" });
                  setAddingPhase(false);
                }} style={{ ...S.btnPrimary, fontSize: 11, padding: "7px 14px", width: "auto", whiteSpace: "nowrap" }}>Add Phase</button>
              </div>
            </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
