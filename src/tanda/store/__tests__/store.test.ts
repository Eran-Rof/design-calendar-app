import "./setup";
/**
 * Comprehensive tests for all 4 Zustand store slices:
 *   CoreSlice, SyncSlice, EmailSlice, TeamsSlice
 *
 * Uses the combined store exported from src/tanda/store/index.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { useTandaStore } from "../index";
import type { TandaStore } from "../index";
import type { XoroPO, Milestone, LocalNote } from "../../../utils/tandaTypes";
import type { AttachmentEntry } from "../../state/core/coreTypes";
import type { SyncLogEntry } from "../../state/sync/syncTypes";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Snapshot the full initial state so we can reset between tests. */
const initialState: TandaStore = useTandaStore.getState();

const get = () => useTandaStore.getState();

function makePO(poNumber: string): XoroPO {
  return { PoNumber: poNumber, VendorName: "TestVendor" };
}

function makeMilestone(id: string, poNumber: string): Milestone {
  return {
    id,
    po_number: poNumber,
    phase: "Design",
    category: "Review",
    sort_order: 1,
    days_before_ddp: 0,
    expected_date: "2026-05-01",
    actual_date: null,
    status: "Not Started",
    status_date: null,
    status_dates: null,
    notes: "",
    note_entries: null,
    updated_at: "2026-01-01",
    updated_by: "test",
    variant_statuses: null,
  };
}

function makeAttachment(id: string): AttachmentEntry {
  return {
    id,
    name: `file-${id}.pdf`,
    url: `https://example.com/${id}`,
    type: "application/pdf",
    size: 1024,
    uploaded_by: "user1",
    uploaded_at: "2026-01-01T00:00:00Z",
  };
}

function makeNote(poNumber: string): LocalNote {
  return {
    id: "note-1",
    po_number: poNumber,
    note: "Test note",
    created_at: "2026-01-01",
    user_name: "test",
  };
}

function makeSyncLogEntry(overrides?: Partial<SyncLogEntry>): SyncLogEntry {
  return {
    ts: "2026-01-01T00:00:00Z",
    user: "tester",
    success: true,
    added: 1,
    changed: 0,
    deleted: 0,
    ...overrides,
  };
}

// ── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  useTandaStore.setState(initialState, true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. CORE SLICE
// ═════════════════════════════════════════════════════════════════════════════

describe("CoreSlice", () => {
  // ── initial state ──────────────────────────────────────────────────────

  it("has correct initial state", () => {
    const s = get();
    expect(s.user).toBeNull();
    expect(s.pos).toEqual([]);
    expect(s.notes).toEqual([]);
    expect(s.selected).toBeNull();
    expect(s.detailMode).toBe("po");
    expect(s.attachments).toEqual({});
    expect(s.uploadingAttachment).toBe(false);
    expect(s.wipTemplates).toEqual({});
    expect(s.milestones).toEqual({});
    expect(s.dcVendors).toEqual([]);
    expect(s.designTemplates).toEqual([]);
  });

  // ── setCoreField ───────────────────────────────────────────────────────

  describe("setCoreField", () => {
    it("sets a simple field", () => {
      get().setCoreField("uploadingAttachment", true);
      expect(get().uploadingAttachment).toBe(true);
    });

    it("sets an array field", () => {
      const pos = [makePO("PO-100")];
      get().setCoreField("pos", pos);
      expect(get().pos).toEqual(pos);
    });

    it("sets field to null", () => {
      get().setCoreField("user", null);
      expect(get().user).toBeNull();
    });

    it("does not affect unrelated fields", () => {
      get().setCoreField("uploadingAttachment", true);
      expect(get().pos).toEqual([]);
      expect(get().selected).toBeNull();
    });
  });

  // ── selectPo ───────────────────────────────────────────────────────────

  describe("selectPo", () => {
    it("sets selected PO and default mode", () => {
      const po = makePO("PO-200");
      get().selectPo(po);
      expect(get().selected).toEqual(po);
      expect(get().detailMode).toBe("po");
    });

    it("sets selected PO with explicit mode", () => {
      const po = makePO("PO-201");
      get().selectPo(po, "milestones");
      expect(get().selected).toEqual(po);
      expect(get().detailMode).toBe("milestones");
    });

    it("deselects PO by passing null", () => {
      get().selectPo(makePO("PO-300"));
      get().selectPo(null);
      expect(get().selected).toBeNull();
      expect(get().detailMode).toBe("po");
    });

    it("does not affect unrelated fields", () => {
      get().selectPo(makePO("PO-400"), "email");
      expect(get().pos).toEqual([]);
      expect(get().notes).toEqual([]);
    });
  });

  // ── setMilestonesForPo ─────────────────────────────────────────────────

  describe("setMilestonesForPo", () => {
    it("sets milestones for a PO", () => {
      const ms = [makeMilestone("m1", "PO-1")];
      get().setMilestonesForPo("PO-1", ms);
      expect(get().milestones["PO-1"]).toEqual(ms);
    });

    it("replaces existing milestones", () => {
      get().setMilestonesForPo("PO-1", [makeMilestone("m1", "PO-1")]);
      const newMs = [makeMilestone("m2", "PO-1")];
      get().setMilestonesForPo("PO-1", newMs);
      expect(get().milestones["PO-1"]).toEqual(newMs);
    });

    it("sets empty array", () => {
      get().setMilestonesForPo("PO-1", []);
      expect(get().milestones["PO-1"]).toEqual([]);
    });

    it("does not affect other PO milestones", () => {
      get().setMilestonesForPo("PO-1", [makeMilestone("m1", "PO-1")]);
      get().setMilestonesForPo("PO-2", [makeMilestone("m2", "PO-2")]);
      expect(get().milestones["PO-1"]).toHaveLength(1);
      expect(get().milestones["PO-2"]).toHaveLength(1);
    });
  });

  // ── updateMilestone ────────────────────────────────────────────────────

  describe("updateMilestone", () => {
    it("updates existing milestone by id", () => {
      const m = makeMilestone("m1", "PO-1");
      get().setMilestonesForPo("PO-1", [m]);
      const updated = { ...m, phase: "Updated" };
      get().updateMilestone("PO-1", "m1", updated);
      expect(get().milestones["PO-1"][0].phase).toBe("Updated");
    });

    it("appends milestone when id not found", () => {
      get().setMilestonesForPo("PO-1", [makeMilestone("m1", "PO-1")]);
      const newM = makeMilestone("m-new", "PO-1");
      get().updateMilestone("PO-1", "m-new", newM);
      expect(get().milestones["PO-1"]).toHaveLength(2);
    });

    it("handles PO with no milestones yet", () => {
      const m = makeMilestone("m1", "PO-X");
      get().updateMilestone("PO-X", "m1", m);
      expect(get().milestones["PO-X"]).toEqual([m]);
    });

    it("does not affect milestones for other POs", () => {
      get().setMilestonesForPo("PO-A", [makeMilestone("a1", "PO-A")]);
      get().setMilestonesForPo("PO-B", [makeMilestone("b1", "PO-B")]);
      const updated = { ...makeMilestone("a1", "PO-A"), label: "Changed" };
      get().updateMilestone("PO-A", "a1", updated);
      expect(get().milestones["PO-B"]).toHaveLength(1);
      expect(get().milestones["PO-B"][0].id).toBe("b1");
    });
  });

  // ── deleteMilestonesForPo ──────────────────────────────────────────────

  describe("deleteMilestonesForPo", () => {
    it("removes milestones for the given PO", () => {
      get().setMilestonesForPo("PO-1", [makeMilestone("m1", "PO-1")]);
      get().deleteMilestonesForPo("PO-1");
      expect(get().milestones["PO-1"]).toBeUndefined();
    });

    it("is a no-op for non-existent PO", () => {
      get().deleteMilestonesForPo("PO-NONE");
      expect(get().milestones).toEqual({});
    });

    it("does not affect other POs", () => {
      get().setMilestonesForPo("PO-1", [makeMilestone("m1", "PO-1")]);
      get().setMilestonesForPo("PO-2", [makeMilestone("m2", "PO-2")]);
      get().deleteMilestonesForPo("PO-1");
      expect(get().milestones["PO-2"]).toHaveLength(1);
    });
  });

  // ── setAttachmentsForPo ────────────────────────────────────────────────

  describe("setAttachmentsForPo", () => {
    it("sets attachments for a PO", () => {
      const att = [makeAttachment("a1")];
      get().setAttachmentsForPo("PO-1", att);
      expect(get().attachments["PO-1"]).toEqual(att);
    });

    it("sets empty attachments", () => {
      get().setAttachmentsForPo("PO-1", []);
      expect(get().attachments["PO-1"]).toEqual([]);
    });

    it("does not affect other PO attachments", () => {
      get().setAttachmentsForPo("PO-1", [makeAttachment("a1")]);
      get().setAttachmentsForPo("PO-2", [makeAttachment("a2")]);
      expect(get().attachments["PO-1"]).toHaveLength(1);
      expect(get().attachments["PO-2"]).toHaveLength(1);
    });
  });

  // ── updateAttachment ───────────────────────────────────────────────────

  describe("updateAttachment", () => {
    it("updates an existing attachment by id", () => {
      const a = makeAttachment("a1");
      get().setAttachmentsForPo("PO-1", [a]);
      const updated = { ...a, name: "renamed.pdf" };
      get().updateAttachment("PO-1", "a1", updated);
      expect(get().attachments["PO-1"][0].name).toBe("renamed.pdf");
    });

    it("does not add when id not found (maps only)", () => {
      get().setAttachmentsForPo("PO-1", [makeAttachment("a1")]);
      const unrelated = makeAttachment("a-other");
      get().updateAttachment("PO-1", "a-other", unrelated);
      // map returns same length since no match replaces, and non-match keeps original
      expect(get().attachments["PO-1"]).toHaveLength(1);
      expect(get().attachments["PO-1"][0].id).toBe("a1");
    });

    it("handles PO with no attachments (empty array from fallback)", () => {
      const a = makeAttachment("a1");
      get().updateAttachment("PO-EMPTY", "a1", a);
      expect(get().attachments["PO-EMPTY"]).toEqual([]);
    });
  });

  // ── removePo ───────────────────────────────────────────────────────────

  describe("removePo", () => {
    it("removes PO from pos, notes, milestones, and attachments", () => {
      const po = makePO("PO-999");
      const note = makeNote("PO-999");
      useTandaStore.setState({
        pos: [po],
        notes: [note],
        milestones: { "PO-999": [makeMilestone("m1", "PO-999")] },
        attachments: { "PO-999": [makeAttachment("a1")] },
      });
      get().removePo("PO-999");
      expect(get().pos).toEqual([]);
      expect(get().notes).toEqual([]);
      expect(get().milestones["PO-999"]).toBeUndefined();
      expect(get().attachments["PO-999"]).toBeUndefined();
    });

    it("does not affect other POs", () => {
      useTandaStore.setState({
        pos: [makePO("PO-1"), makePO("PO-2")],
        notes: [makeNote("PO-1"), makeNote("PO-2")],
        milestones: {
          "PO-1": [makeMilestone("m1", "PO-1")],
          "PO-2": [makeMilestone("m2", "PO-2")],
        },
        attachments: {
          "PO-1": [makeAttachment("a1")],
          "PO-2": [makeAttachment("a2")],
        },
      });
      get().removePo("PO-1");
      expect(get().pos).toHaveLength(1);
      expect(get().pos[0].PoNumber).toBe("PO-2");
      expect(get().notes).toHaveLength(1);
      expect(get().milestones["PO-2"]).toBeDefined();
      expect(get().attachments["PO-2"]).toBeDefined();
    });

    it("is safe when PO does not exist", () => {
      useTandaStore.setState({ pos: [makePO("PO-1")] });
      get().removePo("PO-NONEXISTENT");
      expect(get().pos).toHaveLength(1);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. SYNC SLICE
// ═════════════════════════════════════════════════════════════════════════════

describe("SyncSlice", () => {
  it("has correct initial state", () => {
    const s = get();
    expect(s.loading).toBe(false);
    expect(s.syncing).toBe(false);
    expect(s.syncErr).toBe("");
    expect(s.lastSync).toBe("");
    expect(s.showSyncModal).toBe(false);
    expect(s.syncFilters).toEqual({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] });
    expect(s.syncProgress).toBe(0);
    expect(s.syncProgressMsg).toBe("");
    expect(s.syncDone).toBeNull();
    expect(s.syncLog).toEqual([]);
    expect(s.showSyncLog).toBe(false);
    expect(s.poSearch).toBe("");
    expect(s.poDropdownOpen).toBe(false);
    expect(s.xoroVendors).toEqual([]);
    expect(s.manualVendors).toEqual([]);
    expect(s.vendorSearch).toBe("");
    expect(s.loadingVendors).toBe(false);
    expect(s.newManualVendor).toBe("");
  });

  // ── setSyncField ───────────────────────────────────────────────────────

  describe("setSyncField", () => {
    it("sets a boolean field", () => {
      get().setSyncField("loading", true);
      expect(get().loading).toBe(true);
    });

    it("sets a string field", () => {
      get().setSyncField("syncErr", "Network error");
      expect(get().syncErr).toBe("Network error");
    });

    it("sets an array field", () => {
      get().setSyncField("xoroVendors", ["V1", "V2"]);
      expect(get().xoroVendors).toEqual(["V1", "V2"]);
    });

    it("does not affect unrelated fields", () => {
      get().setSyncField("loading", true);
      expect(get().syncing).toBe(false);
      expect(get().syncErr).toBe("");
    });
  });

  // ── syncStart ──────────────────────────────────────────────────────────

  describe("syncStart", () => {
    it("sets syncing state correctly", () => {
      get().syncStart();
      expect(get().syncing).toBe(true);
      expect(get().syncErr).toBe("");
      expect(get().syncDone).toBeNull();
      expect(get().syncProgress).toBe(0);
      expect(get().syncProgressMsg).toBe("Connecting to Xoro\u2026");
    });

    it("clears previous error", () => {
      useTandaStore.setState({ syncErr: "old error" });
      get().syncStart();
      expect(get().syncErr).toBe("");
    });

    it("clears previous syncDone", () => {
      useTandaStore.setState({ syncDone: { added: 5, changed: 3, deleted: 1 } });
      get().syncStart();
      expect(get().syncDone).toBeNull();
    });
  });

  // ── syncProgressUpdate ─────────────────────────────────────────────────

  describe("syncProgressUpdate", () => {
    it("updates progress and message", () => {
      get().syncProgressUpdate(50, "Fetching POs...");
      expect(get().syncProgress).toBe(50);
      expect(get().syncProgressMsg).toBe("Fetching POs...");
    });

    it("does not affect syncing flag", () => {
      useTandaStore.setState({ syncing: true });
      get().syncProgressUpdate(75, "Almost done");
      expect(get().syncing).toBe(true);
    });
  });

  // ── syncComplete ───────────────────────────────────────────────────────

  describe("syncComplete", () => {
    it("sets completion state", () => {
      get().syncStart();
      get().syncComplete(10, 5, 2, "2026-04-11T12:00:00Z");
      expect(get().syncing).toBe(false);
      expect(get().syncDone).toEqual({ added: 10, changed: 5, deleted: 2 });
      expect(get().syncProgress).toBe(100);
      expect(get().syncProgressMsg).toBe("Complete");
      expect(get().lastSync).toBe("2026-04-11T12:00:00Z");
    });

    it("works with zero counts", () => {
      get().syncComplete(0, 0, 0, "2026-04-11");
      expect(get().syncDone).toEqual({ added: 0, changed: 0, deleted: 0 });
    });
  });

  // ── syncFail ───────────────────────────────────────────────────────────

  describe("syncFail", () => {
    it("sets failure state", () => {
      get().syncStart();
      get().syncFail("Timeout");
      expect(get().syncing).toBe(false);
      expect(get().syncErr).toBe("Timeout");
      expect(get().syncProgress).toBe(0);
      expect(get().syncProgressMsg).toBe("");
    });

    it("preserves unrelated fields", () => {
      useTandaStore.setState({ lastSync: "2026-01-01" });
      get().syncFail("err");
      expect(get().lastSync).toBe("2026-01-01");
    });
  });

  // ── syncReset ──────────────────────────────────────────────────────────

  describe("syncReset", () => {
    it("resets sync UI state", () => {
      useTandaStore.setState({
        syncing: true,
        syncProgress: 80,
        syncProgressMsg: "Working",
        syncDone: { added: 1, changed: 2, deleted: 3 },
      });
      get().syncReset();
      expect(get().syncing).toBe(false);
      expect(get().syncProgress).toBe(0);
      expect(get().syncProgressMsg).toBe("");
      expect(get().syncDone).toBeNull();
    });

    it("does not reset syncErr or lastSync", () => {
      useTandaStore.setState({ syncErr: "old", lastSync: "2026-01-01" });
      get().syncReset();
      expect(get().syncErr).toBe("old");
      expect(get().lastSync).toBe("2026-01-01");
    });
  });

  // ── appendSyncLog ──────────────────────────────────────────────────────

  describe("appendSyncLog", () => {
    it("prepends entry to log", () => {
      const entry = makeSyncLogEntry();
      get().appendSyncLog(entry);
      expect(get().syncLog).toHaveLength(1);
      expect(get().syncLog[0]).toEqual(entry);
    });

    it("newest entries come first", () => {
      const e1 = makeSyncLogEntry({ ts: "2026-01-01" });
      const e2 = makeSyncLogEntry({ ts: "2026-01-02" });
      get().appendSyncLog(e1);
      get().appendSyncLog(e2);
      expect(get().syncLog[0].ts).toBe("2026-01-02");
      expect(get().syncLog[1].ts).toBe("2026-01-01");
    });

    it("caps log at 10 entries", () => {
      for (let i = 0; i < 12; i++) {
        get().appendSyncLog(makeSyncLogEntry({ ts: `2026-01-${String(i + 1).padStart(2, "0")}` }));
      }
      expect(get().syncLog).toHaveLength(10);
      // Most recent should be first
      expect(get().syncLog[0].ts).toBe("2026-01-12");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. EMAIL SLICE
// ═════════════════════════════════════════════════════════════════════════════

describe("EmailSlice", () => {
  it("has correct initial state for key fields", () => {
    const s = get();
    expect(s.msDisplayName).toBe("");
    expect(s.showEmailConfig).toBe(false);
    expect(s.emailSelPO).toBeNull();
    expect(s.emailsMap).toEqual({});
    expect(s.emailTabCur).toBe("inbox");
    expect(s.emailComposeTo).toBe("");
    expect(s.emailComposeSubject).toBe("");
    expect(s.emailComposeBody).toBe("");
    expect(s.emailSendErr).toBeNull();
    expect(s.emailNextLinks).toEqual({});
    expect(s.emailFlaggedSet).toBeInstanceOf(Set);
    expect(s.emailFlaggedSet.size).toBe(0);
    expect(s.emailCollapsedMsgs).toBeInstanceOf(Set);
    expect(s.emailCollapsedMsgs.size).toBe(0);
    expect(s.emailGlobalView).toBe("po");
    expect(s.dtlComposeTo).toBe("");
    expect(s.dtlEmailThread).toEqual([]);
  });

  // ── setEmailField ──────────────────────────────────────────────────────

  describe("setEmailField", () => {
    it("sets a string field", () => {
      get().setEmailField("emailComposeTo", "user@test.com");
      expect(get().emailComposeTo).toBe("user@test.com");
    });

    it("sets a boolean field", () => {
      get().setEmailField("emailFilterUnread", true);
      expect(get().emailFilterUnread).toBe(true);
    });

    it("sets a null field", () => {
      get().setEmailField("emailSelPO", null);
      expect(get().emailSelPO).toBeNull();
    });

    it("does not affect unrelated fields", () => {
      get().setEmailField("emailComposeTo", "x@y.com");
      expect(get().emailComposeSubject).toBe("");
    });
  });

  // ── mergeEmailsMap ─────────────────────────────────────────────────────

  describe("mergeEmailsMap", () => {
    it("sets emails for a key (replace mode)", () => {
      const emails = [{ id: "e1", subject: "Hi" }];
      get().mergeEmailsMap("PO-1", emails);
      expect(get().emailsMap["PO-1"]).toEqual(emails);
    });

    it("replaces existing emails when append is false/undefined", () => {
      get().mergeEmailsMap("PO-1", [{ id: "e1" }]);
      get().mergeEmailsMap("PO-1", [{ id: "e2" }]);
      expect(get().emailsMap["PO-1"]).toEqual([{ id: "e2" }]);
    });

    it("appends emails when append is true", () => {
      get().mergeEmailsMap("PO-1", [{ id: "e1" }]);
      get().mergeEmailsMap("PO-1", [{ id: "e2" }], true);
      expect(get().emailsMap["PO-1"]).toHaveLength(2);
      expect(get().emailsMap["PO-1"][1]).toEqual({ id: "e2" });
    });

    it("appends to non-existent key creates new array", () => {
      get().mergeEmailsMap("PO-NEW", [{ id: "e1" }], true);
      expect(get().emailsMap["PO-NEW"]).toEqual([{ id: "e1" }]);
    });

    it("sets empty array", () => {
      get().mergeEmailsMap("PO-1", []);
      expect(get().emailsMap["PO-1"]).toEqual([]);
    });

    it("does not affect other keys", () => {
      get().mergeEmailsMap("PO-1", [{ id: "e1" }]);
      get().mergeEmailsMap("PO-2", [{ id: "e2" }]);
      expect(get().emailsMap["PO-1"]).toHaveLength(1);
    });
  });

  // ── mergeSentMap ───────────────────────────────────────────────────────

  describe("mergeSentMap", () => {
    it("sets sent emails for a key", () => {
      get().mergeSentMap("PO-1", [{ id: "s1" }]);
      expect(get().emailSentMap["PO-1"]).toEqual([{ id: "s1" }]);
    });

    it("replaces existing sent emails", () => {
      get().mergeSentMap("PO-1", [{ id: "s1" }]);
      get().mergeSentMap("PO-1", [{ id: "s2" }]);
      expect(get().emailSentMap["PO-1"]).toEqual([{ id: "s2" }]);
    });

    it("does not affect other keys", () => {
      get().mergeSentMap("PO-1", [{ id: "s1" }]);
      get().mergeSentMap("PO-2", [{ id: "s2" }]);
      expect(get().emailSentMap["PO-1"]).toEqual([{ id: "s1" }]);
    });
  });

  // ── setEmailNextLink ───────────────────────────────────────────────────

  describe("setEmailNextLink", () => {
    it("sets a next link for a key", () => {
      get().setEmailNextLink("PO-1", "https://graph.microsoft.com/next");
      expect(get().emailNextLinks["PO-1"]).toBe("https://graph.microsoft.com/next");
    });

    it("sets null to indicate no more pages", () => {
      get().setEmailNextLink("PO-1", "https://example.com");
      get().setEmailNextLink("PO-1", null);
      expect(get().emailNextLinks["PO-1"]).toBeNull();
    });

    it("does not affect other keys", () => {
      get().setEmailNextLink("PO-1", "link1");
      get().setEmailNextLink("PO-2", "link2");
      expect(get().emailNextLinks["PO-1"]).toBe("link1");
    });
  });

  // ── emailResetCompose ──────────────────────────────────────────────────

  describe("emailResetCompose", () => {
    it("resets compose fields", () => {
      useTandaStore.setState({
        emailComposeTo: "a@b.com",
        emailComposeSubject: "Test",
        emailComposeBody: "Body",
        emailSendErr: "some error",
      });
      get().emailResetCompose();
      expect(get().emailComposeTo).toBe("");
      expect(get().emailComposeSubject).toBe("");
      expect(get().emailComposeBody).toBe("");
      expect(get().emailSendErr).toBeNull();
    });

    it("does not affect non-compose fields", () => {
      useTandaStore.setState({ emailTabCur: "compose", emailSelPO: "PO-1" });
      get().emailResetCompose();
      expect(get().emailTabCur).toBe("compose");
      expect(get().emailSelPO).toBe("PO-1");
    });
  });

  // ── emailResetDetail ───────────────────────────────────────────────────

  describe("emailResetDetail", () => {
    it("resets detail fields", () => {
      useTandaStore.setState({
        dtlComposeTo: "x@y.com",
        dtlComposeSubject: "Sub",
        dtlComposeBody: "Body",
        dtlSendErr: "err",
        dtlReply: "reply text",
        dtlEmailSel: { id: "e1" },
        dtlEmailThread: [{ id: "t1" }],
        dtlThreadLoading: true,
      });
      get().emailResetDetail();
      expect(get().dtlComposeTo).toBe("");
      expect(get().dtlComposeSubject).toBe("");
      expect(get().dtlComposeBody).toBe("");
      expect(get().dtlSendErr).toBeNull();
      expect(get().dtlReply).toBe("");
      expect(get().dtlEmailSel).toBeNull();
      expect(get().dtlEmailThread).toEqual([]);
      expect(get().dtlThreadLoading).toBe(false);
    });

    it("does not affect main compose fields", () => {
      useTandaStore.setState({ emailComposeTo: "keep@me.com" });
      get().emailResetDetail();
      expect(get().emailComposeTo).toBe("keep@me.com");
    });
  });

  // ── toggleFlagged ──────────────────────────────────────────────────────

  describe("toggleFlagged", () => {
    it("adds id to flagged set", () => {
      get().toggleFlagged("msg-1");
      expect(get().emailFlaggedSet.has("msg-1")).toBe(true);
    });

    it("removes id when already flagged", () => {
      get().toggleFlagged("msg-1");
      get().toggleFlagged("msg-1");
      expect(get().emailFlaggedSet.has("msg-1")).toBe(false);
    });

    it("handles multiple ids independently", () => {
      get().toggleFlagged("msg-1");
      get().toggleFlagged("msg-2");
      expect(get().emailFlaggedSet.size).toBe(2);
      get().toggleFlagged("msg-1");
      expect(get().emailFlaggedSet.has("msg-1")).toBe(false);
      expect(get().emailFlaggedSet.has("msg-2")).toBe(true);
    });
  });

  // ── toggleCollapsedMsg ─────────────────────────────────────────────────

  describe("toggleCollapsedMsg", () => {
    it("adds id to collapsed set", () => {
      get().toggleCollapsedMsg("msg-1");
      expect(get().emailCollapsedMsgs.has("msg-1")).toBe(true);
    });

    it("removes id when already collapsed", () => {
      get().toggleCollapsedMsg("msg-1");
      get().toggleCollapsedMsg("msg-1");
      expect(get().emailCollapsedMsgs.has("msg-1")).toBe(false);
    });

    it("does not affect flagged set", () => {
      get().toggleFlagged("msg-1");
      get().toggleCollapsedMsg("msg-1");
      expect(get().emailFlaggedSet.has("msg-1")).toBe(true);
      expect(get().emailCollapsedMsgs.has("msg-1")).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. TEAMS SLICE
// ═════════════════════════════════════════════════════════════════════════════

describe("TeamsSlice", () => {
  it("has correct initial state", () => {
    const s = get();
    expect(s.teamsChannelMap).toEqual({});
    expect(s.teamsTeamId).toBe("");
    expect(s.teamsSelPO).toBeNull();
    expect(s.teamsMessages).toEqual({});
    expect(s.teamsLoading).toEqual({});
    expect(s.teamsCreating).toBeNull();
    expect(s.teamsNewMsg).toBe("");
    expect(s.teamsAuthStatus).toBe("idle");
    expect(s.teamsSearchPO).toBe("");
    expect(s.teamsDirectTo).toBe("");
    expect(s.teamsDirectMsg).toBe("");
    expect(s.teamsDirectSending).toBe(false);
    expect(s.teamsDirectErr).toBeNull();
    expect(s.teamsTab).toBe("channels");
    expect(s.dmConversations).toEqual([]);
    expect(s.dmActiveChatId).toBeNull();
    expect(s.dmComposing).toBe(true);
    expect(s.dmSelectedName).toBe("");
    expect(s.dmLoading).toBe(false);
    expect(s.dmError).toBeNull();
    expect(s.dmNewMsg).toBe("");
    expect(s.dmSending).toBe(false);
    expect(s.teamsContacts).toEqual([]);
    expect(s.teamsContactsLoading).toBe(false);
    expect(s.teamsContactSearch).toBe("");
    expect(s.teamsContactDropdown).toBe(false);
    expect(s.teamsContactSearchResults).toEqual([]);
    expect(s.teamsContactSearchLoading).toBe(false);
    expect(s.teamsContactsError).toBeNull();
    expect(s.dtlDMTo).toBe("");
    expect(s.dtlDMMsg).toBe("");
    expect(s.dtlDMSending).toBe(false);
    expect(s.dtlDMErr).toBeNull();
    expect(s.dtlDMContactSearch).toBe("");
    expect(s.dtlDMContactDropdown).toBe(false);
    expect(s.dtlDMContactSearchResults).toEqual([]);
    expect(s.dtlDMContactSearchLoading).toBe(false);
  });

  // ── setTeamsField ──────────────────────────────────────────────────────

  describe("setTeamsField", () => {
    it("sets a string field", () => {
      get().setTeamsField("teamsTeamId", "team-123");
      expect(get().teamsTeamId).toBe("team-123");
    });

    it("sets a boolean field", () => {
      get().setTeamsField("dmLoading", true);
      expect(get().dmLoading).toBe(true);
    });

    it("sets a null field", () => {
      get().setTeamsField("teamsSelPO", null);
      expect(get().teamsSelPO).toBeNull();
    });

    it("sets a complex object field", () => {
      get().setTeamsField("teamsChannelMap", { "PO-1": { channelId: "c1", teamId: "t1" } });
      expect(get().teamsChannelMap["PO-1"]).toEqual({ channelId: "c1", teamId: "t1" });
    });

    it("does not affect unrelated fields", () => {
      get().setTeamsField("teamsTeamId", "team-123");
      expect(get().teamsNewMsg).toBe("");
      expect(get().teamsTab).toBe("channels");
    });
  });

  // ── teamsResetDm ───────────────────────────────────────────────────────

  describe("teamsResetDm", () => {
    it("resets DM fields", () => {
      useTandaStore.setState({
        teamsDirectTo: "user@test.com",
        teamsDirectMsg: "Hello",
        teamsDirectSending: true,
        teamsDirectErr: "error",
      });
      get().teamsResetDm();
      expect(get().teamsDirectTo).toBe("");
      expect(get().teamsDirectMsg).toBe("");
      expect(get().teamsDirectSending).toBe(false);
      expect(get().teamsDirectErr).toBeNull();
    });

    it("does not affect channel fields", () => {
      useTandaStore.setState({
        teamsTeamId: "team-123",
        teamsNewMsg: "channel msg",
      });
      get().teamsResetDm();
      expect(get().teamsTeamId).toBe("team-123");
      expect(get().teamsNewMsg).toBe("channel msg");
    });

    it("does not affect detail-panel DM fields", () => {
      useTandaStore.setState({ dtlDMTo: "someone@test.com" });
      get().teamsResetDm();
      expect(get().dtlDMTo).toBe("someone@test.com");
    });
  });

  // ── teamsResetDtlDm ────────────────────────────────────────────────────

  describe("teamsResetDtlDm", () => {
    it("resets detail-panel DM fields", () => {
      useTandaStore.setState({
        dtlDMTo: "user@test.com",
        dtlDMMsg: "Hello",
        dtlDMSending: true,
        dtlDMErr: "error",
        dtlDMContactSearch: "search",
        dtlDMContactDropdown: true,
        dtlDMContactSearchResults: [{ id: "c1" }],
        dtlDMContactSearchLoading: true,
      });
      get().teamsResetDtlDm();
      expect(get().dtlDMTo).toBe("");
      expect(get().dtlDMMsg).toBe("");
      expect(get().dtlDMSending).toBe(false);
      expect(get().dtlDMErr).toBeNull();
      expect(get().dtlDMContactSearch).toBe("");
      expect(get().dtlDMContactDropdown).toBe(false);
      expect(get().dtlDMContactSearchResults).toEqual([]);
      expect(get().dtlDMContactSearchLoading).toBe(false);
    });

    it("does not affect main DM fields", () => {
      useTandaStore.setState({ teamsDirectTo: "keep@me.com" });
      get().teamsResetDtlDm();
      expect(get().teamsDirectTo).toBe("keep@me.com");
    });

    it("does not affect channel fields", () => {
      useTandaStore.setState({ teamsTeamId: "team-abc" });
      get().teamsResetDtlDm();
      expect(get().teamsTeamId).toBe("team-abc");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. COMBINED STORE
// ═════════════════════════════════════════════════════════════════════════════

describe("Combined TandaStore", () => {
  it("exposes all slice actions", () => {
    const s = get();
    // Core
    expect(typeof s.setCoreField).toBe("function");
    expect(typeof s.selectPo).toBe("function");
    expect(typeof s.setMilestonesForPo).toBe("function");
    expect(typeof s.updateMilestone).toBe("function");
    expect(typeof s.deleteMilestonesForPo).toBe("function");
    expect(typeof s.setAttachmentsForPo).toBe("function");
    expect(typeof s.updateAttachment).toBe("function");
    expect(typeof s.removePo).toBe("function");
    // Sync
    expect(typeof s.setSyncField).toBe("function");
    expect(typeof s.syncStart).toBe("function");
    expect(typeof s.syncProgressUpdate).toBe("function");
    expect(typeof s.syncComplete).toBe("function");
    expect(typeof s.syncFail).toBe("function");
    expect(typeof s.syncReset).toBe("function");
    expect(typeof s.appendSyncLog).toBe("function");
    // Email
    expect(typeof s.setEmailField).toBe("function");
    expect(typeof s.mergeEmailsMap).toBe("function");
    expect(typeof s.mergeSentMap).toBe("function");
    expect(typeof s.setEmailNextLink).toBe("function");
    expect(typeof s.emailResetCompose).toBe("function");
    expect(typeof s.emailResetDetail).toBe("function");
    expect(typeof s.toggleFlagged).toBe("function");
    expect(typeof s.toggleCollapsedMsg).toBe("function");
    // Teams
    expect(typeof s.setTeamsField).toBe("function");
    expect(typeof s.teamsResetDm).toBe("function");
    expect(typeof s.teamsResetDtlDm).toBe("function");
  });

  it("actions from one slice do not corrupt another slice state", () => {
    // Set some state in each slice
    get().setCoreField("uploadingAttachment", true);
    get().setSyncField("syncing", true);
    get().setEmailField("emailComposeTo", "test@test.com");
    get().setTeamsField("teamsTeamId", "team-1");

    // Verify all are independent
    expect(get().uploadingAttachment).toBe(true);
    expect(get().syncing).toBe(true);
    expect(get().emailComposeTo).toBe("test@test.com");
    expect(get().teamsTeamId).toBe("team-1");

    // Reset one slice's field
    get().setCoreField("uploadingAttachment", false);
    expect(get().syncing).toBe(true);
    expect(get().emailComposeTo).toBe("test@test.com");
    expect(get().teamsTeamId).toBe("team-1");
  });
});
