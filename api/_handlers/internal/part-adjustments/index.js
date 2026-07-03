// api/internal/part-adjustments
//
// GET  — list part_adjustments (most recent first). ?part_id, ?posted=true|false,
//        ?limit.
// POST — create AND post a part adjustment in one step. Body:
//          { part_id (required), adjustment_type, qty_delta (signed, !=0),
//            unit_cost_cents (required when qty_delta>0; omit when <0),
//            reason (required), gl_account_id (counter account, required),
//            location_id?, actor_user_id? }
//        Resolves the 1360 Inventory-Parts account, inserts the row, invokes
//        postEvent('part_adjustment'), stamps posted_je_id. Positive creates a
//        part FIFO layer; negative FIFO-consumes.
//
// Parts are kept separate from style inventory; this never touches
// inventory_adjustments / ip_item_master.

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../_lib/accounting/posting/index.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(["opening_balance", "found", "correction", "damage", "shrinkage", "write_off"]);

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

// The parts inventory asset account is code '1360' (M2 seed).
async function resolvePartsInventoryAccount(admin, entityId) {
  const { data } = await admin
    .from("gl_accounts")
    .select("id, code, name, is_postable, status")
    .eq("entity_id", entityId)
    .eq("code", "1360")
    .maybeSingle();
  return data && data.is_postable && data.status === "active" ? data : null;
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
    const partId = url.searchParams.get("part_id");
    const posted = url.searchParams.get("posted");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1000);

    let query = admin
      .from("part_adjustments")
      .select("*")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (partId && UUID_RE.test(partId)) query = query.eq("part_id", partId);
    if (posted === "true") query = query.not("posted_je_id", "is", null);
    if (posted === "false") query = query.is("posted_je_id", null);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validate(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const partsAccount = await resolvePartsInventoryAccount(admin, entityId);
    if (!partsAccount) {
      return res.status(400).json({ error: "Inventory-Parts account (code 1360) not found or not postable. Apply the M2 GL migration first." });
    }

    const actorUserId = v.data.actor_user_id;
    const row = {
      entity_id: entityId,
      part_id: v.data.part_id,
      location_id: v.data.location_id,
      adjustment_type: v.data.adjustment_type,
      qty_delta: v.data.qty_delta,
      unit_cost_cents: v.data.unit_cost_cents,
      reason: v.data.reason,
      gl_account_id: v.data.gl_account_id,
      created_by_user_id: actorUserId,
    };
    const { data: adj, error: insErr } = await admin
      .from("part_adjustments").insert(row).select().single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    let postResult;
    try {
      postResult = await postEvent(admin, {
        kind: "part_adjustment",
        entity_id: entityId,
        created_by_user_id: actorUserId,
        reason: adj.reason || `Part adjustment ${adj.adjustment_type} ${adj.id}`,
        data: {
          adjustment_id: adj.id,
          part_id: adj.part_id,
          adjustment_type: adj.adjustment_type,
          qty_delta: adj.qty_delta,
          unit_cost_cents: adj.unit_cost_cents,
          inventory_parts_account_id: partsAccount.id,
          gl_account_id: adj.gl_account_id,
          location_id: adj.location_id,
          posting_date: new Date().toISOString().slice(0, 10),
          reason: adj.reason,
        },
      });
    } catch (err) {
      // Roll back the orphan row so a failed post doesn't leave an unposted shell.
      await admin.from("part_adjustments").delete().eq("id", adj.id);
      return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
    }

    const jeId = postResult.accrual_je_id || postResult.cash_je_id || null;
    const { data: posted, error: upErr } = await admin
      .from("part_adjustments")
      .update({ posted_je_id: jeId, posted_at: new Date().toISOString() })
      .eq("id", adj.id)
      .select()
      .single();
    if (upErr) {
      return res.status(500).json({ error: `JE posted (id=${jeId}) but failed to stamp part adjustment: ${upErr.message}`, accrual_je_id: postResult.accrual_je_id });
    }

    return res.status(201).json({
      ...posted,
      accrual_je_id: postResult.accrual_je_id,
      cash_je_id: postResult.cash_je_id,
      part_consume_results: postResult.part_consume_results || null,
      part_inventory_layer_ids: postResult.part_inventory_layer_ids || null,
      part_inventory_layer_errors: postResult.part_inventory_layer_errors || null,
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function validate(body) {
  if (body == null || typeof body !== "object") return { error: "Request body must be an object" };
  if (!body.part_id || !UUID_RE.test(String(body.part_id))) return { error: "part_id (uuid) is required" };
  const type = String(body.adjustment_type || "").trim();
  if (!TYPES.has(type)) return { error: `adjustment_type must be one of: ${[...TYPES].join(", ")}` };
  if (!body.reason || !String(body.reason).trim()) return { error: "reason is required" };
  if (!body.gl_account_id || !UUID_RE.test(String(body.gl_account_id))) return { error: "gl_account_id (counter account uuid) is required" };

  const qty = typeof body.qty_delta === "number" ? body.qty_delta : parseFloat(body.qty_delta);
  if (!Number.isFinite(qty) || qty === 0) return { error: "qty_delta must be a non-zero number" };

  let unitCost = null;
  if (qty > 0) {
    if (body.unit_cost_cents == null || body.unit_cost_cents === "") {
      return { error: "unit_cost_cents is required for a positive qty_delta" };
    }
    unitCost = typeof body.unit_cost_cents === "number" ? body.unit_cost_cents : parseInt(body.unit_cost_cents, 10);
    if (!Number.isInteger(unitCost) || unitCost < 0) return { error: "unit_cost_cents must be a non-negative integer (cents)" };
  } else if (body.unit_cost_cents != null && body.unit_cost_cents !== "") {
    return { error: "unit_cost_cents must be omitted for a negative qty_delta (FIFO derives the cost)" };
  }

  let locationId = null;
  if (body.location_id != null && body.location_id !== "") {
    if (!UUID_RE.test(String(body.location_id))) return { error: "location_id must be a uuid" };
    locationId = String(body.location_id);
  }
  const actorUserId = body.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;

  return {
    data: {
      part_id: String(body.part_id),
      adjustment_type: type,
      qty_delta: qty,
      unit_cost_cents: unitCost,
      reason: String(body.reason).trim(),
      gl_account_id: String(body.gl_account_id),
      location_id: locationId,
      actor_user_id: actorUserId,
    },
  };
}
