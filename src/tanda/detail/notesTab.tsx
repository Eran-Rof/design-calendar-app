import React from "react";
import { fmtDate } from "../../utils/tandaTypes";
import S from "../styles";
import type { DetailPanelCtx } from "../detailPanel";

/**
 * Notes tab body. Lists user-authored PO notes with edit/delete and an
 * add-note input. Admins can modify any note; users can modify their own.
 */
export function NotesTab({ ctx }: { ctx: DetailPanelCtx }): React.ReactElement | null {
  const {
    selected, detailMode, user, selectedNotes, editingNoteId, setEditingNoteId,
    editingNoteText, setEditingNoteText, setConfirmModal, editNote, deleteNote,
    newNote, setNewNote, addNote,
  } = ctx;

  if (!selected) return null;
  if (!(detailMode === "notes" || detailMode === "all")) return null;

  const isAdmin = user?.role === "admin";

  return (
    <div>
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
    </div>
  );
}
