// api/vendor/rfqs/:id/decline
//
// POST — vendor declines the RFQ invitation.
//   body: { reason? } (optional)
// Sets invitation.status='declined' and notifies the internal
// procurement team so they can gauge response rates and optionally
// invite backup vendors.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const dIdx = parts.lastIndexOf("decline");
  return dIdx > 0 ? parts[dIdx - 1] : null;
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

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const reason = body?.reason ? String(body.reason).trim().slice(0, 500) : null;

  const { data: invitation } = await admin.from("rfq_invitations")
    .select("*").eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!invitation) return res.status(404).json({ error: "Invitation not found" });
  if (invitation.status === "declined") return res.status(200).json({ ok: true, already: true });
  if (invitation.status === "submitted") return res.status(409).json({ error: "Cannot decline after submitting a quote — withdraw via dispute or contact procurement" });

  const nowIso = new Date().toISOString();
  await admin.from("rfq_invitations").update({
    status: "declined",
    declined_at: nowIso,
  }).eq("id", invitation.id);

  try {
    const emails = (process.env.INTERNAL_PROCUREMENT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (emails.length > 0) {
      const [{ data: rfq }, { data: vendor }] = await Promise.all([
        admin.from("rfqs").select("title").eq("id", rfqId).maybeSingle(),
        admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle(),
      ]);
      const origin = `https://${req.headers.host}`;
      await Promise.all(emails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "rfq_declined",
            title: `${vendor?.name || "A vendor"} declined RFQ ${rfq?.title || ""}`,
            body: reason ? `Reason: ${reason}` : "No reason provided.",
            link: "/",
            metadata: { rfq_id: rfqId, vendor_id: caller.vendor_id, reason },
            recipient: { internal_id: "procurement", email },
            dedupe_key: `rfq_declined_${rfqId}_${caller.vendor_id}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));
    }
  } catch { /* swallow */ }

  return res.status(200).json({ ok: true, status: "declined" });
}
