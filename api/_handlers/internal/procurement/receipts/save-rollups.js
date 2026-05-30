// api/internal/procurement/receipts/[id]/save-rollups
//
// Tangerine P13-3 — D19 receipt-rollup save handler. Replaces the receipt's
// rollups wholesale with the provided list, auto-creates one AP `invoices`
// row per rollup in status='pending_bookkeeper_approval' (the D19 gate),
// and updates the parent receipt's landed_cost_cents.
//
// Body: { rollups: [ { expense_gl_account_id, amount_cents, vendor_id?,
//                       description, capitalized_to_inventory? } ] }
//
// Path param: req.query.id is the tanda_po_receipts.id.

import { createClient } from "@supabase/supabase-js";
import { applyRollups, validateRollup } from "./index.js";

export const config = { maxDuration: 30 };

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
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid receipt id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  const v = validateSaveRollupsBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Fetch receipt + assert it's still mutable.
  const { data: receipt, error: fetchErr } = await admin
    .from("tanda_po_receipts")
    .select("id, entity_id, status")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });
  if (receipt.status === "posted") {
    return res.status(409).json({
      error: `Cannot modify rollups while receipt status='${receipt.status}'. Reverse the posting first.`,
    });
  }

  const result = await applyRollups(admin, id, receipt.entity_id, v.data.rollups);
  if (result.error) return res.status(500).json({ error: result.error });

  return res.status(200).json({
    receipt_id: id,
    landed_cost_cents: result.data.landed_cost_cents,
    rollups: result.data.rollups,
  });
}

export function validateSaveRollupsBody(body) {
  if (!Array.isArray(body.rollups)) {
    return { error: "rollups must be an array (empty array clears existing rollups)" };
  }
  const rollups = [];
  for (let i = 0; i < body.rollups.length; i++) {
    const r = validateRollup(body.rollups[i], i + 1);
    if (r.error) return { error: r.error };
    rollups.push(r.data);
  }
  return { data: { rollups } };
}
