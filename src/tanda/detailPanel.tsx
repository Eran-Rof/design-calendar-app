import React, { useState, useRef, useEffect } from "react";
import { type XoroPO, type Milestone, type WipTemplate, type LocalNote, type User, type DCVendor,
  STATUS_COLORS, WIP_CATEGORIES, MILESTONE_STATUSES, MILESTONE_STATUS_COLORS, DEFAULT_WIP_TEMPLATES,
  milestoneUid, itemQty, poTotal, normalizeSize, sizeSort, fmtDate, fmtCurrency } from "../utils/tandaTypes";
import { styledEmailHtml } from "../utils/emailHtml";
import { MS_CLIENT_ID, MS_TENANT_ID } from "../utils/msAuth";
import { printPODetail } from "./exportHelpers";
import S from "./styles";

export type DetailPanelCtx = Record<string, any>;

const TEAMS_PURPLE = "#5b5ea6";
const TEAMS_PURPLE_LT = "#7b83eb";
const OUTLOOK_BLUE = "#0078D4";

function daysUntil(d?: string) {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86400000);
}

/**
 * Date input that defers committing the value until blur or until a complete
 * YYYY-MM-DD value is selected. Prevents Chrome's native date picker from
 * closing mid-interaction (e.g. clicking month-nav arrows) when the parent
 * re-renders on every keystroke.
 */
function MilestoneDateInput({ value, onCommit, style }: { value: string; onCommit: (v: string) => void; style?: React.CSSProperties }) {
  const [local, setLocal] = useState(value || "");
  const dirtyRef = useRef(false);
  // Re-sync when the upstream value changes (e.g. from cascade) but only if
  // the user isn't currently editing.
  useEffect(() => {
    if (!dirtyRef.current) setLocal(value || "");
  }, [value]);
  return (
    <input
      type="date"
      value={local}
      style={style}
      onChange={e => {
        dirtyRef.current = true;
        const v = e.target.value;
        setLocal(v);
        // Commit immediately only when the value is a complete, valid date.
        // The native picker fires onChange exactly once on day-selection.
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          dirtyRef.current = false;
          if (v !== (value || "")) onCommit(v);
        }
      }}
      onBlur={() => {
        if (!dirtyRef.current) return;
        dirtyRef.current = false;
        if (local !== (value || "")) onCommit(local);
      }}
    />
  );
}

function InfoCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={S.infoCell}>
      <div style={S.infoCellLabel}>{label}</div>
      <div style={S.infoCellValue}>{value}</div>
    </div>
  );
}

export function WipTemplateEditor({ templates, onSave }: { templates: WipTemplate[]; onSave: (t: WipTemplate[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<WipTemplate>({ id: "", phase: "", category: "Pre-Production", daysBeforeDDP: 0, status: "Not Started", notes: "" });

  if (!adding) return (
    <button style={{ ...S.btnSecondary, marginTop: 12 }} onClick={() => { setForm({ id: milestoneUid(), phase: "", category: "Pre-Production", daysBeforeDDP: 0, status: "Not Started", notes: "" }); setAdding(true); }}>
      + Add Phase
    </button>
  );

  return (
    <div style={{ marginTop: 12, background: "#0F172A", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Phase Name</label>
          <input style={{ ...S.input, fontSize: 13 }} value={form.phase} onChange={e => setForm(f => ({ ...f, phase: e.target.value }))} placeholder="e.g. Lab Dip" />
        </div>
        <div>
          <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Category</label>
          <select style={{ ...S.select, width: "100%" }} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
            {WIP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Days Before DDP</label>
          <input type="text" inputMode="numeric" pattern="[0-9]*" style={{ ...S.input, fontSize: 13 }} value={form.daysBeforeDDP} onClick={e => (e.target as HTMLInputElement).select()} onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ""); setForm(f => ({ ...f, daysBeforeDDP: v === "" ? 0 : parseInt(v) })); }} />
        </div>
        <div>
          <label style={{ color: "#94A3B8", fontSize: 11, display: "block", marginBottom: 3 }}>Default Status</label>
          <select style={{ ...S.select, width: "100%" }} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
            {MILESTONE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button style={S.btnSecondary} onClick={() => setAdding(false)}>Cancel</button>
        <button style={{ ...S.btnPrimary, width: "auto", padding: "8px 16px" }} onClick={() => {
          if (!form.phase.trim()) return;
          onSave([...templates, form]);
          setAdding(false);
        }}>Add Phase</button>
      </div>
    </div>
  );
}

export function detailPanel(ctx: DetailPanelCtx): React.ReactElement | null {
  const { selected, detailMode, setDetailMode, setSelected, setView, setNewNote, matrixCollapsed, setMatrixCollapsed, lineItemsCollapsed, setLineItemsCollapsed, poInfoCollapsed, setPoInfoCollapsed, progressCollapsed, setProgressCollapsed, editingNote, setEditingNote, editingNoteId, setEditingNoteId, editingNoteText, setEditingNoteText, msNoteText, setMsNoteText, expandedVariants, setExpandedVariants, addingPhase, setAddingPhase, newPhaseForm, setNewPhaseForm, acceptedBlocked, setAcceptedBlocked, blockedModal, setBlockedModal, confirmModal, setConfirmModal, collapsedCats, setCollapsedCats, showCreateTpl, setShowCreateTpl, attachments, setAttachments, attachInputRef, uploadingAttachment, setUploadingAttachment, milestones, setMilestones, wipTemplates, setWipTemplates, dcVendors, designTemplates, notes, newNote, user, emailToken, teamsToken, msDisplayName, pos, toast, setToast, handleExportPOExcel, ensureMilestones, saveMilestone, saveMilestones, generateMilestones, regenerateMilestones, cascadeDueDateChange, vendorHasTemplate, templateVendorList, getVendorTemplates, saveVendorTemplates, openCategoryWithCheck, isCatBlocked, uploadAttachment, loadAttachments, deleteAttachment, undoDeleteAttachment, purgeExpiredAttachments, addNote, editNote, deleteNote, addHistory, deletePO, setSearch, setTeamsSelPO, setTeamsTab, loadDtlEmails, loadDtlFullEmail, loadDtlThread, loadDtlSentEmails, authenticateEmail, dtlReplyToEmail, dtlSendEmail, teamsLoadPOMessages, teamsStartChat, teamsSendMessage, teamsGraphPost, teamsGraph, loadTeamsContacts, handleTeamsContactInput, teamsSendDirect, sendDmReply, loadDmMessages, msSignOut, selectedNotes, selectedHistory, dtlEmails, dtlEmailLoading, dtlEmailErr, dtlEmailSel, dtlEmailThread, dtlThreadLoading, dtlEmailTab, setDtlEmailTab, dtlSentEmails, dtlSentLoading, dtlComposeTo, setDtlComposeTo, dtlComposeSubject, setDtlComposeSubject, dtlComposeBody, setDtlComposeBody, dtlSendErr, setDtlSendErr, dtlReply, setDtlReply, dtlNextLink, dtlLoadingOlder, setDtlLoadingOlder, teamsChannelMap, teamsMessages, setTeamsMessages, teamsLoading, teamsNewMsg, setTeamsNewMsg, teamsContacts, teamsContactsLoading, teamsContactsError, dtlDMTo, setDtlDMTo, dtlDMMsg, setDtlDMMsg, dtlDMSending, setDtlDMSending, dtlDMErr, setDtlDMErr, dtlDMContactSearch, setDtlDMContactSearch, dtlDMContactDropdown, setDtlDMContactDropdown, dtlDMContactSearchResults, setDtlDMContactSearchResults, dtlDMContactSearchLoading, setDtlDMContactSearchLoading, dmConversations, setDmConversations, dmActiveChatId, setDmActiveChatId, dmScrollRef } = ctx;

    if (!selected) return null;
    const items = selected.Items ?? selected.PoLineArr ?? [];
    const days  = daysUntil(selected.DateExpectedDelivery);
    const total = poTotal(selected);
    const statusColor = STATUS_COLORS[selected.StatusName ?? ""] ?? "#6B7280";

    // Lazy-generate milestones on first view
    const poNum = selected.PoNumber ?? "";
    if (poNum && selected.DateExpectedDelivery && !milestones[poNum]) {
      const vendorN = selected.VendorName ?? "";
      if (vendorN && !vendorHasTemplate(vendorN)) {
        // Show create-template modal instead of detail panel
        if (!showCreateTpl) setShowCreateTpl(vendorN);
      } else {
        ensureMilestones(selected);
      }
    }

    // Block detail panel — show create-template modal first
    if (showCreateTpl) {
      const vendorN = showCreateTpl;
      return (
        <div style={S.modalOverlay} onClick={() => { setShowCreateTpl(null); setSelected(null); }}>
          <div style={{ ...S.modal, width: 500 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Create Production Template</h2>
              <button style={S.closeBtn} onClick={() => { setShowCreateTpl(null); setSelected(null); }}>✕</button>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#D1D5DB", fontSize: 14, marginTop: 0, marginBottom: 16 }}>
                No production template exists for <strong style={{ color: "#60A5FA" }}>{vendorN}</strong>. Create one to generate milestones for this PO.
              </p>
              <div style={{ marginBottom: 16 }}>
                <label style={S.label}>Copy from</label>
                <select style={{ ...S.select, width: "100%" }} id="modalCopyFrom">
                  <option value="__default__">Default Template</option>
                  {templateVendorList().map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => { setShowCreateTpl(null); setSelected(null); }}>
                  Cancel
                </button>
                <button style={{ ...S.btnPrimary, flex: 2 }} onClick={async () => {
                  const copyEl = document.getElementById("modalCopyFrom") as HTMLSelectElement;
                  const copyFrom = copyEl?.value || "__default__";
                  const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom);
                  const newTpls = source.map(t => ({ ...t, id: milestoneUid() }));
                  await saveVendorTemplates(vendorN, newTpls);
                  setShowCreateTpl(null);
                  const poNum = selected?.PoNumber ?? "";
                  addHistory(poNum, `Template created for ${vendorN} (copied from ${copyFrom === "__default__" ? "Default" : copyFrom})`);
                  // Generate milestones now that template exists
                  if (selected && selected.DateExpectedDelivery) {
                    const ms = generateMilestones(poNum, selected.DateExpectedDelivery, vendorN);
                    if (ms.length > 0) {
                      await saveMilestones(ms);
                      addHistory(poNum, `Milestones generated (${ms.length} phases) using ${vendorN} template`);
                    }
                  }
                }}>
                  Create Template & Generate Milestones
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const showPO = detailMode === "po" || detailMode === "all";
    const showMilestones = detailMode === "milestones" || detailMode === "all";
    const showNotes = detailMode === "notes" || detailMode === "all";
    const showHistory = detailMode === "history" || detailMode === "all";
    const totalQty = items.reduce((s, i) => s + itemQty(i), 0);

    // Matrix rows (base+color combos) — shared by Item Matrix table and variant panel
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

    const tabStyle = (mode: string): React.CSSProperties => ({
      flex: 1, padding: "12px 20px", fontSize: 16, cursor: "pointer", fontWeight: 700,
      border: "1px solid #334155", borderBottom: detailMode === mode ? "none" : "1px solid #334155",
      background: detailMode === mode ? "#1E293B" : "#0F172A",
      color: detailMode === mode ? "#60A5FA" : "#6B7280",
      borderRadius: "10px 10px 0 0",
      marginBottom: detailMode === mode ? -1 : 0,
      position: "relative" as const,
      zIndex: detailMode === mode ? 1 : 0,
    });

    return (
      <div style={{ position: "fixed", inset: 0, top: 56, background: "#0F172A", zIndex: 90, overflowY: "auto", display: "flex", flexDirection: "column", fontSize: "120%" }}>
        <div id="po-detail-content" style={{ maxWidth: "90%", margin: "0 auto", width: "100%", padding: "24px 20px", flex: 1 }}>
          {/* Header — sticky, includes all PO info */}
          <div style={{ ...S.detailHeader, borderLeft: `4px solid ${statusColor}`, borderRadius: 12, marginBottom: 16, position: "sticky", top: 0, zIndex: 10, background: "#0F172A", flexDirection: "column", gap: 10 }}>
            {/* Row 1: PO# / Vendor + buttons */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%" }}>
              <div>
                <div style={{ ...S.detailPONum, fontSize: 24 }}>{selected.PoNumber ?? "—"}</div>
                <div style={{ ...S.detailVendor, fontSize: 18 }}>{selected.VendorName ?? "Unknown Vendor"}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ ...S.badge, background: statusColor + "33", color: statusColor, border: `1px solid ${statusColor}66`, fontSize: 14, padding: "4px 12px" }}>
                  {selected.StatusName ?? "Unknown"}
                </span>
                <button onClick={() => handleExportPOExcel(selected, items, detailMode)}
                  style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                  onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Excel
                </button>
                <button style={{ ...S.btnSecondary, fontSize: 12, padding: "6px 14px", display: "flex", alignItems: "center", gap: 4 }} onClick={() => printPODetail()}>🖨️ Print</button>
                <button onClick={() => setConfirmModal({ title: "Delete PO", message: `Delete PO ${selected.PoNumber}? This will permanently remove the PO, all milestones, notes, and history.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => deletePO(selected.PoNumber ?? "") })}
                  style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#EF4444"; e.currentTarget.style.color = "#fff"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#EF4444"; }}>🗑 Delete PO</button>
                <button style={{ ...S.closeBtn, fontSize: 16, padding: "4px 10px" }} onClick={() => { setSelected(null); setSearch(""); }}>✕ Close</button>
              </div>
            </div>
            {/* Row 2: PO info pills */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(() => {
                const ddpColor = days !== null && days < 0 ? "#EF4444" : days !== null && days <= 7 ? "#F59E0B" : "#10B981";
                const ddpSuffix = days === null ? "" : days < 0 ? ` (${Math.abs(days)}d late)` : days === 0 ? " (Today!)" : ` (${days}d)`;
                const origin = (() => { const v = dcVendors.find(v => v.name === selected.VendorName); return (v as any)?.country || null; })();
                const pills: [string, string, string?][] = [
                  ["Order", fmtDate(selected.DateOrder) || "—"],
                  ["DDP", (fmtDate(selected.DateExpectedDelivery) || "—") + ddpSuffix, ddpColor],
                  ...(selected.VendorReqDate ? [["Vendor Req", fmtDate(selected.VendorReqDate)] as [string, string]] : []),
                  ["Value", fmtCurrency(total, selected.CurrencyCode)],
                  ["Qty", totalQty.toLocaleString()],
                  ...(selected.PaymentTermsName ? [["Payment", selected.PaymentTermsName] as [string, string]] : []),
                  ...(selected.ShipMethodName ? [["Ship", selected.ShipMethodName] as [string, string]] : []),
                  ...(selected.CarrierName ? [["Carrier", selected.CarrierName] as [string, string]] : []),
                  ...(selected.BuyerName ? [["Buyer", selected.BuyerName] as [string, string]] : []),
                  ...(selected.BrandName ? [["Brand", selected.BrandName] as [string, string]] : []),
                  ...(origin ? [["Origin", origin] as [string, string]] : []),
                  ...(selected.Memo ? [["Memo", selected.Memo] as [string, string]] : []),
                  ...(selected.Tags ? [["Tags", selected.Tags] as [string, string]] : []),
                ];
                return pills.map(([label, val, color]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "#1E293B", borderRadius: 6, border: "1px solid #334155" }}>
                    <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}:</span>
                    <span style={{ fontSize: 13, color: color || "#D1D5DB", fontWeight: 600 }}>{val}</span>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Milestone Progress Bar + Quick Status */}
          {(() => {
            const poMs = milestones[selected.PoNumber ?? ""] || [];
            if (poMs.length === 0) return null;
            const complete = poMs.filter(m => m.status === "Complete").length;
            const inProg = poMs.filter(m => m.status === "In Progress").length;
            const delayed = poMs.filter(m => m.status === "Delayed").length;
            const na = poMs.filter(m => m.status === "N/A").length;
            const active = poMs.length - na;
            const pct = active > 0 ? Math.round((complete / active) * 100) : 0;
            const delayedPct = active > 0 ? Math.round((delayed / active) * 100) : 0;
            const inProgPct = active > 0 ? Math.round((inProg / active) * 100) : 0;
            // Category summary
            const cats = WIP_CATEGORIES.filter(cat => poMs.some(m => m.category === cat));
            return (
              <div style={{ marginBottom: 12 }}>
                <div onClick={() => setProgressCollapsed(!progressCollapsed)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: progressCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
                  <span style={{ color: "#6B7280", fontSize: 12 }}>{progressCollapsed ? "▶" : "▼"}</span>
                  <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Production Progress</span>
                  <span style={{ color: "#10B981", fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}>{pct}%</span>
                  <span style={{ color: "#6B7280", fontSize: 11 }}>{complete}/{active} milestones</span>
                  {delayed > 0 && <span style={{ color: "#EF4444", fontSize: 11, fontWeight: 600 }}>⚠ {delayed} delayed</span>}
                </div>
                {!progressCollapsed && <div style={{ background: "#0F172A", borderRadius: "0 0 8px 8px", padding: "12px 14px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                  {([
                    ["Complete", complete, "#10B981", "#6EE7B7", "#047857"],
                    ["In Progress", inProg, "#3B82F6", "#93C5FD", "#1D4ED8"],
                    ["Delayed", delayed, "#EF4444", "#FCA5A5", "#7F1D1D"],
                    ["Not Started", active - complete - inProg - delayed, "#6B7280", "#6B7280", "#1F2937"],
                  ] as [string, number, string, string, string][]).filter(([, count]) => (count as number) > 0).map(([label, count, labelColor, gradLight, gradDark]) => {
                    const statusPct = active > 0 ? Math.round(((count as number) / active) * 100) : 0;
                    return (
                      <div key={label as string} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 90, fontSize: 11, color: labelColor as string, fontWeight: 600, textAlign: "right", flexShrink: 0 }}>{label as string}</span>
                        <div style={{ flex: 1, height: 10, borderRadius: 5, background: "#0F172A", overflow: "hidden" }}>
                          <div style={{ width: `${statusPct}%`, height: "100%", background: `linear-gradient(90deg, ${gradLight}, ${gradDark})`, borderRadius: 5, transition: "width 0.3s", minWidth: (count as number) > 0 ? 4 : 0 }} />
                        </div>
                        <span style={{ width: 55, fontSize: 11, color: "#94A3B8", fontFamily: "monospace", flexShrink: 0 }}>{count} ({statusPct}%)</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {cats.map(cat => {
                    const catMs = poMs.filter(m => m.category === cat);
                    const catDone = catMs.filter(m => m.status === "Complete").length;
                    const catNA = catMs.filter(m => m.status === "N/A").length;
                    const catActive = catMs.length - catNA;
                    const allDone = catActive > 0 && catDone === catActive;
                    const hasDelayed = catMs.some(m => m.status === "Delayed");
                    const hasInProg = catMs.some(m => m.status === "In Progress");
                    const dotColor = allDone ? "#10B981" : hasDelayed ? "#EF4444" : hasInProg ? "#3B82F6" : "#6B7280";
                    return (
                      <div key={cat} onClick={() => openCategoryWithCheck(selected.PoNumber ?? "", cat)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 6, background: "#0F172A", border: "1px solid #334155", cursor: "pointer", transition: "border-color 0.15s" }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = dotColor}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "#334155"}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor }} />
                        <span style={{ fontSize: 11, color: "#D1D5DB" }}>{cat}</span>
                        <span style={{ fontSize: 10, color: "#6B7280", fontFamily: "monospace" }}>{catDone}/{catActive}</span>
                      </div>
                    );
                  })}
                </div>
                </div>}
              </div>
            );
          })()}

          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 0 }}>
            <button style={tabStyle("po")} onClick={() => setDetailMode("po")}>PO / Matrix</button>
            <button style={tabStyle("milestones")} onClick={() => setDetailMode("milestones")}>Milestones</button>
            <button style={tabStyle("notes")} onClick={() => setDetailMode("notes")}>Notes</button>
            <button style={tabStyle("attachments")} onClick={() => { setDetailMode("attachments"); const pn = selected.PoNumber ?? ""; if (pn && !attachments[pn]) loadAttachments(pn); }}>📎 Files</button>
            <button style={tabStyle("email")} onClick={() => { setDetailMode("email"); setDtlEmailTab("inbox"); const pn = selected.PoNumber ?? ""; if (pn && emailToken && !dtlEmails[pn]?.length) loadDtlEmails(pn); }}>📧 Email/Teams</button>
            <button style={tabStyle("history")} onClick={() => setDetailMode("history")}>History</button>
            <button style={tabStyle("all")} onClick={() => setDetailMode("all")}>All</button>
          </div>
          <div style={{ border: "1px solid #334155", borderTop: "none", borderRadius: "0 0 10px 10px", background: "#1E293B", padding: 20, marginBottom: 20 }}>

          {/* PO / Matrix combined section */}
          {showPO && items.length > 0 && (() => {
            // Matrix data
            const parsed = items.map((item: any) => {
              const sku = item.ItemNumber ?? ""; const parts = sku.split("-");
              const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
              const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
              return { base: parts[0] || sku, color, size: sz, qty: itemQty(item), price: item.UnitPrice ?? 0, desc: item.Description ?? "" };
            });
            const sizeSet2 = new Set<string>();
            parsed.forEach((p: any) => { if (p.size) sizeSet2.add(p.size); });
            const sizeOrder = [...sizeSet2].sort(sizeSort);
            const bases: string[] = [];
            const byBase: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number }[]> = {};
            parsed.forEach((p: any) => {
              if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
              let row = byBase[p.base].find((r: any) => r.color === p.color);
              if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price }; byBase[p.base].push(row); }
              row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
            });

            return (
              <>
                {/* Matrix — collapsible, milestone-tab style */}
                <div style={{ marginBottom: 8 }}>
                  <div onClick={() => setMatrixCollapsed(!matrixCollapsed)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: matrixCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
                    <span style={{ color: "#6B7280", fontSize: 12 }}>{matrixCollapsed ? "▶" : "▼"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Item Matrix</span>
                    <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{bases.length} base parts · {sizeOrder.length} sizes</span>
                  </div>
                  {!matrixCollapsed && (
                    <div style={{ overflowX: "auto", background: "#0F172A", borderRadius: "0 0 8px 8px" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: "#0F172A" }}>
                            <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Base Part</th>
                            <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Description</th>
                            <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Color</th>
                            {sizeOrder.map(sz => (
                              <th key={sz} style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", minWidth: 60 }}>{sz}</th>
                            ))}
                            <th style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total</th>
                            <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>PO Cost</th>
                            <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bases.map((base, bi) => {
                            const rows = byBase[base];
                            return rows.map((row, ri) => {
                              const rowTotal = Object.values(row.sizes).reduce((s: number, q: any) => s + q, 0);
                              const rowCost = rowTotal * row.price;
                              const isLast = ri === rows.length - 1;
                              return (
                                <tr key={base + "-" + row.color} style={{ borderBottom: isLast && bi < bases.length - 1 ? "2px solid #334155" : "1px solid #1E293B" }}>
                                  <td style={{ padding: "8px 14px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, borderRight: "1px solid #334155" }}>{base}</td>
                                  <td style={{ padding: "8px 14px", color: "#9CA3AF", fontSize: 12 }}>{row.desc || "—"}</td>
                                  <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                                  {sizeOrder.map(sz => (
                                    <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: row.sizes[sz] ? "#E5E7EB" : "#334155", fontFamily: "monospace" }}>{row.sizes[sz] || "—"}</td>
                                  ))}
                                  <td style={{ padding: "8px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{rowTotal}</td>
                                  <td style={{ padding: "8px 14px", textAlign: "right", color: "#9CA3AF", fontFamily: "monospace" }}>{fmtCurrency(row.price, selected.CurrencyCode)}</td>
                                  <td style={{ padding: "8px 14px", textAlign: "right", color: "#10B981", fontWeight: 600, fontFamily: "monospace" }}>{fmtCurrency(rowCost, selected.CurrencyCode)}</td>
                                </tr>
                              );
                            });
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: "2px solid #334155", background: "#0F172A" }}>
                            <td colSpan={3} style={{ padding: "12px 14px", color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                            {sizeOrder.map(sz => {
                              const colTotal = parsed.filter((p: any) => p.size === sz).reduce((s: number, p: any) => s + p.qty, 0);
                              return <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{colTotal}</td>;
                            })}
                            <td style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>{totalQty}</td>
                            <td style={{ padding: "12px 14px" }} />
                            <td style={{ padding: "12px 14px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(total, selected.CurrencyCode)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>

                {/* Line Items — collapsible, milestone-tab style */}
                <div style={{ marginBottom: 20 }}>
                  <div onClick={() => setLineItemsCollapsed(!lineItemsCollapsed)}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: lineItemsCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
                    <span style={{ color: "#6B7280", fontSize: 12 }}>{lineItemsCollapsed ? "▶" : "▼"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Line Items</span>
                    <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{items.length} items</span>
                  </div>
                  {!lineItemsCollapsed && (
                    <div style={{ ...S.itemsTable, borderRadius: "0 0 8px 8px" }}>
                      <div style={S.itemsHeader}>
                        <span>SKU</span><span>Description</span><span>Qty</span><span>Unit Price</span><span>Total</span>
                      </div>
                      {items.map((item, i) => (
                        <div key={i} style={S.itemRow}>
                          <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>{item.ItemNumber ?? "—"}</span>
                          <span style={{ color: "#D1D5DB" }}>{item.Description ?? "—"}</span>
                          <span style={{ color: "#E5E7EB", textAlign: "right" }}>{itemQty(item)}{(item.QtyReceived ?? 0) > 0 ? <span style={{ color: "#6B7280", fontSize: 10 }}> / {item.QtyOrder}</span> : ""}</span>
                          <span style={{ color: "#E5E7EB", textAlign: "right" }}>{fmtCurrency(item.UnitPrice, selected.CurrencyCode)}</span>
                          <span style={{ color: "#10B981", textAlign: "right", fontWeight: 600 }}>
                            {fmtCurrency(itemQty(item) * (item.UnitPrice ?? 0), selected.CurrencyCode)}
                          </span>
                        </div>
                      ))}
                      <div style={S.itemsTotal}>
                        <span style={{ gridColumn: "1/5", textAlign: "right", color: "#9CA3AF" }}>Total</span>
                        <span style={{ color: "#10B981", fontWeight: 700 }}>{fmtCurrency(total, selected.CurrencyCode)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

            {/* Attachments Tab */}
            {(detailMode === "attachments" || detailMode === "all") && (() => {
              const pn = selected.PoNumber ?? "";
              const files = attachments[pn] || [];
              const fmtSize = (b: number) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB";
              const getFileIcon = (type: string, name: string) => {
                const ext = name.split(".").pop()?.toLowerCase() || "";
                if (type.includes("pdf") || ext === "pdf") return { bg: "#DC2626", label: "PDF" };
                if (type.includes("sheet") || type.includes("excel") || ext === "xlsx" || ext === "xls" || ext === "csv") return { bg: "#16A34A", label: "XLS" };
                if (type.includes("word") || type.includes("doc") || ext === "docx" || ext === "doc") return { bg: "#2563EB", label: "DOC" };
                if (type.includes("presentation") || type.includes("powerpoint") || ext === "pptx" || ext === "ppt") return { bg: "#D97706", label: "PPT" };
                if (ext === "zip" || ext === "rar" || ext === "7z") return { bg: "#7C3AED", label: "ZIP" };
                if (ext === "txt" || ext === "rtf") return { bg: "#6B7280", label: "TXT" };
                return { bg: "#475569", label: ext.toUpperCase().slice(0, 3) || "FILE" };
              };
              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={S.sectionLabel}>Attachments ({files.filter(f => !(f as any).deleted_at).length})</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {uploadingAttachment && <span style={{ fontSize: 12, color: "#F59E0B" }}>Uploading…</span>}
                      <input id="po-attach-input" type="file" multiple accept="*/*" style={{ display: "none" }} onChange={async e => {
                        const fileList = e.target.files; if (!fileList || fileList.length === 0) return;
                        setUploadingAttachment(true);
                        const existingFiles = (attachments[pn] || []).filter((f: any) => !(f as any).deleted_at);
                        const names: string[] = [];
                        for (let i = 0; i < fileList.length; i++) {
                          const file = fileList[i];
                          const duplicate = existingFiles.find((f: any) => f.name === file.name);
                          let uploadFile = file;
                          if (duplicate) {
                            const action = await new Promise<"replace" | "add" | "skip">(resolve => {
                              setConfirmModal({
                                title: "File Already Exists",
                                message: `"${file.name}" already exists in this PO's attachments.`,
                                icon: "📎",
                                confirmText: "Replace",
                                confirmColor: "#EF4444",
                                cancelText: "Add Version",
                                onConfirm: () => resolve("replace"),
                                onCancel: () => resolve("add"),
                              });
                            });
                            if (action === "replace") {
                              await deleteAttachment(pn, duplicate.id);
                            } else {
                              // Add version number: count existing copies of this base name
                              const baseName = file.name.replace(/\.[^.]+$/, "");
                              const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
                              // Strip existing version suffix (V2, V3, etc.) from base for counting
                              const cleanBase = baseName.replace(/ V\d+$/, "");
                              const versionCount = existingFiles.filter((f: any) => {
                                const fBase = f.name.replace(/\.[^.]+$/, "").replace(/ V\d+$/, "");
                                return fBase === cleanBase;
                              }).length;
                              const versionedName = `${cleanBase} V${versionCount + 1}${ext}`;
                              uploadFile = new File([file], versionedName, { type: file.type });
                            }
                          }
                          try {
                            await uploadAttachment(pn, uploadFile);
                            names.push(uploadFile.name);
                          } catch (err) { console.error("Upload error:", err); }
                        }
                        if (names.length > 0) {
                          addHistory(pn, `Attachment${names.length > 1 ? "s" : ""} uploaded: ${names.join(", ")}`);
                        }
                        await loadAttachments(pn);
                        setUploadingAttachment(false);
                        e.target.value = "";
                      }} />
                      <button onClick={() => (document.getElementById("po-attach-input") as HTMLInputElement)?.click()} disabled={uploadingAttachment} style={{ ...S.btnPrimary, fontSize: 11, padding: "6px 14px", width: "auto", opacity: uploadingAttachment ? 0.5 : 1 }}>+ Upload Files</button>
                    </div>
                  </div>
                  {files.length === 0 ? (
                    <div style={{ background: "#0F172A", borderRadius: 8, padding: 30, textAlign: "center" }}>
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📎</div>
                      <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>No attachments yet</div>
                      <button onClick={() => (document.getElementById("po-attach-input") as HTMLInputElement)?.click()} style={{ ...S.btnSecondary, fontSize: 12 }}>Upload your first file</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {files.map(f => {
                        const isDeleted = !!(f as any).deleted_at;
                        const timeAgo = f.uploaded_at ? (() => { const ms = Date.now() - new Date(f.uploaded_at).getTime(); const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })() : "";
                        const deleteTimeLeft = isDeleted ? (() => { const ms = 24 * 60 * 60 * 1000 - (Date.now() - new Date((f as any).deleted_at).getTime()); if (ms <= 0) return ""; const h = Math.floor(ms / 3600000); return `${h}h left to undo`; })() : "";
                        if (isDeleted) {
                          const msLeft = 24 * 60 * 60 * 1000 - (Date.now() - new Date((f as any).deleted_at).getTime());
                          if (msLeft <= 0) return null;
                          const h = Math.floor(msLeft / 3600000); const m = Math.floor((msLeft % 3600000) / 60000); const s = Math.floor((msLeft % 60000) / 1000);
                          const countdown = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
                          return (
                          <div key={f.id} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0F172A", borderRadius: 8, border: "1px dashed #EF444444", overflow: "hidden" }}>
                            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                              <span style={{ fontSize: 28, fontWeight: 800, fontFamily: "monospace", color: "#10B981", textShadow: "0 0 12px #10B98166, 0 0 24px #10B98133", letterSpacing: 2 }}>{countdown}</span>
                            </div>
                            <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", alignItems: "center", gap: 12, opacity: 0.5 }}>
                              <span style={{ fontSize: 24, flexShrink: 0 }}>🗑</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, color: "#EF4444", fontWeight: 600, textDecoration: "line-through" }}>{f.name}</div>
                              </div>
                            </div>
                            <button onClick={() => undoDeleteAttachment(pn, f.id)}
                              style={{ position: "relative", zIndex: 2, padding: "8px 18px", borderRadius: 8, border: "none", background: "linear-gradient(135deg, #F59E0B, #D97706)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, boxShadow: "0 2px 8px rgba(245,158,11,0.3)" }}>↩ Undo</button>
                          </div>
                          );
                        }
                        return (
                          <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#0F172A", borderRadius: 8, border: "1px solid #334155" }}>
                            {f.type.startsWith("image/") && f.url ? (
                              <img src={f.url} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", flexShrink: 0, border: "1px solid #334155" }} />
                            ) : (
                              <div style={{ width: 44, height: 44, borderRadius: 6, background: getFileIcon(f.type, f.name).bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                <span style={{ color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>{getFileIcon(f.type, f.name).label}</span>
                              </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#60A5FA", fontWeight: 600, textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                                onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"} onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}>{f.name}</a>
                              <div style={{ fontSize: 11, color: "#6B7280" }}>{fmtSize(f.size)} · {f.uploaded_by} · {timeAgo}</div>
                            </div>
                            <button onClick={e => { e.stopPropagation(); setConfirmModal({ title: "Delete Attachment", message: `Delete "${f.name}"? You'll have 24 hours to undo.`, icon: "🗑", confirmText: "Delete", confirmColor: "#EF4444", onConfirm: () => deleteAttachment(pn, f.id) }); }}
                              style={{ background: "none", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>✕</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Email Tab */}
            {(detailMode === "email" || detailMode === "all") && (() => {
              const OUTLOOK_BLUE = "#0078D4";
              const pn = selected.PoNumber ?? "";
              const prefix = "[PO-" + pn + "]";
              const dtlList = dtlEmails[pn] || [];
              const isLoading = !!dtlEmailLoading[pn];
              const err = dtlEmailErr[pn];

              return (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={S.sectionLabel}>Emails for {prefix}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {emailToken && <button onClick={() => loadDtlEmails(pn)} style={{ ...S.btnSecondary, fontSize: 11, padding: "4px 10px" }}>↻ Refresh</button>}
                    </div>
                  </div>

                  {!emailToken ? (
                    <div style={{ textAlign: "center", padding: "30px 0" }}>
                      <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                      <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>Sign in with Microsoft to view emails</div>
                      {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                        <div style={{ color: "#D97706", fontSize: 12 }}>Azure credentials not configured — check Vercel env vars</div>
                      ) : (
                        <button onClick={authenticateEmail} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap" as const }}>
                        {(["inbox", "sent", "thread", "compose", "teams"] as const).map(tab => (
                          <button key={tab} onClick={() => { setDtlEmailTab(tab); if (tab === "compose") setDtlComposeSubject(prefix + " "); if (tab === "sent") loadDtlSentEmails(poNum); if (tab === "teams" && teamsToken && teamsChannelMap[poNum] && !teamsMessages[poNum]?.length) teamsLoadPOMessages(poNum); }}
                            style={{ padding: "8px 14px", border: "1px solid #334155", borderBottom: dtlEmailTab === tab ? "none" : "1px solid #334155", background: dtlEmailTab === tab ? "#1E293B" : "#0F172A", color: dtlEmailTab === tab ? (tab === "teams" ? TEAMS_PURPLE_LT : OUTLOOK_BLUE) : "#6B7280", fontWeight: dtlEmailTab === tab ? 700 : 500, cursor: "pointer", fontFamily: "inherit", fontSize: 12, borderRadius: "8px 8px 0 0" }}>
                            {tab === "teams" ? "💬 Teams" : tab.charAt(0).toUpperCase() + tab.slice(1)}
                          </button>
                        ))}
                      </div>

                      {dtlEmailTab === "inbox" && (
                        <>
                          {isLoading ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading emails…</div>
                          ) : err ? (
                            <div style={{ background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "12px 16px", color: "#FCA5A5", fontSize: 13 }}>⚠ {err}</div>
                          ) : dtlList.length === 0 ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0" }}>
                              <div style={{ fontSize: 24, marginBottom: 6 }}>📧</div>
                              <div style={{ fontSize: 13 }}>No emails matching "{prefix}"</div>
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {dtlList.map((em: any) => {
                                const sender = em.from?.emailAddress ? em.from.emailAddress.name || em.from.emailAddress.address : "Unknown";
                                const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                                const time = em.receivedDateTime ? new Date(em.receivedDateTime).toLocaleString() : "";
                                return (
                                  <div key={em.id} onClick={() => { loadDtlFullEmail(em.id); if (em.conversationId) loadDtlThread(em.conversationId); }}
                                    style={{ background: em.isRead ? "#0F172A" : OUTLOOK_BLUE + "15", border: "1px solid " + (em.isRead ? "#334155" : OUTLOOK_BLUE + "44"), borderRadius: 8, padding: "10px 14px", cursor: "pointer", transition: "all 0.12s" }}>
                                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                      <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                          <span style={{ fontSize: 12, fontWeight: em.isRead ? 500 : 700, color: "#F1F5F9" }}>{sender}</span>
                                          <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                          {em.hasAttachments && <span style={{ fontSize: 10, color: "#6B7280" }}>📎</span>}
                                          {!em.isRead && <span style={{ width: 7, height: 7, borderRadius: "50%", background: OUTLOOK_BLUE, flexShrink: 0 }} />}
                                        </div>
                                        <div style={{ fontSize: 12, fontWeight: em.isRead ? 400 : 600, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                                        <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{em.bodyPreview || ""}</div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                              {dtlNextLink[pn] && (
                                <button onClick={() => loadDtlEmails(pn, dtlNextLink[pn]!)} disabled={dtlLoadingOlder} style={{ ...S.btnPrimary, opacity: dtlLoadingOlder ? 0.6 : 1, fontSize: 12 }}>{dtlLoadingOlder ? "Loading…" : "Load older emails"}</button>
                              )}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                            <button onClick={() => { setDtlEmailTab("compose"); setDtlComposeSubject(prefix + " "); }} style={{ ...S.btnPrimary, width: "auto", fontSize: 11, padding: "7px 14px" }}>+ New Email</button>
                            <span style={{ fontSize: 11, color: "#6B7280" }}>{dtlList.length} email{dtlList.length !== 1 ? "s" : ""}</span>
                          </div>
                        </>
                      )}

                      {dtlEmailTab === "sent" && (
                        <div>
                          {dtlSentLoading[pn] ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading sent emails…</div>
                          ) : (dtlSentEmails[pn] || []).length === 0 ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0" }}><div style={{ fontSize: 24, marginBottom: 6 }}>📤</div><div style={{ fontSize: 13 }}>No sent emails for "{prefix}"</div></div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {(dtlSentEmails[pn] || []).map((em: any) => {
                                const toList = (em.toRecipients || []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean).join(", ") || "—";
                                const time = em.sentDateTime ? new Date(em.sentDateTime).toLocaleString() : "";
                                return (
                                  <div key={em.id} onClick={() => { loadDtlFullEmail(em.id); if (em.conversationId) loadDtlThread(em.conversationId); }}
                                    style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", cursor: "pointer" }}>
                                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                      <div style={{ width: 30, height: 30, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>→</div>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                                          <span style={{ fontSize: 11, color: "#94A3B8" }}>To: {toList}</span>
                                          <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                          {em.hasAttachments && <span style={{ fontSize: 10, color: "#6B7280" }}>📎</span>}
                                        </div>
                                        <div style={{ fontSize: 12, fontWeight: 500, color: "#E2E8F0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{em.subject}</div>
                                        <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>{em.bodyPreview || ""}</div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {dtlEmailTab === "thread" && (
                        <div>
                          {dtlThreadLoading ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Loading thread…</div>
                          ) : dtlEmailThread.length === 0 ? (
                            <div style={{ textAlign: "center", color: "#6B7280", padding: "24px 0", fontSize: 13 }}>Click an email to view its thread</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                              {dtlEmailThread.map((msg: any) => {
                                const sender = msg.from?.emailAddress ? msg.from.emailAddress.name || msg.from.emailAddress.address : "Unknown";
                                const initials = sender.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
                                const time = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleString() : "";
                                const htmlBody = msg.body?.content || "";
                                return (
                                  <div key={msg.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "12px 16px" }}>
                                    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
                                      <div style={{ width: 28, height: 28, borderRadius: "50%", background: OUTLOOK_BLUE + "22", border: "2px solid " + OUTLOOK_BLUE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: OUTLOOK_BLUE, flexShrink: 0 }}>{initials}</div>
                                      <div style={{ flex: 1 }}>
                                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                                          <span style={{ fontSize: 12, fontWeight: 700, color: "#F1F5F9" }}>{sender}</span>
                                          <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                        </div>
                                        <div style={{ fontSize: 11, color: "#6B7280" }}>{msg.subject}</div>
                                      </div>
                                    </div>
                                    <iframe sandbox="allow-same-origin" srcDoc={styledEmailHtml(htmlBody)} style={{ width: "100%", border: "none", minHeight: 80, borderRadius: 6, background: "#F8FAFC" }}
                                      onLoad={e => { try { const h = (e.target as HTMLIFrameElement).contentDocument!.body.scrollHeight; (e.target as HTMLIFrameElement).style.height = Math.min(h + 20, 400) + "px"; } catch (_) {} }} />
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {dtlEmailSel && (
                            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                              <input value={dtlReply} onChange={e => setDtlReply(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dtlReplyToEmail(dtlEmailSel.id); } }} placeholder="Write a reply…" style={{ ...S.input, flex: 1 }} />
                              <button onClick={() => dtlReplyToEmail(dtlEmailSel.id)} style={{ ...S.btnPrimary, width: "auto", padding: "10px 20px" }}>Reply</button>
                            </div>
                          )}
                        </div>
                      )}

                      {dtlEmailTab === "compose" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          <div>
                            <label style={S.label}>To (comma-separated)</label>
                            <input value={dtlComposeTo} onChange={e => setDtlComposeTo(e.target.value)} placeholder="email@example.com" style={S.input} />
                          </div>
                          <div>
                            <label style={S.label}>Subject</label>
                            <input value={dtlComposeSubject} onChange={e => setDtlComposeSubject(e.target.value)} style={S.input} />
                          </div>
                          <div>
                            <label style={S.label}>Body</label>
                            <textarea value={dtlComposeBody} onChange={e => setDtlComposeBody(e.target.value)} rows={8} style={{ ...S.textarea, minHeight: 120 }} placeholder="Type your message…" />
                          </div>
                          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                            <button onClick={() => setDtlEmailTab("inbox")} style={S.btnSecondary}>Cancel</button>
                            <button onClick={() => dtlSendEmail(pn)} disabled={!dtlComposeTo.trim() || !dtlComposeSubject.trim()} style={{ ...S.btnPrimary, width: "auto", opacity: (!dtlComposeTo.trim() || !dtlComposeSubject.trim()) ? 0.5 : 1 }}>Send Email</button>
                          </div>
                        </div>
                      )}

                      {dtlSendErr && (
                        <div style={{ marginTop: 8, background: "#7F1D1D", border: "1px solid #EF4444", borderRadius: 8, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 12, color: "#FCA5A5", flex: 1 }}>⚠ {dtlSendErr}</span>
                          <button onClick={() => setDtlSendErr(null)} style={{ border: "none", background: "none", color: "#FCA5A5", cursor: "pointer", fontFamily: "inherit", fontWeight: 700, fontSize: 11 }}>✕</button>
                        </div>
                      )}

                      {dtlEmailTab === "teams" && (
                        <div>
                          {!teamsToken ? (
                            <div style={{ textAlign: "center", padding: "30px 0" }}>
                              <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                              <div style={{ color: "#6B7280", fontSize: 13, marginBottom: 12 }}>Sign in with Microsoft to use Teams</div>
                              {(!MS_CLIENT_ID || !MS_TENANT_ID) ? (
                                <div style={{ color: "#D97706", fontSize: 12 }}>Azure credentials not configured</div>
                              ) : (
                                <button onClick={authenticateTeams} style={{ ...S.btnPrimary, width: "auto", fontSize: 12, padding: "8px 18px" }}>Sign in with Microsoft</button>
                              )}
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                              {/* Channel Messages */}
                              <div style={{ background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 10, overflow: "hidden" }}>
                                <div style={{ padding: "10px 14px", background: `${TEAMS_PURPLE}22`, borderBottom: `1px solid ${TEAMS_PURPLE}44`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>💬 Channel: {pn}</span>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    {teamsChannelMap[poNum] && <button onClick={() => teamsLoadPOMessages(poNum)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: `1px solid ${TEAMS_PURPLE}44`, background: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>}
                                    <button onClick={() => { setSelected(null); setView("teams"); setTeamsSelPO(poNum); setTeamsTab("channels"); }} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 6, border: `1px solid ${TEAMS_PURPLE}44`, background: `${TEAMS_PURPLE}22`, color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit" }}>Open Teams ↗</button>
                                  </div>
                                </div>
                                {!teamsChannelMap[poNum] ? (
                                  <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>
                                    No Teams channel for this PO.{" "}
                                    <button onClick={() => { setSelected(null); setView("teams"); setTeamsSelPO(poNum); }} style={{ color: TEAMS_PURPLE_LT, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>Go to Teams to create one</button>
                                  </div>
                                ) : teamsLoading[poNum] ? (
                                  <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>Loading messages…</div>
                                ) : (teamsMessages[poNum] || []).length === 0 ? (
                                  <div style={{ padding: "14px 16px", fontSize: 12, color: "#6B7280", textAlign: "center" }}>No messages yet in this channel</div>
                                ) : (
                                  <div style={{ maxHeight: 200, overflowY: "auto" as const, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                                    {(teamsMessages[poNum] || []).slice(-5).map((msg: any) => {
                                      const author = msg.from?.user?.displayName || "Unknown";
                                      const clean = (msg.body?.content || "").replace(/<[^>]+>/g, "").trim();
                                      const time = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : "";
                                      return (
                                        <div key={msg.id} style={{ background: "#1E293B", borderRadius: 8, padding: "8px 12px" }}>
                                          <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 3 }}>
                                            <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>{author}</span>
                                            <span style={{ fontSize: 10, color: "#6B7280" }}>{time}</span>
                                          </div>
                                          <div style={{ fontSize: 12, color: "#CBD5E1", wordBreak: "break-word" as const }}>{clean || "[Attachment]"}</div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {teamsChannelMap[poNum] && (
                                  <div style={{ padding: "10px 12px", borderTop: `1px solid ${TEAMS_PURPLE}33`, display: "flex", gap: 8 }}>
                                    <input value={teamsNewMsg} onChange={e => setTeamsNewMsg(e.target.value)}
                                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (async () => { const mp = teamsChannelMap[poNum]; if (!mp || !teamsNewMsg.trim() || !teamsToken) return; try { const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } }); setTeamsMessages(m => ({ ...m, [poNum]: [...(m[poNum] || []), sent] })); setTeamsNewMsg(""); } catch(e: any) {} })(); } }}
                                      placeholder="Message channel…"
                                      style={{ flex: 1, background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit" }} />
                                    <button disabled={!teamsNewMsg.trim()} onClick={() => { (async () => { const mp = teamsChannelMap[poNum]; if (!mp || !teamsNewMsg.trim() || !teamsToken) return; try { const sent = await teamsGraphPost(`/teams/${mp.teamId}/channels/${mp.channelId}/messages`, { body: { content: teamsNewMsg.trim(), contentType: "text" } }); setTeamsMessages(m => ({ ...m, [poNum]: [...(m[poNum] || []), sent] })); setTeamsNewMsg(""); } catch(e: any) {} })(); }}
                                      style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 7, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: !teamsNewMsg.trim() ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: !teamsNewMsg.trim() ? 0.5 : 1 }}>Send</button>
                                  </div>
                                )}
                              </div>

                              {/* Quick DM */}
                              <div style={{ background: "#0F172A", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 10, overflow: "visible" as const }}>
                                <div style={{ padding: "10px 14px", background: `${TEAMS_PURPLE}22`, borderBottom: `1px solid ${TEAMS_PURPLE}44` }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: TEAMS_PURPLE_LT }}>↗ Quick Direct Message</span>
                                </div>
                                <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                                  <div style={{ position: "relative" as const }}>
                                    <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>
                                      {teamsContactsLoading
                                        ? "Loading contacts…"
                                        : teamsContactsError
                                          ? <span style={{ color: "#F87171" }}>⚠ Failed — <button onClick={loadTeamsContacts} style={{ background: "none", border: "none", color: TEAMS_PURPLE_LT, cursor: "pointer", fontFamily: "inherit", fontSize: 11, padding: 0, textDecoration: "underline" }}>retry</button></span>
                                          : teamsContacts.length > 0
                                            ? `To (${teamsContacts.length} contacts)`
                                            : "To"}
                                    </div>
                                    <input value={dtlDMTo}
                                      onChange={e => handleTeamsContactInput(e.target.value, "dtl")}
                                      onFocus={() => { setDtlDMContactSearch(dtlDMTo); setDtlDMContactDropdown(true); }}
                                      onBlur={() => setTimeout(() => setDtlDMContactDropdown(false), 150)}
                                      placeholder="Search name or type email…"
                                      style={{ width: "100%", background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                                    {dtlDMContactDropdown && (() => {
                                      const q = (dtlDMContactSearch || "").toLowerCase();
                                      const list = dtlDMContactSearchResults.length > 0
                                        ? dtlDMContactSearchResults
                                        : teamsContacts.filter((c: any) => !q || (c.displayName || "").toLowerCase().includes(q) || (c.userPrincipalName || "").toLowerCase().includes(q) || (c.scoredEmailAddresses?.[0]?.address || "").toLowerCase().includes(q) || (c.mail || "").toLowerCase().includes(q));
                                      if (list.length === 0 && !dtlDMContactSearchLoading) return null;
                                      return (
                                        <div style={{ position: "absolute" as const, top: "100%", left: 0, right: 0, zIndex: 200, background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}66`, borderRadius: 8, maxHeight: 160, overflowY: "auto" as const, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", marginTop: 2 }}>
                                          {dtlDMContactSearchLoading && <div style={{ padding: "6px 12px", fontSize: 11, color: "#6B7280" }}>Searching…</div>}
                                          {list.slice(0, 10).map((c: any) => {
                                            const email = c.userPrincipalName || c.mail || c.scoredEmailAddresses?.[0]?.address || "";
                                            return (
                                              <div key={email || c.displayName} onMouseDown={() => { setDtlDMTo(email); setDtlDMContactDropdown(false); setDtlDMContactSearch(""); setDtlDMContactSearchResults([]); }}
                                                style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${TEAMS_PURPLE}33` }}>
                                                <div style={{ fontSize: 12, fontWeight: 600, color: "#F1F5F9" }}>{c.displayName}</div>
                                                <div style={{ fontSize: 11, color: "#6B7280" }}>{email}</div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                  <textarea value={dtlDMMsg} onChange={e => { setDtlDMMsg(e.target.value); setDtlDMErr(null); }} rows={3}
                                    placeholder="Type your message…"
                                    style={{ width: "100%", background: "#1E293B", border: `1px solid ${TEAMS_PURPLE}44`, borderRadius: 7, padding: "8px 12px", color: "#F1F5F9", fontSize: 12, outline: "none", fontFamily: "inherit", resize: "vertical" as const, boxSizing: "border-box" as const }} />
                                  {dtlDMErr && <div style={{ fontSize: 11, color: "#EF4444" }}>⚠ {dtlDMErr}</div>}
                                  <button disabled={dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()}
                                    onClick={async () => {
                                      if (!dtlDMTo.trim() || !dtlDMMsg.trim()) return;
                                      setDtlDMSending(true); setDtlDMErr(null);
                                      try {
                                        const me = await teamsGraph("/me");
                                        const chat = await teamsGraphPost("/chats", { chatType: "oneOnOne", members: [
                                          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${me.id}')` },
                                          { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${dtlDMTo.trim()}')` },
                                        ]});
                                        const sentMsg = await teamsGraphPost(`/chats/${chat.id}/messages`, { body: { content: dtlDMMsg.trim(), contentType: "text" } });
                                        // Add conversation to DM list so it shows in the Teams view
                                        const recipientName = dtlDMTo.trim().split("@")[0] || dtlDMTo.trim();
                                        setDmConversations((prev: any[]) => {
                                          const existing = prev.find(c => c.chatId === chat.id);
                                          if (existing) {
                                            return prev.map(c => c.chatId === chat.id ? { ...c, messages: [...c.messages, sentMsg] } : c);
                                          }
                                          return [...prev, { chatId: chat.id, recipient: dtlDMTo.trim(), recipientName, messages: [sentMsg] }];
                                        });
                                        setDtlDMMsg(""); setDtlDMTo("");
                                        // Load full conversation so it shows in main Teams DM view too
                                        if (loadDmMessages) await loadDmMessages(chat.id);
                                      } catch(e: any) { setDtlDMErr("Failed: " + e.message); }
                                      setDtlDMSending(false);
                                    }}
                                    style={{ background: `linear-gradient(135deg,${TEAMS_PURPLE},${TEAMS_PURPLE_LT})`, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontSize: 12, fontWeight: 700, cursor: (dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()) ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: (dtlDMSending || !dtlDMTo.trim() || !dtlDMMsg.trim()) ? 0.5 : 1, alignSelf: "flex-end" as const }}>
                                    {dtlDMSending ? "Sending…" : "Send DM ↗"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* Production Milestones */}
            {showMilestones && (() => {
              const poNum = selected.PoNumber ?? "";
              const poMs = milestones[poNum] || [];
              const ddp = selected.DateExpectedDelivery;
              const vendorN = selected.VendorName ?? "";
              const hasVendorTpl = vendorHasTemplate(vendorN);
              const isAdmin = user?.role === "admin";
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
                  {(() => {
                    // Dependency & cascade logic
                    const activeCats = WIP_CATEGORIES.filter(cat => grouped[cat]?.length);
                    const firstIncompleteCat = activeCats.find(cat => grouped[cat].some(m => m.status !== "Complete" && m.status !== "N/A"));

                    // Calculate cascade delays: for each category, check if any predecessor is late
                    const cascadeInfo: Record<string, { blocked: boolean; upstreamDelay: number; delayedCat: string }> = {};
                    activeCats.forEach((cat, idx) => {
                      cascadeInfo[cat] = { blocked: false, upstreamDelay: 0, delayedCat: "" };
                      // Check all preceding categories
                      for (let p = 0; p < idx; p++) {
                        const prevCat = activeCats[p];
                        const prevMs = grouped[prevCat] || [];
                        const prevDone = prevMs.every(m => m.status === "Complete" || m.status === "N/A");
                        if (!prevDone) {
                          cascadeInfo[cat].blocked = true;
                          // Calculate max days late from predecessor's overdue milestones
                          const maxLate = prevMs.reduce((max, m) => {
                            if (m.status === "Complete" || m.status === "N/A" || !m.expected_date) return max;
                            const daysLate = Math.ceil((Date.now() - new Date(m.expected_date).getTime()) / 86400000);
                            return daysLate > 0 ? Math.max(max, daysLate) : max;
                          }, 0);
                          if (maxLate > cascadeInfo[cat].upstreamDelay) {
                            cascadeInfo[cat].upstreamDelay = maxLate;
                            cascadeInfo[cat].delayedCat = prevCat;
                          }
                        }
                      }
                    });

                    return activeCats;
                  })().map(cat => {
                    const catMs = (grouped[cat] || []).sort((a, b) => {
                      // Sort by expected_date first (chronological), then sort_order as tiebreaker
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

                    // Cascade info for this category
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
                              // Cascade: if blocked, show projected date shifted by upstream delay
                              const projectedDate = cascade.upstreamDelay > 0 && m.expected_date && m.status !== "Complete" && m.status !== "N/A"
                                ? new Date(new Date(m.expected_date).getTime() + cascade.upstreamDelay * 86400000).toISOString().slice(0, 10) : null;
                              // Delay warning: status date later than due date
                              const statusDateVal = (m.status_dates || {})[m.status] || m.status_date || null;
                              const delayDays = statusDateVal && m.expected_date
                                ? Math.ceil((new Date(statusDateVal).getTime() - new Date(m.expected_date).getTime()) / 86400000)
                                : 0;
                              // Variant panel
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
                                  {/* ⊕ Variant expand button */}
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
                                        // Sync all variants to the new main status (unless they have been individually overridden to something different)
                                        const existingVariants = { ...(m.variant_statuses || {}) };
                                        const syncedVariants: Record<string, { status: string; status_date: string | null }> = {};
                                        Object.keys(existingVariants).forEach(key => {
                                          syncedVariants[key] = { status: newStatus, status_date: statusDate };
                                        });
                                        saveMilestone({ ...m, status: newStatus, status_date: statusDate, status_dates: Object.keys(d).length > 0 ? d : null, variant_statuses: Object.keys(syncedVariants).length > 0 ? syncedVariants : m.variant_statuses, updated_at: new Date().toISOString(), updated_by: user?.name || "" });
                                      };
                                      if (oldStatus === "Complete" && dates[oldStatus]) {
                                        setConfirmModal({ title: "Clear Complete Date", message: `Clear the "Complete" date (${dates[oldStatus]})?`, icon: "📅", confirmText: "Clear Date", confirmColor: "#F59E0B", cancelText: "Keep Date", onConfirm: () => { delete dates[oldStatus]; doSave(dates); }, onCancel: () => doSave(dates) });
                                        return;
                                      }
                                      doSave(dates);
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
                                      // Sync variant status dates too
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
                                {/* Variant/color status panel */}
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
                                  // Show legacy note as first entry if exists and no entries yet
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
                        // Build list of phases in the selected category for "Insert After" dropdown
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
                                // Explicit position: insert after selected phase
                                const afterIdx = allCatMs.findIndex(m => m.id === newPhaseForm.afterPhase);
                                if (afterIdx >= 0) {
                                  const afterSort = allCatMs[afterIdx].sort_order;
                                  const nextSort = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1].sort_order : afterSort + 100;
                                  sortOrder = afterSort + (nextSort - afterSort) / 2;
                                  insertRef = " (after " + allCatMs[afterIdx].phase + ")";
                                  // Auto-calculate midpoint due date if not provided
                                  if (!autoDueDate) {
                                    const afterDate = allCatMs[afterIdx].expected_date;
                                    const nextM = afterIdx + 1 < allCatMs.length ? allCatMs[afterIdx + 1] : null;
                                    const nextDate = nextM?.expected_date;
                                    if (afterDate && nextDate) {
                                      const mid = new Date((new Date(afterDate).getTime() + new Date(nextDate).getTime()) / 2);
                                      autoDueDate = mid.toISOString().slice(0, 10);
                                    } else if (afterDate) {
                                      // No next phase — add 7 days after
                                      const d = new Date(afterDate); d.setDate(d.getDate() + 7);
                                      autoDueDate = d.toISOString().slice(0, 10);
                                    }
                                  }
                                } else { sortOrder = (allCatMs.length + 1) * 100; }
                              } else if (newPhaseForm.dueDate && allCatMs.length > 0) {
                                // Auto-position by due date: find where it fits chronologically
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
                                  // Due date is before all existing — put first
                                  sortOrder = allCatMs[0].sort_order - 100;
                                  insertRef = " (by date, at beginning)";
                                }
                              } else {
                                // No position info — add at end
                                sortOrder = allCatMs.length > 0 ? allCatMs[allCatMs.length - 1].sort_order + 100 : 0;
                              }

                              const newM: Milestone = { id: milestoneUid(), po_number: poNum, phase: newPhaseForm.name.trim(), category: newPhaseForm.category, sort_order: sortOrder, days_before_ddp: 0, expected_date: autoDueDate || null, actual_date: null, status: "Not Started", status_date: null, status_dates: null, notes: "", note_entries: null, updated_at: new Date().toISOString(), updated_by: user?.name || "" };
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
            })()}

            {/* Notes Tab */}
            {showNotes && (() => {
              const isAdmin = user?.role === "admin";
              return <div>
              <div style={S.sectionLabel}>Notes</div>
              {selectedNotes.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No notes yet.</p>}
              {selectedNotes.map(n => {
                const canModify = isAdmin || n.user_name === user?.name;
                const isEditing = editingNoteId === n.id;
                return (
                <div key={n.id} style={S.noteCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: "#60A5FA", fontWeight: 700, fontSize: 14 }}>{n.user_name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#9CA3AF", fontSize: 12 }}>{fmtDate(n.created_at)} {new Date(n.created_at).toLocaleTimeString()}</span>
                      {canModify && !isEditing && (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => { setEditingNoteId(n.id); setEditingNoteText(n.note); }}
                            style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 12, padding: "2px 4px", fontFamily: "inherit" }}
                            title="Edit">✏️</button>
                          <button onClick={() => {
                            setConfirmModal({
                              title: "Delete Note",
                              message: `Delete this note by ${n.user_name}?\n\n"${n.note.length > 100 ? n.note.slice(0, 100) + "…" : n.note}"`,
                              icon: "🗑️",
                              confirmText: "Delete",
                              confirmColor: "#EF4444",
                              onConfirm: () => deleteNote(n.id),
                            });
                          }}
                            style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 12, padding: "2px 4px", fontFamily: "inherit" }}
                            title="Delete">🗑️</button>
                        </div>
                      )}
                    </div>
                  </div>
                  {isEditing ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <textarea style={{ ...S.textarea, fontSize: 14 }} rows={3} value={editingNoteText}
                        onChange={e => setEditingNoteText(e.target.value)} />
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button style={S.btnSecondary} onClick={() => setEditingNoteId(null)}>Cancel</button>
                        <button style={{ ...S.btnPrimary, width: "auto", padding: "8px 16px" }}
                          onClick={async () => { await editNote(n.id, editingNoteText); setEditingNoteId(null); }}>Save</button>
                      </div>
                    </div>
                  ) : (
                    <p style={{ color: "#D1D5DB", fontSize: 15, margin: 0 }}>{n.note}</p>
                  )}
                </div>
                );
              })}
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexDirection: "column" }}>
                <textarea style={S.textarea} rows={3} placeholder="Add a note..."
                  value={newNote} onChange={e => setNewNote(e.target.value)} />
                <button style={S.btnPrimary} onClick={addNote}>Add Note</button>
              </div>
            </div>;
            })()}

            {/* History Tab */}
            {showHistory && <div>
              <div style={S.sectionLabel}>Change History</div>
              {selectedHistory.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No history recorded yet.</p>}
              {selectedHistory.map(h => (
                <div key={h.id} style={{ display: "flex", gap: 12, padding: "10px 14px", borderBottom: "1px solid #334155", alignItems: "flex-start" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3B82F6", marginTop: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ color: "#D1D5DB", fontSize: 14, margin: 0 }}>{h.note}</p>
                    <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11, color: "#6B7280" }}>
                      <span>{h.user_name}</span>
                      <span>{fmtDate(h.created_at)} {new Date(h.created_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>}
          </div>
        </div>
      </div>
    );
}
