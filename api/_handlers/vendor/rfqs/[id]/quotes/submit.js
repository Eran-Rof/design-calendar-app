// api/vendor/rfqs/:id/quotes/submit
//
// POST — flip the vendor's draft quote to status='submitted'. Once
// submitted, the quote cannot be edited (enforced in the quotes
// create/update endpoint). Fires rfq_quote_submitted to the internal
// procurement team.

import { createClient } from "@supabase/supabase-js";

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

  // Internal notification
  try {
    const emails = (process.env.INTERNAL_PROCUREMENT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (emails.length > 0) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
      const vendorName = vendor?.name || "A vendor";
      const origin = `https://${req.headers.host}`;
      await Promise.all(emails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "rfq_quote_submitted",
            title: `${vendorName} submitted a quote on ${rfq.title}`,
            body: `Total ${quote.total_price != null ? Number(quote.total_price).toLocaleString(undefined, { style: "currency", currency: "USD" }) : "—"}${quote.lead_time_days != null ? ` · lead time ${quote.lead_time_days}d` : ""}.`,
            link: "/",
            metadata: { rfq_id: rfqId, vendor_id: caller.vendor_id, quote_id: quote.id },
            recipient: { internal_id: "procurement", email },
            dedupe_key: `rfq_quote_submitted_${quote.id}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));
    }
  } catch { /* swallow */ }

  return res.status(200).json({ ok: true, quote_id: quote.id, status: "submitted" });
}
