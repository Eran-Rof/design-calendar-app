// api/internal/mfg-reports
//
// GET — manufacturing reports (read-only aggregation). Returns:
//   { open_wip, completed, parts_valuation }
//     open_wip   — builds still in WIP (released/issued/in_progress) with their
//                  cost breakdown (parts / service / consumed-style / total) +
//                  created_at (the UI ages them).
//     completed  — completed builds with completed qty, total + unit cost, and
//                  the same cost breakdown.
//     parts_valuation — { total_value_cents, part_count, top[] } from
//                  part_inventory_layers (on-hand × layer cost).
//
// Manufacturing M6. No live data until builds run.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id ?? null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Builds (exclude cancelled).
  const { data: builds, error: bErr } = await admin
    .from("mfg_build_orders").select("*").eq("entity_id", entityId).neq("status", "cancelled");
  if (bErr) return res.status(500).json({ error: bErr.message });
  const buildList = builds || [];

  // Finished-item labels.
  const itemIds = [...new Set(buildList.map((b) => b.finished_item_id))];
  const { data: items } = itemIds.length
    ? await admin.from("ip_item_master").select("id, sku_code, description").in("id", itemIds)
    : { data: [] };
  const itemBy = new Map((items || []).map((i) => [i.id, i]));

  // Per-build cost breakdown from components.
  const buildIds = buildList.map((b) => b.id);
  const { data: comps } = buildIds.length
    ? await admin.from("mfg_build_components").select("build_order_id, component_kind, actual_cost_cents").in("build_order_id", buildIds)
    : { data: [] };
  const breakdown = new Map(); // build_id → {parts, service, style}
  for (const c of comps || []) {
    const b = breakdown.get(c.build_order_id) || { parts: 0, service: 0, style: 0 };
    const cost = Number(c.actual_cost_cents || 0);
    if (c.component_kind === "part") b.parts += cost;
    else if (c.component_kind === "service") b.service += cost;
    else if (c.component_kind === "finished_style") b.style += cost;
    breakdown.set(c.build_order_id, b);
  }

  const decorate = (b) => {
    const it = itemBy.get(b.finished_item_id);
    const bd = breakdown.get(b.id) || { parts: 0, service: 0, style: 0 };
    return {
      id: b.id, build_number: b.build_number, status: b.status,
      finished_sku: it?.sku_code ?? null, finished_desc: it?.description ?? null,
      target_qty: Number(b.target_qty), completed_qty: Number(b.completed_qty),
      created_at: b.created_at, updated_at: b.updated_at,
      parts_cents: bd.parts, service_cents: bd.service, style_cents: bd.style,
      total_cents: Number(b.accumulated_cost_cents || 0),
      finished_unit_cost_cents: b.finished_unit_cost_cents != null ? Number(b.finished_unit_cost_cents) : null,
    };
  };

  const open_wip = buildList.filter((b) => ["released", "issued", "in_progress"].includes(b.status)).map(decorate);
  const completed = buildList.filter((b) => b.status === "completed").map(decorate);

  // Parts valuation from open part layers.
  const { data: partLayers } = await admin
    .from("part_inventory_layers").select("part_id, remaining_qty, unit_cost_cents").eq("entity_id", entityId).gt("remaining_qty", 0);
  const partAgg = new Map();
  for (const l of partLayers || []) {
    const cur = partAgg.get(l.part_id) || { qty: 0, value: 0 };
    const qty = Number(l.remaining_qty) || 0;
    cur.qty += qty; cur.value += Math.round(qty * Number(l.unit_cost_cents || 0));
    partAgg.set(l.part_id, cur);
  }
  let partValueTotal = 0;
  for (const v of partAgg.values()) partValueTotal += v.value;
  const partIds = [...partAgg.keys()];
  const { data: partRows } = partIds.length
    ? await admin.from("part_master").select("id, code, name").in("id", partIds)
    : { data: [] };
  const partBy = new Map((partRows || []).map((p) => [p.id, p]));
  const top = [...partAgg.entries()]
    .map(([pid, v]) => ({ code: partBy.get(pid)?.code ?? null, name: partBy.get(pid)?.name ?? "(unknown)", on_hand_qty: v.qty, value_cents: v.value }))
    .sort((a, b) => b.value_cents - a.value_cents)
    .slice(0, 25);

  return res.status(200).json({
    open_wip,
    completed,
    parts_valuation: { total_value_cents: partValueTotal, part_count: partAgg.size, top },
    open_wip_total_cents: open_wip.reduce((s, b) => s + b.total_cents, 0),
  });
}
