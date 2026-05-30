// Tests for Tangerine P13-6 — M48 compliance-expiring-daily cron
// (api/cron/compliance-expiring-daily.js). Uses an in-memory supabase
// stub modelled on the ar-aging-overdue-email cron tests in P4-6.

import { describe, it, expect, vi } from "vitest";

import {
  runExpiringCertScan,
  groupByVendor,
  addDays,
  DEFAULT_WINDOW_DAYS,
} from "../../cron/compliance-expiring-daily.js";

const ENTITY_ID = "00000000-0000-0000-0000-aaaaaaaaaaaa";
const VENDOR_A  = "00000000-0000-0000-0000-bbbbbbbbbbbb";
const VENDOR_B  = "00000000-0000-0000-0000-cccccccccccc";

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("compliance-expiring-daily pure helpers", () => {
  it("DEFAULT_WINDOW_DAYS = 60", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(60);
  });

  it("addDays adds N days, preserves YYYY-MM-DD format", () => {
    expect(addDays("2026-05-29", 60)).toBe("2026-07-28");
  });

  it("addDays handles month rollover", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("groupByVendor groups N certs into M vendor buckets", () => {
    const m = groupByVendor([
      { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX" },
      { id: "c2", vendor_id: VENDOR_A, certification_type: "GOTS" },
      { id: "c3", vendor_id: VENDOR_B, certification_type: "OEKO-TEX" },
    ]);
    expect(m.size).toBe(2);
    expect(m.get(VENDOR_A)?.length).toBe(2);
    expect(m.get(VENDOR_B)?.length).toBe(1);
  });

  it("groupByVendor skips rows missing vendor_id", () => {
    const m = groupByVendor([
      { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX" },
      { id: "c2", vendor_id: null,     certification_type: "GOTS" },
    ]);
    expect(m.size).toBe(1);
  });

  it("groupByVendor handles an empty array", () => {
    expect(groupByVendor([]).size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Stub supabase client
// ────────────────────────────────────────────────────────────────────────

function buildStub({ entities, certsByEntity, vendors, throwOnDedup = false, dedupCollisionVendors = new Set() }) {
  return {
    from(table) {
      if (table === "entities") {
        return {
          select() {
            return Promise.resolve({ data: entities, error: null });
          },
        };
      }
      if (table === "vendor_compliance_certifications") {
        const ctx = { table, filters: {} };
        const builder = {
          select() { return builder; },
          eq(col, val) { ctx.filters[col] = val; return builder; },
          gte() { return builder; },
          lte() { return builder; },
          // Resolve to certs for the entity filter applied.
          then(resolve) {
            const e = ctx.filters.entity_id;
            const certs = certsByEntity[e] || [];
            return Promise.resolve({ data: certs, error: null }).then(resolve);
          },
        };
        return builder;
      }
      if (table === "vendors") {
        const ctx = { id: null };
        const builder = {
          select() { return builder; },
          eq(col, val) { if (col === "id") ctx.id = val; return builder; },
          maybeSingle() {
            return Promise.resolve({ data: vendors[ctx.id] || null, error: null });
          },
        };
        return builder;
      }
      if (table === "cron_expiring_cert_log") {
        return {
          insert(row) {
            if (throwOnDedup) return Promise.reject(new Error("dedup throw"));
            if (dedupCollisionVendors.has(row.vendor_id)) {
              return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            }
            return Promise.resolve({ data: row, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// runExpiringCertScan
// ────────────────────────────────────────────────────────────────────────

describe("runExpiringCertScan", () => {
  const today = "2026-05-29";

  it("emits one notification per vendor with expiring certs", async () => {
    const enqueueFn = vi.fn().mockResolvedValue();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: {
        [ENTITY_ID]: [
          { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX", cert_number: "1", expires_at: "2026-06-10" },
          { id: "c2", vendor_id: VENDOR_A, certification_type: "GOTS",     cert_number: "2", expires_at: "2026-07-01" },
          { id: "c3", vendor_id: VENDOR_B, certification_type: "BSCI",     cert_number: "3", expires_at: "2026-06-20" },
        ],
      },
      vendors: {
        [VENDOR_A]: { name: "Vendor A" },
        [VENDOR_B]: { name: "Vendor B" },
      },
    });
    const r = await runExpiringCertScan(stub, { enqueueFn, today });
    expect(r.entities_scanned).toBe(1);
    expect(r.vendors_notified).toBe(2);
    expect(r.certs_in_window).toBe(3);
    expect(enqueueFn).toHaveBeenCalledTimes(2);
  });

  it("includes cert_count + earliest_expiry in payload", async () => {
    const enqueueFn = vi.fn().mockResolvedValue();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: {
        [ENTITY_ID]: [
          { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX", expires_at: "2026-07-01" },
          { id: "c2", vendor_id: VENDOR_A, certification_type: "GOTS",     expires_at: "2026-06-10" },
        ],
      },
      vendors: { [VENDOR_A]: { name: "Vendor A" } },
    });
    await runExpiringCertScan(stub, { enqueueFn, today });
    const call = enqueueFn.mock.calls[0][1];
    expect(call.payload.cert_count).toBe(2);
    expect(call.payload.earliest_expiry).toBe("2026-06-10");
    expect(call.payload.vendor_name).toBe("Vendor A");
  });

  it("uses recipient_roles=['admin','compliance']", async () => {
    const enqueueFn = vi.fn().mockResolvedValue();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: {
        [ENTITY_ID]: [
          { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX", expires_at: "2026-06-10" },
        ],
      },
      vendors: { [VENDOR_A]: { name: "Vendor A" } },
    });
    await runExpiringCertScan(stub, { enqueueFn, today });
    expect(enqueueFn.mock.calls[0][1].recipient_roles).toEqual(["admin", "compliance"]);
    expect(enqueueFn.mock.calls[0][1].kind).toBe("compliance_cert_expiring");
    expect(enqueueFn.mock.calls[0][1].severity).toBe("warn");
  });

  it("skips already-sent vendors via dedup table (23505)", async () => {
    const enqueueFn = vi.fn().mockResolvedValue();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: {
        [ENTITY_ID]: [
          { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX", expires_at: "2026-06-10" },
          { id: "c3", vendor_id: VENDOR_B, certification_type: "BSCI",     expires_at: "2026-06-15" },
        ],
      },
      vendors: { [VENDOR_A]: { name: "A" }, [VENDOR_B]: { name: "B" } },
      dedupCollisionVendors: new Set([VENDOR_A]),
    });
    const r = await runExpiringCertScan(stub, { enqueueFn, today });
    expect(r.duplicates_skipped).toBe(1);
    expect(r.vendors_notified).toBe(1);
  });

  it("returns a clean summary for zero-cert entities", async () => {
    const enqueueFn = vi.fn().mockResolvedValue();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: { [ENTITY_ID]: [] },
      vendors: {},
    });
    const r = await runExpiringCertScan(stub, { enqueueFn, today });
    expect(r.vendors_notified).toBe(0);
    expect(r.certs_in_window).toBe(0);
    expect(r.errors.length).toBe(0);
  });

  it("collects enqueue errors into summary.errors but continues", async () => {
    const enqueueFn = vi.fn()
      .mockRejectedValueOnce(new Error("first vendor failed"))
      .mockResolvedValueOnce();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: {
        [ENTITY_ID]: [
          { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX", expires_at: "2026-06-10" },
          { id: "c2", vendor_id: VENDOR_B, certification_type: "GOTS",     expires_at: "2026-06-15" },
        ],
      },
      vendors: { [VENDOR_A]: { name: "A" }, [VENDOR_B]: { name: "B" } },
    });
    const r = await runExpiringCertScan(stub, { enqueueFn, today });
    expect(r.vendors_notified).toBe(1);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/first vendor failed/);
  });

  it("respects a custom windowDays opt for the window-end date in payload", async () => {
    const enqueueFn = vi.fn().mockResolvedValue();
    const stub = buildStub({
      entities: [{ id: ENTITY_ID, code: "ROF", name: "Ring of Fire" }],
      certsByEntity: {
        [ENTITY_ID]: [
          { id: "c1", vendor_id: VENDOR_A, certification_type: "OEKO-TEX", expires_at: "2026-06-05" },
        ],
      },
      vendors: { [VENDOR_A]: { name: "Vendor A" } },
    });
    await runExpiringCertScan(stub, { enqueueFn, today, windowDays: 30 });
    expect(enqueueFn.mock.calls[0][1].payload.window_end).toBe(addDays(today, 30));
    expect(enqueueFn.mock.calls[0][1].subject).toMatch(/30d/);
  });
});
