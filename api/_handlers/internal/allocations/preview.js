// api/internal/allocations/preview
//
// P16 / M18 — Auto-allocate PREVIEW (no write). Computes the proposed allocation
// for the chosen strategy so the operator sees the exact size-level result
// before applying. The companion POST /api/internal/allocations applies it.
//
// POST { strategy?: 'priority_full', item_ids?: [uuid], line_ids?: [uuid] }
//   scope = item_ids (a style/color's SKUs) or line_ids; omit both = all demand.
//   Returns { proposals: [{ line_id, so_id, so_number, item_id, sku_code, color,
//     size, customer_name, tier, current_allocated, proposed_allocated, grant,
//     blocked_reason? }] }.
//
// v1 strategy = 'priority_full' only: fill each competing line 100% in priority
// order — factor-approved → credit-card → oldest (order_date asc) — until the
// item's live available pool runs out. Factored SOs are gated exactly as the
// apply RPC (approved + reference + resulting allocated $ ≤ factor_approved_cents);
// blocked lines surface with a reason and grant 0. The apply RPC re-validates, so
// a stale preview is safe. The strategy switch is the seam for future fair-share /
// capped-% modes.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

// Priority tier: 1 = factor-approved, 2 = credit-card, 3 = oldest/other, 9 = blocked.
function tierOf(d) {
  if (d.is_factored) {
    const ok = d.factor_approval_status === "approved" && String(d.factor_reference || "").trim() !== "";
    return ok ? { tier: 1 } : { tier: 9, reason: d.factor_approval_status !== "approved" ? "factor not approved" : "factor reference missing" };
  }
  if (d.has_card) return { tier: 2 };
  return { tier: 3 };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const strategy = body?.strategy || "priority_full";
  if (strategy !== "priority_full") return res.status(400).json({ error: `strategy '${strategy}' not supported yet (v1: priority_full)` });
  const itemIds = Array.isArray(body?.item_ids) ? body.item_ids.filter((x) => UUID_RE.test(String(x))) : [];
  const lineIds = Array.isArray(body?.line_ids) ? body.line_ids.filter((x) => UUID_RE.test(String(x))) : [];

  // Pull the demand set for the scope.
  let q = admin.from("v_allocation_demand").select("*").eq("entity_id", entityId);
  if (itemIds.length) q = q.in("item_id", itemIds);
  if (lineIds.length) q = q.in("line_id", lineIds);
  const { data: demand, error } = await q.limit(5000);
  if (error) return res.status(500).json({ error: error.message });
  const rows = demand || [];
  if (!rows.length) return res.status(200).json({ proposals: [] });

  // Live available per item.
  const presentItems = [...new Set(rows.map((r) => r.item_id))];
  const { data: av, error: avErr } = await admin
    .from("v_inventory_available")
    .select("item_id, available_qty")
    .eq("entity_id", entityId)
    .in("item_id", presentItems);
  if (avErr) return res.status(500).json({ error: avErr.message });
  const pool = {};                                   // item_id -> remaining available
  for (const a of av || []) pool[a.item_id] = Math.max(Number(a.available_qty) || 0, 0);

  // Per-SO running allocated $ baseline (from this demand set) for the factor cap.
  const soCents = {};                                // so_id -> allocated cents so far
  for (const r of rows) {
    soCents[r.so_id] = (soCents[r.so_id] || 0) + (Number(r.qty_allocated) || 0) * (Number(r.unit_price_cents) || 0);
  }

  // Sort by tier, then oldest order_date, then earliest ship date.
  const enriched = rows.map((r) => ({ r, ...tierOf(r) }));
  enriched.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ao = a.r.order_date || "9999", bo = b.r.order_date || "9999";
    if (ao !== bo) return ao < bo ? -1 : 1;
    const as = a.r.requested_ship_date || "9999", bs = b.r.requested_ship_date || "9999";
    return as < bs ? -1 : as > bs ? 1 : 0;
  });

  const proposals = [];
  for (const e of enriched) {
    const r = e.r;
    const openQty = Math.max(Number(r.qty_ordered) - Number(r.qty_allocated), 0);
    const base = {
      line_id: r.line_id, so_id: r.so_id, so_number: r.so_number, item_id: r.item_id,
      sku_code: r.sku_code, color: r.color, size: r.size, customer_name: r.customer_name,
      tier: e.tier, current_allocated: Number(r.qty_allocated), proposed_allocated: Number(r.qty_allocated), grant: 0,
    };
    if (e.tier === 9) { proposals.push({ ...base, blocked_reason: e.reason }); continue; }
    if (openQty <= 0) { proposals.push(base); continue; }

    let grant = Math.min(openQty, pool[r.item_id] || 0);

    // Factor $ cap: don't let the SO's allocated $ exceed factor_approved_cents.
    if (r.is_factored) {
      const unit = Number(r.unit_price_cents) || 0;
      const approved = Number(r.factor_approved_cents) || 0;
      const headroomCents = approved - (soCents[r.so_id] || 0);
      const maxByDollars = unit > 0 ? Math.floor(headroomCents / unit) : grant;
      if (maxByDollars < grant) grant = Math.max(maxByDollars, 0);
      if (grant <= 0) { proposals.push({ ...base, blocked_reason: "factor approval $ reached" }); continue; }
      soCents[r.so_id] = (soCents[r.so_id] || 0) + grant * unit;
    }

    if (grant <= 0) { proposals.push(base); continue; }
    pool[r.item_id] = (pool[r.item_id] || 0) - grant;
    proposals.push({ ...base, grant, proposed_allocated: Number(r.qty_allocated) + grant });
  }

  return res.status(200).json({ proposals });
}
