// api/_lib/rfqDocRevision.js
//
// Document-attach revision triggers. Attaching a document to a costing/RFQ line
// or vendor quote that is ALREADY sent / quoted is a vendor-relevant change, so
// it should transition the line/quote to a "revised" state exactly like an
// edited vendor-visible field does — flagging the change and notifying the other
// side.
//
// Two entrypoints, mirroring the two existing revision systems:
//
//   flagCostingLineDocRevised(admin, { lineId, host })
//     ROF side. When a doc is attached to a costing_lines row whose RFQ was
//     already sent (FK-linked rfq_line_items exist), stamp those line items as
//     revised on the synthetic `documents` field (revised_at + revised_fields),
//     snapshot to rfq_line_revisions, and notify the invited vendor(s)
//     (rfq_revised) — the SAME steps the costing-line PUT runs for a real field
//     change (api/_handlers/internal/costing/lines/[line_id]/index.js).
//
//   flagVendorQuoteDocRevised(admin, { quoteId, vendorId, host })
//     Vendor side. When a vendor attaches a doc to an already-submitted (or
//     under-review) quote, snapshot the current quote into rfq_quote_revisions,
//     bump rfq_quotes.revision, and notify procurement as a quote revision —
//     mirroring the vendor quote-revision flow (quote/revise.js + submit.js).
//     The quote stays submitted (the vendor isn't re-editing prices), but
//     revision > 1 + a revision row makes the portal show "Revised".
//
// Both are IDEMPOTENT-friendly and BEST-EFFORT: a notify/snapshot hiccup never
// fails the underlying document upload. `documents` is a synthetic field name —
// it is NOT a column on rfq_line_items, so we only add it to the revised_fields
// array; we never try to write a `documents` column value.

import { resolveInternalRecipientsDetailed } from "./internal-recipients.js";
import { buildQuoteNotification } from "./rfqQuoteNotify.js";

const DOC_FIELD = "documents";

/**
 * Append a value to a Postgres text[] without duplicating it.
 */
function appendUnique(arr, value) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  if (!list.includes(value)) list.push(value);
  return list;
}

/**
 * ROF side — a document was attached to a costing line. If that line's RFQ was
 * already sent (FK-linked rfq_line_items exist), flag those line items revised
 * on the `documents` field, snapshot the revision, and notify the vendor(s).
 *
 * @param {Object} admin   service-role Supabase client
 * @param {Object} args
 * @param {string} args.lineId   costing_lines.id the doc was attached to
 * @param {string} args.host     req.headers.host (to call /api/send-notification)
 * @param {string} [args.docTitle]  optional document title for context
 * @returns {Promise<{ revisedRfqIds: string[] }>}  ids of RFQs flagged (empty when draft/none)
 */
export async function flagCostingLineDocRevised(admin, { lineId, host, docTitle }) {
  if (!lineId) return { revisedRfqIds: [] };

  // Only sent lines have FK-linked rfq_line_items. A doc on a draft line (no
  // linked rfq_line_items) is normal — no revision.
  const { data: items } = await admin
    .from("rfq_line_items")
    .select("id, rfq_id, revised_fields, entity_id")
    .eq("costing_line_id", lineId);
  if (!items || items.length === 0) return { revisedRfqIds: [] };

  const nowIso = new Date().toISOString();
  const changedRfqIds = new Set();

  for (const it of items) {
    // Stamp the line revised on the synthetic `documents` field. We do NOT write
    // a `documents` column (there is none) — only revised_at + revised_fields.
    const revisedFields = appendUnique(it.revised_fields, DOC_FIELD);
    await admin
      .from("rfq_line_items")
      .update({ revised_at: nowIso, revised_fields: revisedFields })
      .eq("id", it.id);
    changedRfqIds.add(it.rfq_id);

    // Append-only ROF revision history snapshot. Best-effort.
    try {
      await admin.from("rfq_line_revisions").insert({
        rfq_line_item_id: it.id,
        rfq_id: it.rfq_id,
        costing_line_id: lineId,
        revised_at: nowIso,
        changed_fields: [DOC_FIELD],
        old_values: { [DOC_FIELD]: null },
        new_values: { [DOC_FIELD]: docTitle || "document added" },
        revised_by: "ROF",
        entity_id: it.entity_id || null,
      });
    } catch { /* history is best-effort */ }
  }

  // Notify the invited vendor(s) of every RFQ whose line(s) were flagged.
  if (changedRfqIds.size > 0 && host) {
    try {
      const ids = Array.from(changedRfqIds);
      const { data: rfqMeta } = await admin.from("rfqs").select("id, title").in("id", ids);
      const titleById = Object.fromEntries((rfqMeta || []).map((r) => [r.id, r.title]));
      const { data: invs } = await admin.from("rfq_invitations").select("rfq_id, vendor_id").in("rfq_id", ids);
      const origin = `https://${host}`;
      await Promise.all((invs || []).map((inv) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "rfq_revised",
            title: `An RFQ was revised: ${titleById[inv.rfq_id] || "RFQ"}`,
            body: "Ring of Fire added a document to this RFQ. Open it to review the updated attachments (highlighted in green).",
            link: `/vendor/rfqs/${inv.rfq_id}`,
            metadata: { rfq_id: inv.rfq_id },
            recipient: { vendor_id: inv.vendor_id },
            // Keyed by this revision's timestamp so each distinct revision notifies.
            dedupe_key: `rfq_revised_${inv.rfq_id}_${inv.vendor_id}_${nowIso}`,
            email: true,
          }),
        }).catch(() => {})
      ));
    } catch { /* best-effort notify */ }
  }

  return { revisedRfqIds: Array.from(changedRfqIds) };
}

/**
 * Vendor side — a document was attached to a vendor quote. If that quote is
 * already submitted / under review, snapshot it, bump the revision, and notify
 * procurement as a quote revision so ROF knows and the quote shows "Revised".
 *
 * @param {Object} admin   service-role Supabase client
 * @param {Object} args
 * @param {string} args.quoteId   rfq_quotes.id the doc was attached to
 * @param {string} args.vendorId  the attaching vendor's id (ownership already verified)
 * @param {string} args.host      req.headers.host (to call /api/send-notification)
 * @returns {Promise<{ revised: boolean, revision?: number }>}
 */
export async function flagVendorQuoteDocRevised(admin, { quoteId, vendorId, host }) {
  if (!quoteId) return { revised: false };

  const { data: quote } = await admin
    .from("rfq_quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (!quote) return { revised: false };
  // Only an already-submitted / under-review quote becomes a revision. A doc on
  // a draft quote is normal (it ships with the first submission) — no revision.
  if (quote.status !== "submitted" && quote.status !== "under_review") return { revised: false };

  // The RFQ must still be open for a revision to be meaningful.
  const { data: rfq } = await admin
    .from("rfqs")
    .select("id, title, status, submission_deadline")
    .eq("id", quote.rfq_id)
    .maybeSingle();
  if (!rfq) return { revised: false };
  if (rfq.status === "closed" || rfq.status === "awarded") return { revised: false };
  if (rfq.submission_deadline && new Date(rfq.submission_deadline) < new Date()) return { revised: false };

  // Snapshot the CURRENT quote header + lines (mirrors quote/revise.js).
  const { data: lines } = await admin
    .from("rfq_quote_lines")
    .select("rfq_line_item_id, unit_price, quantity, notes")
    .eq("quote_id", quote.id);
  const snapshot = {
    total_price: quote.total_price,
    lead_time_days: quote.lead_time_days,
    valid_until: quote.valid_until,
    notes: quote.notes,
    lines: (lines || []).map((l) => ({
      rfq_line_item_id: l.rfq_line_item_id,
      unit_price: l.unit_price,
      quantity: l.quantity,
      notes: l.notes,
    })),
  };

  const currentRevision = quote.revision != null ? quote.revision : 1;
  const { error: revErr } = await admin.from("rfq_quote_revisions").insert({
    quote_id: quote.id,
    rfq_id: quote.rfq_id,
    vendor_id: vendorId || quote.vendor_id || null,
    revision: currentRevision,
    snapshot,
    submitted_at: quote.submitted_at || null,
  });
  if (revErr) return { revised: false };

  // Bump the revision (quote stays submitted — the vendor only added a doc, they
  // didn't reopen to re-edit prices). revision > 1 + the snapshot row above make
  // the portal show "Revised" (src RfqQuotesAndMessages: revision>1 && revisions>0).
  const nextRevision = currentRevision + 1;
  const nowIso = new Date().toISOString();
  await admin.from("rfq_quotes")
    .update({ revision: nextRevision, updated_at: nowIso })
    .eq("id", quote.id);

  // Notify procurement of the revision (rfq_quote_revised). Best-effort.
  if (host) {
    try {
      const origin = `https://${host}`;
      const probeQuote = { ...quote, revision: nextRevision };
      const probe = buildQuoteNotification({ quote: probeQuote, rfqTitle: rfq.title, vendorName: "A vendor" });
      const { recipients } = await resolveInternalRecipientsDetailed(admin, "procurement", { event: probe.event_type });
      if (recipients.length > 0) {
        const { data: vendor } = await admin.from("vendors").select("name").eq("id", vendorId || quote.vendor_id).maybeSingle();
        const vendorName = vendor?.name || "A vendor";
        const n = buildQuoteNotification({ quote: probeQuote, rfqTitle: rfq.title, vendorName });
        await Promise.all(recipients.map((rcp) =>
          fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: n.event_type,
              title: n.title,
              body: `${vendorName} attached a document to their quote on ${rfq.title} — it's now marked revised (v${nextRevision}).`,
              link: "/",
              metadata: { rfq_id: quote.rfq_id, vendor_id: vendorId || quote.vendor_id, quote_id: quote.id, revision: nextRevision, ...(rcp.apps ? { target_apps: rcp.apps } : {}) },
              recipient: { internal_id: rcp.plm_user_id || "procurement", email: rcp.email },
              dedupe_key: n.dedupeKeyFor(rcp.email),
              email: true,
            }),
          }).catch(() => {})
        ));
      }
    } catch { /* best-effort notify */ }
  }

  return { revised: true, revision: nextRevision };
}
