// api/internal/planning/sync-tangerine-supply  (h607)
//
// M31 / P17 direction B — populate the planning supply input tables from native
// Tangerine ERP data (source='tangerine'): on-hand from inventory_layers,
// open POs from purchase_orders. A planning run with supply_source='tangerine'
// then reconciles against these instead of the Xoro/ATS mirror.
//
// POST { which? }  which ∈ 'all' (default) | 'on_hand' | 'open_pos'
//   (x-user-email header; permission: manage_integrations)
//
// Decision/aggregation logic lives in api/_lib/planning-supply-tangerine.js
// (pure transforms, unit-tested). This handler is IO + auth only.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";
import { syncOnHandFromTangerine, syncOpenPosFromTangerine } from "../../../_lib/planning-supply-tangerine.js";

export const config = { maxDuration: 60 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const perm = await checkPermission(req, "manage_integrations");
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const which = body.which || "all";

  try {
    const out = {};
    if (which === "all" || which === "on_hand") out.on_hand = await syncOnHandFromTangerine(admin);
    if (which === "all" || which === "open_pos") out.open_pos = await syncOpenPosFromTangerine(admin);
    const parts = [];
    if (out.on_hand) parts.push(`on-hand: ${out.on_hand.total_units.toLocaleString()} units / ${out.on_hand.skus} SKUs`);
    if (out.open_pos) parts.push(`open POs: ${out.open_pos.open_po_rows_inserted} line(s)`);
    return res.status(200).json({ ok: true, ...out, message: `Tangerine supply synced — ${parts.join(" · ") || "nothing"}.` });
  } catch (e) {
    return res.status(500).json({ error: `Tangerine supply sync failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}
