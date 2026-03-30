import { describe, it, expect } from "vitest";
import { syncReducer } from "../syncReducer";
import { initialSyncState } from "../syncTypes";

describe("syncReducer", () => {
  it("SET_LOADING updates loading", () => {
    const s = syncReducer(initialSyncState, { type: "SET_LOADING", payload: true });
    expect(s.loading).toBe(true);
  });

  it("SYNC_START sets syncing state atomically", () => {
    const s = syncReducer(initialSyncState, { type: "SYNC_START" });
    expect(s.syncing).toBe(true);
    expect(s.syncErr).toBe("");
    expect(s.syncDone).toBeNull();
    expect(s.syncProgress).toBe(0);
    expect(s.syncProgressMsg).toBe("Connecting to Xoro…");
  });

  it("SYNC_PROGRESS updates both fields", () => {
    const s = syncReducer(initialSyncState, { type: "SYNC_PROGRESS", payload: { progress: 50, msg: "Fetching…" } });
    expect(s.syncProgress).toBe(50);
    expect(s.syncProgressMsg).toBe("Fetching…");
  });

  it("SYNC_COMPLETE sets done state", () => {
    const s = syncReducer({ ...initialSyncState, syncing: true }, {
      type: "SYNC_COMPLETE",
      payload: { added: 5, changed: 3, deleted: 1, lastSync: "2026-03-30T12:00:00Z" },
    });
    expect(s.syncing).toBe(false);
    expect(s.syncDone).toEqual({ added: 5, changed: 3, deleted: 1, lastSync: "2026-03-30T12:00:00Z" });
    expect(s.syncProgress).toBe(100);
    expect(s.lastSync).toBe("2026-03-30T12:00:00Z");
  });

  it("SYNC_FAIL clears syncing and sets error", () => {
    const s = syncReducer({ ...initialSyncState, syncing: true }, { type: "SYNC_FAIL", payload: "Network error" });
    expect(s.syncing).toBe(false);
    expect(s.syncErr).toBe("Network error");
  });

  it("APPEND_SYNC_LOG prepends and caps at 10", () => {
    const existing = { ...initialSyncState, syncLog: Array.from({ length: 10 }, (_, i) => ({ ts: `t${i}`, user: "u", success: true, added: 0, changed: 0, deleted: 0 })) };
    const entry = { ts: "new", user: "test", success: true, added: 1, changed: 0, deleted: 0 };
    const s = syncReducer(existing, { type: "APPEND_SYNC_LOG", payload: entry });
    expect(s.syncLog).toHaveLength(10);
    expect(s.syncLog[0].ts).toBe("new");
  });
});
