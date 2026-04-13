import "../../store/__tests__/setup";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useTandaStore } from "../../store/index";
import { useNotesOps } from "../useNotesOps";

// ── Helpers ─────────────────────────────────────────────────────────────────

const initialState = useTandaStore.getState();

function resetStore() {
  useTandaStore.setState(initialState, true);
}

/** Build a successful JSON Response */
function jsonOk(body: any): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** Build a DELETE-style response (no body needed) */
function deleteOk(): Response {
  return { ok: true, status: 204, json: () => Promise.resolve(null) } as unknown as Response;
}

function makeOps(overrides: Partial<Parameters<typeof useNotesOps>[0]> = {}) {
  const opts = {
    loadNotes: vi.fn().mockResolvedValue(undefined),
    getNewNote: vi.fn().mockReturnValue("test note"),
    setNewNote: vi.fn(),
    getSelected: vi.fn().mockReturnValue({ PoNumber: "PO-100" }),
    setSelected: vi.fn(),
    ...overrides,
  };
  const ops = useNotesOps(opts);
  return { ops, opts };
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetStore();
  vi.restoreAllMocks();
  // Set a user in the store
  useTandaStore.getState().setCoreField("user", { id: "u1", name: "Tester", email: "t@t.com" } as any);
  // Default: all fetches succeed with empty array
  global.fetch = vi.fn().mockResolvedValue(jsonOk([]));
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("useNotesOps", () => {
  // ── addNote ─────────────────────────────────────────────────────────────
  describe("addNote", () => {
    it("creates a note in Supabase and calls loadNotes", async () => {
      const { ops, opts } = makeOps();
      await ops.addNote();
      // addNote fires addHistory without await — flush microtasks
      await vi.waitFor(() => expect(opts.loadNotes).toHaveBeenCalled());

      expect(opts.setNewNote).toHaveBeenCalledWith("");
      // At least 2 fetch calls: note insert + history insert
      expect((global.fetch as Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
      // First fetch should be an insert to tanda_notes
      const firstCall = (global.fetch as Mock).mock.calls[0];
      expect(firstCall[0]).toContain("tanda_notes");
      expect(firstCall[1].method).toBe("POST");
      const body = JSON.parse(firstCall[1].body);
      expect(body[0].note).toBe("test note");
      expect(body[0].po_number).toBe("PO-100");
    });

    it("does nothing when note text is empty", async () => {
      const { ops, opts } = makeOps({ getNewNote: vi.fn().mockReturnValue("   ") });
      await ops.addNote();
      expect(opts.loadNotes).not.toHaveBeenCalled();
    });

    it("does nothing when no PO is selected", async () => {
      const { ops, opts } = makeOps({ getSelected: vi.fn().mockReturnValue(null) });
      await ops.addNote();
      expect(opts.loadNotes).not.toHaveBeenCalled();
    });
  });

  // ── editNote ────────────────────────────────────────────────────────────
  describe("editNote", () => {
    it("PATCHes the note text in Supabase", async () => {
      const { ops, opts } = makeOps();
      await ops.editNote("note-1", "updated text");

      const patchCall = (global.fetch as Mock).mock.calls.find(
        (c: any[]) => c[1]?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain("id=eq.note-1");
      expect(JSON.parse(patchCall![1].body).note).toBe("updated text");
      expect(opts.loadNotes).toHaveBeenCalled();
    });

    it("does nothing when text is blank", async () => {
      const { ops, opts } = makeOps();
      await ops.editNote("note-1", "  ");
      expect(opts.loadNotes).not.toHaveBeenCalled();
    });
  });

  // ── deleteNote ──────────────────────────────────────────────────────────
  describe("deleteNote", () => {
    it("sends DELETE to Supabase and reloads notes", async () => {
      (global.fetch as Mock).mockResolvedValue(deleteOk());
      const { ops, opts } = makeOps();
      await ops.deleteNote("note-2");

      const delCall = (global.fetch as Mock).mock.calls.find(
        (c: any[]) => c[1]?.method === "DELETE"
      );
      expect(delCall).toBeDefined();
      expect(delCall![0]).toContain("id=eq.note-2");
      expect(opts.loadNotes).toHaveBeenCalled();
    });
  });

  // ── addHistory ──────────────────────────────────────────────────────────
  describe("addHistory", () => {
    it("creates a history entry with __history__ status", async () => {
      const { ops, opts } = makeOps();
      await ops.addHistory("PO-100", "something happened");

      const insertCall = (global.fetch as Mock).mock.calls.find(
        (c: any[]) => c[1]?.method === "POST" && c[0]?.includes("tanda_notes")
      );
      expect(insertCall).toBeDefined();
      const body = JSON.parse(insertCall![1].body);
      expect(body[0].status_override).toBe("__history__");
      expect(body[0].note).toBe("something happened");
      expect(body[0].po_number).toBe("PO-100");
      expect(opts.loadNotes).toHaveBeenCalled();
    });

    it("does nothing for empty poNumber", async () => {
      const { ops, opts } = makeOps();
      await ops.addHistory("", "something");
      expect(opts.loadNotes).not.toHaveBeenCalled();
    });
  });

  // ── uploadAttachment ────────────────────────────────────────────────────
  describe("uploadAttachment", () => {
    it("uploads to Dropbox proxy then creates Supabase record", async () => {
      const dropboxResponse = jsonOk({ shared_url: "https://dbx.link/file", path_display: "/some/path" });
      const supabaseResponse = jsonOk([{ id: "row-1" }]);

      (global.fetch as Mock)
        .mockResolvedValueOnce(dropboxResponse)   // dropbox upload
        .mockResolvedValueOnce(supabaseResponse);  // supabase insert

      const { ops } = makeOps();
      const file = new File(["hello"], "test.pdf", { type: "application/pdf" });
      await ops.uploadAttachment("PO-100", file);

      const calls = (global.fetch as Mock).mock.calls;
      // First call: Dropbox proxy
      expect(calls[0][0]).toBe("/api/dropbox-proxy");
      expect(calls[0][1].method).toBe("POST");
      expect(calls[0][1].headers["X-Dropbox-Action"]).toBe("upload");
      // Second call: Supabase insert
      expect(calls[1][0]).toContain("tanda_notes");
      const sbBody = JSON.parse(calls[1][1].body);
      expect(sbBody[0].status_override).toBe("__attachment__");
      expect(sbBody[0].po_number).toBe("PO-100");
    });

    it("throws when Dropbox upload fails", async () => {
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false, status: 500, json: () => Promise.resolve({ error: "fail" }),
      } as unknown as Response);

      const { ops } = makeOps();
      const file = new File(["x"], "bad.pdf", { type: "application/pdf" });
      await expect(ops.uploadAttachment("PO-100", file)).rejects.toThrow("Upload failed: 500");
    });
  });

  // ── loadAttachments ─────────────────────────────────────────────────────
  describe("loadAttachments", () => {
    it("fetches attachment notes and stores parsed entries in store", async () => {
      const entry = { id: "att-1", name: "file.pdf", url: "https://link" };
      (global.fetch as Mock).mockResolvedValueOnce(
        jsonOk([{ note: JSON.stringify(entry) }])
      );

      const { ops } = makeOps();
      await ops.loadAttachments("PO-200");

      const attachments = useTandaStore.getState().attachments;
      expect(attachments["PO-200"]).toEqual([entry]);
    });

    it("handles invalid JSON in notes gracefully", async () => {
      (global.fetch as Mock).mockResolvedValueOnce(
        jsonOk([{ note: "not-json" }, { note: JSON.stringify({ id: "ok" }) }])
      );

      const { ops } = makeOps();
      await ops.loadAttachments("PO-200");

      const attachments = useTandaStore.getState().attachments;
      expect(attachments["PO-200"]).toEqual([{ id: "ok" }]);
    });
  });

  // ── deleteAttachment ────────────────────────────────────────────────────
  describe("deleteAttachment", () => {
    it("soft-deletes by adding deleted_at timestamp", async () => {
      const entry = { id: "att-1", name: "file.pdf", url: "u", uploaded_by: "Tester", uploaded_at: "2025-01-01" };
      // Pre-populate store
      useTandaStore.getState().setAttachmentsForPo("PO-300", [entry] as any);

      // select returns the DB row, upsert succeeds
      (global.fetch as Mock)
        .mockResolvedValueOnce(jsonOk([{ id: "row-1", note: JSON.stringify(entry) }]))  // select
        .mockResolvedValueOnce(jsonOk([{ id: "row-1" }]))  // upsert
        .mockResolvedValue(jsonOk([])); // any subsequent (loadNotes, addHistory)

      const { ops } = makeOps();
      await ops.deleteAttachment("PO-300", "att-1");

      const updated = useTandaStore.getState().attachments["PO-300"][0];
      expect(updated.deleted_at).toBeDefined();
      expect(typeof updated.deleted_at).toBe("string");
    });

    it("does nothing when attachment not found in store", async () => {
      useTandaStore.getState().setAttachmentsForPo("PO-300", []);
      const { ops } = makeOps();
      await ops.deleteAttachment("PO-300", "nonexistent");
      expect((global.fetch as Mock)).not.toHaveBeenCalled();
    });
  });

  // ── undoDeleteAttachment ────────────────────────────────────────────────
  describe("undoDeleteAttachment", () => {
    it("restores deleted_at to null/undefined", async () => {
      const entry = { id: "att-2", name: "file2.pdf", url: "u", uploaded_by: "Tester", uploaded_at: "2025-01-01", deleted_at: "2025-06-01" };
      useTandaStore.getState().setAttachmentsForPo("PO-400", [entry] as any);

      (global.fetch as Mock)
        .mockResolvedValueOnce(jsonOk([{ id: "row-2", note: JSON.stringify(entry) }]))  // select
        .mockResolvedValueOnce(jsonOk([{ id: "row-2" }]))  // upsert
        .mockResolvedValue(jsonOk([])); // subsequent calls

      const { ops } = makeOps();
      await ops.undoDeleteAttachment("PO-400", "att-2");

      const restored = useTandaStore.getState().attachments["PO-400"][0];
      expect(restored.deleted_at).toBeUndefined();
    });
  });

  // ── deletePO ────────────────────────────────────────────────────────────
  describe("deletePO", () => {
    it("removes PO, milestones, notes from Supabase and store", async () => {
      // Set up store with PO data
      useTandaStore.getState().setCoreField("pos", [{ PoNumber: "PO-500", VendorName: "V" }] as any);
      useTandaStore.getState().setCoreField("milestones", {
        "PO-500": [{ id: "ms-1", po_number: "PO-500" }],
      } as any);
      useTandaStore.getState().setCoreField("notes", [
        { id: "n-1", po_number: "PO-500", note: "hi" },
      ] as any);

      (global.fetch as Mock).mockResolvedValue(deleteOk());

      const selected = { PoNumber: "PO-500" };
      const { ops, opts } = makeOps({ getSelected: vi.fn().mockReturnValue(selected) });
      await ops.deletePO("PO-500");

      // Should have called DELETE for tanda_pos, tanda_milestones, tanda_notes
      const delCalls = (global.fetch as Mock).mock.calls.filter(
        (c: any[]) => c[1]?.method === "DELETE"
      );
      expect(delCalls.length).toBeGreaterThanOrEqual(3);

      // Store should have PO removed
      const state = useTandaStore.getState();
      expect(state.pos).toEqual([]);
      // Selected should be cleared
      expect(opts.setSelected).toHaveBeenCalledWith(null);
    });

    it("does nothing for empty poNumber", async () => {
      const { ops } = makeOps();
      await ops.deletePO("");
      expect((global.fetch as Mock)).not.toHaveBeenCalled();
    });
  });
});
