import { describe, it, expect } from "vitest";
import {
  generateOffersForEntity,
  expireStaleOffers,
} from "../discount-offers.js";

// ─── Shared DB mock ───────────────────────────────────────────────────────────

function buildAdmin(tables = {}) {
  const api = (name) => {
    let _filters = [];
    const chain = {
      select: () => chain,
      eq:  (f, v) => { _filters = [..._filters, (r) => r[f] === v]; return chain; },
      in:  (f, arr) => { _filters = [..._filters, (r) => arr.includes(r[f])]; return chain; },
      gt:  (f, v) => { _filters = [..._filters, (r) => String(r[f]) > String(v)]; return chain; },
      gte: (f, v) => { _filters = [..._filters, (r) => String(r[f]) >= String(v)]; return chain; },
      lt:  (f, v) => { _filters = [..._filters, (r) => String(r[f]) < String(v)]; return chain; },
      lte: (f, v) => { _filters = [..._filters, (r) => String(r[f]) <= String(v)]; return chain; },
      order: () => chain,
      maybeSingle: async () => {
        const rows = tables[name] || [];
        return { data: rows.find((r) => _filters.every((fn) => fn(r))) ?? null };
      },
      then: (fn) => {
        const rows = (tables[name] || []).filter((r) => _filters.every((fn) => fn(r)));
        return Promise.resolve({ data: rows, error: null }).then(fn);
      },
      insert: (row) => {
        const arr = Array.isArray(row) ? row : [row];
        // Simulate DB column defaults for tables that need them
        const defaults = name === "dynamic_discount_offers" ? { status: "offered" } : {};
        const withIds = arr.map((r, i) => ({
          id: `${name}-${(tables[name] || []).length + i + 1}`,
          ...defaults,
          ...r,
        }));
        (tables[name] ??= []).push(...withIds);
        return {
          select: () => ({
            single: async () => ({ data: withIds[0], error: null }),
            then: (fn) => Promise.resolve({ data: withIds, error: null }).then(fn),
          }),
          then: (fn) => Promise.resolve({ data: null, error: null }).then(fn),
        };
      },
      update: (patch) => {
        const u = {
          _ufilters: [],
          select: function () { return this; },
          eq: function (f, v) { this._ufilters.push((r) => r[f] === v); return this; },
          in: function (f, arr) { this._ufilters.push((r) => arr.includes(r[f])); return this; },
          lt: function (f, v) { this._ufilters.push((r) => String(r[f]) < String(v)); return this; },
          then: function (fn) {
            const all = tables[name] || [];
            const changed = [];
            for (const r of all) {
              if (this._ufilters.every((fn) => fn(r))) { Object.assign(r, patch); changed.push(r); }
            }
            return Promise.resolve({ data: changed, error: null }).then(fn);
          },
        };
        return u;
      },
    };
    return chain;
  };
  return { from: (t) => api(t), _tables: tables };
}

// ─── Shared invoice fixtures ──────────────────────────────────────────────────

const NOW = new Date("2026-04-19T00:00:00Z");

function approvedInvoice(overrides = {}) {
  return {
    id: "inv-1",
    entity_id: "entity-1",
    vendor_id: "vendor-1",
    total: 10000,
    due_date: "2026-06-01",
    status: "approved",
    ...overrides,
  };
}

// ─── generateOffersForEntity idempotency ──────────────────────────────────────

describe("generateOffersForEntity — idempotency", () => {
  it("running twice on the same invoice creates exactly one offer", async () => {
    const tables = {
      invoices: [approvedInvoice()],
      dynamic_discount_offers: [],
    };
    const admin = buildAdmin(tables);

    const first = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(first.created).toHaveLength(1);
    expect(first.skipped).toHaveLength(0);

    const second = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0].reason).toBe("active_offer_exists");

    expect(tables.dynamic_discount_offers).toHaveLength(1);
  });

  it("running N times never creates more than one offer per invoice", async () => {
    const tables = {
      invoices: [approvedInvoice({ id: "inv-a" }), approvedInvoice({ id: "inv-b", vendor_id: "vendor-2" })],
      dynamic_discount_offers: [],
    };
    const admin = buildAdmin(tables);

    for (let i = 0; i < 5; i++) {
      await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    }

    expect(tables.dynamic_discount_offers).toHaveLength(2);
  });

  it("skips invoice with an 'offered' status offer", async () => {
    const tables = {
      invoices: [approvedInvoice()],
      dynamic_discount_offers: [{ invoice_id: "inv-1", status: "offered" }],
    };
    const admin = buildAdmin(tables);

    const result = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0].reason).toBe("active_offer_exists");
  });

  it("skips invoice with an 'accepted' status offer", async () => {
    const tables = {
      invoices: [approvedInvoice()],
      dynamic_discount_offers: [{ invoice_id: "inv-1", status: "accepted" }],
    };
    const admin = buildAdmin(tables);

    const result = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(result.created).toHaveLength(0);
    expect(result.skipped[0].reason).toBe("active_offer_exists");
  });

  it("creates a new offer when the previous one was expired", async () => {
    // An expired offer is no longer 'active' — a new offer should be created
    const tables = {
      invoices: [approvedInvoice()],
      dynamic_discount_offers: [{ invoice_id: "inv-1", status: "expired" }],
    };
    const admin = buildAdmin(tables);

    const result = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(result.created).toHaveLength(1);
  });

  it("creates a new offer when the previous one was rejected", async () => {
    const tables = {
      invoices: [approvedInvoice()],
      dynamic_discount_offers: [{ invoice_id: "inv-1", status: "rejected" }],
    };
    const admin = buildAdmin(tables);

    const result = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(result.created).toHaveLength(1);
  });

  it("skips invoices that are not 'approved' status", async () => {
    const tables = {
      invoices: [
        approvedInvoice({ id: "inv-a", status: "submitted" }),
        approvedInvoice({ id: "inv-b", status: "paid" }),
        approvedInvoice({ id: "inv-c", status: "rejected" }),
        approvedInvoice({ id: "inv-d", status: "approved" }),
      ],
      dynamic_discount_offers: [],
    };
    const admin = buildAdmin(tables);

    const result = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(result.created).toHaveLength(1);
    expect(result.created[0].invoice_id).toBe("inv-d");
  });

  it("skips invoices whose due_date is too close", async () => {
    const tables = {
      invoices: [
        approvedInvoice({ id: "inv-close", due_date: "2026-04-21" }), // 2 days out — ineligible
        approvedInvoice({ id: "inv-far",   due_date: "2026-06-01" }), // eligible
      ],
      dynamic_discount_offers: [],
    };
    const admin = buildAdmin(tables);

    const result = await generateOffersForEntity(admin, { entityId: "entity-1", now: NOW });
    expect(result.created).toHaveLength(1);
    expect(result.created[0].invoice_id).toBe("inv-far");
    // inv-close is excluded at the query level (due_date not > cutoff), so it
    // never appears in skipped — verify it simply wasn't created
    expect(result.created.find((c) => c.invoice_id === "inv-close")).toBeUndefined();
  });
});

// ─── expireStaleOffers idempotency ────────────────────────────────────────────

describe("expireStaleOffers — idempotency", () => {
  it("running twice on already-expired offers changes nothing on second run", async () => {
    const staleTime = "2026-04-18T00:00:00Z";
    const tables = {
      dynamic_discount_offers: [
        { id: "o1", status: "offered", expires_at: staleTime },
      ],
    };
    const admin = buildAdmin(tables);

    const first = await expireStaleOffers(admin, { now: NOW });
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe("o1");

    // After first run, o1.status is now "expired" — the update filter
    // (status=offered AND expires_at < now) will not match it again
    const second = await expireStaleOffers(admin, { now: NOW });
    expect(second).toHaveLength(0);
  });

  it("only expires offers whose expires_at is strictly before now", async () => {
    const tables = {
      dynamic_discount_offers: [
        { id: "stale",  status: "offered", expires_at: "2026-04-18T23:59:59Z" },
        { id: "future", status: "offered", expires_at: "2026-04-20T00:00:00Z" },
      ],
    };
    const admin = buildAdmin(tables);

    const result = await expireStaleOffers(admin, { now: NOW });
    expect(result.map((r) => r.id)).toContain("stale");
    expect(result.map((r) => r.id)).not.toContain("future");
  });

  it("does not touch accepted or rejected offers", async () => {
    const tables = {
      dynamic_discount_offers: [
        { id: "acc", status: "accepted", expires_at: "2026-01-01T00:00:00Z" },
        { id: "rej", status: "rejected", expires_at: "2026-01-01T00:00:00Z" },
        { id: "exp", status: "expired",  expires_at: "2026-01-01T00:00:00Z" },
      ],
    };
    const admin = buildAdmin(tables);

    const result = await expireStaleOffers(admin, { now: NOW });
    expect(result).toHaveLength(0);
  });
});

// ─── Anomaly flag deduplication ───────────────────────────────────────────────
// The anomaly detection job checks for existing open flags before inserting a
// new one. This logic is extracted here as a pure function and tested in
// isolation, matching the guard used in api/cron/anomalies-nightly.js.

describe("anomaly flag deduplication", () => {
  function makeKey(vendorId, flagType, entityId = null) {
    return `${vendorId}:${flagType}:${entityId ?? ""}`;
  }

  function buildOpenFlagIndex(existingFlags) {
    const index = new Set();
    for (const f of existingFlags) {
      index.add(makeKey(f.vendor_id, f.flag_type, f.entity_id));
    }
    return index;
  }

  function shouldInsertFlag(openByKey, vendorId, flagType, entityId = null) {
    return !openByKey.has(makeKey(vendorId, flagType, entityId));
  }

  it("does not insert when an identical open flag already exists", () => {
    const existing = [{ vendor_id: "v1", flag_type: "duplicate_invoice", entity_id: null, status: "open" }];
    const index = buildOpenFlagIndex(existing);
    expect(shouldInsertFlag(index, "v1", "duplicate_invoice", null)).toBe(false);
  });

  it("inserts when no open flag of that type exists for the vendor", () => {
    const index = buildOpenFlagIndex([]);
    expect(shouldInsertFlag(index, "v1", "duplicate_invoice", null)).toBe(true);
  });

  it("inserts when the same type exists but for a different vendor", () => {
    const existing = [{ vendor_id: "v1", flag_type: "price_variance", entity_id: null }];
    const index = buildOpenFlagIndex(existing);
    expect(shouldInsertFlag(index, "v2", "price_variance", null)).toBe(true);
  });

  it("inserts when the same type + vendor exists but for a different entity", () => {
    const existing = [{ vendor_id: "v1", flag_type: "compliance_gap", entity_id: "e1" }];
    const index = buildOpenFlagIndex(existing);
    expect(shouldInsertFlag(index, "v1", "compliance_gap", "e2")).toBe(true);
  });

  it("does not insert when flag matches on vendor + type + entity", () => {
    const existing = [{ vendor_id: "v1", flag_type: "compliance_gap", entity_id: "e1" }];
    const index = buildOpenFlagIndex(existing);
    expect(shouldInsertFlag(index, "v1", "compliance_gap", "e1")).toBe(false);
  });

  it("handles multiple flag types independently", () => {
    const existing = [
      { vendor_id: "v1", flag_type: "duplicate_invoice", entity_id: null },
      { vendor_id: "v1", flag_type: "price_variance",    entity_id: null },
    ];
    const index = buildOpenFlagIndex(existing);
    expect(shouldInsertFlag(index, "v1", "duplicate_invoice", null)).toBe(false);
    expect(shouldInsertFlag(index, "v1", "price_variance", null)).toBe(false);
    expect(shouldInsertFlag(index, "v1", "late_pattern", null)).toBe(true);
  });
});

// ─── Notification deduplication ──────────────────────────────────────────────
// Mirrors the dedupe_key pattern used throughout the notification system.
// A dedupe_key is a unique string scoped to one event + entity; a second insert
// with the same key must be a no-op (handled by the DB unique constraint).

describe("notification dedupe_key uniqueness", () => {
  function dedupeKey(event, entityId, extra = "") {
    return [event, entityId, extra].filter(Boolean).join("_");
  }

  it("produces the same key for the same inputs", () => {
    expect(dedupeKey("invoice_submitted", "inv-1", "ap@example.com"))
      .toBe(dedupeKey("invoice_submitted", "inv-1", "ap@example.com"));
  });

  it("produces different keys for different events", () => {
    expect(dedupeKey("invoice_approved", "inv-1")).not.toBe(dedupeKey("invoice_submitted", "inv-1"));
  });

  it("produces different keys for different entities", () => {
    expect(dedupeKey("invoice_submitted", "inv-1")).not.toBe(dedupeKey("invoice_submitted", "inv-2"));
  });

  it("produces different keys for different recipients", () => {
    expect(dedupeKey("invoice_submitted", "inv-1", "a@b.com"))
      .not.toBe(dedupeKey("invoice_submitted", "inv-1", "c@d.com"));
  });
});

// ─── Job-run logging pattern ──────────────────────────────────────────────────
// Every background job must: record start, update on success, record any error.
// This tests the state machine for job run records.

describe("job run log state machine", () => {
  function buildJobRunner(admin, jobName) {
    return {
      async start() {
        const { data } = await admin.from("ip_job_runs").insert({
          job_name: jobName,
          status: "running",
          started_at: new Date().toISOString(),
        }).select().single();
        return data;
      },
      async succeed(runId, meta = {}) {
        await admin.from("ip_job_runs").update({ status: "success", finished_at: new Date().toISOString(), ...meta }).eq("id", runId);
      },
      async fail(runId, errorMessage) {
        await admin.from("ip_job_runs").update({ status: "error", finished_at: new Date().toISOString(), error_message: errorMessage }).eq("id", runId);
      },
    };
  }

  function buildJobAdmin() {
    const tables = { ip_job_runs: [] };
    return {
      admin: buildAdmin(tables),
      tables,
    };
  }

  it("records a running row on start", async () => {
    const { admin, tables } = buildJobAdmin();
    const runner = buildJobRunner(admin, "anomalies-nightly");
    await runner.start();
    expect(tables.ip_job_runs[0].status).toBe("running");
    expect(tables.ip_job_runs[0].job_name).toBe("anomalies-nightly");
  });

  it("transitions running → success on completion", async () => {
    const { admin, tables } = buildJobAdmin();
    const runner = buildJobRunner(admin, "anomalies-nightly");
    const run = await runner.start();
    await runner.succeed(run.id, { rows_affected: 5 });
    expect(tables.ip_job_runs[0].status).toBe("success");
    expect(tables.ip_job_runs[0].rows_affected).toBe(5);
  });

  it("transitions running → error on failure", async () => {
    const { admin, tables } = buildJobAdmin();
    const runner = buildJobRunner(admin, "anomalies-nightly");
    const run = await runner.start();
    await runner.fail(run.id, "DB timeout");
    expect(tables.ip_job_runs[0].status).toBe("error");
    expect(tables.ip_job_runs[0].error_message).toBe("DB timeout");
  });

  it("a second job run produces a new row, not a mutation of the first", async () => {
    const { admin, tables } = buildJobAdmin();
    const runner = buildJobRunner(admin, "scorecards-monthly");
    const r1 = await runner.start();
    await runner.succeed(r1.id);

    const r2 = await runner.start();
    await runner.fail(r2.id, "timeout");

    expect(tables.ip_job_runs).toHaveLength(2);
    expect(tables.ip_job_runs[0].status).toBe("success");
    expect(tables.ip_job_runs[1].status).toBe("error");
  });
});

// ─── Health score upsert idempotency ─────────────────────────────────────────
// The health score cron uses upsert (onConflict vendor_id,period_start,period_end).
// Two identical upserts must not create duplicate rows.

describe("health score upsert idempotency", () => {
  function upsertHealthScore(admin, score) {
    // Simulates: admin.from("vendor_health_scores").upsert(score, { onConflict: "vendor_id,period_start,period_end" })
    const table = (admin._tables.vendor_health_scores ??= []);
    const existingIdx = table.findIndex(
      (r) => r.vendor_id === score.vendor_id && r.period_start === score.period_start && r.period_end === score.period_end,
    );
    if (existingIdx >= 0) {
      Object.assign(table[existingIdx], score);
    } else {
      table.push({ id: `hs-${table.length + 1}`, ...score });
    }
    return { data: null, error: null };
  }

  it("creates one row on first upsert", () => {
    const admin = buildAdmin({ vendor_health_scores: [] });
    upsertHealthScore(admin, { vendor_id: "v1", period_start: "2026-04-01", period_end: "2026-04-30", score: 85 });
    expect(admin._tables.vendor_health_scores).toHaveLength(1);
  });

  it("updates in place on second upsert with same vendor+period", () => {
    const admin = buildAdmin({ vendor_health_scores: [] });
    upsertHealthScore(admin, { vendor_id: "v1", period_start: "2026-04-01", period_end: "2026-04-30", score: 85 });
    upsertHealthScore(admin, { vendor_id: "v1", period_start: "2026-04-01", period_end: "2026-04-30", score: 90 });
    expect(admin._tables.vendor_health_scores).toHaveLength(1);
    expect(admin._tables.vendor_health_scores[0].score).toBe(90);
  });

  it("creates a separate row for a different period", () => {
    const admin = buildAdmin({ vendor_health_scores: [] });
    upsertHealthScore(admin, { vendor_id: "v1", period_start: "2026-03-01", period_end: "2026-03-31", score: 80 });
    upsertHealthScore(admin, { vendor_id: "v1", period_start: "2026-04-01", period_end: "2026-04-30", score: 85 });
    expect(admin._tables.vendor_health_scores).toHaveLength(2);
  });

  it("running the cron N times leaves exactly one row per vendor+period", () => {
    const admin = buildAdmin({ vendor_health_scores: [] });
    const score = { vendor_id: "v1", period_start: "2026-04-01", period_end: "2026-04-30", score: 88 };
    for (let i = 0; i < 10; i++) {
      upsertHealthScore(admin, { ...score, score: 88 + i });
    }
    expect(admin._tables.vendor_health_scores).toHaveLength(1);
    expect(admin._tables.vendor_health_scores[0].score).toBe(97); // 88 + 9
  });
});
