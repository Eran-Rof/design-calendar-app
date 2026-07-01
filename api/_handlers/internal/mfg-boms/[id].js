// api/internal/mfg-boms/[id]
//
// GET    — BOM header + components, each component resolved to a human label
//          (no raw uuids): part code/name, service code/name, or finished-style
//          sku_code/description.
// PATCH  — update header fields (status, version, default_conversion_vendor_id,
//          notes) and/or REPLACE the full component list when `components` is
//          supplied (delete-all + re-insert). Flipping to status='active' is
//          guarded by the one-active-per-item unique index (409).
// DELETE — delete the BOM (components cascade).

import { createClient } from "@supabase/supabase-js";
import { validateComponents } from "./_validate.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function decorateComponents(admin, bomId) {
  const { data: comps } = await admin
    .from("mfg_bom_components").select("*").eq("bom_id", bomId).order("line_number", { ascending: true });
  const list = comps || [];
  const partIds = list.filter((c) => c.part_id).map((c) => c.part_id);
  const svcIds = list.filter((c) => c.service_item_id).map((c) => c.service_item_id);
  const itemIds = list.filter((c) => c.component_item_id).map((c) => c.component_item_id);

  const [parts, svcs, items] = await Promise.all([
    partIds.length ? admin.from("part_master").select("id, code, name, default_unit_cost_cents").in("id", partIds) : Promise.resolve({ data: [] }),
    svcIds.length ? admin.from("service_item_master").select("id, code, name, default_charge_cents").in("id", svcIds) : Promise.resolve({ data: [] }),
    itemIds.length ? admin.from("ip_item_master").select("id, sku_code, style_code, description").in("id", itemIds) : Promise.resolve({ data: [] }),
  ]);
  const partBy = new Map((parts.data || []).map((p) => [p.id, p]));
  const svcBy = new Map((svcs.data || []).map((s) => [s.id, s]));
  const itemBy = new Map((items.data || []).map((i) => [i.id, i]));

  // Finished-style unit cost = ip_item_avg_cost (same source the SO grid uses),
  // resolved by normalized sku_code via the shared RPC.
  const costBySku = new Map();
  const skus = [...new Set((items.data || []).map((i) => i.sku_code).filter(Boolean))];
  if (skus.length) {
    const { data: costs } = await admin.rpc("resolve_avg_cost_by_norm", { p_skus: skus });
    for (const r of costs || []) {
      if (r.input_sku != null && r.avg_cost != null) costBySku.set(r.input_sku, Math.round(Number(r.avg_cost) * 100));
    }
  }

  return list.map((c) => {
    let label = null, code = null, unitCostCents = null;
    if (c.component_kind === "part" && partBy.get(c.part_id)) {
      const p = partBy.get(c.part_id); code = p.code; label = p.name;
      unitCostCents = p.default_unit_cost_cents ?? null;
    } else if (c.component_kind === "service" && svcBy.get(c.service_item_id)) {
      const s = svcBy.get(c.service_item_id); code = s.code; label = s.name;
      // Stored override wins; else the service master default charge.
      unitCostCents = c.unit_cost_cents != null ? c.unit_cost_cents : (s.default_charge_cents ?? null);
    } else if (c.component_kind === "finished_style" && itemBy.get(c.component_item_id)) {
      const it = itemBy.get(c.component_item_id); code = it.sku_code; label = it.description;
      unitCostCents = costBySku.get(it.sku_code) ?? null;
    }
    return { ...c, component_code: code, component_label: label, resolved_unit_cost_cents: unitCostCents };
  });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data: bom, error } = await admin.from("mfg_bom").select("*").eq("id", id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!bom) return res.status(404).json({ error: "BOM not found" });

    const { data: fi } = bom.finished_item_id
      ? await admin.from("ip_item_master").select("id, sku_code, style_code, description").eq("id", bom.finished_item_id).maybeSingle()
      : { data: null };
    const { data: fstyle } = bom.finished_style_id
      ? await admin.from("style_master").select("id, style_code, style_name").eq("id", bom.finished_style_id).maybeSingle()
      : { data: null };
    const { data: cust } = bom.customer_id
      ? await admin.from("customers").select("id, name, code").eq("id", bom.customer_id).maybeSingle()
      : { data: null };
    const components = await decorateComponents(admin, id);
    return res.status(200).json({ ...bom, finished_item: fi || null, finished_style: fstyle || null, customer_name: cust?.name || null, components });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const patch = {};
    if (body.status != null) {
      if (!["draft", "active", "archived"].includes(body.status)) return res.status(400).json({ error: "status must be draft|active|archived" });
      patch.status = body.status;
    }
    if (body.version != null && body.version !== "") {
      const v = parseInt(body.version, 10);
      if (!Number.isInteger(v) || v < 1) return res.status(400).json({ error: "version must be a positive integer" });
      patch.version = v;
    }
    if ("default_conversion_vendor_id" in body) {
      if (body.default_conversion_vendor_id && !UUID_RE.test(String(body.default_conversion_vendor_id))) return res.status(400).json({ error: "default_conversion_vendor_id must be a uuid" });
      patch.default_conversion_vendor_id = body.default_conversion_vendor_id || null;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() || null : null;
    if ("customer_id" in body) {
      if (body.customer_id && !UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: "customer_id must be a uuid" });
      patch.customer_id = body.customer_id || null;
    }

    // Replace components when supplied.
    let compRows = null;
    if (body.components !== undefined) {
      const compv = validateComponents(body.components);
      if (compv.error) return res.status(400).json({ error: compv.error });
      compRows = compv.rows;
    }

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      const { error: upErr } = await admin.from("mfg_bom").update(patch).eq("id", id);
      if (upErr) {
        if (upErr.code === "23505") return res.status(409).json({ error: "An active BOM already exists for this finished item (or version clash). Archive it first." });
        return res.status(500).json({ error: upErr.message });
      }
    }

    if (compRows !== null) {
      const { error: delErr } = await admin.from("mfg_bom_components").delete().eq("bom_id", id);
      if (delErr) return res.status(500).json({ error: `Failed to clear components: ${delErr.message}` });
      if (compRows.length > 0) {
        const rows = compRows.map((c, i) => ({ ...c, bom_id: id, line_number: i + 1 }));
        const { error: insErr } = await admin.from("mfg_bom_components").insert(rows);
        if (insErr) return res.status(400).json({ error: `Component insert failed: ${insErr.message}` });
      }
    }

    const { data: bom } = await admin.from("mfg_bom").select("*").eq("id", id).maybeSingle();
    const components = await decorateComponents(admin, id);
    return res.status(200).json({ ...bom, components });
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin.from("mfg_bom").delete().eq("id", id).select("id").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "BOM not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
