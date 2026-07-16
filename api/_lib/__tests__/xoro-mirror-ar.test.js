// Cross-cutter T10-2 — AR mirror function tests.
//
// Mocks supabase as an in-memory table store with a chainable query builder
// that supports the operators ar.js uses:
//   .from(table).select(cols).eq(col, val).gte(col, val).lt(col, val).maybeSingle()
//   .from(table).insert(row).select(cols).maybeSingle()
//   .from(table).insert([rows])
//   .from(table).update(patch).eq(col, val)
//   .from(table).delete().eq(col, val).eq(col2, val2)
//
// `awaiting` the final builder resolves with { data, error }.

import { describe, it, expect, beforeEach } from "vitest";
import {
  mirrorArForDate,
  isISODate,
  addDaysISO,
  dayBounds,
  toCents,
  composeLine,
  composeInvoiceHeader,
  groupByInvoice,
  resolveCustomerId,
  maybeExplodeLines,
} from "../xoro-mirror/ar.js";
import {
  allocateProportional,
  normalizeInvoicePayloadLines,
  composeExplodedLines,
  buildExplodedInvoiceLines,
} from "../xoro-mirror/ar-sizegrain.js";

const ENTITY_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ENTITY_ID = "00000000-0000-0000-0000-0000000000ff";

// ─── Mock Supabase ──────────────────────────────────────────────────────────

/**
 * Build a mock supabase from a seed of { tableName: rows[] }.
 * Returns { sb, store, hooks } so tests can inject errors per table/op.
 */
function makeSupabase(seed = {}) {
  const store = {};
  for (const [k, v] of Object.entries(seed)) {
    store[k] = v.map((r) => ({ ...r }));
  }
  // hooks[`${table}.${op}`] = { error: <Error-shape>, throw: <Error> }
  const hooks = {};
  let idSeq = 1000;
  function nextId() {
    return `aaaaaaaa-aaaa-aaaa-aaaa-${String(idSeq++).padStart(12, "0")}`;
  }

  function tableBuilder(table) {
    let mode = "select";
    let selectCols = "*";
    let filters = []; // { op, col, val }
    let patch = null;
    let toInsert = null;
    let postSelect = false;
    let postSelectCols = "*";
    let rangeWindow = null; // [fromIdx, toIdx] inclusive, PostgREST-style

    function applyFilters(rows) {
      return rows.filter((row) => {
        for (const f of filters) {
          if (f.op === "eq" && row[f.col] !== f.val) return false;
          if (f.op === "gte" && !(row[f.col] >= f.val)) return false;
          if (f.op === "lt" && !(row[f.col] < f.val)) return false;
          if (f.op === "is" && f.val === null && !(row[f.col] === null || row[f.col] === undefined)) return false;
          if (f.op === "is" && f.val !== null && row[f.col] !== f.val) return false;
          if (f.op === "in" && !(Array.isArray(f.val) && f.val.includes(row[f.col]))) return false;
        }
        return true;
      });
    }

    function settle() {
      const hookKey = `${table}.${mode}`;
      const hook = hooks[hookKey];
      if (hook?.throw) throw hook.throw;
      if (hook?.error) return { data: null, error: hook.error };

      if (mode === "select") {
        let rows = applyFilters(store[table] || []);
        if (rangeWindow) rows = rows.slice(rangeWindow[0], rangeWindow[1] + 1);
        return { data: rows, error: null };
      }
      if (mode === "insert") {
        const rows = Array.isArray(toInsert) ? toInsert : [toInsert];
        const inserted = rows.map((r) => ({ id: r.id || nextId(), ...r }));
        store[table] = (store[table] || []).concat(inserted);
        if (postSelect) {
          return { data: inserted, error: null };
        }
        return { data: null, error: null };
      }
      if (mode === "update") {
        const target = applyFilters(store[table] || []);
        for (const row of target) {
          Object.assign(row, patch);
        }
        return { data: target, error: null };
      }
      if (mode === "delete") {
        const before = store[table] || [];
        const keep = before.filter((row) => {
          for (const f of filters) {
            if (f.op === "eq" && row[f.col] !== f.val) return true;
          }
          return false;
        });
        store[table] = keep;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    const builder = {
      select(cols = "*") { selectCols = cols; if (mode === "insert") { postSelect = true; postSelectCols = cols; } return builder; },
      eq(col, val) { filters.push({ op: "eq", col, val }); return builder; },
      is(col, val) { filters.push({ op: "is", col, val }); return builder; },
      in(col, vals) { filters.push({ op: "in", col, val: vals }); return builder; },
      gte(col, val) { filters.push({ op: "gte", col, val }); return builder; },
      lt(col, val) { filters.push({ op: "lt", col, val }); return builder; },
      // range(from, to): slice the settled rows like PostgREST pagination.
      // Added when loadSizeSourceFromRawPayloads went paginated (#1824) — the
      // mock must grow a method whenever mirrored code adds a query filter.
      range(fromIdx, toIdx) { rangeWindow = [fromIdx, toIdx]; return builder; },
      insert(rows) { mode = "insert"; toInsert = rows; return builder; },
      update(p) { mode = "update"; patch = p; return builder; },
      delete() { mode = "delete"; return builder; },
      maybeSingle() {
        const res = settle();
        if (res.error) return Promise.resolve(res);
        const data = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
        return Promise.resolve({ data, error: null });
      },
      then(resolve, reject) {
        try {
          const res = settle();
          resolve(res);
        } catch (e) {
          reject(e);
        }
      },
    };
    void selectCols; void postSelectCols;
    return builder;
  }

  const sb = { from: tableBuilder };
  return { sb, store, hooks };
}

// ─── Tiny helpers ───────────────────────────────────────────────────────────

function srcRow({
  id = `src-${Math.random().toString(36).slice(2, 8)}`,
  sku_id = "sku-1",
  customer_id = "ipc-1",
  invoice_number = "INV-100",
  txn_date = "2026-05-28",
  qty = 10,
  unit_price = 12.50,
  net_amount = null,
  gross_amount = null,
  description = null,
} = {}) {
  return {
    id, sku_id, customer_id, invoice_number, txn_date,
    qty, qty_units: qty, unit_price,
    gross_amount, discount_amount: 0, net_amount, description,
  };
}

function seedHappyPath(mirror_date = "2026-05-28") {
  return {
    ip_sales_history_wholesale: [
      srcRow({ id: "s1", invoice_number: "INV-100", txn_date: mirror_date, qty: 2, unit_price: 10, net_amount: 20 }),
      srcRow({ id: "s2", invoice_number: "INV-100", txn_date: mirror_date, qty: 3, unit_price: 5, net_amount: 15 }),
      srcRow({ id: "s3", invoice_number: "INV-101", txn_date: mirror_date, qty: 1, unit_price: 100, net_amount: 100 }),
      srcRow({ id: "s4", invoice_number: "INV-101", txn_date: mirror_date, qty: 4, unit_price: 25, net_amount: 100 }),
      srcRow({ id: "s5", invoice_number: "INV-102", txn_date: mirror_date, qty: 5, unit_price: 8.50, net_amount: 42.50 }),
      srcRow({ id: "s6", invoice_number: "INV-102", txn_date: mirror_date, qty: 2, unit_price: 7.25, net_amount: 14.50 }),
    ],
    ip_customer_master: [
      { id: "ipc-1", customer_code: "CUST-A", name: "Customer A" },
    ],
    customers: [
      { id: "c-A", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A", name: "Customer A" },
    ],
    ar_invoices: [],
    ar_invoice_lines: [],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════════════════════

describe("isISODate", () => {
  it("accepts well-formed dates", () => {
    expect(isISODate("2026-05-28")).toBe(true);
    expect(isISODate("2024-01-01")).toBe(true);
  });
  it("rejects malformed", () => {
    expect(isISODate("2026-5-28")).toBe(false);
    expect(isISODate("28/05/2026")).toBe(false);
    expect(isISODate("")).toBe(false);
    expect(isISODate(null)).toBe(false);
    expect(isISODate(undefined)).toBe(false);
  });
  it("rejects calendar-invalid", () => {
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-13-01")).toBe(false);
  });
});

describe("addDaysISO", () => {
  it("adds days correctly", () => {
    expect(addDaysISO("2026-05-28", 1)).toBe("2026-05-29");
    expect(addDaysISO("2026-05-28", 30)).toBe("2026-06-27");
  });
  it("handles month rollover", () => {
    expect(addDaysISO("2026-01-31", 1)).toBe("2026-02-01");
  });
  it("handles year rollover", () => {
    expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("dayBounds", () => {
  it("returns start = date, end = next day", () => {
    expect(dayBounds("2026-05-28")).toEqual({ start: "2026-05-28", end: "2026-05-29" });
  });
});

describe("toCents", () => {
  it("converts dollars to cents", () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents("9.99")).toBe(999);
  });
  it("returns 0 for null/undefined/NaN", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("not-a-number")).toBe(0);
  });
  it("rounds half-up", () => {
    expect(toCents(0.105)).toBe(11);
    // 0.105 floats to 0.10500000000000001 so Math.round = 11 cents.
  });
});

describe("composeLine", () => {
  it("uses net_amount when set", () => {
    const r = composeLine("inv-1", 1, srcRow({ qty: 2, unit_price: 10, net_amount: 18 }));
    expect(r.line_total_cents).toBe(1800);
    expect(r.source).toBe("xoro_mirror");
    expect(r.ar_invoice_id).toBe("inv-1");
    expect(r.line_number).toBe(1);
  });
  it("falls back to gross_amount", () => {
    const r = composeLine("inv-1", 2, { qty: 1, unit_price: 5, gross_amount: 7 });
    expect(r.line_total_cents).toBe(700);
  });
  it("falls back to qty * unit_price", () => {
    const r = composeLine("inv-1", 3, { qty: 3, unit_price: 4 });
    expect(r.line_total_cents).toBe(1200);
  });
  it("zeros out when nothing is set", () => {
    const r = composeLine("inv-1", 4, {});
    expect(r.line_total_cents).toBe(0);
  });
  it("carries sku_id, qty, unit_price_cents", () => {
    const r = composeLine("inv-1", 1, srcRow({ sku_id: "sku-X", qty: 7, unit_price: 1.25 }));
    expect(r.inventory_item_id).toBe("sku-X");
    expect(r.quantity).toBe(7);
    expect(r.unit_price_cents).toBe(125);
  });
});

describe("composeInvoiceHeader", () => {
  it("defaults due_date to invoice_date + 30 when missing", () => {
    const h = composeInvoiceHeader({
      entity_id: ENTITY_ID,
      customer_id: "c-1",
      group: { invoice_number: "INV-1", invoice_date: "2026-05-28", due_date: null },
      total_amount_cents: 1000,
    });
    expect(h.due_date).toBe("2026-06-27");
    expect(h.gl_status).toBe("unposted");
    expect(h.invoice_kind).toBe("customer_invoice");
    expect(h.source).toBe("xoro_mirror");
  });
  it("uses Xoro-supplied due_date when present", () => {
    const h = composeInvoiceHeader({
      entity_id: ENTITY_ID,
      customer_id: "c-1",
      group: { invoice_number: "INV-1", invoice_date: "2026-05-28", due_date: "2026-07-01" },
      total_amount_cents: 1000,
    });
    expect(h.due_date).toBe("2026-07-01");
  });
});

describe("groupByInvoice", () => {
  it("groups rows sharing invoice_number", () => {
    const groups = groupByInvoice([
      srcRow({ invoice_number: "A" }),
      srcRow({ invoice_number: "A" }),
      srcRow({ invoice_number: "B" }),
    ]);
    expect(groups.size).toBe(2);
    expect(groups.get("A").lines.length).toBe(2);
    expect(groups.get("B").lines.length).toBe(1);
  });
  it("drops rows with no invoice_number", () => {
    const groups = groupByInvoice([
      srcRow({ invoice_number: null }),
      srcRow({ invoice_number: "" }),
      srcRow({ invoice_number: "A" }),
    ]);
    expect(groups.size).toBe(1);
  });
  it("captures invoice_date from first row", () => {
    const groups = groupByInvoice([
      srcRow({ invoice_number: "A", txn_date: "2026-05-28" }),
    ]);
    expect(groups.get("A").invoice_date).toBe("2026-05-28");
  });
});

describe("resolveCustomerId", () => {
  it("returns null when src_customer_id is missing", async () => {
    const { sb } = makeSupabase({});
    const r = await resolveCustomerId(sb, { entity_id: ENTITY_ID, src_customer_id: null });
    expect(r.customer_id).toBe(null);
  });
  it("resolves via ip_customer_master.customer_code → customers.customer_code", async () => {
    const { sb } = makeSupabase({
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-A", name: "A" }],
      customers: [{ id: "c-A", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A" }],
    });
    const r = await resolveCustomerId(sb, { entity_id: ENTITY_ID, src_customer_id: "ipc-1" });
    expect(r.customer_id).toBe("c-A");
    expect(r.code).toBe("CUST-A");
  });
  it("returns null + code when ip_customer_master row missing", async () => {
    const { sb } = makeSupabase({ ip_customer_master: [], customers: [] });
    const r = await resolveCustomerId(sb, { entity_id: ENTITY_ID, src_customer_id: "ipc-ghost" });
    expect(r.customer_id).toBe(null);
    expect(r.code).toBe(null);
  });
  it("returns null when customers row missing in entity", async () => {
    const { sb } = makeSupabase({
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-X", name: "X" }],
      customers: [{ id: "c-A", entity_id: OTHER_ENTITY_ID, code: "CUST-X", customer_code: "CUST-X" }],
    });
    const r = await resolveCustomerId(sb, { entity_id: ENTITY_ID, src_customer_id: "ipc-1" });
    expect(r.customer_id).toBe(null);
    expect(r.code).toBe("CUST-X");
  });
  it("never resolves to a soft-deleted (merged-away) duplicate", async () => {
    const { sb } = makeSupabase({
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-A", name: "AMAZON FBM" }],
      customers: [{ id: "c-dupe", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A", deleted_at: "2026-07-15T00:00:00Z" }],
    });
    const r = await resolveCustomerId(sb, { entity_id: ENTITY_ID, src_customer_id: "ipc-1" });
    expect(r.customer_id).toBe(null);
    expect(r.code).toBe("CUST-A");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// mirrorArForDate — integration with mock supabase
// ════════════════════════════════════════════════════════════════════════════

describe("mirrorArForDate — input validation", () => {
  it("returns errors[bad_entity] when entity_id is empty", async () => {
    const { sb } = makeSupabase({});
    const r = await mirrorArForDate(sb, "", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.errors[0].kind).toBe("bad_entity");
  });
  it("returns errors[bad_date] when mirror_date is malformed", async () => {
    const { sb } = makeSupabase({});
    const r = await mirrorArForDate(sb, ENTITY_ID, "not-a-date");
    expect(r.errors[0].kind).toBe("bad_date");
  });
});

describe("mirrorArForDate — happy path", () => {
  let sb, store, summary;
  beforeEach(async () => {
    const m = makeSupabase(seedHappyPath());
    sb = m.sb; store = m.store;
    summary = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
  });

  it("upserts 3 ar_invoices", () => {
    expect(summary.rows_upserted).toBe(3);
    expect(store.ar_invoices.length).toBe(3);
  });
  it("inserts 6 ar_invoice_lines (2 lines per invoice × 3 invoices)", () => {
    expect(store.ar_invoice_lines.length).toBe(6);
  });
  it("all rows tagged source='xoro_mirror'", () => {
    expect(store.ar_invoices.every((r) => r.source === "xoro_mirror")).toBe(true);
    expect(store.ar_invoice_lines.every((r) => r.source === "xoro_mirror")).toBe(true);
  });
  it("total_amount_cents = sum of line cents", () => {
    const inv100 = store.ar_invoices.find((r) => r.invoice_number === "INV-100");
    expect(inv100.total_amount_cents).toBe(2000 + 1500); // 20 + 15
    const inv101 = store.ar_invoices.find((r) => r.invoice_number === "INV-101");
    expect(inv101.total_amount_cents).toBe(10000 + 10000); // 100 + 100
  });
  it("invoice_date pulled from txn_date when no invoice_date column", () => {
    const inv100 = store.ar_invoices.find((r) => r.invoice_number === "INV-100");
    expect(inv100.invoice_date).toBe("2026-05-28");
  });
  it("default due_date = invoice_date + 30", () => {
    const inv100 = store.ar_invoices.find((r) => r.invoice_number === "INV-100");
    expect(inv100.due_date).toBe("2026-06-27");
  });
  it("customer_id resolved to c-A on all invoices", () => {
    expect(store.ar_invoices.every((r) => r.customer_id === "c-A")).toBe(true);
  });
  it("rows_unchanged is 0 on a fresh mirror", () => {
    expect(summary.rows_unchanged).toBe(0);
  });
  it("rows_skipped_manual_conflict is 0 on a fresh mirror", () => {
    expect(summary.rows_skipped_manual_conflict).toBe(0);
  });
  it("no errors on happy path", () => {
    expect(summary.errors.length).toBe(0);
  });
  it("ar_invoices have invoice_kind='customer_invoice' + gl_status='unposted'", () => {
    for (const inv of store.ar_invoices) {
      expect(inv.invoice_kind).toBe("customer_invoice");
      expect(inv.gl_status).toBe("unposted");
    }
  });
});

describe("mirrorArForDate — unmatched customer", () => {
  it("pushes error + skips the invoice rather than failing the run", async () => {
    const seed = seedHappyPath();
    // Add a 4th invoice with a customer that doesn't resolve.
    seed.ip_sales_history_wholesale.push(
      srcRow({ id: "s7", invoice_number: "INV-103", txn_date: "2026-05-28", customer_id: "ipc-MISSING" }),
    );
    const { sb, store } = makeSupabase(seed);
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.rows_upserted).toBe(3); // first 3 still landed
    const unmatched = r.errors.find((e) => e.kind === "unmatched_customer");
    expect(unmatched).toBeTruthy();
    expect(unmatched.invoice_number).toBe("INV-103");
    expect(store.ar_invoices.find((i) => i.invoice_number === "INV-103")).toBeUndefined();
  });
  it("unmatched customer with no ipc row still routes to errors", async () => {
    const seed = seedHappyPath();
    // Different customer id that points to nothing in ip_customer_master.
    seed.ip_sales_history_wholesale = [
      srcRow({ id: "lone", invoice_number: "INV-X", txn_date: "2026-05-28", customer_id: "ipc-NONE" }),
    ];
    const { sb } = makeSupabase(seed);
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.errors.some((e) => e.kind === "unmatched_customer")).toBe(true);
  });
});

describe("mirrorArForDate — manual conflict", () => {
  it("skips an invoice whose existing row was operator-typed (source='manual')", async () => {
    const seed = seedHappyPath();
    seed.ar_invoices.push({
      id: "existing-100",
      entity_id: ENTITY_ID,
      invoice_number: "INV-100",
      source: "manual",
      total_amount_cents: 99999,
      invoice_date: "2026-05-28",
      due_date: "2026-06-27",
      customer_id: "c-A",
    });
    const { sb, store } = makeSupabase(seed);
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.rows_skipped_manual_conflict).toBe(1);
    expect(r.errors.some((e) => e.kind === "manual_conflict" && e.invoice_number === "INV-100")).toBe(true);
    // Manual row's totals untouched.
    const manual = store.ar_invoices.find((i) => i.id === "existing-100");
    expect(manual.total_amount_cents).toBe(99999);
    // The other 2 invoices still landed.
    expect(r.rows_upserted).toBe(2);
  });
  it("does NOT delete xoro_mirror lines under a manual header", async () => {
    const seed = seedHappyPath();
    seed.ar_invoices.push({
      id: "existing-100",
      entity_id: ENTITY_ID,
      invoice_number: "INV-100",
      source: "manual",
      total_amount_cents: 0,
      invoice_date: "2026-05-28",
      due_date: "2026-06-27",
      customer_id: "c-A",
    });
    // Add a phantom 'manual' line that should NOT be touched.
    seed.ar_invoice_lines.push({
      id: "manual-line",
      ar_invoice_id: "existing-100",
      line_number: 1,
      source: "manual",
      line_total_cents: 50,
    });
    const { sb, store } = makeSupabase(seed);
    await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(store.ar_invoice_lines.find((l) => l.id === "manual-line")).toBeTruthy();
  });
});

describe("mirrorArForDate — idempotent re-mirror", () => {
  it("UPDATEs the existing xoro_mirror row without inflating rows_upserted on identical re-run", async () => {
    const seed = seedHappyPath();
    const { sb, store } = makeSupabase(seed);
    const r1 = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r1.rows_upserted).toBe(3);

    // Second mirror: same source rows, no header drift.
    const r2 = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r2.rows_upserted).toBe(0);
    expect(r2.rows_unchanged).toBe(3);
    expect(store.ar_invoices.length).toBe(3); // didn't duplicate
    expect(store.ar_invoice_lines.length).toBe(6); // lines wiped + reinserted
  });

  it("counts as rows_upserted (not unchanged) when total_amount_cents drifts", async () => {
    const seed = seedHappyPath();
    const { sb, store } = makeSupabase(seed);
    await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");

    // Mutate source row so total changes.
    const src = store.ip_sales_history_wholesale.find((r) => r.id === "s1");
    src.net_amount = 50;

    const r2 = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r2.rows_upserted).toBeGreaterThanOrEqual(1);
    const inv100 = store.ar_invoices.find((r) => r.invoice_number === "INV-100");
    expect(inv100.total_amount_cents).toBe(5000 + 1500); // 50 + 15
  });

  it("preserves manual lines while wiping xoro_mirror lines on re-run", async () => {
    const seed = seedHappyPath();
    const { sb, store } = makeSupabase(seed);
    await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");

    // Operator types a manual extra line on the mirrored invoice.
    const inv100 = store.ar_invoices.find((r) => r.invoice_number === "INV-100");
    store.ar_invoice_lines.push({
      id: "manual-extra",
      ar_invoice_id: inv100.id,
      line_number: 99,
      source: "manual",
      line_total_cents: 777,
    });

    // Re-mirror: should leave the manual line alone.
    await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(store.ar_invoice_lines.find((l) => l.id === "manual-extra")).toBeTruthy();
    // xoro_mirror lines still present (re-inserted): 2 per invoice × 3 invoices
    const mirrored = store.ar_invoice_lines.filter((l) => l.source === "xoro_mirror");
    expect(mirrored.length).toBe(6);
  });
});

describe("mirrorArForDate — empty input", () => {
  it("returns clean zero counters when no source rows exist for the date", async () => {
    const { sb } = makeSupabase({
      ip_sales_history_wholesale: [],
      ip_customer_master: [],
      customers: [],
      ar_invoices: [],
      ar_invoice_lines: [],
    });
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r).toEqual({
      rows_upserted: 0,
      rows_unchanged: 0,
      rows_skipped_manual_conflict: 0,
      errors: [],
    });
  });

  it("ignores rows from a different day (txn_date filter works)", async () => {
    const seed = seedHappyPath("2026-05-27"); // all seeded on the 27th
    const { sb } = makeSupabase(seed);
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28"); // ask for the 28th
    expect(r.rows_upserted).toBe(0);
  });
});

describe("mirrorArForDate — supabase error handling", () => {
  it("catches source read error + records in errors", async () => {
    const { sb, hooks } = makeSupabase(seedHappyPath());
    hooks["ip_sales_history_wholesale.select"] = { error: { message: "boom" } };
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.errors[0].kind).toBe("source_read_failed");
    expect(r.errors[0].message).toBe("boom");
  });

  it("catches thrown source read + records source_read_threw", async () => {
    const { sb, hooks } = makeSupabase(seedHappyPath());
    hooks["ip_sales_history_wholesale.select"] = { throw: new Error("network gone") };
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.errors[0].kind).toBe("source_read_threw");
  });

  it("catches insert failure + continues to next invoice group", async () => {
    const seed = seedHappyPath();
    const { sb, hooks } = makeSupabase(seed);
    hooks["ar_invoices.insert"] = { error: { message: "constraint" } };
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    // All 3 fail on insert, but errors carry the failures, not crash.
    expect(r.rows_upserted).toBe(0);
    expect(r.errors.filter((e) => e.kind === "insert_failed").length).toBe(3);
  });

  it("catches lines insert failure + records lines_insert_failed", async () => {
    const { sb, hooks } = makeSupabase(seedHappyPath());
    hooks["ar_invoice_lines.insert"] = { error: { message: "lines bad" } };
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.errors.some((e) => e.kind === "lines_insert_failed")).toBe(true);
  });
});

describe("mirrorArForDate — line composition edge cases", () => {
  it("falls back to qty * unit_price when net_amount is null", async () => {
    const seed = {
      ip_sales_history_wholesale: [
        srcRow({ id: "lone", invoice_number: "INV-EDGE", txn_date: "2026-05-28", qty: 3, unit_price: 4, net_amount: null, gross_amount: null }),
      ],
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-A", name: "A" }],
      customers: [{ id: "c-A", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A" }],
      ar_invoices: [],
      ar_invoice_lines: [],
    };
    const { sb, store } = makeSupabase(seed);
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(store.ar_invoices[0].total_amount_cents).toBe(1200);
  });

  it("falls back to gross_amount when net_amount is null", async () => {
    const seed = {
      ip_sales_history_wholesale: [
        srcRow({ id: "lone", invoice_number: "INV-G", txn_date: "2026-05-28", net_amount: null, gross_amount: 7.77 }),
      ],
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-A", name: "A" }],
      customers: [{ id: "c-A", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A" }],
      ar_invoices: [],
      ar_invoice_lines: [],
    };
    const { sb, store } = makeSupabase(seed);
    await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(store.ar_invoices[0].total_amount_cents).toBe(777);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Size-grain explosion (deliverable 2)
// ════════════════════════════════════════════════════════════════════════════

describe("allocateProportional", () => {
  it("splits exactly and preserves the total", () => {
    expect(allocateProportional(100, [6, 4])).toEqual([60, 40]);
    const p = allocateProportional(10000, [6000, 4000]);
    expect(p.reduce((a, b) => a + b, 0)).toBe(10000);
  });
  it("hands the rounding remainder to the largest fractional remainder", () => {
    const p = allocateProportional(10, [1, 1, 1]);
    expect(p.reduce((a, b) => a + b, 0)).toBe(10);
    expect(p).toEqual([4, 3, 3]);
  });
  it("even-splits when all weights are zero", () => {
    expect(allocateProportional(7, [0, 0, 0])).toEqual([3, 2, 2]);
  });
  it("returns zeros for total 0", () => {
    expect(allocateProportional(0, [5, 5])).toEqual([0, 0]);
  });
  it("is cents-exact on a discounted (indivisible) total", () => {
    const p = allocateProportional(9499, [7, 3]);
    expect(p.reduce((a, b) => a + b, 0)).toBe(9499);
  });
});

describe("normalizeInvoicePayloadLines", () => {
  const rec = {
    invoiceHeader: { InvoiceNumber: "PT-I001348" },
    invoiceItemLineArr: [
      { Id: 1, ItemNumber: "PTYG0001H-Black-M", Qty: 6, TotalAmount: 42, Discount: 0 },
      { Id: 2, ItemNumber: "PTYG0001H-Black-L", Qty: 4, TotalAmount: 28, Discount: 0 },
      { Id: 3, ItemNumber: "", Qty: 1, TotalAmount: 5 },
    ],
  };
  it("reads the invoice number from the header", () => {
    expect(normalizeInvoicePayloadLines(rec).invoice_number).toBe("PT-I001348");
  });
  it("keeps only lines with a SKU and carries size + net cents", () => {
    const { lines } = normalizeInvoicePayloadLines(rec);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ canon_sku: "PTYG0001H-BLACK-M", style_color: "PTYG0001H-BLACK", size: "M", qty: 6, net_cents: 4200 });
  });
  it("computes net = gross - discount in cents", () => {
    const { lines } = normalizeInvoicePayloadLines({
      invoiceHeader: { InvoiceNumber: "X" },
      invoiceItemLineArr: [{ ItemNumber: "A-RED-M", Qty: 2, TotalAmount: 20, Discount: 3 }],
    });
    expect(lines[0].net_cents).toBe(1700);
  });
});

describe("composeExplodedLines", () => {
  const resolve = (e) => ({ "A-RED-M": "id-m", "A-RED-L": "id-l" }[e.canon_sku] || null);
  const sizeLines = [
    { canon_sku: "A-RED-M", size: "M", qty: 6, net_cents: 6000, item_number: "A-RED-M" },
    { canon_sku: "A-RED-L", size: "L", qty: 4, net_cents: 4000, item_number: "A-RED-L" },
  ];
  it("preserves the line total to the cent", () => {
    const out = composeExplodedLines({ line_number: 1, line_total_cents: 10000, quantity: 10 }, sizeLines, resolve);
    expect(out.reduce((a, l) => a + l.line_total_cents, 0)).toBe(10000);
  });
  it("preserves the total quantity", () => {
    const out = composeExplodedLines({ line_number: 1, line_total_cents: 10000, quantity: 10 }, sizeLines, resolve);
    expect(out.reduce((a, l) => a + l.quantity, 0)).toBe(10);
  });
  it("sets unit_price_cents null when qty*unit cannot reproduce the total (trigger-safe)", () => {
    const out = composeExplodedLines({ line_number: 1, line_total_cents: 9499, quantity: 10 }, sizeLines, resolve);
    expect(out.reduce((a, l) => a + l.line_total_cents, 0)).toBe(9499);
    expect(out.some((l) => l.unit_price_cents === null)).toBe(true);
  });
  it("sets a clean unit_price_cents when it divides exactly", () => {
    const out = composeExplodedLines({ line_number: 1, line_total_cents: 10000, quantity: 10 }, sizeLines, resolve);
    expect(out.every((l) => l.unit_price_cents === 1000)).toBe(true);
  });
  it("returns null when a size item cannot be resolved (keeps the rollup)", () => {
    const out = composeExplodedLines({ line_number: 1, line_total_cents: 10000, quantity: 10 }, sizeLines, () => null);
    expect(out).toBeNull();
  });
  it("returns null when there are no size lines", () => {
    expect(composeExplodedLines({ line_number: 1, line_total_cents: 100 }, [], resolve)).toBeNull();
  });
});

describe("buildExplodedInvoiceLines", () => {
  const resolve = (e) => ({ "A-RED-M": "id-m", "A-RED-L": "id-l" }[e.canon_sku] || null);
  const sizeLines = [
    { canon_sku: "A-RED-M", size: "M", qty: 6, net_cents: 6000, style_color: "A-RED" },
    { canon_sku: "A-RED-L", size: "L", qty: 4, net_cents: 4000, style_color: "A-RED" },
  ];
  it("explodes matched rollups and re-sequences line numbers", () => {
    const rollups = [{ line_number: 1, line_total_cents: 10000, quantity: 10, _style_color: "A-RED" }];
    const { lines, explodedRollups, keptRollups } = buildExplodedInvoiceLines(rollups, sizeLines, resolve);
    expect(explodedRollups).toBe(1);
    expect(keptRollups).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.line_number)).toEqual([1, 2]);
    expect(lines.reduce((a, l) => a + l.line_total_cents, 0)).toBe(10000);
  });
  it("passes through rollups with no matching size bucket", () => {
    const rollups = [{ line_number: 1, line_total_cents: 500, quantity: 5, _style_color: "B-BLUE" }];
    const { lines, explodedRollups, keptRollups } = buildExplodedInvoiceLines(rollups, sizeLines, resolve);
    expect(explodedRollups).toBe(0);
    expect(keptRollups).toBe(1);
    expect(lines).toHaveLength(1);
  });
});

describe("maybeExplodeLines (mock-integrated)", () => {
  function seed() {
    return {
      ip_item_master: [
        { id: "item-sc", sku_code: "A-RED" },
        { id: "item-m", sku_code: "A-RED-M" },
        { id: "item-l", sku_code: "A-RED-L" },
      ],
    };
  }
  const composed = [{ line_number: 1, inventory_item_id: "item-sc", line_total_cents: 10000, quantity: 10, source: "xoro_mirror", description: null }];
  it("explodes into per-size lines when the invoice is covered", async () => {
    const { sb } = makeSupabase(seed());
    const sizeSource = new Map([["INV-1", [
      { canon_sku: "A-RED-M", size: "M", qty: 6, net_cents: 6000, style_color: "A-RED" },
      { canon_sku: "A-RED-L", size: "L", qty: 4, net_cents: 4000, style_color: "A-RED" },
    ]]]);
    const out = await maybeExplodeLines(sb, { entity_id: ENTITY_ID, invoice_number: "INV-1", composedLines: composed, sizeSource });
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.inventory_item_id).sort()).toEqual(["item-l", "item-m"]);
    expect(out.reduce((a, l) => a + l.line_total_cents, 0)).toBe(10000);
    expect(out.every((l) => l._style_color === undefined)).toBe(true);
  });
  it("is a no-op when the invoice has no size coverage", async () => {
    const { sb } = makeSupabase(seed());
    const out = await maybeExplodeLines(sb, { entity_id: ENTITY_ID, invoice_number: "INV-UNCOVERED", composedLines: composed, sizeSource: new Map() });
    expect(out).toBe(composed);
  });
});

describe("mirrorArForDate — size-grain explosion end to end", () => {
  it("mirrors a covered invoice as per-size lines summing to the invoice total", async () => {
    const seed = {
      ip_sales_history_wholesale: [
        srcRow({ id: "s1", sku_id: "item-sc", invoice_number: "INV-100", txn_date: "2026-05-28", qty: 10, unit_price: 10, net_amount: 100 }),
      ],
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-A", name: "A" }],
      customers: [{ id: "c-A", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A" }],
      ip_item_master: [
        { id: "item-sc", sku_code: "PTYG0001H-BLACK" },
        { id: "item-m", sku_code: "PTYG0001H-BLACK-M" },
        { id: "item-l", sku_code: "PTYG0001H-BLACK-L" },
      ],
      raw_xoro_payloads: [
        { endpoint: "sales-history", payload: { data: [
          { invoiceHeader: { InvoiceNumber: "INV-100" }, invoiceItemLineArr: [
            { Id: 1, ItemNumber: "PTYG0001H-Black-M", Qty: 6, TotalAmount: 60, Discount: 0 },
            { Id: 2, ItemNumber: "PTYG0001H-Black-L", Qty: 4, TotalAmount: 40, Discount: 0 },
          ] },
        ] } },
      ],
      ar_invoices: [],
      ar_invoice_lines: [],
    };
    const { sb, store } = makeSupabase(seed);
    const r = await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    const lines = store.ar_invoice_lines.filter((l) => l.ar_invoice_id === store.ar_invoices[0].id);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.inventory_item_id).sort()).toEqual(["item-l", "item-m"]);
    expect(lines.reduce((a, l) => a + l.line_total_cents, 0)).toBe(10000);
    expect(store.ar_invoices[0].total_amount_cents).toBe(10000);
  });

  it("leaves an uncovered invoice as a single style+color rollup line", async () => {
    const seed = {
      ip_sales_history_wholesale: [
        srcRow({ id: "s1", sku_id: "item-sc", invoice_number: "INV-NOCOV", txn_date: "2026-05-28", qty: 10, unit_price: 10, net_amount: 100 }),
      ],
      ip_customer_master: [{ id: "ipc-1", customer_code: "CUST-A", name: "A" }],
      customers: [{ id: "c-A", entity_id: ENTITY_ID, code: "CUST-A", customer_code: "CUST-A" }],
      ip_item_master: [{ id: "item-sc", sku_code: "PTYG0001H-BLACK" }],
      raw_xoro_payloads: [],
      ar_invoices: [],
      ar_invoice_lines: [],
    };
    const { sb, store } = makeSupabase(seed);
    await mirrorArForDate(sb, ENTITY_ID, "2026-05-28");
    const lines = store.ar_invoice_lines.filter((l) => l.ar_invoice_id === store.ar_invoices[0].id);
    expect(lines).toHaveLength(1);
    expect(lines[0].inventory_item_id).toBe("item-sc");
    expect(store.ar_invoices[0].total_amount_cents).toBe(10000);
  });
});
