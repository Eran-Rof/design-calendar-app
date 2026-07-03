// api/_lib/xoro-mirror/ap.js
//
// Tangerine T10-3 — Xoro shadow-mirror, AP domain.
// Architecture: docs/tangerine/T10-shadow-mirror-architecture.md §4.2.
//
// Reads receiving-complete `tanda_pos` rows for a given mirror_date and
// upserts a corresponding `invoices` (AP bill) row per PO with
// `source='xoro_mirror'`. Operator-typed bills (source='manual') with a
// colliding (vendor_id, invoice_number) are skipped — never overwritten.
//
// The function is pure: no env vars, no service-role-key plumbing. The
// caller passes a configured supabase client. This keeps it trivial to
// drive from the manual-trigger handler, the nightly cron, and tests.
//
// Returns:
//   {
//     rows_upserted:                int,   // newly inserted xoro_mirror rows
//     rows_unchanged:               int,   // re-mirrored xoro_mirror rows (idempotent)
//     rows_skipped_manual_conflict: int,   // (vendor_id, invoice_number) already manual
//     errors:                       [{ po_number, reason }],
//   }
//
// Conventions (per ops memory + arch):
// - "Receiving-complete" = tanda_pos.status IN ('Received','Closed').
//   'Partially Received' / 'Partial Received' / 'Cancelled' are SKIPPED.
// - Vendor resolution: tanda_pos.vendor_id (if set) wins. Else look up
//   vendors.code by tanda_pos.vendor (the Xoro vendor name string). Else
//   vendors.aliases @> [vendor]. Unmatched → errors[], skip the row.
// - mirror_date selection: prefer tanda_pos.data->>DateClosed (when Xoro
//   marks the PO closed), else tanda_pos.data->>DateReceived, else
//   date_expected. We match `mirror_date` as ISO YYYY-MM-DD.
// - Money: invoices table uses NUMERIC (subtotal/tax/total). We pull
//   Xoro's invoice_amount from tanda_pos.data->>TotalAmount (its native
//   numeric string) and slot into `total`. Subtotal/tax default to total
//   / 0 when Xoro doesn't expose the split (the daily summary JE doesn't
//   need a tax split — line 193 of arch §4.4).

const RECEIVING_COMPLETE_STATUSES = ["Received", "Closed"];

/**
 * Best-effort string extraction from the Xoro `data` JSONB blob.
 * Tries a series of candidate keys and returns the first defined value.
 */
function pickStr(data, ...keys) {
  if (!data || typeof data !== "object") return null;
  for (const k of keys) {
    const v = data[k];
    if (v != null && String(v).length > 0) return String(v);
  }
  return null;
}

/**
 * Coerce a "money-ish" Xoro value into a JS number suitable for a NUMERIC
 * column. Returns null on missing / unparseable input.
 */
export function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // Strip currency markers / commas
    const cleaned = v.replace(/[$,]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extract an ISO date (YYYY-MM-DD) from various Xoro / tanda_pos shapes.
 * Returns null on no-match or unparseable.
 */
export function pickIsoDate(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(v);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Determine the mirror-relevant event date for a tanda_pos row.
 * Order of preference: DateClosed, DateReceived, ReceivedAt, then the
 * row's own date_expected as a last resort (rare; only happens when
 * status is Closed but Xoro left date fields blank).
 */
export function eventDateFor(row) {
  const data = row?.data || {};
  return (
    pickIsoDate(data.DateClosed) ||
    pickIsoDate(data.DateReceived) ||
    pickIsoDate(data.ReceivedAt) ||
    pickIsoDate(row?.date_expected_delivery) ||
    pickIsoDate(row?.date_expected) ||
    null
  );
}

/**
 * Build the canonical invoice_number for a mirrored AP bill.
 * Uses Xoro's vendor invoice number when present (data.VendorInvoiceNumber
 * or data.InvoiceNumber). Falls back to `XORO-<po_number>` so the upsert
 * key is always populated.
 */
export function buildInvoiceNumber(row) {
  const fromBlob = pickStr(row?.data, "VendorInvoiceNumber", "InvoiceNumber", "BillNumber");
  if (fromBlob) return fromBlob;
  return `XORO-${row.po_number || "unknown"}`;
}

/**
 * Resolve a Xoro vendor string (tanda_pos.vendor) → Tangerine vendors.id.
 * Returns the uuid or null.
 *
 * Strategy:
 *   1. If row.vendor_id is set, trust it.
 *   2. Else try `vendors.code = <vendorString>`.
 *   3. Else try `vendors.aliases @> {<vendorString>}`.
 *   4. Else try `vendors.name = <vendorString>` (case-insensitive).
 *      vendors.name is populated for all Xoro-synced vendors even when
 *      code/aliases are empty, so this is the practical join for AP bills.
 */
export async function resolveVendorId(supabase, row, vendorCache) {
  if (row?.vendor_id) return row.vendor_id;
  const vstr = (row?.vendor || "").trim();
  if (!vstr) return null;

  if (vendorCache.has(vstr)) return vendorCache.get(vstr);

  // 2) code match
  {
    const { data } = await supabase
      .from("vendors")
      .select("id")
      .eq("code", vstr)
      .maybeSingle();
    if (data?.id) {
      vendorCache.set(vstr, data.id);
      return data.id;
    }
  }
  // 3) alias match
  {
    const { data } = await supabase
      .from("vendors")
      .select("id")
      .contains("aliases", [vstr])
      .limit(1);
    if (data && data.length > 0 && data[0]?.id) {
      vendorCache.set(vstr, data[0].id);
      return data[0].id;
    }
  }
  // 4) name match (ilike for case tolerance; skips soft-deleted vendors)
  {
    const { data } = await supabase
      .from("vendors")
      .select("id")
      .ilike("name", vstr)
      .is("deleted_at", null)
      .limit(1);
    if (data && data.length > 0 && data[0]?.id) {
      vendorCache.set(vstr, data[0].id);
      return data[0].id;
    }
  }

  vendorCache.set(vstr, null);
  return null;
}

/**
 * Main entry point. Mirrors all receiving-complete tanda_pos rows whose
 * event date matches mirror_date into the `invoices` (AP) table for the
 * given entity_id. Returns counts + per-row errors.
 *
 * @param {object} supabase  configured client (anon-key-safe-for-reads;
 *                           service-role for writes)
 * @param {string} entity_id uuid of the Tangerine entity (ROF)
 * @param {string} mirror_date ISO YYYY-MM-DD
 */
export async function mirrorApForDate(supabase, entity_id, mirror_date) {
  const result = {
    rows_upserted: 0,
    rows_unchanged: 0,
    rows_skipped_manual_conflict: 0,
    errors: [],
  };

  if (!entity_id || typeof entity_id !== "string") {
    result.errors.push({ po_number: null, reason: "entity_id is required" });
    return result;
  }
  if (!mirror_date || !/^\d{4}-\d{2}-\d{2}$/.test(mirror_date)) {
    result.errors.push({ po_number: null, reason: "mirror_date must be YYYY-MM-DD" });
    return result;
  }

  // 1. Pull candidate tanda_pos rows by status. We can't filter by event
  //    date in SQL (it's buried in jsonb), so we pull the status subset
  //    and filter in JS.
  let candidates;
  try {
    const { data, error } = await supabase
      .from("tanda_pos")
      .select("po_number, vendor, vendor_id, status, date_expected, date_expected_delivery, data, uuid_id, entity_id")
      .in("status", RECEIVING_COMPLETE_STATUSES);
    if (error) {
      result.errors.push({ po_number: null, reason: `tanda_pos read failed: ${error.message}` });
      return result;
    }
    candidates = data || [];
  } catch (err) {
    result.errors.push({ po_number: null, reason: `tanda_pos read threw: ${err?.message || String(err)}` });
    return result;
  }

  // 2. Filter to mirror_date events.
  const inScope = [];
  for (const row of candidates) {
    const ev = eventDateFor(row);
    if (ev === mirror_date) inScope.push(row);
  }

  if (inScope.length === 0) return result;

  // 3. Resolve vendors. Cache the lookups to amortize across rows.
  const vendorCache = new Map();

  for (const row of inScope) {
    const po_number = row?.po_number || null;
    // Xoro-date policy: the bill's invoice_date is the row's OWN Xoro event date
    // (DateClosed → DateReceived → …, via eventDateFor), NOT the mirror_date arg.
    // For a normal single-date run these are equal (the in-scope filter above
    // requires eventDateFor === mirror_date), but deriving it per-row makes the
    // date correct BY CONSTRUCTION — so a future multi-date run stamps every bill
    // with its true Xoro date instead of one run-level date. Falls back to
    // mirror_date defensively (inScope guarantees eventDate is non-null == mirror_date).
    const eventDate = eventDateFor(row) || mirror_date;

    let vendor_id;
    try {
      vendor_id = await resolveVendorId(supabase, row, vendorCache);
    } catch (err) {
      result.errors.push({ po_number, reason: `vendor resolution threw: ${err?.message || String(err)}` });
      continue;
    }
    if (!vendor_id) {
      result.errors.push({
        po_number,
        reason: `unmatched vendor: '${row?.vendor || ""}' has no vendors.code or alias`,
      });
      continue;
    }

    const invoice_number = buildInvoiceNumber(row);
    const totalNum = parseMoney(
      pickStr(row?.data, "TotalAmount", "InvoiceAmount", "GrandTotal", "BillAmount"),
    );
    const subtotalNum = parseMoney(pickStr(row?.data, "SubTotal", "Subtotal")) ?? totalNum;
    const taxNum = parseMoney(pickStr(row?.data, "TaxAmount", "Tax")) ?? 0;
    const due_date = pickIsoDate(pickStr(row?.data, "DueDate", "PaymentDueDate"));

    // 4. Check for an existing (vendor_id, invoice_number) row. If
    //    source='manual', skip + count. If source='xoro_mirror', update
    //    (idempotent). Else insert new.
    let existing;
    try {
      const { data, error } = await supabase
        .from("invoices")
        .select("id, source")
        .eq("vendor_id", vendor_id)
        .eq("invoice_number", invoice_number)
        .maybeSingle();
      if (error) {
        result.errors.push({ po_number, reason: `existing-bill probe failed: ${error.message}` });
        continue;
      }
      existing = data || null;
    } catch (err) {
      result.errors.push({ po_number, reason: `existing-bill probe threw: ${err?.message || String(err)}` });
      continue;
    }

    if (existing && existing.source && existing.source !== "xoro_mirror") {
      // Operator-typed bill (or shopify/fba/etc.) — preserve.
      result.rows_skipped_manual_conflict += 1;
      continue;
    }

    const payload = {
      entity_id,
      vendor_id,
      po_id: row?.uuid_id || null,
      invoice_number,
      invoice_date: eventDate,
      due_date,
      subtotal: subtotalNum,
      tax: taxNum,
      total: totalNum,
      currency: "USD",
      status: "approved",
      source: "xoro_mirror",
      invoice_kind: "vendor_bill",
    };

    if (existing) {
      // Idempotent re-mirror.
      try {
        const { error } = await supabase
          .from("invoices")
          .update(payload)
          .eq("id", existing.id);
        if (error) {
          result.errors.push({ po_number, reason: `update failed: ${error.message}` });
          continue;
        }
        result.rows_unchanged += 1;
      } catch (err) {
        result.errors.push({ po_number, reason: `update threw: ${err?.message || String(err)}` });
        continue;
      }
    } else {
      try {
        const { error } = await supabase.from("invoices").insert(payload);
        if (error) {
          result.errors.push({ po_number, reason: `insert failed: ${error.message}` });
          continue;
        }
        result.rows_upserted += 1;
      } catch (err) {
        result.errors.push({ po_number, reason: `insert threw: ${err?.message || String(err)}` });
        continue;
      }
    }
  }

  return result;
}

export const __test_only__ = {
  RECEIVING_COMPLETE_STATUSES,
  pickStr,
};
