// api/internal/faire/post-payout/:id
//
// Tangerine P12c-3 — manual trigger for the Faire payout JE posting service.
//
// POST /api/internal/faire/post-payout/:id
//   :id = faire_payouts.id (uuid).
//
// Calls postFairePayoutJe({ fairePayoutId, adminClient }). Returns:
//   200 { status:'posted',         je_id, bank_transaction_id }
//   200 { status:'already_posted', je_id }
//   400 { error: ... }                                      — missing GL accounts
//   401 { error: 'Missing internal token' | 'Invalid internal token' }
//   404 { error: 'faire_payouts <id> not found' }
//   500 { error: ... }
//
// Auth: gated by authenticateInternalCaller.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { postFairePayoutJe } from "../../../../_lib/marketplaces/faire/post-payout-je.js";

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
    const result = await postFairePayoutJe({
      fairePayoutId: id,
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
    if (e?.code === "rpc_failed") {
      return res.status(500).json({ error: e.message });
    }
    if (e?.code === "faire_payouts_update_failed") {
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
