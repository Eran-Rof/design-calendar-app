// api/internal/rfqs/:id/publish
//
// POST — flip status draft → published and send invitations to every
// invited vendor. Idempotent: re-publishing skips invitations that
// already received the rfq_invited notification (dedupe_key includes
// rfq_id + vendor_id).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { publishRfq } from "../../../../_lib/rfqPublish.js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const pIdx = parts.lastIndexOf("publish");
  return pIdx > 0 ? parts[pIdx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rfq id" });

  const { data: rfq } = await admin.from("rfqs").select("*").eq("id", id).maybeSingle();
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });

  // The full publish/send flow (status flip, lazy invitation, costing-line
  // promotion, vendor rfq_invited notification) lives in the shared helper so
  // the costing "Vendor RFQ" generate flow can auto-send in one step too.
  const origin = `https://${req.headers.host}`;
  const out = await publishRfq(admin, rfq, origin);
  if (!out.ok) {
    return res.status(out.conflict ? 409 : 500).json({ error: out.error });
  }
  return res.status(200).json({
    ok: true,
    id: out.id,
    status: out.status,
    notified: out.notified,
    lines_sent: out.lines_sent,
  });
}
