// api/_lib/rfqPublish.js
//
// Shared RFQ publish/send logic, factored out of api/_handlers/internal/rfqs/
// [id]/publish.js so the costing "Vendor RFQ" generate flow can auto-send each
// freshly created RFQ in one step (no separate "Send to Vendor" click).
//
// publishRfq() performs the FULL send: flip status draft -> published, lazily
// create the rfq_invitations row from intended_vendor_id (the "send gate" that
// exposes the RFQ in the vendor portal), promote linked costing lines to 'sent',
// and fire the `rfq_invited` vendor notification (best-effort).
//
// Idempotent + safe: re-publishing skips the invitation insert if it already
// exists, never downgrades a terminal RFQ (awarded/closed throw), and the
// notification carries a dedupe_key so a re-send doesn't double-alert.

import { markLinesSent } from "./costingLineStatus.js";

/**
 * Publish (send) a single RFQ. Pass the service-role `admin` client and the
 * already-fetched rfq row (must include id, status, intended_vendor_id, title,
 * submission_deadline). `origin` is the absolute base URL used to reach
 * /api/send-notification (e.g. `https://${req.headers.host}`).
 *
 * @returns {Promise<{ ok: boolean, id: string, status?: string, notified?: number,
 *                      lines_sent?: number, conflict?: boolean, error?: string }>}
 *   ok:false with conflict:true when the RFQ is awarded/closed (caller maps to 409);
 *   ok:false with error when a hard insert/update failed (caller maps to 500).
 */
export async function publishRfq(admin, rfq, origin) {
  if (!rfq || !rfq.id) return { ok: false, error: "Missing rfq" };
  const id = rfq.id;

  if (rfq.status === "awarded" || rfq.status === "closed") {
    return { ok: false, conflict: true, error: `Cannot publish an RFQ in status ${rfq.status}` };
  }

  if (rfq.status !== "published") {
    const { error } = await admin
      .from("rfqs")
      .update({ status: "published", updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
  }

  // Send gate: costing-generated RFQs carry intended_vendor_id but have NO
  // invitation until the first send. Create it lazily here so the vendor only
  // gains portal visibility at the moment the RFQ is sent.
  if (rfq.intended_vendor_id) {
    const { data: existingInv } = await admin
      .from("rfq_invitations")
      .select("id")
      .eq("rfq_id", id)
      .eq("vendor_id", rfq.intended_vendor_id)
      .maybeSingle();
    if (!existingInv) {
      const { error: invErr } = await admin
        .from("rfq_invitations")
        .insert({ rfq_id: id, vendor_id: rfq.intended_vendor_id, status: "invited" });
      if (invErr) return { ok: false, error: `Could not create invitation: ${invErr.message}` };
    }
  }

  const [{ data: invitations }, { data: lineItems }] = await Promise.all([
    admin.from("rfq_invitations").select("vendor_id").eq("rfq_id", id).eq("status", "invited"),
    admin.from("rfq_line_items").select("id").eq("rfq_id", id),
  ]);
  const lineCount = (lineItems || []).length;

  // Costing line lifecycle: now that an invitation exists (the vendor can see
  // the RFQ), promote every linked costing line draft|revised -> sent. Terminal
  // states are never downgraded. Best-effort; never breaks publish.
  let lineStatus = { moved: [], skipped: [] };
  try {
    lineStatus = await markLinesSent(admin, id, { note: "rfq_published" });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[rfq-publish] line status -> sent issue rfq=${id}: ${e && e.message ? e.message : String(e)}`);
  }

  // Best-effort vendor notification — never fail the publish on a notify hiccup.
  for (const inv of invitations || []) {
    try {
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "rfq_invited",
          title: `New RFQ: ${rfq.title}`,
          body: `You're invited to quote on ${rfq.title}. ${lineCount} line item${lineCount === 1 ? "" : "s"}${rfq.submission_deadline ? ` · deadline ${rfq.submission_deadline.slice(0, 10)}` : ""}.`,
          link: "/vendor/rfqs",
          metadata: { rfq_id: id, vendor_id: inv.vendor_id },
          recipient: { vendor_id: inv.vendor_id },
          dedupe_key: `rfq_invited_${id}_${inv.vendor_id}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* swallow */ }
  }

  return {
    ok: true,
    id,
    status: "published",
    notified: (invitations || []).length,
    lines_sent: lineStatus.moved.length,
  };
}
