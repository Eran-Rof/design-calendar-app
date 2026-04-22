import { describe, it, expect, beforeEach } from "vitest";
import {
  detectCostSaving, detectRiskAlerts, detectConsolidation,
  detectContractRenewal, detectPerformanceTrend, detectMarketBenchmark,
  runInsightsForEntity,
} from "../insights.js";

// ──────────────────────────────────────────────────────────────────────────
// Admin stub: in-memory tables with minimal Supabase query-builder surface.
// ──────────────────────────────────────────────────────────────────────────
function buildAdmin(tables = {}) {
  const inserted = { ai_insights: [] };
  const updated  = { ai_insights: [] };
  let countExact = null;

  function chain(tableName) {
    let rows = [...(tables[tableName] || [])];
    let orderField = null;
    let orderDesc = false;

    const api = {
      select: (_cols, opts) => { if (opts?.count === "exact") countExact = rows.length; return api; },
      eq:     (f, v) => { rows = rows.filter((r) => r[f] === v); return api; },
      neq:    (f, v) => { rows = rows.filter((r) => r[f] !== v); return api; },
      in:     (f, arr) => { rows = rows.filter((r) => arr.includes(r[f])); return api; },
      gt:     (f, v) => { rows = rows.filter((r) => String(r[f]) > String(v)); return api; },
      gte:    (f, v) => { rows = rows.filter((r) => String(r[f]) >= String(v)); return api; },
      lt:     (f, v) => { rows = rows.filter((r) => String(r[f]) < String(v)); return api; },
      lte:    (f, v) => { rows = rows.filter((r) => String(r[f]) <= String(v)); return api; },
      not:    (f, op, v) => {
        if (op === "is" && v === null) rows = rows.filter((r) => r[f] !== null && r[f] !== undefined);
        return api;
      },
      order:  (f, o) => { orderField = f; orderDesc = !o?.ascending; return api; },
      range:  () => api,
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      single:      async () => ({ data: rows[0] ?? null }),
      then:   (onFulfilled) => {
        let out = rows;
        if (orderField) {
          out = [...rows].sort((a, b) => {
            const av = String(a[orderField] ?? ""); const bv = String(b[orderField] ?? "");
            return orderDesc ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
          });
        }
        return Promise.resolve({ data: out, error: null, count: countExact }).then(onFulfilled);
      },
      insert: (row) => {
        const arr = Array.isArray(row) ? row : [row];
        (tables[tableName] ||= []).push(...arr);
        inserted[tableName] = [...(inserted[tableName] || []), ...arr];
        return {
          select: () => ({
            single: async () => ({ data: arr[0], error: null }),
          }),
          then: (onFulfilled) => Promise.resolve({ data: null, error: null }).then(onFulfilled),
        };
      },
      update: (patch) => {
        const updateApi = {
          _updates: patch, _filters: [],
          eq: function (f, v) { this._filters.push((r) => r[f] === v); return this; },
          in: function (f, arr) { this._filters.push((r) => arr.includes(r[f])); return this; },
          lt: function (f, v) { this._filters.push((r) => String(r[f]) < String(v)); return this; },
          select: function () { return this; },
          then: function (onFulfilled) {
            const all = tables[tableName] || [];
            const changed = [];
            for (const r of all) {
              if (this._filters.every((fn) => fn(r))) {
                Object.assign(r, this._updates);
                changed.push(r);
              }
            }
            updated[tableName] = [...(updated[tableName] || []), ...changed];
            return Promise.resolve({ data: changed, error: null }).then(onFulfilled);
          },
        };
        return updateApi;
      },
    };
    return api;
  }

  return {
    from: (t) => chain(t),
    _inserted: inserted,
    _updated: updated,
    _tables: tables,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Detector tests
// ──────────────────────────────────────────────────────────────────────────

describe("detectCostSaving", () => {
  it("flags items >15% above benchmark P50 and recommends preferred alternative when cheaper", async () => {
    const admin = buildAdmin({
      catalog_items: [
        { id: "it1", vendor_id: "v1", sku: "WID-1", name: "Widget", category: "widgets", unit_price: 120, status: "active" },
        { id: "it2", vendor_id: "v2", sku: "WID-2", name: "Widget alt", category: "widgets", unit_price:  90, status: "active" },
        { id: "it3", vendor_id: "v1", sku: "OK-1",  name: "OK",     category: "widgets", unit_price: 102, status: "active" }, // 2% over — excluded
      ],
      benchmark_data: [
        { category: "widgets", metric: "unit_price", percentile_50: 100, percentile_75: 110, period_end: "2026-04-01" },
      ],
      preferred_vendors: [
        { vendor_id: "v2", category: "widgets", rank: 1 },
      ],
    });
    const out = await detectCostSaving({ admin, vendorIds: ["v1", "v2"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "cost_saving", vendor_id: "v1",
      data_snapshot: expect.objectContaining({ sku: "WID-1", alt_vendor_id: "v2", alt_unit_price: 90 }),
    });
    expect(out[0].recommendation).toContain("preferred vendor");
  });

  it("ignores items missing a benchmark or category", async () => {
    const admin = buildAdmin({
      catalog_items: [
        { id: "x", vendor_id: "v1", sku: "X", name: "X", category: null, unit_price: 999, status: "active" },
      ],
      benchmark_data: [], preferred_vendors: [],
    });
    expect(await detectCostSaving({ admin, vendorIds: ["v1"] })).toEqual([]);
  });
});

describe("detectRiskAlerts", () => {
  const now = new Date("2026-04-19T00:00:00Z");

  it("flags health_score drop > 15 points between the last two periods", async () => {
    const admin = buildAdmin({
      vendor_health_scores: [
        { vendor_id: "v1", overall_score: 60, period_start: "2026-03-01", period_end: "2026-03-31", generated_at: "2026-04-01" },
        { vendor_id: "v1", overall_score: 82, period_start: "2026-02-01", period_end: "2026-02-28", generated_at: "2026-03-01" },
      ],
      anomaly_flags: [], contracts: [], compliance_documents: [],
    });
    const out = await detectRiskAlerts({ admin, vendorIds: ["v1"], now });
    expect(out.some((r) => r.data_snapshot.reason === "health_score_drop" && r.data_snapshot.drop_points === 22)).toBe(true);
  });

  it("flags open critical anomalies older than 7 days", async () => {
    const admin = buildAdmin({
      vendor_health_scores: [], contracts: [], compliance_documents: [],
      anomaly_flags: [
        { id: "a1", vendor_id: "v1", type: "price_variance", severity: "critical", status: "open", detected_at: "2026-04-05T00:00:00Z", description: "—" },
        { id: "a2", vendor_id: "v1", type: "price_variance", severity: "critical", status: "open", detected_at: "2026-04-18T00:00:00Z", description: "too new" },
      ],
    });
    const out = await detectRiskAlerts({ admin, vendorIds: ["v1"], now });
    const stale = out.filter((r) => r.data_snapshot.reason === "stale_critical_anomaly");
    expect(stale).toHaveLength(1);
    expect(stale[0].data_snapshot.anomaly_id).toBe("a1");
  });

  it("flags contract expiring ≤45d with no draft/sent renewal", async () => {
    const admin = buildAdmin({
      vendor_health_scores: [], anomaly_flags: [], compliance_documents: [],
      contracts: [
        { id: "c1", vendor_id: "v1", title: "MSA",  status: "signed", end_date: "2026-05-15" }, // 26 days out
        { id: "c2", vendor_id: "v2", title: "MSA2", status: "signed", end_date: "2026-05-15" },
        { id: "c3", vendor_id: "v2", title: "MSA2 renewal", status: "draft", end_date: null },
      ],
    });
    const out = await detectRiskAlerts({ admin, vendorIds: ["v1", "v2"], now });
    const expiring = out.filter((r) => r.data_snapshot.reason === "contract_expiring_no_renewal");
    expect(expiring).toHaveLength(1);
    expect(expiring[0].vendor_id).toBe("v1");
  });

  it("flags approved compliance docs expiring ≤30d", async () => {
    const admin = buildAdmin({
      vendor_health_scores: [], anomaly_flags: [], contracts: [],
      compliance_documents: [
        { id: "d1", vendor_id: "v1", document_type_id: "t1", expiry_date: "2026-05-10", status: "approved" }, // 21d
        { id: "d2", vendor_id: "v1", document_type_id: "t1", expiry_date: "2026-07-10", status: "approved" }, // too far
      ],
    });
    const out = await detectRiskAlerts({ admin, vendorIds: ["v1"], now });
    const expiring = out.filter((r) => r.data_snapshot.reason === "compliance_doc_expiring");
    expect(expiring).toHaveLength(1);
  });
});

describe("detectConsolidation", () => {
  const now = new Date("2026-04-19T00:00:00Z");

  it("flags categories with 3+ vendors and combined spend < $100k", async () => {
    const admin = buildAdmin({
      catalog_items: [
        { vendor_id: "v1", category: "office", status: "active" },
        { vendor_id: "v2", category: "office", status: "active" },
        { vendor_id: "v3", category: "office", status: "active" },
        { vendor_id: "v4", category: "steel",  status: "active" }, // different category
      ],
      invoices: [
        { vendor_id: "v1", total: 10000, status: "approved", invoice_date: "2026-03-01" },
        { vendor_id: "v2", total: 15000, status: "paid",     invoice_date: "2026-03-01" },
        { vendor_id: "v3", total: 17000, status: "approved", invoice_date: "2026-03-01" },
        { vendor_id: "v4", total: 50000, status: "approved", invoice_date: "2026-03-01" },
      ],
    });
    const out = await detectConsolidation({ admin, vendorIds: ["v1", "v2", "v3", "v4"], now });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "consolidation", vendor_id: null,
      data_snapshot: expect.objectContaining({ category: "office", combined_spend: 42000 }),
    });
  });

  it("does not flag categories with combined spend >= $100k", async () => {
    const admin = buildAdmin({
      catalog_items: [
        { vendor_id: "v1", category: "office", status: "active" },
        { vendor_id: "v2", category: "office", status: "active" },
        { vendor_id: "v3", category: "office", status: "active" },
      ],
      invoices: [
        { vendor_id: "v1", total: 60000, status: "paid", invoice_date: "2026-03-01" },
        { vendor_id: "v2", total: 80000, status: "paid", invoice_date: "2026-03-01" },
        { vendor_id: "v3", total: 50000, status: "paid", invoice_date: "2026-03-01" },
      ],
    });
    const out = await detectConsolidation({ admin, vendorIds: ["v1", "v2", "v3"], now });
    expect(out).toEqual([]);
  });
});

describe("detectContractRenewal", () => {
  const now = new Date("2026-04-19T00:00:00Z");
  it("flags signed contracts ≤60 days from expiry without a draft/sent renewal", async () => {
    const admin = buildAdmin({
      contracts: [
        { id: "c1", vendor_id: "v1", title: "MSA", status: "signed", end_date: "2026-06-01" }, // 43d
        { id: "c2", vendor_id: "v2", title: "MSA", status: "signed", end_date: "2026-07-01" }, // 73d → skipped
        { id: "c3", vendor_id: "v3", title: "MSA", status: "signed", end_date: "2026-06-01" },
        { id: "c4", vendor_id: "v3", title: "MSA renewal", status: "draft", end_date: null }, // has renewal
      ],
    });
    const out = await detectContractRenewal({ admin, vendorIds: ["v1", "v2", "v3"], now });
    expect(out.map((r) => r.vendor_id)).toEqual(["v1"]);
  });
});

describe("detectPerformanceTrend", () => {
  it("flags >10 point delta over 3 periods (improved or declined)", async () => {
    const admin = buildAdmin({
      vendor_scorecards: [
        { vendor_id: "v1", on_time_delivery_pct: 88, period_start: "2026-03-01", period_end: "2026-03-31" },
        { vendor_id: "v1", on_time_delivery_pct: 82, period_start: "2026-02-01", period_end: "2026-02-28" },
        { vendor_id: "v1", on_time_delivery_pct: 72, period_start: "2026-01-01", period_end: "2026-01-31" },
        { vendor_id: "v2", on_time_delivery_pct: 90, period_start: "2026-03-01", period_end: "2026-03-31" },
        { vendor_id: "v2", on_time_delivery_pct: 92, period_start: "2026-02-01", period_end: "2026-02-28" },
        { vendor_id: "v2", on_time_delivery_pct: 95, period_start: "2026-01-01", period_end: "2026-01-31" }, // delta 5 → skip
      ],
    });
    const out = await detectPerformanceTrend({ admin, vendorIds: ["v1", "v2"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ vendor_id: "v1", data_snapshot: expect.objectContaining({ direction: "improved", delta_points: 16 }) });
  });
});

describe("detectMarketBenchmark", () => {
  it("flags categories where entity avg > P75", async () => {
    const admin = buildAdmin({
      catalog_items: [
        { vendor_id: "v1", category: "widgets", unit_price: 130, status: "active" },
        { vendor_id: "v2", category: "widgets", unit_price: 130, status: "active" },
        { vendor_id: "v3", category: "steel",   unit_price:  40, status: "active" },
      ],
      benchmark_data: [
        { category: "widgets", metric: "unit_price", percentile_50: 100, percentile_75: 115, period_end: "2026-04-01" },
        { category: "steel",   metric: "unit_price", percentile_50: 50,  percentile_75: 55,  period_end: "2026-04-01" },
      ],
    });
    const out = await detectMarketBenchmark({ admin, vendorIds: ["v1", "v2", "v3"] });
    // widgets avg 130 > P75 115; steel avg 40 < P75 55
    expect(out.map((r) => r.data_snapshot.category)).toEqual(["widgets"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────────────────

describe("runInsightsForEntity", () => {
  const now = new Date("2026-04-19T00:00:00Z");

  it("inserts new insights, skips duplicates, and expires stale rows", async () => {
    const admin = buildAdmin({
      entity_vendors: [
        { entity_id: "e1", vendor_id: "v1", relationship_status: "active" },
      ],
      catalog_items: [
        { id: "it1", vendor_id: "v1", sku: "WID-1", name: "Widget", category: "widgets", unit_price: 150, status: "active" },
      ],
      benchmark_data: [
        { category: "widgets", metric: "unit_price", percentile_50: 100, percentile_75: 110, period_end: "2026-04-01" },
      ],
      preferred_vendors: [],
      vendor_health_scores: [], anomaly_flags: [], contracts: [], compliance_documents: [],
      invoices: [], vendor_scorecards: [],
      ai_insights: [
        // Existing unread cost_saving for v1 — should cause dedup
        { id: "ins-existing", entity_id: "e1", vendor_id: "v1", type: "cost_saving", status: "read", expires_at: "2030-01-01T00:00:00Z" },
        // Stale 'new' expired row — should get dismissed
        { id: "ins-stale", entity_id: "e1", vendor_id: null, type: "market_benchmark", status: "new", expires_at: "2026-04-01T00:00:00Z" },
      ],
    });

    const res = await runInsightsForEntity({ admin, entityId: "e1", now });
    expect(res.inserted).toBe(0);            // cost_saving deduped
    expect(res.candidates).toBeGreaterThan(0);
    expect(res.deduped).toBe(res.candidates);
    expect(res.expired).toBe(1);             // stale row dismissed
    const stale = admin._tables.ai_insights.find((r) => r.id === "ins-stale");
    expect(stale.status).toBe("dismissed");
  });

  it("inserts fresh candidates with expires_at = now+30d", async () => {
    const admin = buildAdmin({
      entity_vendors: [{ entity_id: "e1", vendor_id: "v1", relationship_status: "active" }],
      catalog_items: [
        { id: "it1", vendor_id: "v1", sku: "WID-1", name: "Widget", category: "widgets", unit_price: 150, status: "active" },
      ],
      benchmark_data: [
        { category: "widgets", metric: "unit_price", percentile_50: 100, percentile_75: 110, period_end: "2026-04-01" },
      ],
      preferred_vendors: [],
      vendor_health_scores: [], anomaly_flags: [], contracts: [], compliance_documents: [],
      invoices: [], vendor_scorecards: [],
      ai_insights: [],
    });
    const res = await runInsightsForEntity({ admin, entityId: "e1", now });
    expect(res.inserted).toBeGreaterThan(0);
    const row = admin._inserted.ai_insights[0];
    expect(row.entity_id).toBe("e1");
    expect(row.type).toBeTruthy();
    const exp = new Date(row.expires_at);
    const gen = new Date(row.generated_at);
    expect(Math.round((exp - gen) / 86400000)).toBe(30);
  });
});
