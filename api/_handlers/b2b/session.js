// api/b2b/session  (GET /api/b2b/session)
//
// P18-B — the B2B customer portal's authorize-me endpoint. The /b2b browser app
// calls this right after Supabase Auth establishes a session, sending the
// buyer's Supabase access token as `Authorization: Bearer <jwt>`.
//
// On success returns the (server-trusted) identity the shell needs to render:
//   { b2b_account_id, customer_id, customer_name, display_name, role, can_place_orders }
//
// SECURITY: the customer_id is read from b2b_accounts via resolveB2BSession —
// NEVER from anything the client sends. On 401 the client signs out; on 403 it
// shows "not authorized for the portal".

import { createClient } from "@supabase/supabase-js";
import { resolveB2BSession } from "../../_lib/b2b/session.js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function adminClient() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = adminClient();
  const sess = await resolveB2BSession(req, admin);
  if (!sess.ok) return res.status(sess.status).json({ error: sess.error });

  const { account, customer_id } = sess;

  // Resolve a human-friendly customer/company name for the header. Best-effort:
  // the shell still renders if this lookup fails.
  let customer_name = null;
  try {
    const { data: cust } = await admin
      .from("customers")
      .select("name")
      .eq("id", customer_id)
      .maybeSingle();
    customer_name = cust?.name || null;
  } catch { /* non-fatal */ }

  return res.status(200).json({
    b2b_account_id:  account.id,
    customer_id,
    customer_name,
    display_name:    account.display_name || null,
    role:            account.role || "buyer",
    can_place_orders: account.can_place_orders === true,
  });
}
