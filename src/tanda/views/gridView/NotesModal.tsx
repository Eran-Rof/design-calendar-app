// Self-contained notes modal extracted from GridView.tsx. Owns its
// own state (noteText, addPhase, editing) — the parent grid just
// passes the PO + milestones + add/edit/delete callbacks and waits
// for onClose.

import { useEffect, useState } from "react";
import type { XoroPO, Milestone } from "../../../utils/tandaTypes";
import { fmtDateDisplay } from "../../../utils/tandaTypes";
import SearchableSelect from "../../components/SearchableSelect";

export interface NotesModalProps {
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

export function NotesModal({ po, ms, filterPhase, filterVariant, onClose, onAddNote, onEditNote, onDeleteNote, onAddVariantNote, onEditVariantNote, onDeleteVariantNote }: NotesModalProps) {
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
  // modal (no filterPhase, no filterVariant) so the row-level notes icon includes them.
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
        style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 10, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.6)" }}
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
                                  >✎</button>
                                  <button
                                    onClick={() => handleDelete(i)}
                                    title="Delete note"
                                    style={{ background: "#2A1A1A", border: "1px solid #4B2020", color: "#F87171", cursor: "pointer", fontSize: 12, padding: "2px 7px", borderRadius: 4, lineHeight: 1, fontWeight: 600 }}
                                    onMouseEnter={e => { e.currentTarget.style.background = "#3D1515"; e.currentTarget.style.color = "#EF4444"; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = "#2A1A1A"; e.currentTarget.style.color = "#F87171"; }}
                                  >✕</button>
                                </div>
                              </div>
                              <div style={{ color: "#4B5563", fontSize: 10, marginTop: 4 }}>{ne.user} · {fmtDateDisplay(ne.date)}</div>
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
                    <span style={{ color: "#60A5FA" }}>{vn.variant}</span> · {vn.phase} · {vn.user} · {fmtDateDisplay(vn.date)}
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
            <div style={{ marginBottom: 8 }}>
              <SearchableSelect
                value={addPhase || null}
                onChange={v => setAddPhase(v)}
                options={availableMs.map(m => ({ value: m.phase, label: m.phase }))}
                inputStyle={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, color: "#D1D5DB", fontSize: 11, padding: "5px 8px", boxSizing: "border-box", outline: "none" }}
              />
            </div>
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
