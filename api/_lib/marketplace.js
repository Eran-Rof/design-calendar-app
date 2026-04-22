// api/_lib/marketplace.js
//
// Shared helpers for marketplace search + ranking.
//
//   tokenise(q)                 → lower-case word list (drops short noise tokens)
//   matchesSearch(listing, q)   → true if q appears in title, description, or capabilities
//   rankListings(listings, esg) → sorted by featured desc, views desc, esg overall desc
//
// ESG integration: if the caller provides a Map<vendor_id, overall_score>,
// the rank uses it as the tertiary key. Otherwise we just sort by featured + views.

export function tokenise(q) {
  return String(q || "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 2);
}

function searchCorpus(l) {
  const cap = Array.isArray(l.capabilities) ? l.capabilities.join(" ") : "";
  return `${l.title || ""} ${l.description || ""} ${cap}`.toLowerCase();
}

export function matchesSearch(listing, q) {
  const tokens = tokenise(q);
  if (tokens.length === 0) return true;
  const corpus = searchCorpus(listing);
  return tokens.every((t) => corpus.includes(t));
}

export function matchesFilters(listing, { category, certifications, geographic_coverage, min_order_value }) {
  if (category && listing.category !== category) return false;
  if (certifications && certifications.length) {
    const have = new Set(listing.certifications || []);
    if (!certifications.every((c) => have.has(c))) return false;
  }
  if (geographic_coverage && geographic_coverage.length) {
    const have = new Set(listing.geographic_coverage || []);
    if (!geographic_coverage.some((g) => have.has(g))) return false;
  }
  if (min_order_value !== undefined && min_order_value !== null && min_order_value !== "") {
    const n = Number(min_order_value);
    if (Number.isFinite(n) && (listing.min_order_value == null || Number(listing.min_order_value) > n)) return false;
  }
  return true;
}

export function rankListings(listings, esgByVendor = {}) {
  return [...listings].sort((a, b) => {
    if (!!b.featured !== !!a.featured) return b.featured ? 1 : -1;
    const av = Number(a.views || 0), bv = Number(b.views || 0);
    if (av !== bv) return bv - av;
    const as = Number(esgByVendor[a.vendor_id] || 0);
    const bs = Number(esgByVendor[b.vendor_id] || 0);
    return bs - as;
  });
}

// Given a batch of listings, fetch each vendor's latest ESG score.
// Returns { [vendor_id]: overall_score }.
export async function esgMapForVendors(admin, vendorIds) {
  if (!vendorIds || vendorIds.length === 0) return {};
  const { data } = await admin.from("esg_scores")
    .select("vendor_id, overall_score, period_end")
    .in("vendor_id", vendorIds)
    .order("period_end", { ascending: false });
  const out = {};
  for (const s of data || []) {
    if (!(s.vendor_id in out)) out[s.vendor_id] = Number(s.overall_score || 0);
  }
  return out;
}
