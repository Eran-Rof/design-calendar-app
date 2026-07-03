// api/internal/mfg-boms
//
// GET  — list BOMs. ?finished_item_id=<uuid> scopes to one finished style;
//        ?status=draft|active|archived filters; default returns all non-archived.
//        Each row includes finished_item (code/desc) + component_count.
// POST — create a BOM header + its components in one call. Body:
//          { finished_item_id (required), version?, status? (draft|active),
//            default_conversion_vendor_id?, notes?,
//            components: [ { component_kind, part_id|service_item_id|component_item_id,
//                            qty_per_unit?, scrap_pct?, cost_source? } ] }
//        Setting status='active' is guarded by the one-active-per-item unique
//        index (409 on conflict).
//
// Manufacturing BOM = recipe for assembling a finished style from parts +
// services + (optionally) other finished styles.

import { createClient } from "@supabase/supabase-js";
import { validateComponents } from "./_validate.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const finishedItemId = (url.searchParams.get("finished_item_id") || "").trim();
    const status = (url.searchParams.get("status") || "").trim();

    let query = admin
      .from("mfg_bom")
      .select("*")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false });
    if (finishedItemId && UUID_RE.test(finishedItemId)) query = query.eq("finished_item_id", finishedItemId);
    if (status) query = query.eq("status", status);
    else query = query.neq("status", "archived");

    const { data: boms, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    if (!boms || boms.length === 0) return res.status(200).json([]);

    // Resolve finished-item + finished-style + customer labels + component counts.
    const itemIds = [...new Set(boms.map((b) => b.finished_item_id).filter(Boolean))];
    const { data: items } = itemIds.length
      ? await admin.from("ip_item_master").select("id, sku_code, style_code, description").in("id", itemIds)
      : { data: [] };
    const itemById = new Map((items || []).map((i) => [i.id, i]));

    const styleIds = [...new Set(boms.map((b) => b.finished_style_id).filter(Boolean))];
    const styleById = new Map();
    if (styleIds.length) {
      const { data: styles } = await admin.from("style_master").select("id, style_code, style_name").in("id", styleIds);
      for (const s of styles || []) styleById.set(s.id, s);
    }

    const custIds = [...new Set(boms.map((b) => b.customer_id).filter(Boolean))];
    const custById = new Map();
    if (custIds.length) {
      const { data: custs } = await admin.from("customers").select("id, name, code").in("id", custIds);
      for (const c of custs || []) custById.set(c.id, c);
    }

    const bomIds = boms.map((b) => b.id);
    const { data: comps } = await admin
      .from("mfg_bom_components").select("bom_id").in("bom_id", bomIds);
    const countByBom = new Map();
    for (const c of comps || []) countByBom.set(c.bom_id, (countByBom.get(c.bom_id) || 0) + 1);

    const out = boms.map((b) => ({
      ...b,
      finished_item: itemById.get(b.finished_item_id)
        ? { sku_code: itemById.get(b.finished_item_id).sku_code, style_code: itemById.get(b.finished_item_id).style_code, description: itemById.get(b.finished_item_id).description }
        : null,
      finished_style: b.finished_style_id && styleById.get(b.finished_style_id)
        ? { style_code: styleById.get(b.finished_style_id).style_code, style_name: styleById.get(b.finished_style_id).style_name }
        : null,
      customer_name: b.customer_id ? (custById.get(b.customer_id)?.name || null) : null,
      component_count: countByBom.get(b.id) || 0,
    }));
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};
    // Finished good = a STYLE. Accept finished_style_id (preferred) or a legacy
    // finished_item_id; resolve the other. finished_item_id stays a
    // representative SKU handle for the style.
    let finishedStyleId = body.finished_style_id || null;
    let finishedItemId = body.finished_item_id || null;
    if (finishedStyleId) {
      if (!UUID_RE.test(String(finishedStyleId))) return res.status(400).json({ error: "finished_style_id must be a uuid" });
      const { data: st } = await admin.from("style_master").select("id").eq("id", String(finishedStyleId)).maybeSingle();
      if (!st) return res.status(404).json({ error: "Style not found" });
      if (!finishedItemId) {
        const { data: rep } = await admin.from("ip_item_master").select("id").eq("style_id", String(finishedStyleId)).limit(1).maybeSingle();
        if (!rep?.id) return res.status(400).json({ error: "This style has no SKUs yet — add one before creating its BOM." });
        finishedItemId = rep.id;
      }
    } else if (finishedItemId) {
      if (!UUID_RE.test(String(finishedItemId))) return res.status(400).json({ error: "finished_item_id must be a uuid" });
      const { data: fi } = await admin.from("ip_item_master").select("style_id").eq("id", String(finishedItemId)).maybeSingle();
      finishedStyleId = fi?.style_id || null;
    } else {
      return res.status(400).json({ error: "finished_style_id (or finished_item_id) is required" });
    }
    // Optional customer — a private-label / customer-specific BOM.
    let customerId = null;
    if (body.customer_id != null && body.customer_id !== "") {
      if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: "customer_id must be a uuid" });
      customerId = String(body.customer_id);
    }
    const status = body.status === "active" ? "active" : "draft";
    let version = 1;
    if (body.version != null && body.version !== "") {
      version = parseInt(body.version, 10);
      if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: "version must be a positive integer" });
    }
    if (body.default_conversion_vendor_id != null && body.default_conversion_vendor_id !== "" && !UUID_RE.test(String(body.default_conversion_vendor_id))) {
      return res.status(400).json({ error: "default_conversion_vendor_id must be a uuid" });
    }
    const compv = validateComponents(body.components);
    if (compv.error) return res.status(400).json({ error: compv.error });

    const header = {
      entity_id: entityId,
      finished_item_id: String(finishedItemId),
      finished_style_id: finishedStyleId,
      customer_id: customerId,
      version,
      status,
      bom_kind: body.bom_kind === "sku" ? "sku" : "style",
      default_conversion_vendor_id: body.default_conversion_vendor_id || null,
      notes: body.notes != null ? String(body.notes).trim() || null : null,
    };
    const { data: bom, error: hErr } = await admin.from("mfg_bom").insert(header).select().single();
    if (hErr) {
      if (hErr.code === "23505") {
        return res.status(409).json({ error: "A BOM with this version already exists, or an active BOM already exists for this style" + (customerId ? " and customer." : ". Archive it first or bump the version.") });
      }
      return res.status(500).json({ error: hErr.message });
    }

    if (compv.rows.length > 0) {
      const rows = compv.rows.map((c, i) => ({ ...c, bom_id: bom.id, line_number: i + 1 }));
      const { error: cErr } = await admin.from("mfg_bom_components").insert(rows);
      if (cErr) {
        await admin.from("mfg_bom").delete().eq("id", bom.id); // roll back header
        return res.status(400).json({ error: `Component insert failed: ${cErr.message}` });
      }
    }
    return res.status(201).json({ ...bom, component_count: compv.rows.length });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
