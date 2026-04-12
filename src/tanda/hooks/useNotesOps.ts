import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { useTandaStore } from "../store/index";

// ── Supabase helpers (mirrors the module-level `sb` in TandA.tsx) ──
const sb = {
  from: (table: string) => ({
    select: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    insert: async (rows: any) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: SB_HEADERS, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    upsert: async (rows: any, opts?: { onConflict?: string }) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const url = `${SB_URL}/rest/v1/${table}${opts?.onConflict ? `?on_conflict=${opts.onConflict}` : ""}`;
      const res = await fetch(url, { method: "POST", headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    delete: async (filter: string) => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: SB_HEADERS });
      return { error: res.ok ? null : await res.json() };
    },
  }),
};

interface UseNotesOpsOpts {
  loadNotes: () => Promise<void>;
  getNewNote: () => string;
  setNewNote: (v: string) => void;
  getSelected: () => any;
  setSelected: (v: any) => void;
}

export function useNotesOps(opts: UseNotesOpsOpts) {
  const { loadNotes, getNewNote, setNewNote, getSelected, setSelected } = opts;

  const getUser = () => useTandaStore.getState().user;
  const store = {
    setAttachmentsForPo: useTandaStore.getState().setAttachmentsForPo,
    updateAttachment: useTandaStore.getState().updateAttachment,
    removePo: useTandaStore.getState().removePo,
  };

  async function addHistory(poNumber: string, description: string) {
    if (!poNumber) return;
    const user = getUser();
    await sb.from("tanda_notes").insert({
      po_number: poNumber,
      note: description,
      status_override: "__history__",
      user_name: user?.name || "System",
      created_at: new Date().toISOString(),
    });
    await loadNotes();
  }

  async function addNote() {
    const newNote = getNewNote();
    const selected = getSelected();
    const user = getUser();
    if (!newNote.trim() || !selected || !user) return;
    const noteText = newNote.trim();
    await sb.from("tanda_notes").insert({
      po_number: selected.PoNumber,
      note: noteText,
      status_override: null,
      user_name: user.name,
      created_at: new Date().toISOString(),
    });
    setNewNote("");
    addHistory(selected.PoNumber ?? "", `Note added: "${noteText.length > 80 ? noteText.slice(0, 80) + "\u2026" : noteText}"`);
  }

  async function editNote(noteId: string, newText: string) {
    if (!newText.trim()) return;
    await fetch(`${SB_URL}/rest/v1/tanda_notes?id=eq.${encodeURIComponent(noteId)}`, {
      method: "PATCH", headers: { ...SB_HEADERS, "Prefer": "return=minimal" },
      body: JSON.stringify({ note: newText.trim() }),
    });
    await loadNotes();
  }

  async function deleteNote(noteId: string) {
    await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(noteId)}`);
    await loadNotes();
  }

  // ── Attachments (Dropbox) ────────────────────────────────────────────────
  async function uploadAttachment(poNumber: string, file: File) {
    const user = getUser();
    const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const dbxPath = `/Eran Bitton/Apps/design-calendar-app/po-attachments/${poNumber}/${safeName}`;
    const res = await fetch("/api/dropbox-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Dropbox-Action": "upload", "X-Dropbox-Path": dbxPath },
      body: file,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    const url = data.shared_url || "";
    const entry = { id: safeName, name: file.name, url, dbxPath: data.path_display || dbxPath, type: file.type, size: file.size, uploaded_by: user?.name || "", uploaded_at: new Date().toISOString() };
    await sb.from("tanda_notes").insert({ po_number: poNumber, note: JSON.stringify(entry), status_override: "__attachment__", user_name: user?.name || "", created_at: new Date().toISOString() });
  }

  async function loadAttachments(poNumber: string) {
    const { data } = await sb.from("tanda_notes").select("*", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (data) {
      const entries = data.map((r: any) => { try { return JSON.parse(r.note); } catch { return null; } }).filter(Boolean);
      useTandaStore.getState().setAttachmentsForPo(poNumber, entries);
    }
  }

  async function deleteAttachment(poNumber: string, attachId: string) {
    const attachments = useTandaStore.getState().attachments;
    const entry = (attachments[poNumber] || []).find(a => a.id === attachId);
    if (!entry) return;
    // Soft delete: mark as deleted with timestamp, don't remove from Dropbox yet
    const updatedEntry = { ...entry, deleted_at: new Date().toISOString() };
    // Update metadata in Supabase
    const { data, error: selErr } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (selErr) {
      console.warn("deleteAttachment: failed to load attachment rows", selErr);
      await loadAttachments(poNumber);
      return;
    }
    const row = data?.find((r: any) => { try { return JSON.parse(r.note).id === attachId; } catch { return false; } });
    if (!row) {
      // Row was deleted by another user (or never persisted) — refresh and bail
      console.warn(`deleteAttachment: attachment ${attachId} not found in DB for ${poNumber}; refreshing local state`);
      await loadAttachments(poNumber);
      return;
    }
    const { error: upErr } = await sb.from("tanda_notes").upsert({ id: row.id, po_number: poNumber, note: JSON.stringify(updatedEntry), status_override: "__attachment__", user_name: entry.uploaded_by, created_at: entry.uploaded_at }, { onConflict: "id" });
    if (upErr) {
      console.warn("deleteAttachment: upsert failed", upErr);
      await loadAttachments(poNumber);
      return;
    }
    useTandaStore.getState().updateAttachment(poNumber, attachId, updatedEntry);
    addHistory(poNumber, `Attachment soft-deleted: ${entry.name} (undo available for 24h)`);
  }

  async function undoDeleteAttachment(poNumber: string, attachId: string) {
    const attachments = useTandaStore.getState().attachments;
    const entry = (attachments[poNumber] || []).find(a => a.id === attachId);
    if (!entry) return;
    const restoredEntry = { ...entry }; delete (restoredEntry as any).deleted_at;
    const { data } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    const row = data?.find((r: any) => { try { return JSON.parse(r.note).id === attachId; } catch { return false; } });
    if (row) {
      await sb.from("tanda_notes").upsert({ id: row.id, po_number: poNumber, note: JSON.stringify(restoredEntry), status_override: "__attachment__", user_name: entry.uploaded_by, created_at: entry.uploaded_at }, { onConflict: "id" });
    }
    useTandaStore.getState().updateAttachment(poNumber, attachId, restoredEntry);
    addHistory(poNumber, `Attachment restored: ${entry.name}`);
  }

  async function purgeExpiredAttachments(poNumber: string) {
    const attachments = useTandaStore.getState().attachments;
    const files = attachments[poNumber] || [];
    const now = Date.now();
    const expired = files.filter((f: any) =>
      f.deleted_at && now - new Date(f.deleted_at).getTime() > 24 * 60 * 60 * 1000
    );
    if (expired.length === 0) return;

    // Fetch attachment rows ONCE up front, build an id→row.id map.
    const { data: rows, error: selErr } = await sb.from("tanda_notes").select("id,note", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (selErr) {
      console.warn("purgeExpiredAttachments: failed to load rows", selErr);
      return;
    }
    const attachIdToRowId = new Map<string, string>();
    (rows ?? []).forEach((r: any) => {
      try { attachIdToRowId.set(JSON.parse(r.note).id, r.id); } catch {}
    });

    // Delete each expired attachment from Dropbox + DB.
    for (const f of expired) {
      const dbxPath = (f as any).dbxPath || `/Eran Bitton/Apps/design-calendar-app/po-attachments/${poNumber}/${f.id}`;
      try {
        await fetch(`/api/dropbox-proxy?action=delete&path=${encodeURIComponent(dbxPath)}`);
      } catch (e) {
        console.warn(`Dropbox purge failed for ${f.id}:`, e);
        addHistory(poNumber, `Warning: failed to purge Dropbox file for ${f.name}`);
      }
      const rowId = attachIdToRowId.get(f.id);
      if (rowId) {
        const { error: delErr } = await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(rowId)}`);
        if (delErr) console.warn(`DB purge failed for ${f.id}:`, delErr);
      }
    }

    // Reload from Supabase to get clean state after purge
    const { data: refreshed } = await sb.from("tanda_notes").select("*", `po_number=eq.${encodeURIComponent(poNumber)}&status_override=eq.__attachment__`);
    if (refreshed) {
      const entries = refreshed.map((r: any) => { try { return JSON.parse(r.note); } catch { return null; } }).filter(Boolean);
      useTandaStore.getState().setAttachmentsForPo(poNumber, entries);
    }
  }

  async function deletePO(poNumber: string) {
    if (!poNumber) return;
    const state = useTandaStore.getState();
    const milestones = state.milestones;
    const notes = state.notes;
    // Delete from tanda_pos
    await sb.from("tanda_pos").delete(`po_number=eq.${encodeURIComponent(poNumber)}`);
    // Delete all milestones for this PO
    const poMs = milestones[poNumber] || [];
    for (const m of poMs) {
      await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
    }
    // Delete all notes and history for this PO
    const poNotes = notes.filter(n => n.po_number === poNumber);
    for (const n of poNotes) {
      if (n.id) await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(n.id)}`);
    }
    // Remove from local state — atomic via reducer
    useTandaStore.getState().removePo(poNumber);
    const selected = getSelected();
    if (selected?.PoNumber === poNumber) setSelected(null);
  }

  return {
    addNote,
    editNote,
    deleteNote,
    addHistory,
    uploadAttachment,
    loadAttachments,
    deleteAttachment,
    undoDeleteAttachment,
    purgeExpiredAttachments,
    deletePO,
  };
}
