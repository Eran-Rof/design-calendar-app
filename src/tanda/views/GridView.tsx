import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import XLSXStyle from "xlsx-js-style";
import {
  type XoroPO, type Milestone, type WipTemplate, type View,
  MILESTONE_STATUS_COLORS, MILESTONE_STATUSES, fmtDate, fmtCurrency, milestoneUid, isLineClosed,
} from "../../utils/tandaTypes";
import S from "../styles";
import { MilestoneDateInput } from "../detail/MilestoneDateInput";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { useTandaStore } from "../store/index";

const PAGE_SIZE = 16;
const MAX_UNDO  = 30;

/** Normalise any date string Xoro might return into YYYY-MM-DD.
 *  Handles: "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD", "MM/DD/YYYY", etc.
 *  Returns "" if the string is empty or unparseable. */
function normDateISO(d?: string): string {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}-\d{2}T/.test(d)) return d.slice(0, 10);
  const dt = new Date(d);
  if (!isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  return "";
}

// Fixed column widths: expand | notes | PO# | Vendor | Buyer | BuyerPO | DDP | Days from DDP
const FIXED_COLS = "32px 32px 130px 160px 140px 110px 90px 72px";
// Per-phase sub-columns sized to fit content + ~2-char breathing room:
//   Due Date 88 | Status ("Not Started") 90 | Status Date 82 | Days ("365 late") 56 | Phase Notes 26
const PHASE_SUB  = "88px 90px 82px 56px 26px";
const PHASE_COLS = 5;

// Border constants — standard borders 2px, phase divider 4px.
const B_CELL = "2px solid #374151";   // standard cell border
const B_HDR  = "2px solid #475569";  // header borders
// Phase divider: absolutely-positioned overlay inside the first sub-col of
// phases[1+]. The overlay extends top: -2px so it paints OVER the 2px
// borderBottom gap of the row above, and z-index keeps it on top of sibling
// grid items. overflow: visible on the host cell lets it bleed upward.
const PHASE_DIV_COLOR = "#818CF8";
const phaseDividerOverlay: React.CSSProperties = {
  position: "absolute",
  top: -2,
  left: 0,
  width: 4,
  height: "calc(100% + 2px)",
  background: PHASE_DIV_COLOR,
  pointerEvents: "none",
  zIndex: 3,
};
// Applied to the host cell that carries a divider overlay (left or right)
const phaseDividerHost: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  overflow: "visible",
};
// Right-side overlay — used on the Notes cell of the LAST phase (closing border)
const phaseDividerOverlayRight: React.CSSProperties = {
  position: "absolute",
  top: -2,
  right: 0,
  width: 4,
  height: "calc(100% + 2px)",
  background: PHASE_DIV_COLOR,
  pointerEvents: "none",
  zIndex: 3,
};

function buildColTpl(phaseCount: number) {
  return phaseCount > 0
    ? `${FIXED_COLS} ${Array(phaseCount).fill(PHASE_SUB).join(" ")}`
    : FIXED_COLS;
}

// ── NotesModal ─────────────────────────────────────────────────────────────
// Separate component so it can own its own state (noteText, addPhase).
interface NotesModalProps {
  po: XoroPO;
  ms: Milestone[];           // live milestone list (optimistically updated)
  filterPhase?: string;      // if set, scopes display + add-target to one phase
  filterVariant?: string;    // if set, reads/writes variant_notes[varKey] instead of note_entries
  onClose: () => void;
  onAddNote: (m: Milestone, text: string) => void;
  onEditNote: (m: Milestone, index: number, newText: string) => void;
  onDeleteNote: (m: Milestone, index: number) => void;
  onAddVariantNote?: (m: Milestone, varKey: string, text: string) => void;
  onEditVariantNote?: (m: Milestone, varKey: string, index: number, newText: string) => void;
  onDeleteVariantNote?: (m: Milestone, varKey: string, index: number) => void;
}
function NotesModal({ po, ms, filterPhase, filterVariant, onClose, onAddNote, onEditNote, onDeleteNote, onAddVariantNote, onEditVariantNote, onDeleteVariantNote }: NotesModalProps) {
  const [noteText, setNoteText] = useState("");
  const [addPhase, setAddPhase] = useState(filterPhase ?? "");
  const [editing, setEditing] = useState<{ milestoneId: string; index: number; text: string } | null>(null);

  const isVariantMode = !!filterVariant;

  // Milestones selectable for adding a note
  const availableMs = filterPhase ? ms.filter(m => m.phase === filterPhase) : ms;

  // Set initial addPhase once
  useEffect(() => {
    if (!addPhase && availableMs.length > 0) setAddPhase(availableMs[0].phase);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Notes to display — variant mode reads from variant_notes[varKey]
  const shown = (() => {
    if (isVariantMode) {
      return (filterPhase ? ms.filter(m => m.phase === filterPhase) : ms)
        .filter(m => (m.variant_notes?.[filterVariant!] || []).length > 0);
    }
    return filterPhase
      ? ms.filter(m => m.phase === filterPhase && ((m.note_entries && m.note_entries.length > 0) || m.notes))
      : ms.filter(m => (m.note_entries && m.note_entries.length > 0) || m.notes);
  })();

  // Variant notes aggregated across all milestones — shown in the "all notes"
  // modal (no filterPhase, no filterVariant) so the row-level 📝 includes them.
  const variantNotesFlat = (!isVariantMode && !filterPhase) ? ms.flatMap(m =>
    Object.entries(m.variant_notes || {}).flatMap(([vk, arr]) =>
      arr.map(ne => ({ ...ne, phase: m.phase, variant: vk, milestoneId: m.id }))
    )
  ) : [];

  const handleAdd = () => {
    if (!noteText.trim()) return;
    const target = availableMs.find(m => m.phase === addPhase) ?? availableMs[0];
    if (!target) return;
    if (isVariantMode && onAddVariantNote) {
      onAddVariantNote(target, filterVariant!, noteText.trim());
    } else {
      onAddNote(target, noteText.trim());
    }
    setNoteText("");
  };

  const handleEditSave = (m: Milestone) => {
    if (!editing || !editing.text.trim()) return;
    if (isVariantMode && onEditVariantNote) {
      onEditVariantNote(m, filterVariant!, editing.index, editing.text.trim());
    } else {
      onEditNote(m, editing.index, editing.text.trim());
    }
    setEditing(null);
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, width: 560, maxHeight: "75vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>
              {po.PoNumber}
              {filterPhase && <span style={{ marginLeft: 10, color: "#C4B5FD", fontFamily: "sans-serif", fontSize: 12, fontWeight: 400 }}>· {filterPhase}</span>}
            </div>
            <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>
              {isVariantMode ? `Line Item Notes — ${filterVariant}` : filterPhase ? "Phase Notes" : "All Milestone Notes"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {/* Existing notes — scrollable */}
        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {shown.length === 0 && variantNotesFlat.length === 0 ? (
            <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
              No notes yet — add one below.
            </div>
          ) : (<>

            {shown.map(m => {
              const entries = isVariantMode ? (m.variant_notes?.[filterVariant!] || []) : (m.note_entries || []);
              const handleDelete = (i: number) => {
                if (isVariantMode && onDeleteVariantNote) onDeleteVariantNote(m, filterVariant!, i);
                else onDeleteNote(m, i);
              };
              return (
              <div key={m.id} style={{ marginBottom: 18 }}>
                {!filterPhase && (
                  <div style={{ color: "#C4B5FD", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 7 }}>
                    {m.phase}
                    <span style={{ marginLeft: 8, color: "#6B7280", fontWeight: 400, textTransform: "none", fontSize: 10 }}>{m.category}</span>
                  </div>
                )}
                {entries.length > 0
                  ? entries.map((ne, i) => {
                      const isEditingThis = editing?.milestoneId === m.id && editing?.index === i;
                      return (
                        <div key={i} style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px", marginBottom: 6 }}>
                          {isEditingThis ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <textarea
                                autoFocus
                                value={editing.text}
                                onChange={e => setEditing({ ...editing, text: e.target.value })}
                                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleEditSave(m); } if (e.key === "Escape") setEditing(null); }}
                                style={{ background: "#0F172A", border: "1px solid #3B82F6", borderRadius: 4, color: "#E5E7EB", fontSize: 12, padding: "6px 8px", resize: "none", height: 56, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
                              />
                              <div style={{ display: "flex", gap: 6 }}>
                                <button onClick={() => handleEditSave(m)} style={{ background: "#3B82F6", border: "none", borderRadius: 4, color: "#fff", fontSize: 11, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>Save</button>
                                <button onClick={() => setEditing(null)} style={{ background: "#1A2535", border: "1px solid #334155", borderRadius: 4, color: "#9CA3AF", fontSize: 11, padding: "4px 10px", cursor: "pointer" }}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                                <div style={{ color: "#E5E7EB", fontSize: 12, flex: 1 }}>{ne.text}</div>
                                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                  <button
                                    onClick={() => setEditing({ milestoneId: m.id, index: i, text: ne.text })}
                                    title="Edit note"
                                    style={{ background: "#1A2B40", border: "1px solid #334155", color: "#93C5FD", cursor: "pointer", fontSize: 12, padding: "2px 7px", borderRadius: 4, lineHeight: 1, fontWeight: 600 }}
                                    onMouseEnter={e => { e.currentTarget.style.background = "#1E3A5F"; e.currentTarget.style.color = "#60A5FA"; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = "#1A2B40"; e.currentTarget.style.color = "#93C5FD"; }}
                                  >✏</button>
                                  <button
                                    onClick={() => handleDelete(i)}
                                    title="Delete note"
                                    style={{ background: "#2A1A1A", border: "1px solid #4B2020", color: "#F87171", cursor: "pointer", fontSize: 12, padding: "2px 7px", borderRadius: 4, lineHeight: 1, fontWeight: 600 }}
                                    onMouseEnter={e => { e.currentTarget.style.background = "#3D1515"; e.currentTarget.style.color = "#EF4444"; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = "#2A1A1A"; e.currentTarget.style.color = "#F87171"; }}
                                  >✕</button>
                                </div>
                              </div>
                              <div style={{ color: "#4B5563", fontSize: 10, marginTop: 4 }}>{ne.user} · {ne.date}</div>
                            </>
                          )}
                        </div>
                      );
                    })
                  : !isVariantMode && m.notes
                    ? <div style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px" }}>
                        <div style={{ color: "#E5E7EB", fontSize: 12 }}>{m.notes}</div>
                        <div style={{ color: "#4B5563", fontSize: 10, marginTop: 4 }}>legacy note</div>
                      </div>
                    : null}
              </div>
              );
            })}
          {/* Variant (line item) notes — shown in the "all notes" view */}
          {variantNotesFlat.length > 0 && (
            <div style={{ marginTop: shown.length > 0 ? 16 : 0 }}>
              <div style={{ color: "#F59E0B", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Line Item Notes</div>
              {variantNotesFlat.map((vn, i) => (
                <div key={i} style={{ background: "#1E293B", borderRadius: 6, padding: "8px 12px", marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ color: "#E5E7EB", fontSize: 12, flex: 1 }}>{vn.text}</div>
                  </div>
                  <div style={{ color: "#4B5563", fontSize: 10, marginTop: 4 }}>
                    <span style={{ color: "#60A5FA" }}>{vn.variant}</span> · {vn.phase} · {vn.user} · {vn.date}
                  </div>
                </div>
              ))}
            </div>
          )}
          </>)}
        </div>

        {/* Add note footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #1E293B", flexShrink: 0, background: "#080F1A", borderRadius: "0 0 10px 10px" }}>
          {!filterPhase && availableMs.length > 1 && (
            <select
              value={addPhase}
              onChange={e => setAddPhase(e.target.value)}
              style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, color: "#D1D5DB", fontSize: 11, padding: "5px 8px", marginBottom: 8, boxSizing: "border-box", outline: "none" }}
            >
              {availableMs.map(m => <option key={m.id} value={m.phase}>{m.phase}</option>)}
            </select>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder={filterPhase ? `Add note for ${filterPhase}…` : "Add a note…"}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
              style={{ flex: 1, background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: "#E5E7EB", fontSize: 12, padding: "8px 10px", resize: "none", height: 60, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
            />
            <button
              onClick={handleAdd}
              disabled={!noteText.trim()}
              style={{ background: noteText.trim() ? "#3B82F6" : "#1A2535", border: "none", borderRadius: 6, color: noteText.trim() ? "#fff" : "#374151", fontSize: 12, padding: "0 16px", cursor: noteText.trim() ? "pointer" : "default", fontWeight: 600, flexShrink: 0, transition: "background 0.15s" }}
            >
              Add
            </button>
          </div>
          <div style={{ color: "#374151", fontSize: 10, marginTop: 5 }}>Enter to submit · Shift+Enter for new line</div>
        </div>
      </div>
    </div>
  );
}

// ── Style/Color grouping helpers ─────────────────────────────────────────
function isSizeToken(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return false;
  if (/^(xs|s|sm|sml|small|m|med|medium|l|lg|lrg|large|xl|xlg|xlarge|xxl|2xl|xxxl|3xl|4xl|5xl|6xl)$/.test(t)) return true;
  if (/^\d{1,3}$/.test(t)) return true;   // numeric sizes (6, 8, 10, 32, 34 …)
  if (/^\d{1,3}[wlr]$/i.test(t)) return true; // 32W, 34L …
  return false;
}
/** Returns the style+color portion of an item number (strips trailing size segment). */
function styleColorKey(itemNumber: string, description: string): string {
  if (!itemNumber) return description || "";
  const parts = itemNumber.split("-");
  if (parts.length > 1 && isSizeToken(parts[parts.length - 1])) {
    return parts.slice(0, -1).join("-");
  }
  return itemNumber;
}
/** Returns the size label from an item number, or "" if none detected. */
function itemSizeLabel(itemNumber: string): string {
  if (!itemNumber) return "";
  const parts = itemNumber.split("-");
  if (parts.length > 1 && isSizeToken(parts[parts.length - 1])) return parts[parts.length - 1].trim();
  return "";
}
/** Sort size strings: numeric first (ascending), then alpha sizes in standard order, then lexicographic. */
function sizeSort(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  const ORDER: Record<string, number> = { XS: 0, S: 1, SM: 1, Small: 1, M: 2, Medium: 2, L: 3, Large: 3, XL: 4, Xlarge: 4, XXL: 5, "2XL": 5, "3XL": 6, "4XL": 7, "5XL": 8, "6XL": 9 };
  const oa = ORDER[a.toUpperCase()] ?? ORDER[a];
  const ob = ORDER[b.toUpperCase()] ?? ORDER[b];
  if (oa !== undefined && ob !== undefined) return oa - ob;
  if (oa !== undefined) return -1;
  if (ob !== undefined) return 1;
  return a.localeCompare(b);
}

// ── GridView ───────────────────────────────────────────────────────────────
interface GridViewProps {
  pos: XoroPO[];
  milestones: Record<string, Milestone[]>;
  buyers: string[];
  vendors: string[];
  setView: (v: View) => void;
  setSelected: (po: XoroPO | null) => void;
  setDetailMode: (m: any) => void;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => void;
  saveMilestones: (ms: Milestone[]) => Promise<void>;
  ensureMilestones: (po: XoroPO) => Promise<Milestone[] | "needs_template"> | void;
  generateMilestones: (poNumber: string, ddpDate: string, vendorName?: string) => Milestone[];
  regenerateMilestones: (po: XoroPO) => Promise<void>;
  vendorHasTemplate: (vendorName: string) => boolean;
  templateVendorList: () => string[];
  getVendorTemplates: (vendor?: string) => WipTemplate[];
  saveVendorTemplates: (vendor: string, templates: WipTemplate[]) => void;
  user: { name?: string } | null;
}

export function GridView({
  pos, milestones, buyers, vendors, setView, setSelected, setDetailMode,
  saveMilestone, saveMilestones, ensureMilestones, generateMilestones, regenerateMilestones,
  vendorHasTemplate, templateVendorList, getVendorTemplates, saveVendorTemplates,
  user,
}: GridViewProps) {

  // Inject scrollbar CSS once — always-visible horizontal bar in dark-theme colors.
  useEffect(() => {
    const id = "gv-scrollbar-style";
    if (document.getElementById(id)) return;
    const el = document.createElement("style");
    el.id = id;
    el.textContent = `
      .gv-scroll { overflow-x: scroll; overflow-y: auto; }
      .gv-scroll::-webkit-scrollbar { height: 8px; width: 8px; }
      .gv-scroll::-webkit-scrollbar-track { background: #0F172A; border-top: 1px solid #1E293B; }
      .gv-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
      .gv-scroll::-webkit-scrollbar-thumb:hover { background: #475569; }
      .gv-scroll::-webkit-scrollbar-corner { background: #0F172A; }
    `;
    document.head.appendChild(el);
  }, []);

  const [search, setSearch]                     = useState("");
  const [filterVendor, setFilterVendor]         = useState("All");
  const [filterBuyer, setFilterBuyer]           = useState("All");
  const [expandedPoNum, setExpandedPoNum]       = useState<string | null>(null);
  const [expandViewMode, setExpandViewMode]     = useState<"line" | "matrix">("line");
  const [buyerPoEditing, setBuyerPoEditing]     = useState<string | null>(null);
  const [buyerPoDraft, setBuyerPoDraft]     = useState("");
  const [page, setPage]                     = useState(0);
  // Each entry is a batch of milestones to restore together (supports cascade undo).
  const [undoStack, setUndoStack]           = useState<Milestone[][]>([]);
  const [notesModal, setNotesModal]         = useState<{
    po: XoroPO; ms: Milestone[]; filterPhase?: string; filterVariant?: string;
  } | null>(null);
  // Vendors the user dismissed this session — state so dismissal triggers re-render.
  const [dismissedTplVendors, setDismissedTplVendors] = useState<Set<string>>(new Set());
  // When the set of available vendor templates grows (user or background load),
  // un-dismiss those vendors so they don't get permanently hidden if they were
  // dismissed before wipTemplates finished loading.
  const prevTemplateVendorCountRef = useRef<number>(0);
  useEffect(() => {
    const currentCount = templateVendorList().length;
    if (currentCount > prevTemplateVendorCountRef.current) {
      prevTemplateVendorCountRef.current = currentCount;
      // Remove any dismissed vendors that now have a template — they no longer
      // need re-prompting. Also remove those that still don't have one so they
      // can be re-surfaced (they may have been dismissed due to timing).
      setDismissedTplVendors(prev => {
        const next = new Set<string>();
        prev.forEach(v => {
          // Keep dismissed only if vendor now has a template (no need to re-show).
          if (templateVendorList().includes(v)) next.add(v);
        });
        return next;
      });
    }
  }, [templateVendorList]);
  // DDP confirmation modal — shown when a phase date change would shift the DDP.
  const [ddpChangeModal, setDDPChangeModal] = useState<{
    po: XoroPO;
    triggerMs: Milestone;
    newDate: string;
    newDDP: string;
    oldDDP: string;
    poMs: Milestone[];
  } | null>(null);
  // POs whose DDP was modified this session — highlighted orange.
  const [modifiedDDPs, setModifiedDDPs] = useState<Set<string>>(new Set());

  const ensureAttemptedRef = useRef<Set<string>>(new Set());

  // ── Rows ────────────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    const s = search.toLowerCase();
    return pos.filter(p => {
      if (filterVendor !== "All" && (p.VendorName ?? "") !== filterVendor) return false;
      if (filterBuyer  !== "All" && (p.BuyerName  ?? "") !== filterBuyer)  return false;
      if (!s) return true;
      return (
        (p.PoNumber   ?? "").toLowerCase().includes(s) ||
        (p.VendorName ?? "").toLowerCase().includes(s) ||
        (p.BuyerName  ?? "").toLowerCase().includes(s) ||
        (p.BuyerPo    ?? "").toLowerCase().includes(s)
      );
    });
  }, [pos, search, filterVendor, filterBuyer]);

  useEffect(() => setPage(0), [search, filterVendor, filterBuyer]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows   = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // First vendor on the current page that has no template and hasn't been dismissed.
  // Computed at render time so it re-evaluates automatically after wipTemplates loads
  // or after the user dismisses a vendor — no timing/false-positive issues.
  const tplModalVendor = useMemo(() => {
    for (const po of pageRows) {
      const vendorN = po.VendorName ?? "";
      if (vendorN && !vendorHasTemplate(vendorN) && !dismissedTplVendors.has(vendorN)) {
        return vendorN;
      }
    }
    return null;
  }, [pageRows, vendorHasTemplate, dismissedTplVendors]);

  // Auto-populate milestones for every PO on the current page.
  // Also detects partial milestones (PO has some phases but fewer than the current
  // template) and silently regenerates them so new template phases fill in.
  useEffect(() => {
    for (const po of pageRows) {
      if (!ensureMilestones) continue;
      const poNum    = po.PoNumber ?? "";
      const vendorN  = po.VendorName ?? "";
      const ddp      = normDateISO(po.DateExpectedDelivery);
      if (!poNum || !ddp) continue;

      const existing = milestones[poNum] || [];

      if (existing.length === 0) {
        // No milestones yet — try to generate.
        // We only block retries on SUCCESS (milestones saved) or hard error.
        // "needs_template" clears the ref so the effect retries automatically
        // once wipTemplates loads or the user creates a template.
        if (ensureAttemptedRef.current.has(poNum)) continue;
        ensureAttemptedRef.current.add(poNum);
        const normPo = ddp !== (po.DateExpectedDelivery ?? "") ? { ...po, DateExpectedDelivery: ddp } : po;
        void (async () => {
          try {
            const result = await ensureMilestones(normPo);
            // No template yet — clear so we retry when templates become available.
            if (result === "needs_template") ensureAttemptedRef.current.delete(poNum);
          } catch (e) {
            ensureAttemptedRef.current.delete(poNum);
            console.error("[Grid] ensureMilestones failed for", poNum, e);
          }
        })();
      } else if (vendorN && vendorHasTemplate(vendorN)) {
        // PO has milestones — check if they're partial (fewer phases than current template).
        const templatePhaseCount = getVendorTemplates(vendorN).length;
        const regenKey = poNum + "_regen";
        if (templatePhaseCount > 0 && existing.length < templatePhaseCount && !ensureAttemptedRef.current.has(regenKey)) {
          ensureAttemptedRef.current.add(regenKey);
          const normPo = ddp !== (po.DateExpectedDelivery ?? "") ? { ...po, DateExpectedDelivery: ddp } : po;
          void regenerateMilestones(normPo).catch(e => {
            ensureAttemptedRef.current.delete(regenKey);
            console.error("[Grid] regenerateMilestones failed for", poNum, e);
          });
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRows, milestones, ensureMilestones, vendorHasTemplate, getVendorTemplates, regenerateMilestones]);

  const phases = useMemo(() => {
    const order = new Map<string, number>();
    rows.forEach(p => {
      (milestones[p.PoNumber ?? ""] || []).forEach(m => {
        const cur = order.get(m.phase);
        if (cur === undefined || m.sort_order < cur) order.set(m.phase, m.sort_order);
      });
    });
    return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([phase]) => phase);
  }, [rows, milestones]);

  // ── Mutations ───────────────────────────────────────────────────────────
  // pushUndo accepts a batch (array) of milestones — all are restored together on undo.
  const pushUndo = useCallback((batch: Milestone | Milestone[]) => {
    const arr = Array.isArray(batch) ? batch : [batch];
    setUndoStack(s => [arr, ...s].slice(0, MAX_UNDO));
  }, []);

  const updateStatus = (po: XoroPO, m: Milestone, newStatus: string) => {
    pushUndo(m);
    const dates = { ...(m.status_dates || {}) };
    const iso   = new Date().toISOString().split("T")[0];
    if (newStatus !== "Not Started" && !dates[newStatus]) dates[newStatus] = iso;
    saveMilestone({
      ...m,
      status: newStatus,
      status_date: dates[newStatus] || null,
      status_dates: Object.keys(dates).length > 0 ? dates : null,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    }, true);
  };

  const updateField = useCallback((m: Milestone, patch: Partial<Milestone>) => {
    pushUndo(m);
    saveMilestone({ ...m, ...patch, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
  }, [pushUndo, saveMilestone, user]);

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const [batch, ...rest] = undoStack;
    setUndoStack(rest);
    // Restore all milestones in the batch (single edit = 1 item, cascade = many).
    batch.forEach(prev => {
      saveMilestone({ ...prev, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
    });
  };

  // Add note to a specific milestone; optimistic store update so the UI
  // reflects the change immediately without waiting for the DB round-trip.
  const addNote = useCallback((milestone: Milestone, text: string) => {
    const now      = new Date();
    const dateStr  = now.toISOString().slice(0, 10);
    const newEntry = { text, user: user?.name || "Unknown", date: dateStr };
    const updated  = {
      ...milestone,
      note_entries: [...(milestone.note_entries || []), newEntry],
      updated_at: now.toISOString(),
      updated_by: user?.name || "",
    };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const editNote = useCallback((milestone: Milestone, index: number, newText: string) => {
    const entries = [...(milestone.note_entries || [])];
    entries[index] = { ...entries[index], text: newText };
    const updated = {
      ...milestone,
      note_entries: entries,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const deleteNote = useCallback((milestone: Milestone, index: number) => {
    const entries = [...(milestone.note_entries || [])];
    entries.splice(index, 1);
    const updated = {
      ...milestone,
      note_entries: entries.length > 0 ? entries : null,
      updated_at: new Date().toISOString(),
      updated_by: user?.name || "",
    };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  // ── Per-line-item (variant) notes ───────────────────────────────────────
  // Stored in milestone.variant_notes[varKey] so each SKU group gets its
  // own note thread, independent of the PO-level note_entries.
  const addVariantNote = useCallback((milestone: Milestone, varKey: string, text: string) => {
    const now = new Date();
    const entry = { text, user: user?.name || "Unknown", date: now.toISOString().slice(0, 10) };
    const vn = { ...(milestone.variant_notes || {}) };
    vn[varKey] = [...(vn[varKey] || []), entry];
    const updated = { ...milestone, variant_notes: vn, updated_at: now.toISOString(), updated_by: user?.name || "" };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const editVariantNote = useCallback((milestone: Milestone, varKey: string, index: number, newText: string) => {
    const vn = { ...(milestone.variant_notes || {}) };
    const entries = [...(vn[varKey] || [])];
    entries[index] = { ...entries[index], text: newText };
    vn[varKey] = entries;
    const updated = { ...milestone, variant_notes: vn, updated_at: new Date().toISOString(), updated_by: user?.name || "" };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  const deleteVariantNote = useCallback((milestone: Milestone, varKey: string, index: number) => {
    const vn = { ...(milestone.variant_notes || {}) };
    const entries = [...(vn[varKey] || [])];
    entries.splice(index, 1);
    vn[varKey] = entries.length > 0 ? entries : [];
    const cleanVn = Object.fromEntries(Object.entries(vn).filter(([, v]) => v.length > 0));
    const updated = { ...milestone, variant_notes: Object.keys(cleanVn).length > 0 ? cleanVn : null, updated_at: new Date().toISOString(), updated_by: user?.name || "" };
    useTandaStore.getState().updateMilestone(milestone.po_number, milestone.id, updated);
    saveMilestone(updated, true);
  }, [user, saveMilestone]);

  // ── Buyer dropdown options ────────────────────────────────────────────
  // All known buyers from POs + fixed stock options; always sorted.
  const buyerOptions = useMemo(() => {
    const fixed = ["ROF Stock", "PT Stock"];
    return [...new Set([...buyers, ...fixed])].sort();
  }, [buyers]);

  // ── Buyer PO ────────────────────────────────────────────────────────────
  const persistBuyerPo = async (poNumber: string, value: string) => {
    const trimmed = value.trim();
    useTandaStore.getState().updatePo(poNumber, { BuyerPo: trimmed });
    try {
      await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNumber)}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_po: trimmed || null }),
      });
    } catch (e) { console.error("Failed to update buyer_po:", e); }
  };

  const persistBuyerName = async (poNumber: string, value: string) => {
    useTandaStore.getState().updatePo(poNumber, { BuyerName: value });
    try {
      await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNumber)}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_name: value || null }),
      });
    } catch (e) { console.error("Failed to update buyer_name:", e); }
  };

  // ── Shared DDP persist helper ────────────────────────────────────────────
  const persistDDP = useCallback(async (poNum: string, newDDP: string) => {
    useTandaStore.getState().updatePo(poNum, { DateExpectedDelivery: newDDP });
    setModifiedDDPs(prev => new Set([...prev, poNum]));
    try {
      await fetch(`${SB_URL}/rest/v1/tanda_pos?po_number=eq.${encodeURIComponent(poNum)}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ date_expected_delivery: newDDP || null }),
      });
    } catch (e) { console.error("Failed to update DDP:", e); }
  }, []);

  // ── Cascade all milestones from a given DDP (helper used by both paths) ──
  const cascadeFromDDP = useCallback((poMs: Milestone[], newDDP: string, skipId?: string) => {
    const ddpDate = new Date(newDDP + "T00:00:00");
    for (const m of poMs) {
      if (skipId && m.id === skipId) continue;
      const shifted = new Date(ddpDate);
      shifted.setDate(shifted.getDate() - (m.days_before_ddp ?? 0));
      const newDate = shifted.toISOString().slice(0, 10);
      if (newDate !== normDateISO(m.expected_date ?? "")) {
        saveMilestone({
          ...m, expected_date: newDate,
          updated_at: new Date().toISOString(),
          updated_by: user?.name || "",
        }, true);
      }
    }
  }, [saveMilestone, user]);

  // ── Direct DDP edit (from DDP cell) ─────────────────────────────────────
  const updateDDP = useCallback(async (po: XoroPO, newDDP: string) => {
    const poNum = po.PoNumber ?? "";
    const poMs  = milestones[poNum] || [];
    const oldDDP = normDateISO(po.DateExpectedDelivery);
    if (!newDDP) { await persistDDP(poNum, newDDP); return; }
    if (poMs.length === 0) {
      await persistDDP(poNum, newDDP);
      // No milestones yet — generate fresh from new DDP.
      if (vendorHasTemplate(po.VendorName ?? "")) {
        const ms = generateMilestones(poNum, newDDP, po.VendorName);
        if (ms.length > 0) await saveMilestones(ms);
      }
      return;
    }
    // Snapshot ALL milestones + DDP as one undo batch before cascading.
    pushUndo(poMs);
    await persistDDP(poNum, newDDP);
    // Cascade all milestones.
    cascadeFromDDP(poMs, newDDP);
    // Auto-note on DDP milestone about the direct edit.
    if (oldDDP && oldDDP !== newDDP) {
      const ddpMs = poMs.find(m => (m.days_before_ddp ?? 0) === 0) || poMs[poMs.length - 1];
      if (ddpMs) addNote(ddpMs, `DDP updated from ${fmtDate(oldDDP)} to ${fmtDate(newDDP)} — all phase dates recalculated`);
    }
  }, [milestones, pushUndo, persistDDP, cascadeFromDDP, saveMilestones, generateMilestones, vendorHasTemplate, addNote]);

  // ── Phase date change — may imply a new DDP ──────────────────────────────
  // If the new date implies a different DDP, show a confirmation modal.
  // On confirm: update all milestones + DDP, mark orange, add auto-note.
  const updateMilestoneDate = useCallback((po: XoroPO, m: Milestone, newDate: string | null) => {
    if (!newDate) {
      updateField(m, { expected_date: null });
      return;
    }
    const poNum  = po.PoNumber ?? "";
    const poMs   = milestones[poNum] || [];
    const currentDDP = normDateISO(po.DateExpectedDelivery);

    // Compute the DDP implied by this phase date.
    const implied = new Date(newDate + "T00:00:00");
    implied.setDate(implied.getDate() + (m.days_before_ddp ?? 0));
    const newDDP = implied.toISOString().slice(0, 10);

    if (!currentDDP || newDDP === currentDDP || poMs.length <= 1) {
      // No DDP conflict — snapshot all affected milestones before updating.
      pushUndo(poMs.length > 1 ? poMs : m);
      saveMilestone({ ...m, expected_date: newDate, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
      if (poMs.length > 1) cascadeFromDDP(poMs, newDDP, m.id);
      return;
    }
    // DDP would change — ask user to confirm before cascading.
    // Snapshot stored on ddpChangeModal so handleDDPConfirm can push it.
    setDDPChangeModal({ po, triggerMs: m, newDate, newDDP, oldDDP: currentDDP, poMs });
  }, [milestones, pushUndo, saveMilestone, user, cascadeFromDDP]);

  // ── Confirm DDP change triggered by phase date edit ──────────────────────
  const handleDDPConfirm = useCallback(async () => {
    if (!ddpChangeModal) return;
    const { po, triggerMs, newDate, newDDP, oldDDP, poMs } = ddpChangeModal;
    setDDPChangeModal(null);
    const poNum = po.PoNumber ?? "";
    // Snapshot entire PO milestone set as one undo batch before any changes.
    pushUndo(poMs);
    // 1. Update the trigger milestone.
    saveMilestone({ ...triggerMs, expected_date: newDate, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
    // 2. Cascade all other milestones from new DDP.
    cascadeFromDDP(poMs, newDDP, triggerMs.id);
    // 3. Persist new DDP.
    await persistDDP(poNum, newDDP);
    // 4. Auto-note on the DDP milestone.
    const ddpMs = poMs.find(m => (m.days_before_ddp ?? 0) === 0) || poMs[poMs.length - 1];
    if (ddpMs) addNote(ddpMs, `DDP changed from ${fmtDate(oldDDP)} to ${fmtDate(newDDP)} — triggered by "${triggerMs.phase}" date change`);
  }, [ddpChangeModal, pushUndo, saveMilestone, user, cascadeFromDDP, persistDDP, addNote]);

  // ── Excel export ────────────────────────────────────────────────────────
  const exportToExcel = () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const HDR: any = {
      font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Calibri" },
      fill:      { fgColor: { rgb: "217346" }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center", wrapText: true },
      border: { top: { style: "thin", color: { rgb: "145A2E" } }, bottom: { style: "medium", color: { rgb: "145A2E" } }, left: { style: "thin", color: { rgb: "145A2E" } }, right: { style: "thin", color: { rgb: "145A2E" } } },
    };
    const HDR2: any = { ...HDR, fill: { fgColor: { rgb: "1A5C38" }, patternType: "solid" }, font: { ...HDR.font, sz: 9 } };
    const cellBase: any = { font: { sz: 10, name: "Calibri" }, alignment: { vertical: "center" }, border: { top: { style: "thin", color: { rgb: "D0D8E4" } }, bottom: { style: "thin", color: { rgb: "D0D8E4" } }, left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } } };
    const cellAlt: any  = { ...cellBase, fill: { fgColor: { rgb: "F0FAF4" }, patternType: "solid" } };
    const mono = (b: any): any => ({ ...b, font: { ...b.font, name: "Courier New" } });

    const fixedHdrs1 = ["PO #", "Vendor", "Buyer", "Buyer PO", "DDP", "Days from DDP"];
    const phaseHdrs1: string[] = [];
    const phaseHdrs2: string[] = [];
    phases.forEach(p => { phaseHdrs1.push(p, "", "", "", ""); phaseHdrs2.push("Due Date", "Status", "Status Date", "Days", "Notes"); });

    const row1 = [...fixedHdrs1.map(h => ({ v: h, t: "s", s: HDR })), ...phaseHdrs1.map(h => ({ v: h, t: "s", s: h ? HDR : { ...HDR, fill: { fgColor: { rgb: "1A5C38" }, patternType: "solid" } } }))];
    const row2 = [...fixedHdrs1.map(() => ({ v: "", t: "s", s: HDR2 })), ...phaseHdrs2.map(h => ({ v: h, t: "s", s: HDR2 }))];

    const dataRows = rows.map((po, ri) => {
      const base = ri % 2 === 0 ? cellBase : cellAlt;
      const poNum = po.PoNumber ?? "";
      const poMs  = milestones[poNum] || [];
      const phaseMap = new Map<string, Milestone>();
      poMs.forEach(m => phaseMap.set(m.phase, m));
      const ddp    = normDateISO(po.DateExpectedDelivery);
      const days   = ddp ? Math.ceil((new Date(ddp).getTime() - today.getTime()) / 86400000) : null;
      const daysTxt = days === null ? "" : days < 0 ? `${Math.abs(days)} late` : days === 0 ? "Today" : `${days}`;
      const fixed = [
        { v: poNum, t: "s", s: mono(base) }, { v: po.VendorName || "", t: "s", s: base },
        { v: po.BuyerName || "", t: "s", s: base }, { v: po.BuyerPo || "", t: "s", s: mono(base) },
        { v: fmtDate(ddp) || "", t: "s", s: base }, { v: daysTxt, t: "s", s: base },
      ];
      const phaseCells: any[] = [];
      phases.forEach(phase => {
        const m = phaseMap.get(phase);
        if (!m) { for (let i = 0; i < PHASE_COLS; i++) phaseCells.push({ v: "", t: "s", s: base }); return; }
        const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
        const dTxt = m.status === "Complete" ? "Done" : m.status === "N/A" ? "" : daysRem === null ? "" : daysRem < 0 ? `${Math.abs(daysRem)} late` : daysRem === 0 ? "Today" : `${daysRem}`;
        const sdVal = (m.status_dates || {})[m.status] || m.status_date || "";
        const noteCount = (m.note_entries?.length || 0) + (m.notes ? 1 : 0);
        const allNoteText = [
          ...(m.note_entries || []).map(ne => `${ne.date} ${ne.user}: ${ne.text}`),
          ...(m.notes ? [m.notes] : []),
        ].join(" | ");
        phaseCells.push(
          { v: m.expected_date ? fmtDate(m.expected_date) || "" : "", t: "s", s: base },
          { v: m.status, t: "s", s: base },
          { v: sdVal ? fmtDate(sdVal) || "" : "", t: "s", s: base },
          { v: dTxt, t: "s", s: base },
          { v: noteCount > 0 ? allNoteText : "", t: "s", s: base },
        );
      });
      return [...fixed, ...phaseCells];
    });

    const ws = XLSXStyle.utils.aoa_to_sheet([[]]);
    XLSXStyle.utils.sheet_add_aoa(ws, [row1.map(c => c.v), row2.map(c => c.v), ...dataRows.map(r => r.map((c: any) => c.v))]);
    const applyRow = (ri: number, cells: any[]) => cells.forEach((c, ci) => { const addr = XLSXStyle.utils.encode_cell({ r: ri, c: ci }); if (!ws[addr]) ws[addr] = { v: c.v, t: c.t }; ws[addr].s = c.s; });
    applyRow(0, row1); applyRow(1, row2); dataRows.forEach((r, ri) => applyRow(ri + 2, r));
    const fixedWidths = [12, 22, 18, 14, 12, 14];
    const phaseWidths = phases.flatMap(() => [12, 14, 12, 10, 30]);
    ws["!cols"] = [...fixedWidths, ...phaseWidths].map(w => ({ wch: w }));
    ws["!merges"] = phases.map((_, pi) => ({ s: { r: 0, c: fixedHdrs1.length + pi * PHASE_COLS }, e: { r: 0, c: fixedHdrs1.length + pi * PHASE_COLS + PHASE_COLS - 1 } }));
    ws["!rows"] = [{ hpx: 28 }, { hpx: 18 }];
    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, "WIP Grid");
    XLSXStyle.writeFile(wb, `WIP_Grid_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ── Cell styles ─────────────────────────────────────────────────────────
  // Data cells — no borderTop: only borderBottom draws horizontal lines.
  // Having both borderTop and borderBottom doubles up the lines and creates
  // ugly overlaps where they cross the thick phase-divider vertical borders.
  const cell: React.CSSProperties = {
    padding: "4px 7px",
    borderRight:  B_CELL,
    borderBottom: B_CELL,
    overflow: "hidden",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
  };

  const hdr1: React.CSSProperties = {
    ...cell,
    background: "#162032",
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderTop:    B_HDR,   // top frame line — only on header
    borderBottom: B_HDR,
    borderRight:  B_HDR,
    whiteSpace: "normal",
    wordBreak: "break-word",
    minHeight: 38,
    alignItems: "center",
  };

  const hdr2: React.CSSProperties = {
    ...cell,
    background: "#111827",
    color: "#4B5563",
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderBottom: B_HDR,
    borderRight:  B_HDR,
    justifyContent: "center",
    minHeight: 24,
    padding: "3px 4px",
  };

  // Phase sub-cells — same base as cell, just smaller font/padding.
  const sub: React.CSSProperties = {
    ...cell,
    fontSize: 10,
    padding: "2px 4px",
  };

  // Left border on first column to close the outer frame.
  const firstCol: React.CSSProperties = { borderLeft: B_CELL };

  const ct    = buildColTpl(phases.length);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <div style={{ maxWidth: "100%", margin: "0 auto", padding: "0 12px" }}>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div style={{ ...S.filters, flexWrap: "wrap" }}>
        <input
          style={{ ...S.input, flex: 1, minWidth: 240, marginBottom: 0 }}
          placeholder="🔍 Search PO#, vendor, buyer, buyer PO…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select style={{ ...S.select, width: 200 }} value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
          <option value="All">All Vendors</option>
          {vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select style={{ ...S.select, width: 200 }} value={filterBuyer} onChange={e => setFilterBuyer(e.target.value)}>
          <option value="All">All Buyers</option>
          {buyerOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterVendor("All"); setFilterBuyer("All"); }}>Clear</button>

        <button
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          title={undoStack.length > 0 ? `Undo last change (${undoStack.length} available)` : "Nothing to undo"}
          style={{ ...S.btnSecondary, opacity: undoStack.length === 0 ? 0.35 : 1, display: "flex", alignItems: "center", gap: 5 }}
        >
          ↩ Undo
        </button>

        <button
          onClick={exportToExcel}
          title="Download as Excel"
          style={{ background: "#217346", border: "1px solid #145A2E", color: "#fff", borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ fontSize: 15 }}>⬇</span> Excel
        </button>
      </div>

      {/* ── Create-template modal — shown for the first vendor on the page
           that has no template. Re-evaluates after wipTemplates loads so
           there are no false positives from early async timing. ──────── */}
      {tplModalVendor && (() => {
        const vendorN = tplModalVendor;
        const dismiss = () => setDismissedTplVendors(prev => new Set([...prev, vendorN]));
        return (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={dismiss}
          >
            <div
              style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, width: 500, boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 16, fontWeight: 700 }}>Create Production Template</h2>
                <button onClick={dismiss} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
              </div>
              <div style={{ padding: "16px 20px" }}>
                <p style={{ color: "#D1D5DB", fontSize: 14, marginTop: 0, marginBottom: 16 }}>
                  No production template exists for <strong style={{ color: "#60A5FA" }}>{vendorN}</strong>. Create one to generate milestones for all their POs.
                </p>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ color: "#94A3B8", fontSize: 12, display: "block", marginBottom: 6 }}>Copy from</label>
                  <select style={{ ...S.select, width: "100%" }} id="gridModalCopyFrom">
                    <option value="__default__">Default Template</option>
                    {templateVendorList().map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button style={{ ...S.btnSecondary, flex: 1 }} onClick={dismiss}>Cancel</button>
                  <button style={{ ...S.btnPrimary, flex: 2 }} onClick={async () => {
                    const copyEl = document.getElementById("gridModalCopyFrom") as HTMLSelectElement;
                    const copyFrom = copyEl?.value || "__default__";
                    const source = getVendorTemplates(copyFrom === "__default__" ? undefined : copyFrom) || [];
                    const newTpls = source.map((t: WipTemplate) => ({ ...t, id: milestoneUid() }));
                    await saveVendorTemplates(vendorN, newTpls);
                    const vendorPos = pos.filter(p => p.VendorName === vendorN && p.DateExpectedDelivery);
                    // Clear ensureAttempted so the effect can retry any POs that were
                    // blocked waiting for this template to exist.
                    vendorPos.forEach(vpo => ensureAttemptedRef.current.delete(vpo.PoNumber ?? ""));
                    // Generate fresh milestones for POs with none; regenerate POs with partial milestones.
                    const allMs: Milestone[] = [];
                    for (const vpo of vendorPos) {
                      const existing = milestones[vpo.PoNumber ?? ""] || [];
                      if (existing.length === 0) {
                        const ms = generateMilestones(vpo.PoNumber ?? "", vpo.DateExpectedDelivery!, vendorN);
                        allMs.push(...ms);
                      } else {
                        // Has partial milestones — regenerate to pick up new phases.
                        void regenerateMilestones(vpo);
                      }
                    }
                    if (allMs.length > 0) await saveMilestones(allMs);
                    dismiss();
                  }}>
                    Create Template &amp; Generate Milestones
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>

        {/* ── Status bar + pagination ─────────────────────────────────── */}
        <div style={{ padding: "10px 14px", color: "#9CA3AF", fontSize: 13, borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Showing {pageRows.length} of {rows.length} PO{rows.length !== 1 ? "s" : ""} · {phases.length} phase{phases.length !== 1 ? "s" : ""}</span>
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page === 0 ? 0.4 : 1 }}>‹ Prev</button>
              <span style={{ color: "#6B7280", fontSize: 11 }}>Page {page + 1} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                style={{ ...S.btnSecondary, padding: "3px 10px", fontSize: 11, opacity: page >= totalPages - 1 ? 0.4 : 1 }}>Next ›</button>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No POs match the filters.</div>
        ) : phases.length === 0 ? (
          <div style={{ padding: 32, color: "#6B7280", fontSize: 13, textAlign: "center" }}>No milestones generated yet for the visible POs.</div>
        ) : (
          <div className="gv-scroll" style={{ maxHeight: "calc(100vh - 240px)" }}>
            <div style={{ minWidth: "fit-content" }}>

              {/* ── Sticky two-row header ──────────────────────────────── */}
              <div style={{ position: "sticky", top: 0, zIndex: 3 }}>

                {/* Row 1 */}
                <div style={{ display: "grid", gridTemplateColumns: ct }}>
                  <span style={{ ...hdr1, ...firstCol }} />
                  <span style={{ ...hdr1 }} />
                  <span style={{ ...hdr1 }}>PO #</span>
                  <span style={{ ...hdr1 }}>Vendor</span>
                  <span style={{ ...hdr1 }}>Buyer</span>
                  <span style={{ ...hdr1, justifyContent: "center" }}>Buyer PO</span>
                  <span style={{ ...hdr1, justifyContent: "center" }}>DDP</span>
                  <span style={{ ...hdr1, justifyContent: "flex-end" }}>Days from DDP</span>
                  {phases.map((p, i) => {
                    const isLastPhase = i === phases.length - 1;
                    return (
                      <span key={p} title={p} style={{
                        ...hdr1,
                        gridColumn: `span ${PHASE_COLS}`,
                        justifyContent: "center",
                        background: "#1A2535",
                        color: "#C4B5FD",
                        borderRight: B_HDR,
                        borderBottom: B_HDR,
                        position: "relative", zIndex: 1, overflow: "visible",
                      }}>
                        {/* Left divider — all phases; top:0 because this is the topmost row */}
                        <span style={{ ...phaseDividerOverlay, top: 0, height: "calc(100% + 2px)" }} />
                        {/* Right closing border on last phase */}
                        {isLastPhase && <span style={{ ...phaseDividerOverlayRight, top: 0, height: "calc(100% + 2px)" }} />}
                        {p}
                      </span>
                    );
                  })}
                </div>

                {/* Row 2 */}
                <div style={{ display: "grid", gridTemplateColumns: ct }}>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <span key={i} style={{ ...hdr2, ...(i === 0 ? firstCol : {}) }} />
                  ))}
                  {phases.map((p, pi) => {
                    const isLastPhase = pi === phases.length - 1;
                    return (
                      <React.Fragment key={p}>
                        {/* Left divider on every Due Date sub-label */}
                        <span style={{ ...hdr2, ...phaseDividerHost }}>
                          <span style={phaseDividerOverlay} />
                          Due Date
                        </span>
                        <span style={{ ...hdr2 }}>Status</span>
                        <span style={{ ...hdr2 }}>Status Date</span>
                        <span style={{ ...hdr2 }}>Days</span>
                        {/* Right closing border on last phase Notes sub-label */}
                        <span style={{ ...hdr2, ...(isLastPhase ? phaseDividerHost : {}) }}>
                          {isLastPhase && <span style={phaseDividerOverlayRight} />}
                          📝
                        </span>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* ── Data rows ─────────────────────────────────────────── */}
              {pageRows.map(po => {
                const poNum    = po.PoNumber ?? "";
                const poMs     = milestones[poNum] || [];
                const phaseMap = new Map<string, Milestone>();
                poMs.forEach(m => phaseMap.set(m.phase, m));

                const ddpRaw  = po.DateExpectedDelivery;
                const ddp     = normDateISO(ddpRaw);
                const days    = ddp ? Math.ceil((new Date(ddp + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
                const daysClr = days === null ? "#6B7280" : days < 0 ? "#EF4444" : days <= 7 ? "#F59E0B" : "#10B981";
                const daysTxt = days === null ? "—" : days < 0 ? `${Math.abs(days)} late` : days === 0 ? "Today" : `${days}`;
                const isEditing      = buyerPoEditing === poNum;
                const isExpanded    = expandedPoNum === poNum;
                const variantNoteCount = poMs.reduce((acc, m) => acc + Object.values(m.variant_notes || {}).reduce((s, arr) => s + arr.length, 0), 0);
                const poNoteCount = poMs.reduce((acc, m) => acc + (m.note_entries?.length || 0) + (m.notes ? 1 : 0), 0);
                const totalNoteCount = poNoteCount + variantNoteCount;
                const hasNotes = totalNoteCount > 0;

                return (
                  <div key={poNum}>
                  <div style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: isExpanded ? "#0D1929" : undefined }}>

                    {/* Expand */}
                    <span
                      style={{ ...cell, ...firstCol, justifyContent: "center", cursor: "pointer" }}
                      onClick={() => setExpandedPoNum(isExpanded ? null : poNum)}
                      title={isExpanded ? "Collapse" : "Expand line items & milestones"}
                    >
                      <span style={{ fontSize: 16, color: "#F97316", fontWeight: 700, lineHeight: 1 }}>
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </span>

                    {/* Row-level notes — opens all-PO notes + add form.
                         Tooltip preview: latest note text truncated. */}
                    {(() => {
                      const allEntries = [
                        ...poMs.flatMap(m => (m.note_entries || []).map(ne => ({ ...ne, phase: m.phase, variant: "" }))),
                        ...poMs.flatMap(m => Object.entries(m.variant_notes || {}).flatMap(([vk, arr]) => arr.map(ne => ({ ...ne, phase: m.phase, variant: vk })))),
                      ];
                      const latest = allEntries.length > 0 ? allEntries[allEntries.length - 1] : null;
                      const latestText = latest
                        ? `[${latest.phase}${latest.variant ? ` · ${latest.variant}` : ""}] ${latest.text}`
                        : "";
                      const tip = hasNotes
                        ? `${totalNoteCount} note${totalNoteCount !== 1 ? "s" : ""}${latestText ? `\nLatest: ${latestText.slice(0, 120)}` : ""}\n\nClick to view/add`
                        : "Add PO notes";
                      return (
                        <span
                          style={{ ...cell, justifyContent: "center", cursor: "pointer", flexDirection: "column", gap: 1, padding: "2px 4px" }}
                          onClick={() => setNotesModal({ po, ms: poMs })}
                          title={tip}
                        >
                          <span style={{ fontSize: 13, color: hasNotes ? "#60A5FA" : "#374151", lineHeight: 1 }}>📝</span>
                          {hasNotes && <span style={{ fontSize: 8, fontWeight: 700, color: "#60A5FA", lineHeight: 1 }}>{totalNoteCount}</span>}
                        </span>
                      );
                    })()}

                    {/* PO # */}
                    <span
                      onClick={() => { setSelected(po); setDetailMode("grid"); setView("list"); }}
                      style={{ ...cell, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12, cursor: "pointer", textDecoration: "underline", whiteSpace: "normal", wordBreak: "break-all" }}
                      title="Open full PO detail"
                    >
                      {poNum}
                    </span>

                    {/* Vendor */}
                    <span style={{ ...cell, color: "#D1D5DB", fontWeight: 600, whiteSpace: "normal", wordBreak: "break-word" }} title={po.VendorName || ""}>
                      {po.VendorName || "—"}
                    </span>

                    {/* Buyer — dropdown from all customers + ROF Stock + PT Stock */}
                    <span style={{ ...cell, padding: 2 }}>
                      <select
                        value={po.BuyerName || ""}
                        onChange={e => persistBuyerName(poNum, e.target.value)}
                        style={{ background: "transparent", border: "none", color: po.BuyerName ? "#D1D5DB" : "#4B5563", fontSize: 11, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: "pointer" }}
                      >
                        <option value="" style={{ background: "#0F172A", color: "#4B5563" }}>— unassigned —</option>
                        {buyerOptions.map(b => <option key={b} value={b} style={{ background: "#0F172A", color: "#D1D5DB" }}>{b}</option>)}
                      </select>
                    </span>

                    {/* Buyer PO */}
                    <span
                      style={{ ...cell, justifyContent: "center", cursor: isEditing ? "text" : "pointer", color: po.BuyerPo ? "#60A5FA" : "#4B5563", fontFamily: "monospace", padding: isEditing ? 0 : cell.padding }}
                      onClick={() => { if (!isEditing) { setBuyerPoEditing(poNum); setBuyerPoDraft(po.BuyerPo || ""); } }}
                      title={isEditing ? "" : "Click to edit"}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={buyerPoDraft}
                          onChange={e => setBuyerPoDraft(e.target.value)}
                          onBlur={() => { if (buyerPoDraft !== (po.BuyerPo || "")) persistBuyerPo(poNum, buyerPoDraft); setBuyerPoEditing(null); }}
                          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); else if (e.key === "Escape") setBuyerPoEditing(null); }}
                          style={{ width: "100%", height: "100%", background: "#0F172A", border: "1px solid #3B82F6", borderRadius: 0, color: "#F1F5F9", fontSize: 11, padding: "3px 6px", fontFamily: "monospace", boxSizing: "border-box", outline: "none", textAlign: "center" }}
                        />
                      ) : (po.BuyerPo || "—")}
                    </span>

                    {/* DDP — editable; changing cascades all milestone expected_dates.
                        normDateISO converts any Xoro date format to YYYY-MM-DD
                        which MilestoneDateInput requires. */}
                    <span style={{ ...cell, padding: 2, justifyContent: "center" }} title={ddp ? "Click to edit DDP — all phase dates will recalculate" : "Click to set DDP"}>
                      <MilestoneDateInput
                        value={ddp}
                        onCommit={v => { if (v !== ddp) updateDDP(po, v); }}
                        style={{ background: "transparent", border: `1px solid ${modifiedDDPs.has(poNum) ? "#F97316" : "#334155"}`, borderRadius: 3, color: modifiedDDPs.has(poNum) ? "#F97316" : ddp ? "#9CA3AF" : "#374151", fontSize: 11, fontWeight: modifiedDDPs.has(poNum) ? 700 : 400, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer", textAlign: "center" } as React.CSSProperties}
                      />
                    </span>

                    {/* Days from DDP */}
                    <span style={{ ...cell, justifyContent: "flex-end", color: daysClr, fontWeight: 700 }}>
                      {daysTxt}
                    </span>

                    {/* Phase sub-cells */}
                    {phases.map((phase, pi) => {
                      const m = phaseMap.get(phase);

                      const isLastPhase = pi === phases.length - 1;
                      if (!m) {
                        return (
                          <React.Fragment key={phase}>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...phaseDividerHost }}>
                              <span style={phaseDividerOverlay} />
                              —
                            </span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                            <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...(isLastPhase ? phaseDividerHost : {}) }}>
                              {isLastPhase && <span style={phaseDividerOverlayRight} />}
                              —
                            </span>
                          </React.Fragment>
                        );
                      }

                      const daysRem = m.expected_date
                        ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000)
                        : null;
                      const dClr = m.status === "Complete" ? "#10B981" : m.status === "N/A" ? "#6B7280"
                        : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                      const dTxt = m.status === "Complete" ? "Done" : m.status === "N/A" ? "—"
                        : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)} late`
                        : daysRem === 0 ? "Today" : `${daysRem}`;
                      const sdVal        = (m.status_dates || {})[m.status] || m.status_date || "";
                      const phaseHasNotes = (m.note_entries && m.note_entries.length > 0) || !!m.notes;
                      const noteCount    = (m.note_entries?.length || 0) + (m.notes ? 1 : 0);

                      return (
                        <React.Fragment key={phase}>
                          {/* Due Date — left divider on every phase, content centered */}
                          <span style={{ ...sub, padding: 2, justifyContent: "center", ...phaseDividerHost }}>
                            <span style={phaseDividerOverlay} />
                            <MilestoneDateInput
                              value={normDateISO(m.expected_date ?? "")}
                              onCommit={v => updateMilestoneDate(po, m, v || null)}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: "#9CA3AF", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer", textAlign: "center" } as React.CSSProperties}
                            />
                          </span>

                          {/* Status */}
                          <span style={{ ...sub, padding: 2 }}>
                            <select
                              value={m.status}
                              onChange={e => updateStatus(po, m, e.target.value)}
                              style={{ background: "transparent", border: "none", color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 10, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: "pointer" }}
                            >
                              {MILESTONE_STATUSES.map(s => (
                                <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s], background: "#0F172A" }}>{s}</option>
                              ))}
                            </select>
                          </span>

                          {/* Status Date */}
                          <span style={{ ...sub, padding: 2 }}>
                            <MilestoneDateInput
                              value={sdVal}
                              onCommit={v => {
                                const val = v || null;
                                const dates = { ...(m.status_dates || {}) };
                                if (val) dates[m.status] = val; else delete dates[m.status];
                                updateField(m, { status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null });
                              }}
                              style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: sdVal ? "#60A5FA" : "#334155", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer" } as React.CSSProperties}
                            />
                          </span>

                          {/* Days */}
                          <span style={{ ...sub, justifyContent: "center", color: dClr, fontWeight: 700 }}>
                            {dTxt}
                          </span>

                          {/* Per-phase notes — right closing border on last phase */}
                          <span
                            style={{ ...sub, justifyContent: "center", cursor: "pointer", padding: 2, ...(isLastPhase ? phaseDividerHost : {}) }}
                            onClick={() => setNotesModal({ po, ms: poMs, filterPhase: phase })}
                            title={phaseHasNotes ? `${noteCount} note${noteCount !== 1 ? "s" : ""} — click to view/add/edit` : `Add note for ${phase}`}
                          >
                            {isLastPhase && <span style={phaseDividerOverlayRight} />}
                            <span style={{ fontSize: 11, color: phaseHasNotes ? "#60A5FA" : "#374151" }}>
                              {phaseHasNotes ? `📝${noteCount}` : "📝"}
                            </span>
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  {/* ── Inline expanded detail ── grid-aligned so phase
                       divider lines continue through item rows ─────── */}
                  {isExpanded && (() => {
                    const allItems  = po.Items ?? po.PoLineArr ?? [];
                    const sortedMs  = [...poMs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                    const infoBg    = "#06101D";
                    const infoBg2   = "#080F1A";

                    // Build style/color groups (strip trailing size from ItemNumber)
                    const groupMap = new Map<string, { key: string; desc: string; items: typeof allItems }>();
                    allItems.forEach((item, idx) => {
                      const k = styleColorKey(item.ItemNumber || "", item.Description || "") || `item_${idx}`;
                      if (!groupMap.has(k)) groupMap.set(k, { key: k, desc: item.Description || "", items: [] });
                      groupMap.get(k)!.items.push(item);
                    });
                    const groups = [...groupMap.values()];

                    // Collect all unique detected sizes (for matrix col headers)
                    const sizeSet = new Set<string>();
                    allItems.forEach(it => { const sz = itemSizeLabel(it.ItemNumber || ""); if (sz) sizeSet.add(sz); });
                    const hasSizes   = sizeSet.size > 0;
                    const sortedSizes = [...sizeSet].sort(sizeSort);

                    // Total cost of lines still left to receive
                    // Closed/cancelled lines and fully-received lines contribute $0
                    const remainingCost = allItems.reduce((s, it) => {
                      const qty = isLineClosed(it) ? 0 : (it.QtyRemaining ?? Math.max(0, (it.QtyOrder ?? 0) - (it.QtyReceived ?? 0)));
                      return s + qty * (it.UnitPrice ?? 0);
                    }, 0);
                    const currency = po.CurrencyCode || "USD";

                    // Info fields for PO strip
                    const infoFields = [
                      { label: "Order Date",  val: fmtDate(po.DateOrder) },
                      { label: "Brand",       val: po.BrandName },
                      { label: "Remaining Cost", val: fmtCurrency(remainingCost, currency), highlight: true },
                      { label: "Ship Method", val: po.ShipMethodName },
                      { label: "Carrier",     val: po.CarrierName },
                      { label: "Payment",     val: po.PaymentTermsName },
                      { label: "Tags",        val: po.Tags },
                    ].filter(f => f.val) as { label: string; val: string; highlight?: boolean }[];

                    return (
                      <>
                        {/* ── PO info strip — phase spacers keep dividers alive ── */}
                        <div style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg }}>
                          <div style={{ gridColumn: "1 / 9", padding: "8px 14px 10px", display: "flex", gap: 18, alignItems: "center", borderLeft: B_CELL, borderBottom: "1px solid #1E293B", flexWrap: "wrap" }}>
                            <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{poNum}</span>
                            <span style={{ color: "#9CA3AF", fontSize: 12, fontWeight: 600 }}>{po.VendorName}</span>
                            {po.StatusName && <span style={{ background: "#1E293B", color: "#94A3B8", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{po.StatusName}</span>}
                            {infoFields.map(({ label, val, highlight }) => (
                              <span key={label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                <span style={{ color: "#374151", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
                                <span style={{ color: highlight ? "#F59E0B" : "#D1D5DB", fontSize: 11, fontWeight: highlight ? 700 : 400 }}>{val}</span>
                              </span>
                            ))}
                            {po.Memo && (
                              <span style={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 220 }}>
                                <span style={{ color: "#374151", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Memo</span>
                                <span style={{ color: "#6B7280", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{po.Memo}</span>
                              </span>
                            )}
                            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                              {(["line", "matrix"] as const).map(mode => (
                                <button key={mode} onClick={() => setExpandViewMode(mode)}
                                  style={{ background: expandViewMode === mode ? "#1E3A5F" : "transparent", border: `1px solid ${expandViewMode === mode ? "#3B82F6" : "#334155"}`, color: expandViewMode === mode ? "#93C5FD" : "#4B5563", borderRadius: 5, padding: "2px 10px", fontSize: 10, cursor: "pointer", fontWeight: expandViewMode === mode ? 700 : 400 }}
                                >{mode === "line" ? "By Line" : "Matrix"}</button>
                              ))}
                              <button onClick={() => setExpandedPoNum(null)} style={{ background: "none", border: "none", color: "#374151", fontSize: 14, cursor: "pointer", paddingLeft: 4 }} title="Collapse">✕</button>
                            </div>
                          </div>
                          {phases.map((phase, pi) => {
                            const isLast = pi === phases.length - 1;
                            return (
                              <React.Fragment key={phase}>
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg, ...phaseDividerHost }}><span style={phaseDividerOverlay} /></span>
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg }} />
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg }} />
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg }} />
                                <span style={{ borderBottom: "1px solid #1E293B", background: infoBg, ...(isLast ? phaseDividerHost : {}) }}>{isLast && <span style={phaseDividerOverlayRight} />}</span>
                              </React.Fragment>
                            );
                          })}
                        </div>

                        {expandViewMode === "line" ? (
                          <>
                            {/* ── Item sub-header ─────────────────────────────── */}
                            <div style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg2 }}>
                              {/* Fixed area: item key | line status | delivery */}
                              <div style={{ gridColumn: "1 / 9", padding: "3px 14px", borderLeft: B_CELL, borderBottom: B_CELL, display: "grid", gridTemplateColumns: "1fr 90px 80px", alignItems: "center", gap: 8 }}>
                                <span style={{ color: "#4B5563", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Style / Color</span>
                                <span style={{ color: "#4B5563", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Line Status</span>
                                <span style={{ color: "#4B5563", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Delivery</span>
                              </div>
                              {phases.map((phase, pi) => {
                                const isLast = pi === phases.length - 1;
                                return (
                                  <React.Fragment key={phase}>
                                    <span style={{ ...hdr2, background: infoBg2, ...phaseDividerHost }}><span style={phaseDividerOverlay} />Due Date</span>
                                    <span style={{ ...hdr2, background: infoBg2 }}>Status</span>
                                    <span style={{ ...hdr2, background: infoBg2 }}>Status Date</span>
                                    <span style={{ ...hdr2, background: infoBg2 }}>Days</span>
                                    <span style={{ ...hdr2, background: infoBg2, ...(isLast ? phaseDividerHost : {}) }}>
                                      {isLast && <span style={phaseDividerOverlayRight} />}📝
                                    </span>
                                  </React.Fragment>
                                );
                              })}
                            </div>

                            {/* ── One row per style/color group ──────────────── */}
                            {groups.length === 0 ? (
                              <div style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg }}>
                                <div style={{ gridColumn: "1 / 9", padding: "8px 14px", borderLeft: B_CELL, borderBottom: B_CELL, color: "#374151", fontSize: 11 }}>No line items on this PO.</div>
                                {phases.map((phase, pi) => { const isLast = pi === phases.length - 1; return (
                                  <React.Fragment key={phase}>
                                    <span style={{ borderBottom: B_CELL, background: infoBg, ...phaseDividerHost }}><span style={phaseDividerOverlay} /></span>
                                    <span style={{ borderBottom: B_CELL, background: infoBg }} /><span style={{ borderBottom: B_CELL, background: infoBg }} /><span style={{ borderBottom: B_CELL, background: infoBg }} />
                                    <span style={{ borderBottom: B_CELL, background: infoBg, ...(isLast ? phaseDividerHost : {}) }}>{isLast && <span style={phaseDividerOverlayRight} />}</span>
                                  </React.Fragment>
                                ); })}
                              </div>
                            ) : groups.map((group, gIdx) => {
                              const groupItems = group.items;
                              const varKey   = group.key; // used as variant_statuses key
                              const closed   = groupItems.every(it => isLineClosed(it));
                              const rowBg    = gIdx % 2 === 0 ? infoBg : infoBg2;
                              const totalQty = groupItems.reduce((s, it) => s + (it.QtyOrder ?? 0), 0);

                              // Aggregate line status from Xoro items
                              const lineStatuses = [...new Set(groupItems.map(it => it.StatusName || "").filter(Boolean))];
                              const lineStatus   = lineStatuses.length === 1 ? lineStatuses[0] : lineStatuses.length > 1 ? "Mixed" : "—";
                              const lineStColor  = closed ? "#EF4444" : lineStatus === "Mixed" ? "#F59E0B" : lineStatus === "—" ? "#374151" : "#10B981";

                              // Aggregate delivery date from Xoro items — normalize
                              // to YYYY-MM-DD so comparisons against ddp work.
                              const deliveries = [...new Set(groupItems.map(it => normDateISO(it.DateExpectedDelivery)).filter(Boolean))];
                              const deliveryDisplay = deliveries.length === 0 ? "—" : deliveries.length === 1 ? fmtDate(deliveries[0]) : "Mixed";

                              return (
                                <div key={gIdx} style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: rowBg }}>
                                  {/* Style/color + line status + delivery spanning 8 fixed cols */}
                                  <div style={{ gridColumn: "1 / 9", padding: "3px 14px", borderLeft: B_CELL, borderBottom: B_CELL, display: "grid", gridTemplateColumns: "1fr 90px 80px", alignItems: "center", gap: 8, opacity: closed ? 0.5 : 1 }}>
                                    <span>
                                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 10 }}>{group.key}</span>
                                      {group.desc && group.desc !== group.key && <span style={{ color: "#4B5563", fontSize: 10, marginLeft: 6 }}>{group.desc}</span>}
                                      <span style={{ color: "#2D3748", fontSize: 9, marginLeft: 8 }}>Qty: {totalQty}</span>
                                    </span>
                                    <span style={{ textAlign: "center", color: lineStColor, fontSize: 10, fontWeight: 600 }}>{lineStatus}</span>
                                    <span style={{ textAlign: "center", color: "#9CA3AF", fontSize: 10 }}>{deliveryDisplay}</span>
                                  </div>
                                  {/* Phase sub-cells using varKey for variant_statuses */}
                                  {phases.map((phase, pi) => {
                                    const m = phaseMap.get(phase);
                                    const isLast = pi === phases.length - 1;
                                    if (!m) {
                                      return (
                                        <React.Fragment key={phase}>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...phaseDividerHost }}><span style={phaseDividerOverlay} />—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B" }}>—</span>
                                          <span style={{ ...sub, justifyContent: "center", color: "#1E293B", ...(isLast ? phaseDividerHost : {}) }}>{isLast && <span style={phaseDividerOverlayRight} />}—</span>
                                        </React.Fragment>
                                      );
                                    }
                                    const vs             = m.variant_statuses?.[varKey];
                                    const itemStatus     = vs?.status ?? m.status;
                                    const itemStatusDate = vs?.status_date ?? ((m.status_dates || {})[m.status] || m.status_date || "");
                                    const itemColor      = MILESTONE_STATUS_COLORS[itemStatus] || "#6B7280";
                                    // When a line item has its own delivery date, compute
                                    // phase dates from THAT date instead of the PO header DDP.
                                    const lineDDP = deliveries.length === 1 ? deliveries[0] : "";
                                    const lineExpected = (() => {
                                      if (!lineDDP || lineDDP === ddp) return m.expected_date;
                                      const d = new Date(lineDDP + "T00:00:00");
                                      if (isNaN(d.getTime())) return m.expected_date;
                                      d.setDate(d.getDate() - (m.days_before_ddp ?? 0));
                                      return d.toISOString().slice(0, 10);
                                    })();
                                    const daysRem        = lineExpected ? Math.ceil((new Date(lineExpected + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
                                    const dClr           = itemStatus === "Complete" ? "#10B981" : itemStatus === "N/A" ? "#6B7280" : daysRem === null ? "#6B7280" : daysRem < 0 ? "#EF4444" : daysRem <= 7 ? "#F59E0B" : "#10B981";
                                    const dTxt           = itemStatus === "Complete" ? "Done" : itemStatus === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)} late` : daysRem === 0 ? "Today" : `${daysRem}`;
                                    return (
                                      <React.Fragment key={phase}>
                                        <span style={{ ...sub, padding: 2, justifyContent: "center", ...phaseDividerHost }}>
                                          <span style={phaseDividerOverlay} />
                                          <span
                                            style={{ color: lineExpected !== m.expected_date ? "#F59E0B" : "#9CA3AF", fontSize: 10, fontFamily: "monospace", textAlign: "center", width: "100%" }}
                                            title={lineExpected !== m.expected_date ? `Based on line delivery ${fmtDate(lineDDP)} (PO DDP: ${fmtDate(ddp)})` : ""}
                                          >
                                            {lineExpected ? fmtDate(lineExpected) : "—"}
                                          </span>
                                        </span>
                                        <span style={{ ...sub, padding: 2 }}>
                                          <select
                                            value={itemStatus}
                                            onChange={e => {
                                              if (closed) return;
                                              const iso = new Date().toISOString().split("T")[0];
                                              const vsNew = { ...(m.variant_statuses || {}) };
                                              const prev  = vsNew[varKey];
                                              vsNew[varKey] = { status: e.target.value, status_date: e.target.value !== "Not Started" ? (prev?.status_date || iso) : null };
                                              saveMilestone({ ...m, variant_statuses: vsNew, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                            }}
                                            disabled={closed}
                                            style={{ background: "transparent", border: "none", color: closed ? "#374151" : itemColor, fontSize: 10, padding: "2px 4px", width: "100%", fontWeight: 600, outline: "none", cursor: closed ? "default" : "pointer" }}
                                          >
                                            {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s], background: "#0F172A" }}>{s}</option>)}
                                          </select>
                                        </span>
                                        <span style={{ ...sub, padding: 2 }}>
                                          <MilestoneDateInput
                                            value={itemStatusDate}
                                            onCommit={v => {
                                              const val = v || null;
                                              const vsNew = { ...(m.variant_statuses || {}) };
                                              const prev  = vsNew[varKey];
                                              vsNew[varKey] = { status: prev?.status ?? itemStatus, status_date: val };
                                              saveMilestone({ ...m, variant_statuses: vsNew, updated_at: new Date().toISOString(), updated_by: user?.name || "" }, true);
                                            }}
                                            style={{ background: "transparent", border: "1px solid #334155", borderRadius: 3, color: itemStatusDate ? "#60A5FA" : "#334155", fontSize: 10, padding: "2px 5px", width: "100%", boxSizing: "border-box", cursor: "pointer" } as React.CSSProperties}
                                          />
                                        </span>
                                        <span style={{ ...sub, justifyContent: "center", color: dClr, fontWeight: 700 }}>{dTxt}</span>
                                        {/* Per-line-item notes — stored in variant_notes[varKey] */}
                                        {(() => {
                                          const vnEntries = m.variant_notes?.[varKey] || [];
                                          const vnCount = vnEntries.length;
                                          const vnHas = vnCount > 0;
                                          return (
                                            <span
                                              style={{ ...sub, justifyContent: "center", cursor: "pointer", padding: 2, ...(isLast ? phaseDividerHost : {}) }}
                                              onClick={() => setNotesModal({ po, ms: poMs, filterPhase: phase, filterVariant: varKey })}
                                              title={vnHas ? `${vnCount} note${vnCount !== 1 ? "s" : ""} for ${varKey} — click to view/add` : `Add note for ${varKey} · ${phase}`}
                                            >
                                              {isLast && <span style={phaseDividerOverlayRight} />}
                                              <span style={{ fontSize: 10, color: vnHas ? "#60A5FA" : "#374151" }}>
                                                {vnHas ? `📝${vnCount}` : "📝"}
                                              </span>
                                            </span>
                                          );
                                        })()}
                                      </React.Fragment>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </>
                        ) : (
                          /* ── MATRIX VIEW — read-only, full size breakdown ── */
                          <div style={{ display: "grid", gridTemplateColumns: ct, minWidth: "fit-content", background: infoBg }}>
                            <div style={{ gridColumn: `1 / ${8 + phases.length * 5 + 1}`, borderLeft: B_CELL, borderBottom: B_CELL, padding: "12px 14px", overflowX: "auto" }}>
                              {allItems.length === 0 ? (
                                <div style={{ color: "#374151", fontSize: 12 }}>No line items on this PO.</div>
                              ) : hasSizes ? (
                                /* Style/Color × Size matrix */
                                <table style={{ borderCollapse: "collapse", fontSize: 10 }}>
                                  <thead>
                                    <tr style={{ background: "#0F172A" }}>
                                      <th style={{ padding: "5px 10px", color: "#94A3B8", fontWeight: 700, textAlign: "left", borderBottom: "2px solid #334155", borderRight: "2px solid #334155", position: "sticky", left: 0, background: "#0F172A", zIndex: 2, minWidth: 180, whiteSpace: "nowrap" }}>Style / Color</th>
                                      {sortedSizes.map(sz => (
                                        <th key={sz} style={{ padding: "4px 8px", color: "#C4B5FD", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 90, fontSize: 10, whiteSpace: "nowrap" }}>{sz}</th>
                                      ))}
                                      <th style={{ padding: "4px 8px", color: "#10B981", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 90, whiteSpace: "nowrap" }}>Line Status</th>
                                      <th style={{ padding: "4px 8px", color: "#94A3B8", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 60 }}>Total Qty</th>
                                      <th style={{ padding: "4px 8px", color: "#94A3B8", fontWeight: 700, textAlign: "center", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 80, whiteSpace: "nowrap" }}>Delivery</th>
                                      <th style={{ padding: "4px 8px", color: "#F59E0B", fontWeight: 700, textAlign: "right", borderBottom: "2px solid #334155", borderRight: "1px solid #1E293B", minWidth: 70, whiteSpace: "nowrap" }}>Unit Cost</th>
                                      <th style={{ padding: "4px 8px", color: "#F59E0B", fontWeight: 700, textAlign: "right", borderBottom: "2px solid #334155", minWidth: 90, whiteSpace: "nowrap" }}>Total Cost</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groups.map((group, gIdx) => {
                                      const rowBg = gIdx % 2 === 0 ? "#080F1A" : "#060C16";
                                      const closed = group.items.every(it => isLineClosed(it));
                                      const totalQty = group.items.reduce((s, it) => s + (it.QtyOrder ?? 0), 0);
                                      // Map size → item
                                      const sizeMap = new Map<string, typeof allItems[0]>();
                                      group.items.forEach(it => { const sz = itemSizeLabel(it.ItemNumber || ""); if (sz) sizeMap.set(sz, it); });
                                      // Delivery date
                                      const delivs = [...new Set(group.items.map(it => normDateISO(it.DateExpectedDelivery)).filter(Boolean))];
                                      const delivDisplay = delivs.length === 0 ? "—" : delivs.length === 1 ? fmtDate(delivs[0]) : "Mixed";
                                      return (
                                        <tr key={gIdx} style={{ background: rowBg }}>
                                          <td style={{ padding: "5px 10px", borderRight: "2px solid #334155", borderBottom: "1px solid #1E293B", position: "sticky", left: 0, background: rowBg, zIndex: 1 }}>
                                            <div style={{ color: closed ? "#374151" : "#D1D5DB", fontWeight: 600, fontSize: 11 }}>{group.desc || group.key}</div>
                                            <div style={{ color: "#2D3748", fontSize: 9, fontFamily: "monospace" }}>{group.key !== group.desc ? group.key : ""}</div>
                                          </td>
                                          {sortedSizes.map(sz => {
                                            const it = sizeMap.get(sz);
                                            if (!it) return <td key={sz} style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: "#1E293B" }}>—</td>;
                                            return (
                                              <td key={sz} style={{ padding: "4px 6px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center" }}>
                                                <div style={{ color: "#9CA3AF", fontWeight: 700, fontSize: 11 }}>{it.QtyOrder ?? "—"}</div>
                                              </td>
                                            );
                                          })}
                                          {(() => {
                                            const statuses = [...new Set(group.items.map(it => it.StatusName || "").filter(Boolean))];
                                            const lineStatus = statuses.length === 0 ? "—" : statuses.length === 1 ? statuses[0] : "Mixed";
                                            const lineStColor = closed ? "#374151" : lineStatus === "Closed" || lineStatus === "Cancelled" ? "#EF4444" : lineStatus === "Mixed" ? "#F59E0B" : "#10B981";
                                            const activeItems = group.items.filter(it => !isLineClosed(it));
                                            const prices = [...new Set(activeItems.map(it => it.UnitPrice ?? 0))];
                                            const currency = po.CurrencyCode || "USD";
                                            const unitCostDisplay = activeItems.length === 0 ? "—" : prices.length === 1 ? fmtCurrency(prices[0], currency) : "Mixed";
                                            const totalCost = activeItems.reduce((s, it) => s + (it.QtyOrder ?? 0) * (it.UnitPrice ?? 0), 0);
                                            const totalCostDisplay = activeItems.length === 0 ? "—" : fmtCurrency(totalCost, currency);
                                            return (
                                              <>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: lineStColor, fontWeight: 600, fontSize: 10 }}>{lineStatus}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: "#9CA3AF", fontWeight: 700 }}>{totalQty}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "center", color: "#9CA3AF", fontSize: 10 }}>{delivDisplay}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", borderRight: "1px solid #0F172A", textAlign: "right", color: closed ? "#374151" : "#F59E0B", fontSize: 10 }}>{unitCostDisplay}</td>
                                                <td style={{ padding: "4px 8px", borderBottom: "1px solid #1E293B", textAlign: "right", color: closed ? "#374151" : "#F59E0B", fontWeight: 700, fontSize: 10 }}>{totalCostDisplay}</td>
                                              </>
                                            );
                                          })()}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              ) : (
                                /* No sizes detected — flat item list with status + delivery */
                                <table style={{ borderCollapse: "collapse", fontSize: 10, width: "100%" }}>
                                  <thead>
                                    <tr style={{ background: "#0F172A" }}>
                                      {["Item #", "Description", "Qty Ordered", "Qty Received", "Qty Remaining", "Line Status", "Delivery Date"].map(h => (
                                        <th key={h} style={{ padding: "5px 8px", color: "#6B7280", fontWeight: 700, textAlign: "left", borderBottom: "2px solid #1E293B", whiteSpace: "nowrap" }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {allItems.map((item, idx) => {
                                      const itClosed = isLineClosed(item);
                                      const stColor  = itClosed ? "#EF4444" : "#10B981";
                                      return (
                                        <tr key={idx} style={{ background: idx % 2 === 0 ? "#080F1A" : "#060C16", borderBottom: "1px solid #0D1929" }}>
                                          <td style={{ padding: "4px 8px", color: "#60A5FA", fontFamily: "monospace", opacity: itClosed ? 0.4 : 1 }}>{item.ItemNumber || "—"}</td>
                                          <td style={{ padding: "4px 8px", color: "#D1D5DB", opacity: itClosed ? 0.4 : 1 }}>{item.Description || "—"}</td>
                                          <td style={{ padding: "4px 8px", color: "#9CA3AF", textAlign: "right" }}>{item.QtyOrder ?? "—"}</td>
                                          <td style={{ padding: "4px 8px", color: (item.QtyReceived ?? 0) > 0 ? "#10B981" : "#4B5563", textAlign: "right" }}>{item.QtyReceived ?? 0}</td>
                                          <td style={{ padding: "4px 8px", color: "#9CA3AF", textAlign: "right" }}>{item.QtyRemaining ?? "—"}</td>
                                          <td style={{ padding: "4px 8px", color: stColor, fontWeight: 600 }}>{item.StatusName || "—"}</td>
                                          <td style={{ padding: "4px 8px", color: "#9CA3AF" }}>{fmtDate(item.DateExpectedDelivery) || "—"}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── DDP change confirmation modal ────────────────────────────────── */}
      {ddpChangeModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1010, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setDDPChangeModal(null)}
        >
          <div
            style={{ background: "#0F172A", border: "1px solid #F97316", borderRadius: 10, width: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #1E293B", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, color: "#F97316", fontSize: 15, fontWeight: 700 }}>⚠ DDP Date Will Change</h2>
              <button onClick={() => setDDPChangeModal(null)} style={{ background: "none", border: "none", color: "#6B7280", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <p style={{ color: "#D1D5DB", fontSize: 13, margin: "0 0 12px" }}>
                Changing <strong style={{ color: "#C4B5FD" }}>{ddpChangeModal.triggerMs.phase}</strong> date
                will shift the DDP from{" "}
                <strong style={{ color: "#9CA3AF" }}>{fmtDate(ddpChangeModal.oldDDP)}</strong> to{" "}
                <strong style={{ color: "#F97316" }}>{fmtDate(ddpChangeModal.newDDP)}</strong>.
              </p>
              <p style={{ color: "#6B7280", fontSize: 12, margin: "0 0 16px" }}>
                All other phase dates will recalculate from the new DDP. A note will be added automatically.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  style={{ ...S.btnSecondary, flex: 1 }}
                  onClick={() => setDDPChangeModal(null)}
                >
                  Cancel — keep original dates
                </button>
                <button
                  style={{ background: "#F97316", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, padding: "10px 16px", cursor: "pointer", flex: 2 }}
                  onClick={handleDDPConfirm}
                >
                  Accept — update DDP &amp; all phases
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Notes modal ───────────────────────────────────────────────────── */}
      {notesModal && (
        <NotesModal
          key={`${notesModal.po.PoNumber ?? ""}::${notesModal.filterPhase ?? "_all"}::${notesModal.filterVariant ?? "_po"}`}
          po={notesModal.po}
          ms={milestones[notesModal.po.PoNumber ?? ""] || []}
          filterPhase={notesModal.filterPhase}
          filterVariant={notesModal.filterVariant}
          onClose={() => setNotesModal(null)}
          onAddNote={addNote}
          onEditNote={editNote}
          onDeleteNote={deleteNote}
          onAddVariantNote={addVariantNote}
          onEditVariantNote={editVariantNote}
          onDeleteVariantNote={deleteVariantNote}
        />
      )}

    </div>
  );
}
