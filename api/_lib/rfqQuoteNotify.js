// api/_lib/rfqQuoteNotify.js
//
// Builds the internal notification payload for a vendor quote submission,
// distinguishing a FIRST submission from a REVISION (a resubmission after the
// vendor reopened an already-submitted quote — quote.revision > 1).
//
// Pure + dependency-free so the branching logic is unit-testable without the
// handler's Supabase/auth/fetch machinery.

/**
 * @param {Object} args
 * @param {{ id: string, revision?: number|null, total_price?: number|null, lead_time_days?: number|null }} args.quote
 * @param {string} args.rfqTitle
 * @param {string} args.vendorName
 * @returns {{
 *   isRevision: boolean, revision: number, event_type: string,
 *   title: string, body: string, dedupeKeyFor: (email: string) => string
 * }}
 */
export function buildQuoteNotification({ quote, rfqTitle, vendorName }) {
  const rev = quote && quote.revision != null ? quote.revision : 1;
  const isRevision = rev > 1;
  const totalStr = quote && quote.total_price != null
    ? Number(quote.total_price).toLocaleString(undefined, { style: "currency", currency: "USD" })
    : "—";
  const leadStr = quote && quote.lead_time_days != null ? ` · lead time ${quote.lead_time_days}d` : "";

  return {
    isRevision,
    revision: rev,
    event_type: isRevision ? "rfq_quote_revised" : "rfq_quote_submitted",
    title: isRevision
      ? `${vendorName} revised their quote on ${rfqTitle} (v${rev})`
      : `${vendorName} submitted a quote on ${rfqTitle}`,
    body: isRevision
      ? `Revised total ${totalStr}${leadStr}. Review the updated quote — the earlier figures are kept in the revision history.`
      : `Total ${totalStr}${leadStr}.`,
    // Per-revision dedupe so each new revision notifies; first submission keeps
    // the original key shape for backward compatibility.
    dedupeKeyFor: (email) => isRevision
      ? `rfq_quote_revised_${quote.id}_${rev}_${email}`
      : `rfq_quote_submitted_${quote.id}_${email}`,
  };
}

/**
 * Build the VENDOR-facing confirmation receipt for their own quote
 * submission/revision (lands in the vendor's in-app bell + email).
 *
 * @param {Object} args
 * @param {{ id: string, revision?: number|null }} args.quote
 * @param {string} args.rfqTitle
 * @returns {{ isRevision: boolean, revision: number, event_type: string, title: string, body: string, dedupeKey: string }}
 */
export function buildVendorQuoteReceipt({ quote, rfqTitle }) {
  const rev = quote && quote.revision != null ? quote.revision : 1;
  const isRevision = rev > 1;
  return {
    isRevision,
    revision: rev,
    event_type: isRevision ? "rfq_quote_revised_receipt" : "rfq_quote_submitted_receipt",
    title: isRevision
      ? `Your revised quote (v${rev}) was submitted`
      : "Your quote was submitted",
    body: isRevision
      ? `Ring of Fire received your revised quote on "${rfqTitle}". They'll review the updated figures.`
      : `Ring of Fire received your quote on "${rfqTitle}".`,
    dedupeKey: isRevision
      ? `rfq_quote_revised_receipt_${quote.id}_${rev}`
      : `rfq_quote_submitted_receipt_${quote.id}`,
  };
}
