// api/internal/shopify/post-cogs/:id
//
// Tangerine P11-5 — manual trigger for the Shopify per-line COGS posting
// service. Useful when:
//   1. The AR JE (P11-3) posted but COGS failed (eg. operator hadn't yet
//      seeded 5000/1300 on the entity COA, or inventory wasn't yet
//      received). After fixing the cause, hit this endpoint to retry.
//   2. Backfill ran before SKU→ip_item_master mapping was complete; after
//      a master refresh, retry COGS to capture the now-resolvable lines.
//
// POST /api/internal/shopify/post-cogs/:id
//   :id = shopify_orders.id (uuid).
//
// Body (optional, ignored today; reserved for future flags).
//
// Calls postShopifyOrderCogs({ shopifyOrderId, adminClient }). Returns:
//   200 { status:'posted',          je_id, cogs_cents, lines }
//   200 { status:'already_posted',  je_id }
//   200 { status:'no_cogs',         reason }
//   400 { error: ... }     — missing GL accounts / bad uuid
//   401 { error: ... }     — auth gate (mirror of P11-3 manual handler)
//   404 { error: ... }     — shopify_orders not found
//   500 { error: ... }     — RPC failed / unknown
//
// Auth: gated by authenticateInternalCaller. Same gate as every other
// /api/internal/** handler.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { postShopifyOrderCogs } from "../../../../_lib/shopify/post-order-cogs.js";

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

  // 1. Auth gate.
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // 2. Validate id.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) {
    return res.status(400).json({ error: "Invalid id (expected uuid)" });
  }

  // 3. Supabase client.
  const adminClient = client();
  if (!adminClient) {
    return res.status(500).json({ error: "Server not configured" });
  }

  // 4. Run the service.
  try {
    const result = await postShopifyOrderCogs({
      shopifyOrderId: id,
      adminClient,
    });
    return res.status(200).json(result);
  } catch (e) {
    if (e?.code === "not_found") {
      return res.status(404).json({ error: e.message });
    }
    if (e?.code === "gl_accounts_missing") {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === "fifo_consume_failed") {
      return res.status(500).json({
        error: e.message,
        line_errors: e.line_errors || [],
      });
    }
    if (e?.code === "rpc_failed") {
      return res.status(500).json({ error: e.message });
    }
    if (e?.code === "shopify_orders_update_failed") {
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
