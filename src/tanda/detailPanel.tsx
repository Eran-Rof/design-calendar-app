import React, { useState, useRef, useEffect, type Dispatch, type SetStateAction, type RefObject } from "react";
import { createPortal } from "react-dom";
import { type XoroPO, type Milestone, type WipTemplate, type LocalNote, type User, type DCVendor, type View, type DmConversation,
  STATUS_COLORS, WIP_CATEGORIES, MILESTONE_STATUSES, DEFAULT_WIP_TEMPLATES,
  milestoneUid, itemQty, poTotal, hasMultipleDeliveryDates, fmtDate, fmtCurrency } from "../utils/tandaTypes";
import { SB_URL, SB_HEADERS } from "../utils/supabase";
import { useTandaStore } from "./store";
import { printPODetail } from "./exportHelpers";
import S from "./styles";
import type { DetailMode, AttachmentEntry } from "./state/core/coreTypes";
import { EmailTab } from "./detail/emailTab";
import { MilestonesTab } from "./detail/milestonesTab";
import { MilestoneGridTab } from "./detail/milestoneGridTab";
import { PoMatrixTab } from "./detail/poMatrixTab";
import { AttachmentsTab } from "./detail/attachmentsTab";
import { NotesTab } from "./detail/notesTab";
import { HistoryTab } from "./detail/historyTab";

// ── DetailPanelCtx ──────────────────────────────────────────────────────────
// Strict prop bag passed by TandA.tsx into the detail panel. Replaces the
// previous `Record<string, any>` escape hatch so the panel's reads are
// type-checked against the call site.
//
// Setter convention:
//  - `Dispatch<SetStateAction<T>>` for plain useState setters AND for the
//    reducer-wrapped setters in TandA that internally branch on
//    `typeof v === "function"` to support functional updates.
//  - `(v: T) => void` for wrapper setters that only accept a direct value.
export interface BlockedModalState {
  cat: string;
  delayedCat: string;
  daysLate: number;
  onConfirm: () => void;
}

export interface ConfirmModalState {
  title: string;
  message: string;
  icon: string;
  confirmText: string;
  confirmColor: string;
  cancelText?: string;
  listItems?: string[];
  onConfirm: () => void;
  onCancel?: () => void;
}

export interface NewPhaseFormState {
  name: string;
  category: string;
  dueDate: string;
  afterPhase: string;
}

export interface DetailPanelCtx {
  // ── Core selection / view ──
  selected: XoroPO | null;
  detailMode: DetailMode;
  setDetailMode: (v: DetailMode) => void;
  setSelected: (v: XoroPO | null) => void;
  setView: (v: View) => void;
  setNewNote: Dispatch<SetStateAction<string>>;

  // ── Section collapse toggles ──
  matrixCollapsed: boolean;
  setMatrixCollapsed: Dispatch<SetStateAction<boolean>>;
  lineItemsCollapsed: boolean;
  setLineItemsCollapsed: Dispatch<SetStateAction<boolean>>;
  poInfoCollapsed: boolean;
  setPoInfoCollapsed: Dispatch<SetStateAction<boolean>>;
  progressCollapsed: boolean;
  setProgressCollapsed: Dispatch<SetStateAction<boolean>>;

  // ── Note editing ──
  editingNote: string | null;
  setEditingNote: Dispatch<SetStateAction<string | null>>;
  editingNoteId: string | null;
  setEditingNoteId: Dispatch<SetStateAction<string | null>>;
  editingNoteText: string;
  setEditingNoteText: Dispatch<SetStateAction<string>>;
  msNoteText: string;
  setMsNoteText: Dispatch<SetStateAction<string>>;
  expandedVariants: Set<string>;
  setExpandedVariants: Dispatch<SetStateAction<Set<string>>>;

  // ── Phase / template editing ──
  addingPhase: boolean;
  setAddingPhase: Dispatch<SetStateAction<boolean>>;
  newPhaseForm: NewPhaseFormState;
  setNewPhaseForm: Dispatch<SetStateAction<NewPhaseFormState>>;
  acceptedBlocked: Set<string>;
  setAcceptedBlocked: Dispatch<SetStateAction<Set<string>>>;
  blockedModal: BlockedModalState | null;
  setBlockedModal: Dispatch<SetStateAction<BlockedModalState | null>>;
  confirmModal: ConfirmModalState | null;
  setConfirmModal: Dispatch<SetStateAction<ConfirmModalState | null>>;
  collapsedCats: Record<string, boolean>;
  setCollapsedCats: Dispatch<SetStateAction<Record<string, boolean>>>;
  showCreateTpl: string | null;
  setShowCreateTpl: Dispatch<SetStateAction<string | null>>;

  // ── Attachments ──
  attachments: Record<string, AttachmentEntry[]>;
  setAttachments: Dispatch<SetStateAction<Record<string, AttachmentEntry[]>>>;
  attachInputRef: RefObject<HTMLInputElement>;
  uploadingAttachment: boolean;
  setUploadingAttachment: (v: boolean) => void;

  // ── Core data ──
  milestones: Record<string, Milestone[]>;
  setMilestones: Dispatch<SetStateAction<Record<string, Milestone[]>>>;
  wipTemplates: Record<string, WipTemplate[]>;
  setWipTemplates: Dispatch<SetStateAction<Record<string, WipTemplate[]>>>;
  dcVendors: DCVendor[];
  designTemplates: any[];
  notes: LocalNote[];
  newNote: string;
  user: User | null;
  emailToken: string | null;
  teamsToken: string | null;
  msDisplayName: string;
  pos: XoroPO[];
  toast: string | null;
  setToast: Dispatch<SetStateAction<string | null>>;

  // ── PO actions / business logic ──
  handleExportPOExcel: (po: XoroPO, items: any[], mode: string) => void;
  ensureMilestones: (po: XoroPO) => Promise<Milestone[] | "needs_template">;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => Promise<void>;
  saveMilestones: (ms: Milestone[]) => Promise<void>;
  generateMilestones: (poNumber: string, ddpDate: string, vendorName?: string) => Milestone[];
  regenerateMilestones: (po: XoroPO) => Promise<void>;
  cascadeDueDateChange: (milestone: Milestone, newDate: string) => Promise<void>;
  vendorHasTemplate: (vendorName: string) => boolean;
  templateVendorList: () => string[];
  getVendorTemplates: (vendorName?: string) => WipTemplate[];
  saveVendorTemplates: (vendorKey: string, templates: WipTemplate[]) => Promise<void>;
  openCategoryWithCheck: (poNum: string, cat: string, po?: XoroPO | null, switchView?: boolean) => void;
  isCatBlocked: (poNum: string, cat: string) => { blocked: boolean; delayedCat: string; daysLate: number };
  uploadAttachment: (poNumber: string, file: File) => Promise<void>;
  loadAttachments: (poNumber: string) => Promise<void>;
  deleteAttachment: (poNumber: string, attachId: string) => Promise<void>;
  undoDeleteAttachment: (poNumber: string, attachId: string) => Promise<void>;
  purgeExpiredAttachments: (poNumber: string) => Promise<void>;
  addNote: () => Promise<void>;
  editNote: (noteId: string, newText: string) => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;
  addHistory: (poNumber: string, description: string) => Promise<void>;
  deletePO: (poNumber: string) => Promise<void>;
  setSearch: Dispatch<SetStateAction<string>>;
  setTeamsSelPO: (v: string | null) => void;
  setTeamsTab: (v: "channels" | "direct") => void;

  // ── Email (detail panel) ──
  loadDtlEmails: (poNum: string, olderUrl?: string) => Promise<void>;
  loadDtlFullEmail: (id: string) => Promise<void>;
  loadDtlThread: (conversationId: string) => Promise<void>;
  loadDtlSentEmails: (poNum: string) => Promise<void>;
  authenticateEmail: () => Promise<void>;
  dtlReplyToEmail: (messageId: string) => Promise<void>;
  dtlSendEmail: (poNum: string) => Promise<void>;
  emailMarkAsRead: (id: string) => Promise<void>;
  deleteMainEmail: (messageId: string) => Promise<void>;
  loadEmailAttachments: (messageId: string, force?: boolean) => Promise<void>;
  emailAttachments: Record<string, any[]>;
  emailAttachmentsLoading: Record<string, boolean>;

  // ── Teams ──
  teamsLoadPOMessages: (poNum: string, mp?: { channelId: string; teamId: string }) => Promise<void>;
  teamsStartChat: (poNum: string) => Promise<void>;
  teamsSendMessage: (poNum: string) => Promise<void>;
  teamsGraphPost: (path: string, body: any) => Promise<any>;
  teamsGraph: (path: string, extraHeaders?: Record<string, string>) => Promise<any>;
  loadTeamsContacts: () => Promise<void>;
  handleTeamsContactInput: (val: string, target: "main" | "dtl") => void;
  teamsSendDirect: () => Promise<void>;
  sendDmReply: () => Promise<void>;
  loadDmMessages: (chatId: string, silent?: boolean) => Promise<void>;
  msSignOut: () => void;
  selectedNotes: LocalNote[];
  selectedHistory: LocalNote[];

  // ── Detail panel email state ──
  dtlEmails: Record<string, any[]>;
  dtlEmailLoading: Record<string, boolean>;
  dtlEmailErr: Record<string, string | null>;
  dtlEmailSel: any;
  dtlEmailThread: any[];
  dtlThreadLoading: boolean;
  dtlEmailTab: "inbox" | "sent" | "thread" | "compose" | "teams";
  setDtlEmailTab: (v: "inbox" | "sent" | "thread" | "compose" | "teams") => void;
  dtlSentEmails: Record<string, any[]>;
  dtlSentLoading: Record<string, boolean>;
  dtlComposeTo: string;
  setDtlComposeTo: (v: string) => void;
  dtlComposeSubject: string;
  setDtlComposeSubject: (v: string) => void;
  dtlComposeBody: string;
  setDtlComposeBody: (v: string) => void;
  dtlSendErr: string | null;
  setDtlSendErr: (v: string | null) => void;
  dtlReply: string;
  setDtlReply: (v: string) => void;
  dtlNextLink: Record<string, string | null>;
  dtlLoadingOlder: boolean;
  setDtlLoadingOlder: (v: boolean) => void;

  // ── Teams state ──
  teamsChannelMap: Record<string, { channelId: string; teamId: string }>;
  teamsMessages: Record<string, any[]>;
  setTeamsMessages: Dispatch<SetStateAction<Record<string, any[]>>>;
  teamsLoading: Record<string, boolean>;
  teamsNewMsg: string;
  setTeamsNewMsg: (v: string) => void;
  teamsContacts: any[];
  teamsContactsLoading: boolean;
  teamsContactsError: string | null;

  // ── Detail panel DM state ──
  dtlDMTo: string;
  setDtlDMTo: (v: string) => void;
  dtlDMMsg: string;
  setDtlDMMsg: (v: string) => void;
  dtlDMSending: boolean;
  setDtlDMSending: (v: boolean) => void;
  dtlDMErr: string | null;
  setDtlDMErr: (v: string | null) => void;
  dtlDMContactSearch: string;
  setDtlDMContactSearch: (v: string) => void;
  dtlDMContactDropdown: boolean;
  setDtlDMContactDropdown: (v: boolean) => void;
  dtlDMContactSearchResults: any[];
  setDtlDMContactSearchResults: (v: any[]) => void;
  dtlDMContactSearchLoading: boolean;
  setDtlDMContactSearchLoading: (v: boolean) => void;

  // ── DM conversations ──
  dmConversations: DmConversation[];
  setDmConversations: Dispatch<SetStateAction<DmConversation[]>>;
  dmActiveChatId: string | null;
  setDmActiveChatId: (v: string | null) => void;
  dmScrollRef: RefObject<HTMLDivElement>;
}

const TEAMS_PURPLE = "#5b5ea6";
const TEAMS_PURPLE_LT = "#7b83eb";
const OUTLOOK_BLUE = "#0078D4";

export { daysUntil, computeMatrixRows, computeCascadeInfo, sortCategoryMilestones } from "./detailHelpers";
import { daysUntil, computeMatrixRows } from "./detailHelpers";

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
  const { selected, detailMode, setDetailMode, setSelected, setView, setNewNote, matrixCollapsed, setMatrixCollapsed, lineItemsCollapsed, setLineItemsCollapsed, poInfoCollapsed, setPoInfoCollapsed, progressCollapsed, setProgressCollapsed, editingNote, setEditingNote, editingNoteId, setEditingNoteId, editingNoteText, setEditingNoteText, msNoteText, setMsNoteText, expandedVariants, setExpandedVariants, addingPhase, setAddingPhase, newPhaseForm, setNewPhaseForm, acceptedBlocked, setAcceptedBlocked, blockedModal, setBlockedModal, confirmModal, setConfirmModal, collapsedCats, setCollapsedCats, showCreateTpl, setShowCreateTpl, attachments, setAttachments, attachInputRef, uploadingAttachment, setUploadingAttachment, milestones, setMilestones, wipTemplates, setWipTemplates, dcVendors, designTemplates, notes, newNote, user, emailToken, teamsToken, msDisplayName, pos, toast, setToast, handleExportPOExcel, ensureMilestones, saveMilestone, saveMilestones, generateMilestones, regenerateMilestones, cascadeDueDateChange, vendorHasTemplate, templateVendorList, getVendorTemplates, saveVendorTemplates, openCategoryWithCheck, isCatBlocked, uploadAttachment, loadAttachments, deleteAttachment, undoDeleteAttachment, purgeExpiredAttachments, addNote, editNote, deleteNote, addHistory, deletePO, setSearch, setTeamsSelPO, setTeamsTab, loadDtlEmails, loadDtlFullEmail, loadDtlThread, loadDtlSentEmails, authenticateEmail, dtlReplyToEmail, dtlSendEmail, emailMarkAsRead, deleteMainEmail, loadEmailAttachments, emailAttachments, emailAttachmentsLoading, teamsLoadPOMessages, teamsStartChat, teamsSendMessage, teamsGraphPost, teamsGraph, loadTeamsContacts, handleTeamsContactInput, teamsSendDirect, sendDmReply, loadDmMessages, msSignOut, selectedNotes, selectedHistory, dtlEmails, dtlEmailLoading, dtlEmailErr, dtlEmailSel, dtlEmailThread, dtlThreadLoading, dtlEmailTab, setDtlEmailTab, dtlSentEmails, dtlSentLoading, dtlComposeTo, setDtlComposeTo, dtlComposeSubject, setDtlComposeSubject, dtlComposeBody, setDtlComposeBody, dtlSendErr, setDtlSendErr, dtlReply, setDtlReply, dtlNextLink, dtlLoadingOlder, setDtlLoadingOlder, teamsChannelMap, teamsMessages, setTeamsMessages, teamsLoading, teamsNewMsg, setTeamsNewMsg, teamsContacts, teamsContactsLoading, teamsContactsError, dtlDMTo, setDtlDMTo, dtlDMMsg, setDtlDMMsg, dtlDMSending, setDtlDMSending, dtlDMErr, setDtlDMErr, dtlDMContactSearch, setDtlDMContactSearch, dtlDMContactDropdown, setDtlDMContactDropdown, dtlDMContactSearchResults, setDtlDMContactSearchResults, dtlDMContactSearchLoading, setDtlDMContactSearchLoading, dmConversations, setDmConversations, dmActiveChatId, setDmActiveChatId, dmScrollRef } = ctx;

    if (!selected) return null;
    const items = selected.Items ?? selected.PoLineArr ?? [];
    const days  = daysUntil(selected.DateExpectedDelivery);
    const total = poTotal(selected);
    const statusColor = STATUS_COLORS[selected.StatusName ?? ""] ?? "#6B7280";

    // Persist buyer_po to Supabase and mirror into the store. Optimistic so the
    // header reflects the edit immediately even if the network round-trip lags.
    const persistBuyerPo = async (poNumber: string, value: string) => {
      const trimmed = value.trim();
      useTandaStore.getState().updatePo(poNumber, { BuyerPo: trimmed });
      try {
        await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNumber)}`, {
          method: "PATCH",
          headers: { ...SB_HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({ buyer_po: trimmed || null }),
        });
      } catch (e) {
        console.error("Failed to update buyer_po:", e);
      }
    };

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
                  const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom) || [];
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
    const matrixRows = computeMatrixRows(items);

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
                const multiDates = hasMultipleDeliveryDates(selected);
                const pills: [string, string, string?][] = [
                  ["Order", fmtDate(selected.DateOrder) || "—"],
                  ["DDP", (fmtDate(selected.DateExpectedDelivery) || "—") + ddpSuffix + (multiDates ? " · multiple line dates" : ""), multiDates ? "#F59E0B" : ddpColor],
                  ...(selected.VendorReqDate ? [["Vendor Req", fmtDate(selected.VendorReqDate)] as [string, string]] : []),
                  ["Value", fmtCurrency(total, selected.CurrencyCode)],
                  ["Qty", totalQty.toLocaleString()],
                  ...(selected.PaymentTermsName ? [["Payment", selected.PaymentTermsName] as [string, string]] : []),
                  ...(selected.ShipMethodName ? [["Ship", selected.ShipMethodName] as [string, string]] : []),
                  ...(selected.CarrierName ? [["Carrier", selected.CarrierName] as [string, string]] : []),
                  ...(selected.BuyerName ? [["Buyer", selected.BuyerName] as [string, string]] : []),
                  ...(selected.BuyerPo ? [["Buyer PO", selected.BuyerPo] as [string, string]] : []),
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
            {/* Editable Buyer PO row — Xoro ReferenceNumber default, user override wins on next sync */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Buyer PO:</span>
              <input
                key={`${selected.PoNumber}:${selected.BuyerPo ?? ""}`}
                defaultValue={selected.BuyerPo ?? ""}
                placeholder="(none)"
                onBlur={e => {
                  const v = e.target.value;
                  if (v.trim() === (selected.BuyerPo ?? "").trim()) return;
                  persistBuyerPo(selected.PoNumber ?? "", v);
                }}
                onKeyDown={e => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
                style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: "#D1D5DB", fontSize: 13, padding: "4px 10px", width: 200, outline: "none", fontFamily: "monospace" }}
              />
              <span style={{ fontSize: 10, color: "#6B7280" }}>
                {selected.BuyerPo ? "saved" : "edit to set"}
              </span>
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
            <button style={tabStyle("grid")} onClick={() => setDetailMode("grid")}>Grid</button>
            <button style={tabStyle("notes")} onClick={() => setDetailMode("notes")}>Notes</button>
            <button style={tabStyle("attachments")} onClick={() => { setDetailMode("attachments"); const pn = selected.PoNumber ?? ""; if (pn && !attachments[pn]) loadAttachments(pn); }}>📎 Files</button>
            <button style={tabStyle("email")} onClick={() => { setDetailMode("email"); setDtlEmailTab("inbox"); const pn = selected.PoNumber ?? ""; if (pn && emailToken && !dtlEmails[pn]?.length) loadDtlEmails(pn); }}>📧 Email/Teams</button>
            <button style={tabStyle("history")} onClick={() => setDetailMode("history")}>History</button>
            <button style={tabStyle("all")} onClick={() => setDetailMode("all")}>All</button>
          </div>
          <div style={{ border: "1px solid #334155", borderTop: "none", borderRadius: "0 0 10px 10px", background: "#1E293B", padding: 20, marginBottom: 20 }}>

          {/* PO / Matrix combined section */}
          {/* PO / Matrix combined section */}
          <PoMatrixTab ctx={ctx} total={total} totalQty={totalQty} />

            {/* Attachments Tab */}
            {/* Attachments Tab */}
            <AttachmentsTab ctx={ctx} />

            {/* Email Tab */}
            <EmailTab ctx={ctx} />

            {/* Production Milestones */}
            <MilestonesTab ctx={ctx} />

            {/* Milestones Grid (compact spreadsheet entry) */}
            <MilestoneGridTab ctx={ctx} />

            {/* Notes Tab */}
            {/* Notes Tab */}
            <NotesTab ctx={ctx} />

            {/* History Tab */}
            {/* History Tab */}
            <HistoryTab ctx={ctx} />
          </div>
        </div>
      </div>
    );
}
