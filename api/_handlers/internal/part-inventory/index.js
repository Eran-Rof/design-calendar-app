// api/internal/part-inventory
//
// GET — on-hand by part from part_inventory_layers (remaining_qty > 0).
//        Returns one row per part with on_hand_qty, value_cents (Σ
//        remaining_qty × unit_cost_cents), avg_unit_cost_cents, layer_count.
//        ?q=<search> filters part code/name; ?include_zero=true also lists
//        active parts with no on-hand (qty 0).
//
// Read-only aggregation. Parts are kept separate from style inventory — this
// view never touches inventory_layers / ip_item_master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id ?? null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const includeZero = url.searchParams.get("include_zero") === "true";

  // Parts (active) for labels.
  const { data: parts, error: pErr } = await admin
    .from("part_master")
    .select("id, code, name, part_type, uom, is_active")
    .eq("entity_id", entityId);
  if (pErr) return res.status(500).json({ error: pErr.message });
  const partById = new Map((parts || []).map((p) => [p.id, p]));

  // Open layers.
  const { data: layers, error: lErr } = await admin
    .from("part_inventory_layers")
    .select("part_id, remaining_qty, unit_cost_cents")
    .eq("entity_id", entityId)
    .gt("remaining_qty", 0);
  if (lErr) return res.status(500).json({ error: lErr.message });

  const agg = new Map(); // part_id -> { qty, value_cents, layer_count }
  for (const l of layers || []) {
    const cur = agg.get(l.part_id) || { qty: 0, value_cents: 0, layer_count: 0 };
    const qty = Number(l.remaining_qty) || 0;
    cur.qty += qty;
    cur.value_cents += Math.round(qty * Number(l.unit_cost_cents || 0));
    cur.layer_count += 1;
    agg.set(l.part_id, cur);
  }

  const rows = [];
  for (const [partId, a] of agg.entries()) {
    const p = partById.get(partId);
    rows.push(buildRow(partId, p, a));
  }
  if (includeZero) {
    for (const p of parts || []) {
      if (!p.is_active) continue;
      if (agg.has(p.id)) continue;
      rows.push(buildRow(p.id, p, { qty: 0, value_cents: 0, layer_count: 0 }));
    }
  }

  let out = rows;
  if (q) {
    out = rows.filter((r) =>
      (r.code || "").toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q));
  }
  out.sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  return res.status(200).json(out);
}

function buildRow(partId, p, a) {
  const qty = a.qty;
  const valueCents = a.value_cents;
  return {
    part_id: partId,
    code: p?.code ?? null,
    name: p?.name ?? "(unknown part)",
    part_type: p?.part_type ?? null,
    uom: p?.uom ?? null,
    on_hand_qty: qty,
    value_cents: valueCents,
    avg_unit_cost_cents: qty > 0 ? Math.round(valueCents / qty) : 0,
    layer_count: a.layer_count,
  };
}
