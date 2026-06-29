// api/vendor/rfqs/:id/quotes/submit
//
// POST — flip the vendor's draft quote to status='submitted'. Once
// submitted, the quote cannot be edited (enforced in the quotes
// create/update endpoint). Fires rfq_quote_submitted to the internal
// procurement team.

import { createClient } from "@supabase/supabase-js";
import { resolveInternalRecipientsDetailed } from "../../../../../_lib/internal-recipients.js";
import { markLinesQuoted } from "../../../../../_lib/costingLineStatus.js";
import { buildQuoteNotification, buildVendorQuoteReceipt } from "../../../../../_lib/rfqQuoteNotify.js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, display_name").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id, email: data.user.email } : null;
  } catch { return null; }
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const rfqId = getId(req);
  if (!rfqId) return res.status(400).json({ error: "Missing rfq id" });

  const { data: rfq } = await admin.from("rfqs").select("id, title, status, submission_deadline").eq("id", rfqId).maybeSingle();
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (rfq.status === "closed" || rfq.status === "awarded") return res.status(409).json({ error: `RFQ is ${rfq.status} — submissions are closed` });
  if (rfq.submission_deadline && new Date(rfq.submission_deadline) < new Date()) return res.status(409).json({ error: "Submission deadline has passed" });

  const { data: quote } = await admin.from("rfq_quotes").select("*").eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!quote) return res.status(404).json({ error: "No draft quote found — create one first" });
  if (quote.status !== "draft") return res.status(409).json({ error: `Quote is already ${quote.status}` });

  const nowIso = new Date().toISOString();
  await admin.from("rfq_quotes").update({
    status: "submitted",
    submitted_at: nowIso,
    updated_at: nowIso,
  }).eq("id", quote.id);

  // Flip the invitation to 'submitted' so the internal view can see it clearly
  await admin.from("rfq_invitations").update({ status: "submitted" }).eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id);

  // Costing line lifecycle: promote every linked costing line sent -> quoted.
  // Terminal states (awarded/lost/closed) are never downgraded; a line still in
  // draft (publish ran pre-migration) is left for a later transition. Best-
  // effort; never breaks the submit. Legacy / non-costing RFQs no-op.
  try {
    await markLinesQuoted(admin, rfqId, { changedBy: caller.display_name || caller.email || "vendor", note: "vendor_quote_submitted" });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[quote-submit] line status -> quoted issue rfq=${rfqId}: ${e && e.message ? e.message : String(e)}`);
  }

  const origin = `https://${req.headers.host}`;

  // Internal notification — a resubmission of a reopened quote (revision > 1)
  // notifies as a REVISION so procurement knows the figures changed, not a
  // brand-new quote. Delivered to BOTH the in-app bell (for staff whose
  // employees.metadata.plm_user_id is linked) and email.
  try {
    const probe = buildQuoteNotification({ quote, rfqTitle: rfq.title, vendorName: "A vendor" });
    const { recipients } = await resolveInternalRecipientsDetailed(admin, "procurement", { event: probe.event_type });
    if (recipients.length > 0) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
      const vendorName = vendor?.name || "A vendor";
      const n = buildQuoteNotification({ quote, rfqTitle: rfq.title, vendorName });
      await Promise.all(recipients.map((rcp) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: n.event_type,
            title: n.title,
            body: n.body,
            // Internal procurement recipients → open the Tangerine RFQs module
            // (the shared notificationLink resolver also derives this from the
            // rfq_id in metadata as a backstop).
            link: "/tangerine?m=rfqs",
            metadata: { rfq_id: rfqId, vendor_id: caller.vendor_id, quote_id: quote.id, revision: n.revision, ...(rcp.apps ? { target_apps: rcp.apps } : {}) },
            // plm_user_id (when linked) reaches the in-app bell; email always sends.
            recipient: { internal_id: rcp.plm_user_id || "procurement", email: rcp.email },
            dedupe_key: n.dedupeKeyFor(rcp.email),
            email: true,
          }),
        }).catch(() => {})
      ));
    }
  } catch { /* swallow */ }

  // Vendor-facing confirmation receipt — lands in the submitting vendor's own
  // in-app bell (recipient.auth_id) + email, so they know it was received.
  try {
    const receipt = buildVendorQuoteReceipt({ quote, rfqTitle: rfq.title });
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: receipt.event_type,
        title: receipt.title,
        body: receipt.body,
        link: `/vendor/rfqs/${rfqId}`,
        metadata: { rfq_id: rfqId, quote_id: quote.id, revision: receipt.revision },
        recipient: { auth_id: caller.auth_id, email: caller.email },
        dedupe_key: receipt.dedupeKey,
        email: true,
      }),
    }).catch(() => {});
  } catch { /* swallow */ }

  return res.status(200).json({ ok: true, quote_id: quote.id, status: "submitted" });
}
