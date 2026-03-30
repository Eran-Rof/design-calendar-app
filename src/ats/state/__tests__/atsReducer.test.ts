import { describe, it, expect } from "vitest";
import { atsReducer } from "../atsReducer";
import { createInitialState } from "../atsTypes";

const initial = createInitialState("2026-03-25");

describe("atsReducer", () => {
  it("SET updates a single field", () => {
    const s = atsReducer(initial, { type: "SET", field: "search", value: "test" });
    expect(s.search).toBe("test");
    expect(s.loading).toBe(false); // other fields unchanged
  });

  it("UPLOAD_START sets uploading state atomically", () => {
    const s = atsReducer(initial, { type: "UPLOAD_START" });
    expect(s.uploadingFile).toBe(true);
    expect(s.uploadProgress).toEqual({ step: "Preparing…", pct: 0 });
    expect(s.uploadError).toBeNull();
    expect(s.uploadSuccess).toBeNull();
  });

  it("UPLOAD_PROGRESS updates step and pct", () => {
    const s = atsReducer(initial, { type: "UPLOAD_PROGRESS", step: "Parsing…", pct: 45 });
    expect(s.uploadProgress).toEqual({ step: "Parsing…", pct: 45 });
  });

  it("UPLOAD_DONE clears upload state and resets files", () => {
    const uploading = { ...initial, uploadingFile: true, invFile: new File([], "test.xlsx"), showUpload: true };
    const s = atsReducer(uploading, { type: "UPLOAD_DONE", message: "3 SKUs loaded" });
    expect(s.uploadingFile).toBe(false);
    expect(s.uploadProgress).toBeNull();
    expect(s.uploadSuccess).toBe("3 SKUs loaded");
    expect(s.showUpload).toBe(false);
    expect(s.invFile).toBeNull();
  });

  it("UPLOAD_FAIL sets error and clears progress", () => {
    const s = atsReducer({ ...initial, uploadingFile: true }, { type: "UPLOAD_FAIL", error: "Parse error" });
    expect(s.uploadingFile).toBe(false);
    expect(s.uploadError).toBe("Parse error");
  });

  it("SYNC_START sets syncing atomically", () => {
    const s = atsReducer(initial, { type: "SYNC_START" });
    expect(s.syncing).toBe(true);
    expect(s.syncStatus).toBe("Syncing…");
    expect(s.syncError).toBeNull();
  });

  it("SYNC_DONE clears sync state", () => {
    const s = atsReducer({ ...initial, syncing: true }, { type: "SYNC_DONE", lastSync: "2026-03-30" });
    expect(s.syncing).toBe(false);
    expect(s.lastSync).toBe("2026-03-30");
  });

  it("SYNC_FAIL sets error", () => {
    const s = atsReducer({ ...initial, syncing: true }, { type: "SYNC_FAIL", error: { title: "Error", detail: "Timeout" } });
    expect(s.syncing).toBe(false);
    expect(s.syncError).toEqual({ title: "Error", detail: "Timeout" });
  });
});
