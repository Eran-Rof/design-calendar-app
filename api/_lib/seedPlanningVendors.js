// api/_lib/seedPlanningVendors.js
//
// Pure core for "Seed from Tangerine vendors" — the bulk action on the
// planning Vendors screen that creates one ip_vendor_master row per Tangerine
// `vendors` row that isn't already represented. Lifted out of the handler so
// the matching / dedupe / code-generation logic is unit-testable without a
// Supabase client (mirrors the buyPlanToPo.js split).
//
// Matching tiers mirror matchTangerineVendor() in buyPlanToPo.js so "seed"
// and "link suggestions" agree on what counts as "already represented":
//   1. portal_vendor_id — an existing planning vendor already links to this
//      Tangerine vendor.
//   2. vendor_code — case-insensitive exact code match.
//   3. name — case-insensitive exact name match.
// A Tangerine vendor matched by any tier is skipped; the rest are planned for
// creation, pre-linked (portal_vendor_id set). Idempotent: re-running after a
// seed matches every row on tier 1 and creates nothing.

// Slugify a vendor name into a stable, uppercase, code-safe token. Used only
// when the Tangerine vendor has no `code` of its own.
export function slugifyVendorCode(name) {
  const slug = String(name || "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 24);
  return slug || "VENDOR";
}

// Decide which Tangerine vendors need a new planning vendor row.
//
//   tangerineVendors — [{ id, name, code }]  (from `vendors`, deleted_at null)
//   existingVendors  — [{ id, vendor_code, name, portal_vendor_id }] from
//                      ip_vendor_master
//
// Returns { toCreate: [{ vendor_code, name, portal_vendor_id }],
//           skipped:  [{ tangerine_id, name, reason }],
//           summary:  { created, skipped } }.
export function planSeedVendors({ tangerineVendors, existingVendors } = {}) {
  const existing = existingVendors || [];
  const linkedPortalIds = new Set(existing.map((v) => v.portal_vendor_id).filter(Boolean));
  const existingCodes = new Set(existing.map((v) => (v.vendor_code || "").trim().toLowerCase()).filter(Boolean));
  const existingNames = new Set(existing.map((v) => (v.name || "").trim().toLowerCase()).filter(Boolean));

  const toCreate = [];
  const skipped = [];
  // Codes already allocated within this batch — so two Tangerine vendors that
  // slug to the same code don't collide (and so a new code never clashes with
  // an existing ip_vendor_master.vendor_code, which is UNIQUE).
  const usedCodes = new Set(existingCodes);

  for (const tv of tangerineVendors || []) {
    const tid = tv.id;
    const tname = (tv.name || "").trim();
    const tcode = (tv.code || "").trim();
    const tnameLower = tname.toLowerCase();
    const tcodeLower = tcode.toLowerCase();

    if (tid && linkedPortalIds.has(tid)) {
      skipped.push({ tangerine_id: tid, name: tname, reason: "already_linked" });
      continue;
    }
    if (tcodeLower && existingCodes.has(tcodeLower)) {
      skipped.push({ tangerine_id: tid, name: tname, reason: "code_match" });
      continue;
    }
    if (tnameLower && existingNames.has(tnameLower)) {
      skipped.push({ tangerine_id: tid, name: tname, reason: "name_match" });
      continue;
    }

    // Allocate a unique, non-empty vendor_code.
    const base = tcode || slugifyVendorCode(tname);
    let code = base;
    let n = 2;
    while (usedCodes.has(code.toLowerCase())) {
      code = `${base}-${n}`;
      n += 1;
    }
    usedCodes.add(code.toLowerCase());

    toCreate.push({ vendor_code: code, name: tname || code, portal_vendor_id: tid || null });
  }

  return {
    toCreate,
    skipped,
    summary: { created: toCreate.length, skipped: skipped.length },
  };
}
