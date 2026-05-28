// api/internal/bank-transactions/:id/match-candidates
//
// GET — return v_bank_match_candidates rows for one bank_transactions row.
// Sorted by confidence DESC then days_apart ASC.
//
// Tangerine P6-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin
    .from("v_bank_match_candidates")
    .select("*")
    .eq("bank_transaction_id", id)
    .order("confidence", { ascending: false })
    .order("days_apart", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
