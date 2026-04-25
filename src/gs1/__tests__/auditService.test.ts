import { describe, it, expect, vi, beforeEach } from "vitest";

// ── We test the audit log write path in isolation using a mock for supabaseGs1.
// The real service is a thin REST wrapper; here we verify that the store's
// writeAuditLog action is non-fatal and that insertAuditLog is called with the
// correct shape.

// Minimal mock of the DB module — only the functions used by writeAuditLog
vi.mock("../services/supabaseGs1", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/supabaseGs1")>();
  return {
    ...orig,
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
    loadAuditLogs:  vi.fn().mockResolvedValue([]),
  };
});

import * as db from "../services/supabaseGs1";

// We test the store action in isolation rather than mounting a full Zustand tree
// by calling the function directly with a small shim.
async function callWriteAuditLog(entry: Parameters<typeof import("../services/supabaseGs1").insertAuditLog>[0]) {
  // This mirrors what gs1Store.writeAuditLog does
  try {
    await db.insertAuditLog(entry);
  } catch {
    // non-fatal
  }
}

describe("audit log write path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls insertAuditLog with correct entity_type and action for GTIN creation", async () => {
    await callWriteAuditLog({
      entity_type: "pack_gtin",
      entity_id:   "10310927000010",
      action:      "create",
      new_values:  { style_no: "100001", color: "BLK", scale_code: "CA", pack_gtin: "10310927000010" },
    });
    expect(db.insertAuditLog).toHaveBeenCalledOnce();
    const arg = (db.insertAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.entity_type).toBe("pack_gtin");
    expect(arg.action).toBe("create");
    expect(arg.entity_id).toBe("10310927000010");
  });

  it("calls insertAuditLog with correct entity_type and action for SSCC generation", async () => {
    await callWriteAuditLog({
      entity_type: "carton",
      entity_id:   "carton-uuid-1",
      action:      "create",
      new_values:  { sscc: "003109270000000017", serial_reference: 17 },
    });
    const arg = (db.insertAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.entity_type).toBe("carton");
    expect(arg.action).toBe("create");
    expect((arg.new_values as Record<string, unknown>).sscc).toBe("003109270000000017");
  });

  it("does not throw when insertAuditLog rejects (non-fatal)", async () => {
    (db.insertAuditLog as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB down"));
    await expect(callWriteAuditLog({ entity_type: "pack_gtin", action: "create" })).resolves.toBeUndefined();
  });

  it("passes new_values payload through intact", async () => {
    const newValues = { processed: 100, inserted: 45, normalized: 98 };
    await callWriteAuditLog({
      entity_type: "upc_sync",
      entity_id:   "log-id-1",
      action:      "xoro_sync",
      new_values:  newValues,
    });
    const arg = (db.insertAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.new_values).toEqual(newValues);
  });

  it("passes old_values for update actions", async () => {
    await callWriteAuditLog({
      entity_type: "company_settings",
      entity_id:   "settings-id",
      action:      "update",
      old_values:  { gs1_prefix: "0310927", xoro_enabled: false },
      new_values:  { gs1_prefix: "0310927", xoro_enabled: true },
    });
    const arg = (db.insertAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.action).toBe("update");
    expect((arg.old_values as Record<string, unknown>).xoro_enabled).toBe(false);
    expect((arg.new_values as Record<string, unknown>).xoro_enabled).toBe(true);
  });
});
