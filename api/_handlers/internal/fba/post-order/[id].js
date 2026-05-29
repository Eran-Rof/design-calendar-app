// api/internal/fba/post-order/:id
//
// Tangerine P12a-3 — manual trigger for the FBA AR JE posting service.
//
// POST /api/internal/fba/post-order/:id
//   :id = fba_orders.id (uuid).
//
// Body (optional, reserved for future flags).
//
// Calls postFbaOrderJe({ fbaOrderId, adminClient }). Returns:
//   200 { status:'posted',         je_id, ar_invoice_id }   — fresh post
//   200 { status:'already_posted', je_id }                  — idempotent re-call
//   400 { error: ... }                                      — missing GL accounts / bad payload
//   401 { error: 'Missing internal token' | 'Invalid internal token' }
//   404 { error: 'fba_orders <id> not found' }
//   500 { error: ... }                                      — RPC failed / unknown
//
// Auth: gated by authenticateInternalCaller. Same gate as every other
// /api/internal/** handler — Bearer token or X-Internal-Token; soft-open
// when INTERNAL_API_TOKEN is unset (rollout pattern).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { postFbaOrderJe } from "../../../../_lib/marketplaces/fba/post-order-je.js";

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

  // 2. Validate id (dispatcher passes ?id query param — see
  //    feedback_dispatcher_query_not_params: req.query.id, not req.params).
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
    const result = await postFbaOrderJe({
      fbaOrderId: id,
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
    if (e?.code === "customer_resolution_failed") {
      return res.status(400).json({ error: e.message });
    }
    if (e?.code === "rpc_failed") {
      return res.status(500).json({ error: e.message });
    }
    if (e?.code === "ar_invoice_insert_failed" || e?.code === "fba_orders_update_failed") {
      return res.status(500).json({
        error: e.message,
        je_id: e.je_id || null,
        ar_invoice_id: e.ar_invoice_id || null,
      });
    }
    return res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
