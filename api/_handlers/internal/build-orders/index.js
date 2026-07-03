// api/internal/build-orders
//
// GET  — list build orders. ?status=, ?finished_item_id=, ?limit. Each row
//        includes the finished-item label + bom version.
// POST — create a draft build order. Body:
//          { finished_item_id (or bom_id), target_qty (required),
//            bom_id?, location_id?, notes? }
//        If bom_id is given, finished_item_id is taken from the BOM. Resolves
//        the WIP account (1205). build_number auto-generated (BUILD-NNNNN).
//
// Lifecycle: draft → /release → /issue → (/service…) → /complete.

import { insertWithAutoCode } from "../../../_lib/autoCode.js";
import { resolveOrCreateSku } from "../../../_lib/styleMatrix.js";
import { UUID_RE, corsHeaders, client, resolveDefaultEntityId, accountByCode } from "./_shared.js";

export const config = { maxDuration: 20 };
const CODE_PREFIX = "BUILD-";

export default async function handler(req, res) {
  corsHeaders(res, "GET, POST");
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntityId(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const entityId = entity.id;

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const status = (url.searchParams.get("status") || "").trim();
    const finishedItemId = (url.searchParams.get("finished_item_id") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1000);

    let query = admin.from("mfg_build_orders").select("*").eq("entity_id", entityId)
      .order("created_at", { ascending: false }).limit(limit);
    if (status) query = query.eq("status", status);
    if (finishedItemId && UUID_RE.test(finishedItemId)) query = query.eq("finished_item_id", finishedItemId);

    const { data: builds, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    if (!builds || builds.length === 0) return res.status(200).json([]);

    const itemIds = [...new Set(builds.map((b) => b.finished_item_id))];
    const { data: items } = await admin.from("ip_item_master").select("id, sku_code, description").in("id", itemIds);
    const itemBy = new Map((items || []).map((i) => [i.id, i]));

    const custIds = [...new Set(builds.map((b) => b.customer_id).filter(Boolean))];
    const custBy = new Map();
    if (custIds.length) {
      const { data: custs } = await admin.from("customers").select("id, name, code").in("id", custIds);
      for (const c of custs || []) custBy.set(c.id, c);
    }

    const out = builds.map((b) => ({
      ...b,
      finished_item: itemBy.get(b.finished_item_id)
        ? { sku_code: itemBy.get(b.finished_item_id).sku_code, description: itemBy.get(b.finished_item_id).description } : null,
      customer_name: b.customer_id ? (custBy.get(b.customer_id)?.name || null) : null,
    }));
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    // Finished good = a STYLE. Resolution order: bom_id → finished_style_id →
    // finished_item_id. finished_item_id is kept as a REPRESENTATIVE SKU (a
    // handle for labels / single-item fallback); per-size stock is created from
    // the outputs matrix. When only a style is given we resolve a representative
    // SKU from its existing size variants.
    let finishedItemId = body.finished_item_id || null;
    let finishedStyleId = body.finished_style_id || null;
    let styleCode = null;
    let bomId = body.bom_id || null;
    if (bomId) {
      if (!UUID_RE.test(String(bomId))) return res.status(400).json({ error: "bom_id must be a uuid" });
      const { data: bom } = await admin.from("mfg_bom").select("id, finished_item_id, finished_style_id, status").eq("id", bomId).maybeSingle();
      if (!bom) return res.status(404).json({ error: "BOM not found" });
      finishedItemId = bom.finished_item_id || finishedItemId;
      finishedStyleId = bom.finished_style_id || finishedStyleId;
    }
    if (finishedStyleId) {
      if (!UUID_RE.test(String(finishedStyleId))) return res.status(400).json({ error: "finished_style_id must be a uuid" });
      const { data: st } = await admin.from("style_master").select("id, style_code").eq("id", String(finishedStyleId)).maybeSingle();
      if (!st) return res.status(404).json({ error: "Style not found" });
      styleCode = st.style_code || null;
      if (!finishedItemId) {
        // Representative SKU = any existing size variant of the style.
        const { data: rep } = await admin.from("ip_item_master").select("id").eq("style_id", String(finishedStyleId)).limit(1).maybeSingle();
        if (rep?.id) finishedItemId = rep.id;
      }
    }
    if (!finishedItemId || !UUID_RE.test(String(finishedItemId))) {
      return res.status(400).json({ error: "Pick a finished style (with at least one SKU) or a BOM." });
    }
    if (!finishedStyleId) {
      const { data: fi } = await admin.from("ip_item_master").select("style_id, style_code").eq("id", String(finishedItemId)).maybeSingle();
      finishedStyleId = fi?.style_id || null;
      styleCode = styleCode || fi?.style_code || null;
    }
    if (body.location_id != null && body.location_id !== "" && !UUID_RE.test(String(body.location_id))) {
      return res.status(400).json({ error: "location_id must be a uuid" });
    }
    // Phase B — optional customer this build is made for.
    let customerId = null;
    if (body.customer_id != null && body.customer_id !== "") {
      if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: "customer_id must be a uuid" });
      customerId = String(body.customer_id);
    }

    // Planned per-size matrix (optional, entered at creation). Resolves each
    // (size, color) to its SKU up front; target_qty is the matrix total.
    let plannedOutputs = null;
    if (Array.isArray(body.outputs) && body.outputs.length > 0) {
      if (!finishedStyleId) return res.status(400).json({ error: "A size matrix needs a style-backed finished good." });
      const { data: repItem } = await admin.from("ip_item_master").select("color").eq("id", String(finishedItemId)).maybeSingle();
      plannedOutputs = [];
      for (const o of body.outputs) {
        const q = Number(o?.qty);
        if (!Number.isFinite(q) || q <= 0) continue;
        const size = o?.size != null ? String(o.size).trim() : "";
        if (!size) continue;
        const color = o?.color != null && String(o.color).trim() ? String(o.color).trim() : (repItem?.color || null);
        const rr = await resolveOrCreateSku(admin, entityId, { style_id: finishedStyleId, style_code: styleCode, color, size, inseam: o?.inseam || null });
        if (rr?.error || !rr?.id) continue;
        plannedOutputs.push({ item_id: rr.id, color, size, qty: q });
      }
      if (plannedOutputs.length === 0) plannedOutputs = null;
    }

    // target_qty = matrix total when a plan is given, else the supplied number.
    let targetQty = plannedOutputs ? plannedOutputs.reduce((s, o) => s + o.qty, 0) : Number(body.target_qty);
    if (!Number.isFinite(targetQty) || targetQty <= 0) return res.status(400).json({ error: "target_qty must be > 0 (or enter a size matrix)" });

    // WIP = 1205 'Work in Process'. (Code 1305 is 'Deposit Warehouse' in the
    // regrouped COA — the original M4 seed collided with it; see migration
    // 20260952000000.)
    const wip = await accountByCode(admin, entityId, "1205");
    if (!wip) return res.status(400).json({ error: "WIP account (code 1205 Work in Process) not found or not postable. Apply migration 20260952000000." });

    const buildRow = (code) => ({
      code_unused: undefined, // placeholder removed below
      entity_id: entityId,
      build_number: code,
      finished_item_id: String(finishedItemId),
      finished_style_id: finishedStyleId,
      bom_id: bomId,
      target_qty: targetQty,
      status: "draft",
      wip_account_id: wip.id,
      location_id: body.location_id || null,
      customer_id: customerId,
      notes: body.notes != null ? String(body.notes).trim() || null : null,
    });
    // strip placeholder
    const build = (code) => { const r = buildRow(code); delete r.code_unused; return r; };

    const { data, error } = await insertWithAutoCode(admin, "mfg_build_orders", "build_number", CODE_PREFIX, build, { entityId });
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Could not allocate a unique build number; please retry" });
      return res.status(500).json({ error: error.message });
    }

    // Persist the planned per-size matrix (unit cost set at completion).
    if (plannedOutputs) {
      const rows = plannedOutputs.map((o) => ({ build_order_id: data.id, item_id: o.item_id, color: o.color, size: o.size, qty: o.qty, unit_cost_cents: 0 }));
      await admin.from("mfg_build_outputs").insert(rows);
    }

    // Phase B — auto-mint the customer's own style number for this style (saved
    // in the shared style_customer_numbers junction, visible from both Style
    // Master and Customer Master). Best-effort + idempotent: skip when the
    // finished item isn't style-backed, and keep any existing mapping (a
    // customer has at most one number per style — UNIQUE(style_id, customer_id)).
    let customerStyleNumber = null;
    if (customerId && finishedStyleId) {
      const num = body.customer_style_number != null ? String(body.customer_style_number).trim() : "";
      const { data: existing } = await admin.from("style_customer_numbers")
        .select("customer_style_number").eq("entity_id", entityId).eq("style_id", finishedStyleId).eq("customer_id", customerId).maybeSingle();
      if (existing) {
        customerStyleNumber = existing.customer_style_number;
      } else if (num) {
        const { data: created } = await admin.from("style_customer_numbers")
          .insert({ entity_id: entityId, style_id: finishedStyleId, customer_id: customerId, customer_style_number: num, notes: `Auto-created from build ${data.build_number}` })
          .select("customer_style_number").maybeSingle();
        customerStyleNumber = created?.customer_style_number || null;
      }
    }

    return res.status(201).json({ ...data, customer_style_number: customerStyleNumber });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
