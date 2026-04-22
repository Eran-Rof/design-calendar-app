import { describe, it, expect } from "vitest";
import {
  validateTaskInput, validatePinInput, resolvePin, authorizeVendorAccess,
  PIN_ENTITY_TYPES, TASK_STATUSES,
} from "../workspaces.js";

function buildAdmin(tables = {}) {
  return {
    from(name) {
      let rows = [...(tables[name] || [])];
      const api = {
        select: () => api,
        eq: (f, v) => { rows = rows.filter((r) => r[f] === v); return api; },
        maybeSingle: async () => ({ data: rows[0] ?? null }),
        single:      async () => ({ data: rows[0] ?? null }),
        then: (fn) => Promise.resolve({ data: rows, error: null }).then(fn),
      };
      return api;
    },
  };
}

describe("validateTaskInput", () => {
  it("requires title on create", () => {
    expect(validateTaskInput({}).some((e) => e.includes("title"))).toBe(true);
    expect(validateTaskInput({ title: "  " }).some((e) => e.includes("title"))).toBe(true);
  });
  it("does not require title on partial update", () => {
    expect(validateTaskInput({ status: "complete" }, { partial: true })).toEqual([]);
  });
  it("rejects unknown status", () => {
    expect(validateTaskInput({ title: "ok", status: "bogus" }).some((e) => e.includes("status"))).toBe(true);
  });
  it("accepts each defined task status", () => {
    for (const s of TASK_STATUSES) {
      expect(validateTaskInput({ title: "t", status: s })).toEqual([]);
    }
  });
  it("rejects unparseable due_date", () => {
    expect(validateTaskInput({ title: "x", due_date: "not-a-date" }).some((e) => e.includes("due_date"))).toBe(true);
  });
  it("accepts null assignee and null due_date", () => {
    expect(validateTaskInput({ title: "x", assigned_to_type: null, due_date: null })).toEqual([]);
  });
});

describe("validatePinInput", () => {
  it("requires known entity_type and entity_id", () => {
    expect(validatePinInput({}).length).toBeGreaterThan(0);
    expect(validatePinInput({ entity_type: "bogus", entity_id: "x" }).length).toBe(1);
    expect(validatePinInput({ entity_type: "po", entity_id: "123" })).toEqual([]);
  });
  it("accepts every defined entity_type", () => {
    for (const t of PIN_ENTITY_TYPES) {
      expect(validatePinInput({ entity_type: t, entity_id: "x" })).toEqual([]);
    }
  });
});

describe("resolvePin", () => {
  const admin = buildAdmin({
    tanda_pos: [{ uuid_id: "po1", po_number: "PO-42", vendor_id: "v1", status: "Open" }],
    invoices: [{ id: "inv1", invoice_number: "INV-9", total: 500, status: "approved" }],
    contracts: [{ id: "c1", title: "MSA", status: "signed", end_date: "2027-01-01" }],
    rfqs: [{ id: "r1", title: "Widgets 2026", status: "open" }],
    compliance_documents: [{ id: "d1", document_type_id: "t1", status: "approved", expiry_date: "2026-06-30" }],
  });

  it("resolves each pin type to a display label", async () => {
    expect((await resolvePin(admin, "po", "po1")).label).toBe("PO PO-42");
    expect((await resolvePin(admin, "invoice", "inv1")).label).toBe("Invoice INV-9");
    expect((await resolvePin(admin, "contract", "c1")).label).toBe("MSA");
    expect((await resolvePin(admin, "rfq", "r1")).label).toBe("RFQ: Widgets 2026");
    expect((await resolvePin(admin, "document", "d1")).label).toBe("Compliance doc");
  });

  it("returns null for unknown or missing ids", async () => {
    expect(await resolvePin(admin, "po", "nope")).toBeNull();
    expect(await resolvePin(admin, "invoice", null)).toBeNull();
    expect(await resolvePin(admin, "unknown_type", "x")).toBeNull();
  });
});

describe("authorizeVendorAccess", () => {
  const admin = buildAdmin({
    collaboration_workspaces: [
      { id: "w1", vendor_id: "v1", name: "A", status: "active" },
      { id: "w2", vendor_id: "v2", name: "B", status: "active" },
    ],
    vendors: [{ id: "v1", name: "V1" }, { id: "v2", name: "V2" }],
  });

  it("returns workspace when vendor matches", async () => {
    const w = await authorizeVendorAccess(admin, "w1", "v1");
    expect(w?.id).toBe("w1");
  });
  it("returns null when vendor mismatches", async () => {
    expect(await authorizeVendorAccess(admin, "w1", "v2")).toBeNull();
  });
  it("returns null for missing arguments", async () => {
    expect(await authorizeVendorAccess(admin, null, "v1")).toBeNull();
    expect(await authorizeVendorAccess(admin, "w1", null)).toBeNull();
  });
});
