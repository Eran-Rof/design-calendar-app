// Canonical-key builders. The rule, in one line: upper-case, trim, and
// collapse internal whitespace — enough to dedupe human typos without
// erasing meaningful distinctions. SKU codes stay strict (no special-char
// stripping) because our Xoro SKUs include dots and slashes.
//
// These are pure — no IO — so the normalizer and the mapper both call them
// on every inbound row and get the same value back.

function compact(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── SKU ─────────────────────────────────────────────────────────────────────
// Preserves punctuation, upper-cases letters, trims. Shopify SKUs often
// have trailing whitespace or inconsistent case; Xoro is mostly clean but
// occasionally has a leading zero lost as a number. If a consumer passes a
// numeric, we stringify first.
export function canonicalizeSku(input: string | number | null | undefined): string | null {
  if (input == null) return null;
  const s = compact(String(input));
  if (!s) return null;
  return s.toUpperCase();
}

// ── Style / base part ───────────────────────────────────────────────────────
// Style = SKU with size/color suffix stripped, when we can detect it. Most
// of our SKUs follow `<style>-<color>-<size>` with hyphen delimiters. We
// don't try to be clever: if a caller has an authoritative style code
// (from PLM, say), they pass it; otherwise we derive it.
export function canonicalizeStyleCode(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = compact(String(input)).toUpperCase();
  return s || null;
}

// Heuristic style derivation from a SKU. Best-effort only — never trust
// this for merchandising decisions, just for bucketing unknown SKUs so the
// forecaster sees at least something.
// Rule: if the SKU contains two or more hyphens, drop the last two segments.
// Kept deliberately conservative; the PLM-authoritative path is preferred.
export function deriveStyleFromSku(sku: string): string | null {
  const parts = sku.split("-");
  if (parts.length < 3) return null;
  return parts.slice(0, parts.length - 2).join("-");
}

// ── Customer ────────────────────────────────────────────────────────────────
// Xoro customer names drift ("NORDSTROM INC." vs "NORDSTROM, INC" vs
// "Nordstrom Inc"). We canonicalize by uppercasing and stripping
// punctuation except the ampersand. Reconciliation code is expected to
// also look at customer_code / external_refs before name-matching.
export function canonicalizeCustomerName(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input)
    // Strip apostrophes first so "Dick's" → "Dicks", not "Dick S".
    .replace(/['’]/g, "")
    .replace(/[^A-Za-z0-9&\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return s || null;
}

// ── Category ───────────────────────────────────────────────────────────────
// Looser than SKU — categories are free-text in Xoro. Uppercase + compact.
export function canonicalizeCategory(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = compact(String(input));
  return s ? s.toUpperCase() : null;
}

// ── Channel ────────────────────────────────────────────────────────────────
// Channel codes are assigned, not derived from upstream strings. But we
// still accept free-form aliases like "online", "dot-com", "ecom" and
// reduce them so the mapper's lookup is case-insensitive.
export function canonicalizeChannelCode(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = compact(String(input)).toUpperCase().replace(/[\s.-]+/g, "_");
  return s || null;
}

// ── Vendor ─────────────────────────────────────────────────────────────────
// Vendor names behave like customer names — uppercase + strip punctuation
// — but we also strip common corp suffixes to make fuzzy-joining less
// brittle across Xoro ("ACME LTD"), Shopify vendor field ("Acme"), and PLM.
const VENDOR_SUFFIX_RE = /\b(INC|LLC|LTD|CO|CORP|CORPORATION|LIMITED|GMBH|PTE|PTY|SA|SRL|BV|OY|AB)\b\.?/g;

export function canonicalizeVendorName(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input)
    .replace(/[^A-Za-z0-9&\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(VENDOR_SUFFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}
