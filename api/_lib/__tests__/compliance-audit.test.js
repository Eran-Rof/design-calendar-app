import { describe, it, expect } from "vitest";
import { writeAudit, automationSummary, AUDIT_ACTIONS } from "../compliance-audit.js";

function buildAdmin(tables = {}) {
  const inserted = { compliance_audit_trail: [] };
  function chain(name) {
    let rows = [...(tables[name] || [])];
    const api = {
      select: () => api,
      eq: (f, v) => { rows = rows.filter((r) => r[f] === v); return api; },
      gte: (f, v) => { rows = rows.filter((r) => String(r[f]) >= String(v)); return api; },
      lte: (f, v) => { rows = rows.filter((r) => String(r[f]) <= String(v)); return api; },
      in:  (f, arr) => { rows = rows.filter((r) => arr.includes(r[f])); return api; },
      order: () => api,
      then: (fn) => Promise.resolve({ data: rows, error: null }).then(fn),
      insert: (row) => ({
        select: () => ({
          single: async () => ({ data: row, error: null }),
        }),
        then: (fn) => {
          const arr = Array.isArray(row) ? row : [row];
          (tables[name] ||= []).push(...arr);
          (inserted[name] ||= []).push(...arr);
          return Promise.resolve({ data: null, error: null }).then(fn);
        },
      }),
    };
    return api;
  }
  return {
    from: (t) => chain(t),
    _inserted: inserted,
    _tables: tables,
  };
}

describe("writeAudit", () => {
  it("accepts each valid action and writes a row", async () => {
    const admin = buildAdmin({ compliance_audit_trail: [] });
    for (const action of AUDIT_ACTIONS) {
      const r = await writeAudit(admin, { vendor_id: "v1", action, performed_by_type: "system" });
      expect(r.ok).toBe(true);
    }
    expect(admin._inserted.compliance_audit_trail).toHaveLength(AUDIT_ACTIONS.length);
  });
  it("rejects unknown actions and missing fields", async () => {
    const admin = buildAdmin();
    expect((await writeAudit(admin, { vendor_id: "v1", action: "exploded", performed_by_type: "system" })).ok).toBe(false);
    expect((await writeAudit(admin, { action: "uploaded", performed_by_type: "system" })).ok).toBe(false);
    expect((await writeAudit(admin, { vendor_id: "v1", action: "uploaded" })).ok).toBe(false);
  });
});

describe("automationSummary", () => {
  it("counts requests, renewals, and open escalations per doc type", async () => {
    const admin = buildAdmin({
      compliance_audit_trail: [
        { action: "requested", document_id: "d1", created_at: "2026-04-01T00:00:00Z" },
        { action: "approved",  document_id: "d1", created_at: "2026-04-03T00:00:00Z" }, // renewal completed
        { action: "requested", document_id: "d2", created_at: "2026-04-05T00:00:00Z" }, // open (no newer approved)
        { action: "uploaded",  document_id: "d2", created_at: "2026-04-05T00:00:00Z" }, // uploaded but not approved — still "requested" latest? No, uploaded is newer.
        { action: "requested", document_id: "d3", created_at: "2026-04-10T00:00:00Z" }, // open, no follow-up
      ],
      compliance_documents: [
        { id: "d1", document_type_id: "coi" },
        { id: "d2", document_type_id: "coi" },
        { id: "d3", document_type_id: "w9"  },
      ],
    });
    const out = await automationSummary(admin, { from_iso: "2026-04-01T00:00:00Z", to_iso: "2026-04-30T23:59:59Z" });
    expect(out.requests_sent).toBe(3);
    expect(out.renewals_completed).toBe(1); // approved → +1
    // d1 latest=approved → closed; d2 latest=uploaded → closed (not requested); d3 latest=requested → open
    expect(out.escalations_open).toBe(1);
    expect(out.by_document_type.coi).toMatchObject({ requests: 2, renewals: 1, escalations: 0 });
    expect(out.by_document_type.w9).toMatchObject({ requests: 1, renewals: 0, escalations: 1 });
  });

  it("returns zero counts when no audit rows in range", async () => {
    const admin = buildAdmin({ compliance_audit_trail: [] });
    const out = await automationSummary(admin, { from_iso: "2026-04-01T00:00:00Z", to_iso: "2026-04-30T23:59:59Z" });
    expect(out).toMatchObject({ requests_sent: 0, renewals_completed: 0, escalations_open: 0 });
    expect(out.by_document_type).toEqual({});
  });
});
