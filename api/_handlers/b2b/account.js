// api/b2b/account  (GET /api/b2b/account)
//
// P18-E — B2B customer portal account view: invoices / AR + open balance, plus
// the customer's ship-to locations (used by the cart's ship-to picker).
//
// Returns:
//   { customer: { id, name },
//     open_balance_cents,           // Σ (total − paid) over non-void invoices
//     currency,
//     invoices: [{ id, invoice_number, invoice_date, due_date, gl_status,
//                  total_amount_cents, paid_amount_cents, balance_cents }],
//     locations: [{ id, name, code, is_default }] }
//
// SECURITY: resolveB2BSession → customer_id; ar_invoices + customer_locations are
// filtered by customer_id from the verified session — never from the client. A
// buyer can only ever see their own customer's invoices and balance.

import { createClient } from "@supabase/supabase-js";
import { resolveB2BSession } from "../../_lib/b2b/session.js";

export const config = { maxDuration: 15 };

// Invoice statuses that do NOT count toward the open AR balance.
const NON_BALANCE_STATUSES = new Set(["void", "reversed"]);

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
  const { customer_id } = sess;

  // Customer display name (best-effort).
  let customer_name = null;
  try {
    const { data: cust } = await admin.from("customers").select("name").eq("id", customer_id).maybeSingle();
    customer_name = cust?.name || null;
  } catch { /* non-fatal */ }

  // Invoices — scoped to the session customer_id.
  const { data: invRows, error: invErr } = await admin
    .from("ar_invoices")
    .select("id, invoice_number, invoice_date, due_date, gl_status, total_amount_cents, paid_amount_cents")
    .eq("customer_id", customer_id)
    .order("invoice_date", { ascending: false })
    .limit(500);
  if (invErr) return res.status(500).json({ error: invErr.message });

  let openBalance = 0;
  const invoices = (invRows || []).map((r) => {
    const total = Number(r.total_amount_cents) || 0;
    const paid = Number(r.paid_amount_cents) || 0;
    const balance = total - paid;
    if (!NON_BALANCE_STATUSES.has(r.gl_status)) openBalance += balance;
    return {
      id: r.id,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      gl_status: r.gl_status,
      total_amount_cents: total,
      paid_amount_cents: paid,
      balance_cents: balance,
    };
  });

  // Ship-to locations for the cart picker.
  let locations = [];
  try {
    const { data: locs } = await admin
      .from("customer_locations")
      .select("id, name, code, is_default")
      .eq("customer_id", customer_id)
      .eq("active", true)
      .order("is_default", { ascending: false })
      .order("name", { ascending: true });
    locations = (locs || []).map((l) => ({ id: l.id, name: l.name, code: l.code || null, is_default: l.is_default === true }));
  } catch { /* non-fatal */ }

  return res.status(200).json({
    customer: { id: customer_id, name: customer_name },
    open_balance_cents: openBalance,
    currency: "USD",
    invoices,
    locations,
  });
}
