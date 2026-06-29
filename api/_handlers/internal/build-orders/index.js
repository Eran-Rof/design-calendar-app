// api/internal/build-orders
//
// GET  — list build orders. ?status=, ?finished_item_id=, ?limit. Each row
//        includes the finished-item label + bom version.
// POST — create a draft build order. Body:
//          { finished_item_id (or bom_id), target_qty (required),
//            bom_id?, location_id?, notes? }
//        If bom_id is given, finished_item_id is taken from the BOM. Resolves
//        the WIP account (1305). build_number auto-generated (BUILD-NNNNN).
//
// Lifecycle: draft → /release → /issue → (/service…) → /complete.

import { insertWithAutoCode } from "../../../_lib/autoCode.js";
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

    const out = builds.map((b) => ({
      ...b,
      finished_item: itemBy.get(b.finished_item_id)
        ? { sku_code: itemBy.get(b.finished_item_id).sku_code, description: itemBy.get(b.finished_item_id).description } : null,
    }));
    return res.status(200).json(out);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const targetQty = Number(body.target_qty);
    if (!Number.isFinite(targetQty) || targetQty <= 0) return res.status(400).json({ error: "target_qty must be > 0" });

    let finishedItemId = body.finished_item_id;
    let bomId = body.bom_id || null;
    if (bomId) {
      if (!UUID_RE.test(String(bomId))) return res.status(400).json({ error: "bom_id must be a uuid" });
      const { data: bom } = await admin.from("mfg_bom").select("id, finished_item_id, status").eq("id", bomId).maybeSingle();
      if (!bom) return res.status(404).json({ error: "BOM not found" });
      finishedItemId = bom.finished_item_id;
    }
    if (!finishedItemId || !UUID_RE.test(String(finishedItemId))) {
      return res.status(400).json({ error: "finished_item_id (or a bom_id) is required" });
    }
    if (body.location_id != null && body.location_id !== "" && !UUID_RE.test(String(body.location_id))) {
      return res.status(400).json({ error: "location_id must be a uuid" });
    }

    const wip = await accountByCode(admin, entityId, "1305");
    if (!wip) return res.status(400).json({ error: "WIP account (code 1305) not found or not postable. Apply the M4 GL migration first." });

    const buildRow = (code) => ({
      code_unused: undefined, // placeholder removed below
      entity_id: entityId,
      build_number: code,
      finished_item_id: String(finishedItemId),
      bom_id: bomId,
      target_qty: targetQty,
      status: "draft",
      wip_account_id: wip.id,
      location_id: body.location_id || null,
      notes: body.notes != null ? String(body.notes).trim() || null : null,
    });
    // strip placeholder
    const build = (code) => { const r = buildRow(code); delete r.code_unused; return r; };

    const { data, error } = await insertWithAutoCode(admin, "mfg_build_orders", "build_number", CODE_PREFIX, build, { entityId });
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Could not allocate a unique build number; please retry" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
