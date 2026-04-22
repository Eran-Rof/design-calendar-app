// api/internal/contracts/:id
//
// PUT — update contract metadata.
//   body: { status?, internal_owner?, title?, description?, start_date?,
//           end_date?, value?, currency?, notes? }
// Allowed statuses: draft|sent|under_review|signed|expired|terminated
// Fires the matching notification to vendor when status changes:
//   status → sent        → contract_sent
//   status → expired     → contract_expired
//   status → terminated  → contract_terminated

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const ALLOWED_STATUS = ["draft", "sent", "under_review", "signed", "expired", "terminated"];

function getContractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("contracts");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getContractId(req);
  if (!id) return res.status(400).json({ error: "Missing contract id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const updates = {};
  for (const key of ["title", "description", "start_date", "end_date", "value", "currency", "internal_owner", "notes"]) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) updates[key] = body[key];
  }
  if (body?.status) {
    if (!ALLOWED_STATUS.includes(body.status)) return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUS.join(", ")}` });
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields in body" });
  updates.updated_at = new Date().toISOString();

  const { data: existing } = await admin
    .from("contracts").select("id, vendor_id, title, status, contract_type").eq("id", id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Contract not found" });

  const { error: updErr } = await admin.from("contracts").update(updates).eq("id", id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Notify on state changes that affect the vendor
  const eventTypeByStatus = {
    sent: "contract_sent",
    expired: "contract_expired",
    terminated: "contract_terminated",
  };
  if (updates.status && eventTypeByStatus[updates.status] && updates.status !== existing.status) {
    try {
      const origin = `https://${req.headers.host}`;
      const titles = {
        sent: `New contract ready for review: ${existing.title}`,
        expired: `Contract expired: ${existing.title}`,
        terminated: `Contract terminated: ${existing.title}`,
      };
      const bodies = {
        sent: "A contract has been updated and is ready for your review.",
        expired: "This contract has reached its end date and is now expired.",
        terminated: "This contract has been terminated.",
      };
      await fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: eventTypeByStatus[updates.status],
          title: titles[updates.status],
          body: bodies[updates.status],
          link: "/vendor/contracts",
          metadata: { contract_id: id, vendor_id: existing.vendor_id, new_status: updates.status },
          recipient: { vendor_id: existing.vendor_id },
          dedupe_key: `${eventTypeByStatus[updates.status]}_${id}_${new Date().toISOString().slice(0, 10)}`,
          email: true,
        }),
      }).catch(() => {});
    } catch { /* non-blocking */ }
  }

  return res.status(200).json({ ok: true, id });
}
