import { describe, it, expect } from "vitest";
import {
  computeAnnualizedReturn, computeDiscountPct,
  buildOfferCandidate, generateOffersForEntity, expireStaleOffers,
  computeAnalytics, CONSTANTS,
} from "../discount-offers.js";

// ──────────────────────────────────────────────────────────────────────────
// Pure math
// ──────────────────────────────────────────────────────────────────────────

describe("computeAnnualizedReturn", () => {
  it("annualizes the discount rate over the number of days early", () => {
    // 1.5% discount for 15 days early = 36.5% APR
    expect(computeAnnualizedReturn(1.5, 15)).toBeCloseTo(36.5, 1);
    // 2% / 60d = ~12.17%
    expect(computeAnnualizedReturn(2, 60)).toBeCloseTo(12.17, 2);
  });
  it("returns 0 for non-positive days", () => {
    expect(computeAnnualizedReturn(2, 0)).toBe(0);
    expect(computeAnnualizedReturn(2, -3)).toBe(0);
  });
});

describe("computeDiscountPct", () => {
  it("solves the APR formula for discount_pct", () => {
    // target 10% APR over 30 days → 10 * 30 / 365 ≈ 0.822
    expect(computeDiscountPct(30, 10)).toBeCloseTo(0.82, 2);
    // Round trip: input pct → APR → pct
    const days = 45;
    const pct = computeDiscountPct(days, 12);
    expect(computeAnnualizedReturn(pct, days)).toBeCloseTo(12, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// buildOfferCandidate
// ──────────────────────────────────────────────────────────────────────────

describe("buildOfferCandidate", () => {
  const now = new Date("2026-04-19T00:00:00Z");
  const baseInvoice = {
    id: "inv1", entity_id: "e1", vendor_id: "v1",
    total: 10000, due_date: "2026-05-20",
  };

  it("produces a candidate with APR-targeted discount_pct by default", () => {
    const c = buildOfferCandidate(baseInvoice, { now, targetAnnualizedPct: 10 });
    expect(c).not.toBeNull();
    // early_payment_date = now+3 = 2026-04-22; days_early = 20-(-22+30) = 2026-05-20 - 2026-04-22 = 28 days
    expect(c.early_payment_date).toBe("2026-04-22");
    expect(c.original_due_date).toBe("2026-05-20");
    expect(c._computed.days_early).toBe(28);
    // discount_pct = 10 * 28 / 365 ≈ 0.77; discount_amount = 10000 * 0.77 / 100 ≈ 77
    expect(c.discount_pct).toBeCloseTo(0.77, 1);
    expect(c.discount_amount).toBeCloseTo(76.71, 1);
    expect(c.net_payment_amount).toBeCloseTo(10000 - c.discount_amount, 2);
  });

  it("honors discountPctOverride and skips the annualized-floor check", () => {
    const c = buildOfferCandidate(baseInvoice, { now, discountPctOverride: 0.1 });
    expect(c.discount_pct).toBe(0.1);
  });

  it("returns null when due_date is too close", () => {
    const c = buildOfferCandidate({ ...baseInvoice, due_date: "2026-04-24" }, { now });
    // days_early = 2026-04-24 - (now+3=2026-04-22) = 2, less than MIN_DAYS_LEAD_TIME
    expect(c).toBeNull();
  });

  it("returns null for non-positive totals", () => {
    expect(buildOfferCandidate({ ...baseInvoice, total: 0 }, { now })).toBeNull();
    expect(buildOfferCandidate({ ...baseInvoice, total: -100 }, { now })).toBeNull();
  });

  it("rejects auto-generated offers below MIN_ANNUALIZED_RETURN_PCT", () => {
    // targetAnnualizedPct=1 would yield a tiny offer; should reject
    const c = buildOfferCandidate(baseInvoice, { now, targetAnnualizedPct: 1 });
    expect(c).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DB harness + generate / expire / analytics
// ──────────────────────────────────────────────────────────────────────────

function buildAdmin(tables = {}) {
  const api = (name) => {
    let rows = [...(tables[name] || [])];
    let filters = [];
    const chain = {
      select: () => chain,
      eq:  (f, v) => { filters.push((r) => r[f] === v); return chain; },
      in:  (f, arr) => { filters.push((r) => arr.includes(r[f])); return chain; },
      gt:  (f, v) => { filters.push((r) => String(r[f]) > String(v)); return chain; },
      gte: (f, v) => { filters.push((r) => String(r[f]) >= String(v)); return chain; },
      lt:  (f, v) => { filters.push((r) => String(r[f]) < String(v)); return chain; },
      lte: (f, v) => { filters.push((r) => String(r[f]) <= String(v)); return chain; },
      order: () => chain,
      range: () => chain,
      maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) || null }),
      single:      async () => ({ data: rows.find((r) => filters.every((f) => f(r))) || null }),
      then: (fn) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(fn),
      insert: (row) => {
        const arr = Array.isArray(row) ? row : [row];
        const withIds = arr.map((r, i) => ({ id: `${name}-${(tables[name] || []).length + i + 1}`, ...r }));
        (tables[name] ||= []).push(...withIds);
        return {
          select: () => ({
            single: async () => ({ data: withIds[0], error: null }),
            then: (fn) => Promise.resolve({ data: withIds, error: null }).then(fn),
          }),
          then: (fn) => Promise.resolve({ data: null, error: null }).then(fn),
        };
      },
      update: (patch) => {
        const u = { _filters: [], select: function () { return this; },
          eq: function (f, v) { this._filters.push((r) => r[f] === v); return this; },
          in: function (f, arr) { this._filters.push((r) => arr.includes(r[f])); return this; },
          lt: function (f, v) { this._filters.push((r) => String(r[f]) < String(v)); return this; },
          then: function (fn) {
            const all = tables[name] || [];
            const changed = [];
            for (const r of all) {
              if (this._filters.every((fn) => fn(r))) { Object.assign(r, patch); changed.push(r); }
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

describe("generateOffersForEntity", () => {
  const now = new Date("2026-04-19T00:00:00Z");

  it("creates offers for eligible invoices and skips those with active offers", async () => {
    const admin = buildAdmin({
      invoices: [
        { id: "inv1", entity_id: "e1", vendor_id: "v1", total: 10000, due_date: "2026-05-20", status: "approved" },
        { id: "inv2", entity_id: "e1", vendor_id: "v2", total: 20000, due_date: "2026-05-01", status: "approved" },
        { id: "inv3", entity_id: "e1", vendor_id: "v3", total: 5000,  due_date: "2026-04-21", status: "approved" }, // too close
        { id: "inv4", entity_id: "e1", vendor_id: "v4", total: 8000,  due_date: "2026-06-01", status: "submitted" }, // wrong status
        { id: "inv5", entity_id: "e1", vendor_id: "v5", total: 12000, due_date: "2026-06-01", status: "approved" },
      ],
      dynamic_discount_offers: [
        { invoice_id: "inv5", status: "offered" }, // blocks
      ],
    });
    const out = await generateOffersForEntity(admin, { entityId: "e1", now });
    expect(out.created).toHaveLength(2);
    expect(out.created.map((c) => c.invoice_id).sort()).toEqual(["inv1", "inv2"]);
    expect(out.skipped.find((s) => s.invoice_id === "inv5").reason).toBe("active_offer_exists");
  });

  it("persists the offer payload with correct discount math", async () => {
    const admin = buildAdmin({
      invoices: [{ id: "invA", entity_id: "e1", vendor_id: "v1", total: 10000, due_date: "2026-05-20", status: "approved" }],
      dynamic_discount_offers: [],
    });
    await generateOffersForEntity(admin, { entityId: "e1", now });
    const offer = admin._tables.dynamic_discount_offers[0];
    expect(offer).toMatchObject({
      invoice_id: "invA", vendor_id: "v1", entity_id: "e1",
      early_payment_date: "2026-04-22", original_due_date: "2026-05-20",
    });
    // discount_amount ≈ net - total relationship sanity
    expect(Number(offer.net_payment_amount) + Number(offer.discount_amount))
      .toBeCloseTo(10000, 2);
  });
});

describe("expireStaleOffers", () => {
  it("flips offered → expired only when expires_at < now", async () => {
    const now = new Date("2026-04-19T12:00:00Z");
    const admin = buildAdmin({
      dynamic_discount_offers: [
        { id: "o1", status: "offered",  expires_at: "2026-04-18T00:00:00Z" }, // stale
        { id: "o2", status: "offered",  expires_at: "2026-04-25T00:00:00Z" }, // fresh
        { id: "o3", status: "accepted", expires_at: "2026-04-01T00:00:00Z" }, // non-offered — skip
      ],
    });
    const out = await expireStaleOffers(admin, { now });
    expect(out.map((r) => r.id)).toEqual(["o1"]);
    const o1 = admin._tables.dynamic_discount_offers.find((r) => r.id === "o1");
    expect(o1.status).toBe("expired");
  });
});

describe("computeAnalytics", () => {
  it("rolls up total captured / acceptance rate / annualized return", async () => {
    const admin = buildAdmin({
      dynamic_discount_offers: [
        { entity_id: "e1", status: "accepted", discount_pct: 1, discount_amount: 100, net_payment_amount: 9900,
          original_due_date: "2026-05-20", early_payment_date: "2026-04-22", offered_at: "2026-04-10T00:00:00Z" },
        { entity_id: "e1", status: "rejected", discount_pct: 0.5, discount_amount: 50, net_payment_amount: 9950,
          original_due_date: "2026-05-20", early_payment_date: "2026-04-22", offered_at: "2026-04-10T00:00:00Z" },
        { entity_id: "e1", status: "expired",  discount_pct: 1, discount_amount: 100, net_payment_amount: 9900,
          original_due_date: "2026-05-20", early_payment_date: "2026-04-22", offered_at: "2026-04-10T00:00:00Z" },
        { entity_id: "e1", status: "paid",     discount_pct: 1.5, discount_amount: 150, net_payment_amount: 9850,
          original_due_date: "2026-05-20", early_payment_date: "2026-04-22", offered_at: "2026-04-10T00:00:00Z" },
      ],
    });
    const out = await computeAnalytics(admin, { entityId: "e1", periodStart: "2026-04-01", periodEnd: "2026-04-30" });
    expect(out.total_offers_made).toBe(4);
    expect(out.total_offers_accepted).toBe(2); // accepted + paid
    expect(out.total_discount_captured).toBeCloseTo(250, 2);
    expect(out.total_early_payment_amount).toBeCloseTo(19750, 2);
    expect(out.acceptance_rate_pct).toBe(50);
    expect(out.annualized_return_pct).toBeGreaterThan(0);
  });
});

describe("CONSTANTS", () => {
  it("exposes policy defaults for callers", () => {
    expect(CONSTANTS.DEFAULT_TARGET_ANNUALIZED_PCT).toBe(10);
    expect(CONSTANTS.MIN_DAYS_LEAD_TIME).toBe(5);
  });
});
