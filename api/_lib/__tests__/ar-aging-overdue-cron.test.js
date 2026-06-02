// Tests for the AR aging overdue cron (P4-6).
//
// Exercises runOverdueScan via a tiny in-memory supabase double:
//   - one entity, one customer, multiple overdue buckets
//   - dedup behavior (second run skips notifications it already sent today)
//   - bucket→kind mapping
//   - error pass-through

import { describe, it, expect, vi } from "vitest";
import { runOverdueScan, BUCKET_FIELDS } from "../../cron/ar-aging-overdue-email.js";

function makeSupabase({ entities = [], aging = {}, dedupConflicts = new Set() }) {
  const log = []; // captures dedup inserts
  const sb = {
    log,
    from(table) {
      if (table === "entities") {
        return {
          select() { return this; },
          then(resolve) { return resolve({ data: entities, error: null }); },
        };
      }
      if (table === "v_ar_aging") {
        let entityFilter = null;
        const builder = {
          select() { return builder; },
          eq(col, val) { if (col === "entity_id") entityFilter = val; return builder; },
          then(resolve) {
            const rows = aging[entityFilter] || [];
            return resolve({ data: rows, error: null });
          },
        };
        return builder;
      }
      if (table === "notifications_overdue_log") {
        return {
          insert(row) {
            const key = `${row.entity_id}|${row.customer_id}|${row.bucket}`;
            log.push({ ...row });
            const conflict = dedupConflicts.has(key);
            const builder = {
              select() { return builder; },
              maybeSingle() {
                if (conflict) {
                  return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
                }
                return Promise.resolve({ data: { id: "log-" + log.length }, error: null });
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

describe("runOverdueScan", () => {
  it("walks empty entities cleanly", async () => {
    const sb = makeSupabase({ entities: [] });
    const r = await runOverdueScan(sb, { enqueueFn: vi.fn() });
    expect(r.entities_scanned).toBe(0);
    expect(r.customers_scanned).toBe(0);
    expect(r.notifications_enqueued).toBe(0);
    expect(r.duplicates_skipped).toBe(0);
  });

  it("enqueues one notification per non-zero bucket per customer", async () => {
    const enq = vi.fn().mockResolvedValue(undefined);
    const sb = makeSupabase({
      entities: [{ id: "ent-1", code: "ROF", name: "ROF" }],
      aging: {
        "ent-1": [{
          customer_id: "cust-1",
          customer_name: "Burlington",
          customer_code: "BURL",
          bucket_current_cents: 5000,
          bucket_30_cents: 100000,
          bucket_60_cents: 50000,
          bucket_90_cents: 25000,
          bucket_120plus_cents: 10000,
          total_open_cents: 190000,
        }],
      },
    });
    const r = await runOverdueScan(sb, { enqueueFn: enq });
    expect(r.entities_scanned).toBe(1);
    expect(r.customers_scanned).toBe(1);
    // 4 overdue buckets > 0 (30/60/90/120+); current is excluded.
    expect(r.notifications_enqueued).toBe(4);
    expect(r.duplicates_skipped).toBe(0);
    expect(enq).toHaveBeenCalledTimes(4);

    const calls = enq.mock.calls.map(([, ctx]) => ctx);
    const kinds = calls.map((c) => c.kind);
    expect(kinds).toContain("customer_overdue_30d");
    expect(kinds).toContain("customer_overdue_60d");
    // Both 90d and 120+ map to customer_overdue_90d kind.
    expect(kinds.filter((k) => k === "customer_overdue_90d").length).toBe(2);
  });

  it("skips zero or null buckets", async () => {
    const enq = vi.fn();
    const sb = makeSupabase({
      entities: [{ id: "ent-1", code: "ROF", name: "ROF" }],
      aging: {
        "ent-1": [{
          customer_id: "cust-1",
          customer_name: "ACME",
          bucket_current_cents: 100,
          bucket_30_cents: 0,
          bucket_60_cents: null,
          bucket_90_cents: 0,
          bucket_120plus_cents: 0,
          total_open_cents: 100,
        }],
      },
    });
    const r = await runOverdueScan(sb, { enqueueFn: enq });
    expect(r.notifications_enqueued).toBe(0);
    expect(enq).not.toHaveBeenCalled();
  });

  it("dedup: skips enqueue when overdue_log unique-violates", async () => {
    const enq = vi.fn();
    const sb = makeSupabase({
      entities: [{ id: "ent-1", code: "ROF", name: "ROF" }],
      aging: {
        "ent-1": [{
          customer_id: "cust-1",
          customer_name: "Burlington",
          bucket_current_cents: 0,
          bucket_30_cents: 100000,
          bucket_60_cents: 0,
          bucket_90_cents: 0,
          bucket_120plus_cents: 0,
          total_open_cents: 100000,
        }],
      },
      dedupConflicts: new Set(["ent-1|cust-1|30d"]),
    });
    const r = await runOverdueScan(sb, { enqueueFn: enq });
    expect(r.notifications_enqueued).toBe(0);
    expect(r.duplicates_skipped).toBe(1);
    expect(enq).not.toHaveBeenCalled();
  });

  it("dedup-attempted on every overdue bucket", async () => {
    const enq = vi.fn().mockResolvedValue(undefined);
    const sb = makeSupabase({
      entities: [{ id: "ent-1", code: "ROF", name: "ROF" }],
      aging: {
        "ent-1": [{
          customer_id: "cust-1",
          customer_name: "X",
          bucket_current_cents: 0,
          bucket_30_cents: 100,
          bucket_60_cents: 100,
          bucket_90_cents: 0,
          bucket_120plus_cents: 0,
          total_open_cents: 200,
        }],
      },
    });
    await runOverdueScan(sb, { enqueueFn: enq });
    // One insert per overdue bucket (30, 60).
    expect(sb.log.length).toBe(2);
    expect(sb.log.map((l) => l.bucket).sort()).toEqual(["30d", "60d"]);
  });

  it("captures enqueue errors without halting", async () => {
    const enq = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("smtp boom"));
    const sb = makeSupabase({
      entities: [{ id: "ent-1", code: "ROF", name: "ROF" }],
      aging: {
        "ent-1": [{
          customer_id: "cust-1",
          bucket_current_cents: 0,
          bucket_30_cents: 100,
          bucket_60_cents: 100,
          bucket_90_cents: 0,
          bucket_120plus_cents: 0,
          total_open_cents: 200,
        }],
      },
    });
    const r = await runOverdueScan(sb, { enqueueFn: enq });
    expect(r.notifications_enqueued).toBe(1);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/smtp boom/);
  });

  it("BUCKET_FIELDS shape sanity (exported constant)", () => {
    expect(BUCKET_FIELDS.length).toBe(4);
    for (const b of BUCKET_FIELDS) {
      expect(b.field).toMatch(/^bucket_/);
      expect(b.bucket).toMatch(/^(30d|60d|90d|120d_plus)$/);
      expect(b.kind).toMatch(/^customer_overdue_/);
    }
  });
});
