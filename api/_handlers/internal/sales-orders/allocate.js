// api/internal/sales-orders/:id/allocate
//
// P16 / M18 — allocate (reserve) available on-hand inventory to a confirmed
// sales order's lines. Calls the allocate_sales_order() RPC, which bumps each
// line's qty_allocated by the live-available qty (soft reservation; no FIFO
// consumption) and flips the header to 'allocated' when every line is fully
// covered (else it stays 'confirmed' = partial). Returns a per-line summary
// including any shortfalls.

import { createClient } from "@supabase/supabase-js";
import { evaluateSoCreditGate } from "../../../_lib/customers/soShipGate.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const actor = (body?.created_by_user_id && UUID_RE.test(String(body.created_by_user_id)))
    ? String(body.created_by_user_id) : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Non-factor credit ship-gate: a house-account customer with overdue AR (or an
  // unpaid credit-card order) is held — it cannot allocate stock until the hold
  // is cleared or an operator overrides (credit_approval_status='approved').
  // Factored customers are gated inside the allocate_sales_order RPC (factor
  // approval) and are skipped here. Best-effort: a failed lookup blocks (the
  // hold is the safe default for an explicit gate) but surfaces the cause.
  {
    const { data: so } = await admin
      .from("sales_orders")
      .select("id, customer_id, entity_id, payment_terms_id, total_cents, amount_paid_cents, credit_approval_status")
      .eq("id", id).maybeSingle();
    if (so && so.customer_id && so.credit_approval_status !== "approved") {
      const { data: cust } = await admin.from("customers").select("is_factored").eq("id", so.customer_id).maybeSingle();
      if (cust?.is_factored !== true) {
        try {
          const decision = await evaluateSoCreditGate(admin, {
            customer_id: so.customer_id, entity_id: so.entity_id,
            payment_terms_id: so.payment_terms_id, total_cents: so.total_cents,
            amount_paid_cents: so.amount_paid_cents,
          });
          if (decision.blocked) {
            await admin.from("sales_orders").update({
              credit_approval_status: decision.target_status,
              credit_hold_reason: decision.reason,
              credit_checked_at: new Date().toISOString(),
            }).eq("id", so.id);
            return res.status(409).json({ error: decision.reason, credit_gate: decision.gate });
          }
        } catch (e) {
          return res.status(500).json({ error: `Credit gate check failed: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }
  }

  const { data, error } = await admin.rpc("allocate_sales_order", { p_so_id: id, p_user_id: actor });
  if (error) {
    // The RPC RAISEs for not-found / wrong-status; surface as 409 with the message.
    const msg = error.message || String(error);
    const code = /not found/i.test(msg) ? 404 : /only allocate|status is/i.test(msg) ? 409 : 500;
    return res.status(code).json({ error: msg });
  }

  const fully = data?.fully_allocated === true;
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const shorts = lines.filter((l) => Number(l.shortfall) > 0).length;
  const message = fully
    ? "Fully allocated — sales order moved to allocated."
    : shorts > 0
      ? `Partially allocated — ${shorts} line(s) short on stock. SO stays confirmed.`
      : "Allocation run complete.";

  return res.status(200).json({ ...data, message });
}
