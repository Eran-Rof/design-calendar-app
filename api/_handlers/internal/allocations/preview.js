// api/internal/allocations/preview
//
// P16 / M18 — Auto-allocate PREVIEW (no write). Computes the proposed allocation
// for the chosen strategy so the operator sees the exact size-level result
// before applying. The companion POST /api/internal/allocations applies it.
//
// POST { strategy, item_ids?, line_ids?, cap_pct?, cap_basis? }
//   strategy: 'priority_full' (default) | 'fair_share' | 'capped'
//   scope:    item_ids (a style/color's SKUs) or line_ids; omit both = all demand
//   cap_pct:  1..100, required for 'capped'
//   cap_basis:'sku' (per-line open qty) | 'style_color' (per SO+style/color total) — capped only
//   Returns { strategy, proposals: [{ line_id, so_id, so_number, item_id, sku_code,
//     color, size, customer_name, tier, current_allocated, proposed_allocated, grant,
//     blocked_reason? }] }.
//
// All strategies share: priority tiering (factor-approved → credit-card → oldest)
// for ordering / leftover distribution, a running per-item available pool (live
// from v_inventory_available), and the hard factor-credit gate (approved +
// reference + resulting SO allocated $ ≤ factor_approved_cents). Allocation always
// resolves at the size-level SKU, so a style/color % target can never allocate a
// size with zero stock — the % is a ceiling bounded by real per-size availability.
// The apply RPC re-validates, so a stale preview is safe.

import { createClient } from "@supabase/supabase-js";
import { getAllocationRules } from "./rules.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRATEGIES = ["priority_full", "fair_share", "capped"];

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

// Priority tier from the configurable `order` (a permutation of factor_approved
// / credit_card / oldest). tier = 1-based position of the first criterion the
// line matches; 9 = blocked (a factored SO without approval — independent of the
// order, the hard gate always wins). "oldest" matches everyone (the fallback).
function tierOf(d, order) {
  if (d.is_factored) {
    const ok = d.factor_approval_status === "approved" && String(d.factor_reference || "").trim() !== "";
    if (!ok) return { tier: 9, reason: d.factor_approval_status !== "approved" ? "factor not approved" : "factor reference missing" };
  }
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    if (c === "factor_approved" && d.is_factored) return { tier: i + 1 };
    if (c === "credit_card" && d.has_card) return { tier: i + 1 };
    if (c === "oldest") return { tier: i + 1 };
  }
  return { tier: order.length + 1 };
}
// Compare by tier, then the configured tie-break date, then the other date.
function byPriority(a, b, tieBreak) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const primary = tieBreak === "ship_date" ? "requested_ship_date" : "order_date";
  const secondary = tieBreak === "ship_date" ? "order_date" : "requested_ship_date";
  const ap = a.r[primary] || "9999", bp = b.r[primary] || "9999";
  if (ap !== bp) return ap < bp ? -1 : 1;
  const as = a.r[secondary] || "9999", bs = b.r[secondary] || "9999";
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Operator-configured priority order + tie-break (default factor → card →
  // oldest, by order date). `cmp` is the comparator used by every strategy.
  const rules = await getAllocationRules(admin, entityId);
  const cmp = (a, b) => byPriority(a, b, rules.tie_break);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const strategy = body?.strategy || "priority_full";
  if (!STRATEGIES.includes(strategy)) return res.status(400).json({ error: `strategy must be one of ${STRATEGIES.join(", ")}` });
  const capBasis = body?.cap_basis === "style_color" ? "style_color" : "sku";
  const capPct = Number(body?.cap_pct);
  if (strategy === "capped" && (!Number.isFinite(capPct) || capPct <= 0 || capPct > 100)) {
    return res.status(400).json({ error: "cap_pct (1..100) required for the capped strategy" });
  }
  const itemIds = Array.isArray(body?.item_ids) ? body.item_ids.filter((x) => UUID_RE.test(String(x))) : [];
  const lineIds = Array.isArray(body?.line_ids) ? body.line_ids.filter((x) => UUID_RE.test(String(x))) : [];

  // Pull the demand set for the scope.
  let q = admin.from("v_allocation_demand").select("*").eq("entity_id", entityId);
  if (itemIds.length) q = q.in("item_id", itemIds);
  if (lineIds.length) q = q.in("line_id", lineIds);
  const { data: demand, error } = await q.limit(5000);
  if (error) return res.status(500).json({ error: error.message });
  const rows = demand || [];
  if (!rows.length) return res.status(200).json({ strategy, proposals: [] });

  // Live available per item.
  const presentItems = [...new Set(rows.map((r) => r.item_id))];
  const { data: av, error: avErr } = await admin
    .from("v_inventory_available").select("item_id, available_qty")
    .eq("entity_id", entityId).in("item_id", presentItems);
  if (avErr) return res.status(500).json({ error: avErr.message });
  const pool = {};                                   // item_id -> remaining available
  for (const a of av || []) pool[a.item_id] = Math.max(Number(a.available_qty) || 0, 0);

  // Per-SO running allocated $ baseline (from this demand set) for the factor cap.
  const soCents = {};
  for (const r of rows) soCents[r.so_id] = (soCents[r.so_id] || 0) + (Number(r.qty_allocated) || 0) * (Number(r.unit_price_cents) || 0);

  // Enrich + per-line accumulator. blocked lines (tier 9) never receive stock.
  const E = rows.map((r) => {
    const t = tierOf(r, rules.priority_order);
    return { r, tier: t.tier, open: Math.max(Number(r.qty_ordered) - Number(r.qty_allocated), 0), grant: 0, blocked: t.tier === 9 ? t.reason : undefined };
  });

  // Grant up to `want` units to a line, bounded by open, item pool, and factor $ headroom.
  function grant(e, want) {
    if (e.blocked || want <= 0) return 0;
    const r = e.r;
    let g = Math.min(want, e.open - e.grant, pool[r.item_id] || 0);
    if (g <= 0) return 0;
    if (r.is_factored) {
      const unit = Number(r.unit_price_cents) || 0;
      const headroom = (Number(r.factor_approved_cents) || 0) - (soCents[r.so_id] || 0);
      const maxByDollars = unit > 0 ? Math.floor(headroom / unit) : g;
      g = Math.min(g, Math.max(maxByDollars, 0));
      if (g <= 0) { if (e.grant === 0) e.blocked = "factor approval $ reached"; return 0; }
      soCents[r.so_id] = (soCents[r.so_id] || 0) + g * unit;
    }
    e.grant += g;
    pool[r.item_id] = (pool[r.item_id] || 0) - g;
    return g;
  }

  if (strategy === "priority_full") {
    // Each line filled 100% in priority order until the item pool runs out.
    for (const e of [...E].sort(cmp)) grant(e, e.open);

  } else if (strategy === "capped") {
    if (capBasis === "sku") {
      // Per-line ceiling = round(open × pct%); priority full-fill within it.
      for (const e of [...E].sort(cmp)) grant(e, Math.round(e.open * capPct / 100));
    } else {
      // Per (SO, style/color) budget = round(groupOpen × pct%); spread across its
      // sizes in priority order, bounded by per-size pool.
      const groups = new Map();
      for (const e of E) {
        const key = `${e.r.so_id}||${(e.r.description || "").trim()}||${(e.r.color || "").trim()}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      const ordered = [...groups.values()].sort((ga, gb) => cmp(
        ga.reduce((m, x) => (x.tier < m.tier ? x : m), ga[0]),
        gb.reduce((m, x) => (x.tier < m.tier ? x : m), gb[0]),
      ));
      for (const g of ordered) {
        let budget = Math.round(g.reduce((s, e) => s + e.open, 0) * capPct / 100);
        for (const e of [...g].sort(cmp)) {
          if (budget <= 0) break;
          budget -= grant(e, Math.min(e.open, budget));
        }
      }
    }

  } else if (strategy === "fair_share") {
    // Per item: water-fill — distribute the item pool pro-rata by remaining open,
    // capped per line by open + factor $; redistribute leftover by priority.
    const byItem = new Map();
    for (const e of E) { if (!byItem.has(e.r.item_id)) byItem.set(e.r.item_id, []); byItem.get(e.r.item_id).push(e); }
    for (const [itemId, lines] of byItem) {
      const eligible = lines.filter((e) => !e.blocked);
      for (let pass = 0; pass < 8; pass++) {
        const avail = pool[itemId] || 0;
        if (avail <= 0) break;
        const active = eligible.filter((e) => e.grant < e.open);
        if (!active.length) break;
        const totalOpen = active.reduce((s, e) => s + (e.open - e.grant), 0);
        if (totalOpen <= 0) break;
        let progressed = false;
        for (const e of [...active].sort(cmp)) {
          const share = Math.floor(avail * (e.open - e.grant) / totalOpen);
          if (share > 0 && grant(e, share) > 0) progressed = true;
        }
        if (!progressed) { // rounding tail: hand out remaining units 1-by-1 by priority
          for (const e of [...active].sort(cmp)) { if ((pool[itemId] || 0) <= 0) break; grant(e, 1); }
          break;
        }
      }
    }
  }

  const proposals = E.map((e) => ({
    line_id: e.r.line_id, so_id: e.r.so_id, so_number: e.r.so_number, item_id: e.r.item_id,
    sku_code: e.r.sku_code, color: e.r.color, size: e.r.size, customer_name: e.r.customer_name,
    tier: e.tier, current_allocated: Number(e.r.qty_allocated), proposed_allocated: Number(e.r.qty_allocated) + e.grant,
    grant: e.grant, ...(e.blocked ? { blocked_reason: e.blocked } : {}),
  })).filter((p) => p.grant > 0 || p.blocked_reason);

  return res.status(200).json({ strategy, proposals });
}
