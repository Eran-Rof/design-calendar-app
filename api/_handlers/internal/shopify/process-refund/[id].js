// api/internal/shopify/process-refund/:id
//
// Tangerine P11-6 — manual trigger for the Shopify refund processing service.
//
// POST /api/internal/shopify/process-refund/:id
//   :id = shopify_refunds.id (uuid).
//
// Auth: gated by authenticateInternalCaller. Soft-open when INTERNAL_API_TOKEN
// is unset (matches the rollout pattern of every other /api/internal handler).
//
// Calls processShopifyRefund({ shopifyRefundId, adminClient }). Returns:
//   200 { status:'already_processed', ar_credit_memo_id, refund_type }
//   200 { status:'voided',            refund_type:'full',    ar_invoice_id, reversed_je_ids }
//   200 { status:'credit_memo_posted',refund_type:'partial', ar_credit_memo_id, je_id, cogs_je_id, inventory_layer_ids }
//   400 { error: ... } — bad payload / missing GL accounts / invalid amounts
//   401 { error: ... } — auth fail
//   404 { error: ... } — refund/order not found
//   500 { error: ... } — RPC / DB failure

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { processShopifyRefund } from "../../../../_lib/shopify/process-refund.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Internal-Token, X-Entity-ID",
  );
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

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) {
    return res.status(400).json({ error: "Invalid id (expected uuid)" });
  }

  const adminClient = client();
  if (!adminClient) {
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    const result = await processShopifyRefund({
      shopifyRefundId: id,
      adminClient,
    });
    return res.status(200).json(result);
  } catch (e) {
    if (e?.code === "not_found") {
      return res.status(404).json({ error: e.message });
    }
    if (e?.code === "parent_ar_invoice_missing") {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === "gl_accounts_missing") {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === "customer_resolution_failed") {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === "invalid_amounts") {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === "rpc_failed") {
      return res.status(500).json({ error: e.message });
    }
    if (e?.code === "ar_invoice_insert_failed") {
      return res.status(500).json({
        error: e.message,
        je_id: e.je_id || null,
      });
    }
    return res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
