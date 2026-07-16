// api/_lib/customers/matchCustomer.js
//
// Shared customer-dedup guard for the sales/planning importers (sync-invoices,
// xoro-sales-sync, planning-sync). These paths write customer rows via the
// ip_customer_master VIEW (which is an auto-updatable view over the canonical
// `customers` table — see mig 20260522020200). Historically each importer
// matched an incoming customer to an existing one only by exact customer_code
// prefix (EXCEL:/XORO:/ATS:) or CASE/PUNCTUATION-sensitive name, so any casing
// or punctuation drift forked a duplicate: "AMAZON FBM" next to "Amazon FBM",
// "U.S. Apparel" next to "US Apparel". #1816 merged the existing dupes but left
// the importer able to re-create them; this module is the upstream guard.
//
// resolveExistingCustomerId matches in precedence:
//   1. bare customer_code key (drops EXCEL:/XORO:/ATS:, strips whitespace)
//   2. exact uppercase name
//   3. NORMALIZED name (uppercase + strip all non-alphanumerics)
// Only LIVE (deleted_at IS NULL) customers are considered, so a merged-away
// tombstone is never re-attached to.

import { codeBareKey, normalizedNameKey } from "./customerCodeKey.js";

/**
 * Build lookup maps from existing customer rows [{ id, customer_code, name }].
 * First writer wins on collisions (stable, deterministic).
 */
export function buildCustomerLookup(rows) {
  const byCodeBare = new Map();
  const byNameUpper = new Map();
  const byNormName = new Map();
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    if (r.customer_code) {
      const bk = codeBareKey(r.customer_code);
      if (bk && !byCodeBare.has(bk)) byCodeBare.set(bk, r.id);
    }
    if (r.name) {
      const up = String(r.name).trim().toUpperCase();
      if (up && !byNameUpper.has(up)) byNameUpper.set(up, r.id);
      const nn = normalizedNameKey(r.name);
      if (nn && !byNormName.has(nn)) byNormName.set(nn, r.id);
    }
  }
  return { byCodeBare, byNameUpper, byNormName };
}

/**
 * Resolve an incoming (customerCode, name) to an existing customer id, or null.
 * @param {{byCodeBare:Map,byNameUpper:Map,byNormName:Map}} lookup
 * @param {{customerCode?:string|null, name?:string|null}} incoming
 */
export function resolveExistingCustomerId(lookup, { customerCode, name } = {}) {
  if (customerCode) {
    const bk = codeBareKey(customerCode);
    const hit = bk ? lookup.byCodeBare.get(bk) : null;
    if (hit) return hit;
  }
  if (name) {
    const up = String(name).trim().toUpperCase();
    const byName = up ? lookup.byNameUpper.get(up) : null;
    if (byName) return byName;
    const nn = normalizedNameKey(name);
    const byNorm = nn ? lookup.byNormName.get(nn) : null;
    if (byNorm) return byNorm;
  }
  return null;
}

/**
 * Load ALL live customers (deleted_at IS NULL) as [{id, customer_code, name}],
 * paginated to stay correct past the PostgREST 1000-row cap. Reads the base
 * `customers` table (NOT the ip_customer_master view, which exposes soft-deleted
 * tombstones) so the guard never attaches to a merged-away duplicate.
 */
export async function loadLiveCustomers(admin, { pageSize = 1000 } = {}) {
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from("customers")
      .select("id, customer_code, name")
      .is("deleted_at", null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`loadLiveCustomers: ${error.message}`);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}
