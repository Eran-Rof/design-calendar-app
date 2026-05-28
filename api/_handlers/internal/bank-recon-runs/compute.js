// api/internal/bank-recon-runs/:id/compute
//
// POST — refresh gl_balance_cents + uncleared_txn_cents + reconciled_diff_cents
// for an existing recon run. Calls the bank_recon_compute RPC.
//
// Tangerine P6-6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: run, error: rErr } = await admin
    .from("bank_recon_runs")
    .select("bank_account_id, period_id")
    .eq("id", id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!run) return res.status(404).json({ error: "Recon run not found" });

  const { data, error } = await admin.rpc("bank_recon_compute", {
    p_bank_account_id: run.bank_account_id,
    p_period_id: run.period_id,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}
