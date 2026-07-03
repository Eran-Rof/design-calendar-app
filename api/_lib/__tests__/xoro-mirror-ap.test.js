// Tests for the T10-3 AP shadow-mirror function.
//
// Architecture: docs/tangerine/T10-shadow-mirror-architecture.md §4.2.
//
// All tests run against an in-memory supabase double — no live DB.

import { describe, it, expect } from "vitest";
import {
  mirrorApForDate,
  buildInvoiceNumber,
  eventDateFor,
  parseMoney,
  pickIsoDate,
  resolveVendorId,
} from "../xoro-mirror/ap.js";
import { validateBody } from "../../_handlers/internal/xoro-mirror/ap.js";

// ──────────────────────────────────────────────────────────────────────────
// In-memory supabase double
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array} opts.tandaPos   rows in tanda_pos
 * @param {Array} opts.vendors    rows in vendors (each {id, code, aliases?})
 * @param {Array} opts.invoices   pre-existing rows in invoices (each {id, vendor_id, invoice_number, source})
 * @param {object} opts.errors    optional override map of `${table}:${op}` → error to inject
 */
function makeSupabase(opts) {
  const { tandaPos = [], vendors = [], invoices = [], errors = {} } = opts;
  const sb = {
    _inserts: [], // captures inserts (e.g. into invoices)
    _updates: [], // captures updates
    from(table) {
      if (table === "tanda_pos") {
        return makeTandaPosBuilder(tandaPos, errors);
      }
      if (table === "vendors") {
        return makeVendorsBuilder(vendors, errors);
      }
      if (table === "invoices") {
        return makeInvoicesBuilder(invoices, sb, errors);
      }
      if (table === "entities") {
        return makeEntitiesBuilder();
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

function makeTandaPosBuilder(rows, errors) {
  let filterStatuses = null;
  const builder = {
    select() { return builder; },
    in(col, values) {
      if (col === "status") filterStatuses = new Set(values);
      return builder;
    },
    then(resolve) {
      if (errors["tanda_pos:select"]) {
        return resolve({ data: null, error: { message: errors["tanda_pos:select"] } });
      }
      const out = filterStatuses
        ? rows.filter((r) => filterStatuses.has(r.status))
        : rows;
      return resolve({ data: out, error: null });
    },
  };
  return builder;
}

function makeVendorsBuilder(rows, errors) {
  let codeFilter = null;
  let aliasFilter = null;
  let nameFilter = null;  // ilike name match (step 4)
  let skipDeleted = false;
  const builder = {
    select() { return builder; },
    eq(col, val) { if (col === "code") codeFilter = val; return builder; },
    ilike(col, val) { if (col === "name") nameFilter = val?.toLowerCase(); return builder; },
    is(col, val) { if (col === "deleted_at" && val === null) skipDeleted = true; return builder; },
    contains(col, arr) {
      if (col === "aliases") aliasFilter = arr[0];
      return builder;
    },
    limit() { return builder; },
    maybeSingle() {
      if (errors["vendors:select"]) {
        return Promise.resolve({ data: null, error: { message: errors["vendors:select"] } });
      }
      const hit = rows.find((r) => r.code === codeFilter);
      return Promise.resolve({ data: hit || null, error: null });
    },
    then(resolve) {
      if (errors["vendors:select"]) {
        return resolve({ data: null, error: { message: errors["vendors:select"] } });
      }
      let hits = [];
      if (aliasFilter) {
        hits = rows.filter((r) => Array.isArray(r.aliases) && r.aliases.includes(aliasFilter));
      } else if (nameFilter) {
        hits = rows.filter((r) => {
          if (skipDeleted && r.deleted_at) return false;
          return (r.name || "").toLowerCase() === nameFilter;
        });
      }
      return resolve({ data: hits, error: null });
    },
  };
  return builder;
}

function makeInvoicesBuilder(rows, sb, errors) {
  let vendorIdFilter = null;
  let invoiceNumberFilter = null;
  let idFilter = null;
  let insertPayload = null;
  let updatePayload = null;
  const builder = {
    select() { return builder; },
    eq(col, val) {
      if (col === "vendor_id") vendorIdFilter = val;
      else if (col === "invoice_number") invoiceNumberFilter = val;
      else if (col === "id") idFilter = val;
      return builder;
    },
    maybeSingle() {
      if (errors["invoices:select"]) {
        return Promise.resolve({ data: null, error: { message: errors["invoices:select"] } });
      }
      const hit = rows.find(
        (r) => r.vendor_id === vendorIdFilter && r.invoice_number === invoiceNumberFilter,
      );
      return Promise.resolve({ data: hit || null, error: null });
    },
    insert(payload) {
      insertPayload = payload;
      if (errors["invoices:insert"]) {
        return Promise.resolve({ data: null, error: { message: errors["invoices:insert"] } });
      }
      const newRow = { id: `inv-${rows.length + 1}`, ...payload };
      rows.push(newRow);
      sb._inserts.push({ table: "invoices", payload });
      return Promise.resolve({ data: newRow, error: null });
    },
    update(payload) {
      updatePayload = payload;
      // The `update` call is chained with .eq("id", ...) which sets idFilter.
      // We return a thenable so `await supabase.from(...).update(...).eq(...)`
      // resolves correctly.
      const sub = {
        eq(col, val) {
          if (col === "id") idFilter = val;
          return sub;
        },
        then(resolve) {
          if (errors["invoices:update"]) {
            return resolve({ data: null, error: { message: errors["invoices:update"] } });
          }
          const idx = rows.findIndex((r) => r.id === idFilter);
          if (idx >= 0) rows[idx] = { ...rows[idx], ...updatePayload };
          sb._updates.push({ table: "invoices", id: idFilter, payload: updatePayload });
          return resolve({ data: null, error: null });
        },
      };
      return sub;
    },
  };
  return builder;
}

function makeEntitiesBuilder() {
  return {
    select() { return this; },
    eq() { return this; },
    maybeSingle() {
      return Promise.resolve({ data: { id: "ent-rof" }, error: null });
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────────

describe("parseMoney", () => {
  it("parses plain numeric strings", () => {
    expect(parseMoney("123.45")).toBe(123.45);
  });
  it("strips $ and commas", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
  });
  it("returns numbers unchanged", () => {
    expect(parseMoney(99)).toBe(99);
  });
  it("returns null for null/undefined/empty", () => {
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
  it("returns null for garbage", () => {
    expect(parseMoney("not money")).toBeNull();
  });
});

describe("pickIsoDate", () => {
  it("extracts YYYY-MM-DD prefix", () => {
    expect(pickIsoDate("2026-05-28T12:00:00Z")).toBe("2026-05-28");
    expect(pickIsoDate("2026-05-28")).toBe("2026-05-28");
  });
  it("returns null for falsy", () => {
    expect(pickIsoDate(null)).toBeNull();
    expect(pickIsoDate("")).toBeNull();
  });
});

describe("buildInvoiceNumber", () => {
  it("prefers data.VendorInvoiceNumber", () => {
    expect(buildInvoiceNumber({ po_number: "PO1", data: { VendorInvoiceNumber: "VINV-9" } })).toBe("VINV-9");
  });
  it("falls back to data.InvoiceNumber", () => {
    expect(buildInvoiceNumber({ po_number: "PO1", data: { InvoiceNumber: "INV-9" } })).toBe("INV-9");
  });
  it("falls back to XORO-<po_number>", () => {
    expect(buildInvoiceNumber({ po_number: "PO42", data: {} })).toBe("XORO-PO42");
  });
  it("falls back to XORO-unknown when both blank", () => {
    expect(buildInvoiceNumber({ data: {} })).toBe("XORO-unknown");
  });
});

describe("eventDateFor", () => {
  it("prefers DateClosed", () => {
    expect(eventDateFor({ data: { DateClosed: "2026-05-28", DateReceived: "2026-05-27" } })).toBe("2026-05-28");
  });
  it("falls back to DateReceived", () => {
    expect(eventDateFor({ data: { DateReceived: "2026-05-27" } })).toBe("2026-05-27");
  });
  it("falls back to date_expected_delivery on row", () => {
    expect(eventDateFor({ data: {}, date_expected_delivery: "2026-05-25" })).toBe("2026-05-25");
  });
  it("returns null when nothing available", () => {
    expect(eventDateFor({ data: {} })).toBeNull();
  });
});

describe("resolveVendorId", () => {
  it("trusts row.vendor_id when set", async () => {
    const sb = makeSupabase({ vendors: [] });
    const cache = new Map();
    expect(await resolveVendorId(sb, { vendor_id: "v-1", vendor: "irrelevant" }, cache)).toBe("v-1");
  });
  it("matches by vendors.code", async () => {
    const sb = makeSupabase({ vendors: [{ id: "v-2", code: "ACME" }] });
    const cache = new Map();
    expect(await resolveVendorId(sb, { vendor: "ACME" }, cache)).toBe("v-2");
  });
  it("matches by vendors.aliases", async () => {
    const sb = makeSupabase({ vendors: [{ id: "v-3", code: "DIFFERENT", aliases: ["Acme Inc"] }] });
    const cache = new Map();
    expect(await resolveVendorId(sb, { vendor: "Acme Inc" }, cache)).toBe("v-3");
  });
  it("returns null when no match", async () => {
    const sb = makeSupabase({ vendors: [{ id: "v-2", code: "OTHER" }] });
    const cache = new Map();
    expect(await resolveVendorId(sb, { vendor: "MISSING" }, cache)).toBeNull();
  });
  it("uses the cache on repeat lookups", async () => {
    const sb = makeSupabase({ vendors: [{ id: "v-2", code: "ACME" }] });
    const cache = new Map([["ACME", "cached-id"]]);
    expect(await resolveVendorId(sb, { vendor: "ACME" }, cache)).toBe("cached-id");
  });
  it("matches by vendors.name when code and aliases are empty (AP bill case)", async () => {
    // vendors.code=null + aliases=[] is the real prod state for Xoro-synced vendors.
    // The AP bill CSV "Vendor Name" must still resolve via the name column.
    const sb = makeSupabase({ vendors: [{ id: "v-fd", code: null, aliases: [], name: "FASHION DESIGN, LLC", deleted_at: null }] });
    const cache = new Map();
    expect(await resolveVendorId(sb, { vendor: "FASHION DESIGN, LLC" }, cache)).toBe("v-fd");
  });
  it("name match skips soft-deleted vendors", async () => {
    const sb = makeSupabase({ vendors: [
      { id: "v-old", code: null, aliases: [], name: "FASHION DESIGN, LLC", deleted_at: "2026-01-01" },
      { id: "v-live", code: null, aliases: [], name: "FASHION DESIGN, LLC", deleted_at: null },
    ]});
    const cache = new Map();
    expect(await resolveVendorId(sb, { vendor: "FASHION DESIGN, LLC" }, cache)).toBe("v-live");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// validateBody (handler)
// ──────────────────────────────────────────────────────────────────────────

describe("validateBody (handler)", () => {
  it("rejects missing mirror_date", () => {
    expect(validateBody({}).error).toMatch(/mirror_date is required/);
  });
  it("rejects bad mirror_date format", () => {
    expect(validateBody({ mirror_date: "5/28/2026" }).error).toMatch(/YYYY-MM-DD/);
  });
  it("accepts well-formed mirror_date", () => {
    const v = validateBody({ mirror_date: "2026-05-28" });
    expect(v.error).toBeUndefined();
    expect(v.data.mirror_date).toBe("2026-05-28");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// mirrorApForDate — main entry
// ──────────────────────────────────────────────────────────────────────────

describe("mirrorApForDate — input guards", () => {
  it("records error on missing entity_id", async () => {
    const sb = makeSupabase({});
    const r = await mirrorApForDate(sb, "", "2026-05-28");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/entity_id/);
  });
  it("records error on malformed mirror_date", () => {
    const sb = makeSupabase({});
    return mirrorApForDate(sb, "ent-1", "5/28/2026").then((r) => {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].reason).toMatch(/YYYY-MM-DD/);
    });
  });
});

describe("mirrorApForDate — happy paths", () => {
  it("upserts a fresh xoro_mirror AP bill for a Closed PO", async () => {
    const sb = makeSupabase({
      tandaPos: [
        {
          po_number: "PO-1",
          vendor: "ACME",
          vendor_id: null,
          status: "Closed",
          data: { DateClosed: "2026-05-28", TotalAmount: "1234.56" },
          uuid_id: "po-uuid-1",
        },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(r.rows_unchanged).toBe(0);
    expect(r.rows_skipped_manual_conflict).toBe(0);
    expect(r.errors).toEqual([]);
    expect(sb._inserts).toHaveLength(1);
    const payload = sb._inserts[0].payload;
    expect(payload.entity_id).toBe("ent-rof");
    expect(payload.vendor_id).toBe("v-acme");
    expect(payload.source).toBe("xoro_mirror");
    expect(payload.status).toBe("approved");
    expect(payload.currency).toBe("USD");
    expect(payload.invoice_kind).toBe("vendor_bill");
    expect(payload.invoice_number).toBe("XORO-PO-1");
    expect(payload.invoice_date).toBe("2026-05-28");
    expect(payload.total).toBe(1234.56);
    expect(payload.po_id).toBe("po-uuid-1");
  });

  it("dates the bill to the row's own Xoro event date (eventDateFor), not the mirror_date arg", async () => {
    // Lock-in for future multi-date runs: invoice_date is derived per-row from
    // eventDateFor (here it resolves from DateReceived, not DateClosed), so every
    // bill carries its true Xoro date by construction. The summary JE reconciles
    // by invoice_date, so a run spanning multiple dates posts each into its own
    // period. (In a single-date run eventDateFor === mirror_date, so this is
    // value-identical today — but it removes the run-level-date coupling.)
    const sb = makeSupabase({
      tandaPos: [{
        po_number: "PO-R", vendor: "ACME", status: "Closed",
        // Closed but no DateClosed → eventDateFor falls through to DateReceived,
        // and invoice_date must follow that resolved date (not the arg).
        data: { DateReceived: "2026-05-28", TotalAmount: "100" }, uuid_id: "po-r",
      }],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(sb._inserts[0].payload.invoice_date).toBe("2026-05-28"); // = eventDateFor(row) via DateReceived
  });

  it("upserts five Closed POs in one call", async () => {
    const tandaPos = [];
    for (let i = 0; i < 5; i++) {
      tandaPos.push({
        po_number: `PO-${i}`,
        vendor: "ACME",
        status: "Closed",
        data: { DateClosed: "2026-05-28", TotalAmount: `${100 + i}.00` },
        uuid_id: `uuid-${i}`,
      });
    }
    const sb = makeSupabase({
      tandaPos,
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(5);
    expect(sb._inserts).toHaveLength(5);
  });

  it("uses Xoro VendorInvoiceNumber when present", async () => {
    const sb = makeSupabase({
      tandaPos: [{
        po_number: "PO-1", vendor: "ACME", status: "Closed",
        data: { DateClosed: "2026-05-28", TotalAmount: "100", VendorInvoiceNumber: "ACME-9001" },
      }],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(sb._inserts[0].payload.invoice_number).toBe("ACME-9001");
  });

  it("recognizes status='Received' as receiving-complete", async () => {
    const sb = makeSupabase({
      tandaPos: [{
        po_number: "PO-R", vendor: "ACME", status: "Received",
        data: { DateReceived: "2026-05-28", TotalAmount: "50" },
      }],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
  });
});

describe("mirrorApForDate — filtering", () => {
  it("skips Partially Received POs", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-CL", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "10" } },
        { po_number: "PO-P1", vendor: "ACME", status: "Partially Received", data: { DateReceived: "2026-05-28", TotalAmount: "10" } },
        { po_number: "PO-P2", vendor: "ACME", status: "Partial Received", data: { DateReceived: "2026-05-28", TotalAmount: "10" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(sb._inserts[0].payload.invoice_number).toBe("XORO-PO-CL");
  });

  it("skips Cancelled POs", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-X", vendor: "ACME", status: "Cancelled", data: { DateClosed: "2026-05-28", TotalAmount: "10" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(sb._inserts).toHaveLength(0);
  });

  it("returns all-zero counts for a date with no matching events", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-X", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-27", TotalAmount: "10" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.rows_unchanged).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("returns zero counts when tanda_pos is empty", async () => {
    const sb = makeSupabase({ tandaPos: [], vendors: [], invoices: [] });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.rows_skipped_manual_conflict).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

describe("mirrorApForDate — vendor resolution", () => {
  it("records error and continues when vendor code is unmatched", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-G", vendor: "GHOST", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "10" } },
        { po_number: "PO-O", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "20" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].po_number).toBe("PO-G");
    expect(r.errors[0].reason).toMatch(/unmatched vendor/);
  });

  it("resolves via vendors.aliases", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-A", vendor: "ACME INC.", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "10" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME", aliases: ["ACME INC."] }],
      invoices: [],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(1);
    expect(sb._inserts[0].payload.vendor_id).toBe("v-acme");
  });
});

describe("mirrorApForDate — existing-bill conflict handling", () => {
  it("skips + counts when existing bill has source='manual'", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-M", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "10" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [
        { id: "existing-manual", vendor_id: "v-acme", invoice_number: "XORO-PO-M", source: "manual" },
      ],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.rows_skipped_manual_conflict).toBe(1);
    expect(sb._inserts).toHaveLength(0);
    expect(sb._updates).toHaveLength(0);
  });

  it("updates existing xoro_mirror bill (idempotent re-mirror)", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-I", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "99.99" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [
        { id: "existing-mirror", vendor_id: "v-acme", invoice_number: "XORO-PO-I", source: "xoro_mirror", total: 50 },
      ],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.rows_unchanged).toBe(1);
    expect(r.rows_skipped_manual_conflict).toBe(0);
    expect(sb._updates).toHaveLength(1);
    expect(sb._updates[0].payload.total).toBe(99.99);
  });

  it("skips when existing bill has source='shopify' too", async () => {
    // Defense in depth: only xoro_mirror rows should be overwritten.
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-S", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "10" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [
        { id: "existing-shopify", vendor_id: "v-acme", invoice_number: "XORO-PO-S", source: "shopify" },
      ],
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.rows_skipped_manual_conflict).toBe(1);
  });
});

describe("mirrorApForDate — error handling", () => {
  it("records error + returns when tanda_pos read fails", async () => {
    const sb = makeSupabase({ errors: { "tanda_pos:select": "boom" } });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.rows_upserted).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/tanda_pos read failed: boom/);
  });

  it("records error and continues loop on a per-row insert failure", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-OK", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "1" } },
        { po_number: "PO-FAIL", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "2" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
      errors: { "invoices:insert": "constraint violated" },
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    // Both rows attempted; both error because the injected error fires
    // for any insert call. Loop must continue, not throw.
    expect(r.rows_upserted).toBe(0);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0].reason).toMatch(/insert failed/);
    expect(r.errors[1].reason).toMatch(/insert failed/);
  });

  it("records error and continues loop on existing-bill probe failure", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-P", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "1" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
      errors: { "invoices:select": "select boom" },
    });
    const r = await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/existing-bill probe failed: select boom/);
  });
});

describe("mirrorApForDate — payload composition", () => {
  it("populates subtotal/tax/total + currency + status + source correctly", async () => {
    const sb = makeSupabase({
      tandaPos: [
        {
          po_number: "PO-X",
          vendor: "ACME",
          status: "Closed",
          data: {
            DateClosed: "2026-05-28",
            TotalAmount: "1100.00",
            SubTotal: "1000.00",
            TaxAmount: "100.00",
            DueDate: "2026-06-28",
          },
        },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    const p = sb._inserts[0].payload;
    expect(p.subtotal).toBe(1000);
    expect(p.tax).toBe(100);
    expect(p.total).toBe(1100);
    expect(p.due_date).toBe("2026-06-28");
    expect(p.currency).toBe("USD");
    expect(p.status).toBe("approved");
    expect(p.source).toBe("xoro_mirror");
  });

  it("defaults subtotal = total and tax = 0 when Xoro doesn't expose the split", async () => {
    const sb = makeSupabase({
      tandaPos: [
        { po_number: "PO-Y", vendor: "ACME", status: "Closed", data: { DateClosed: "2026-05-28", TotalAmount: "500" } },
      ],
      vendors: [{ id: "v-acme", code: "ACME" }],
      invoices: [],
    });
    await mirrorApForDate(sb, "ent-rof", "2026-05-28");
    const p = sb._inserts[0].payload;
    expect(p.subtotal).toBe(500);
    expect(p.tax).toBe(0);
    expect(p.total).toBe(500);
  });
});
