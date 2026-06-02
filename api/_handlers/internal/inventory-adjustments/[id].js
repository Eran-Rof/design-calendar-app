// api/internal/inventory-adjustments/:id
//
// GET    — fetch one adjustment.
// PATCH  — update mutable fields (reason / qty_delta / unit_cost_cents) only
//          while UNPOSTED (posted_je_id IS NULL). adjustment_type + item_id +
//          gl_account_id are locked post-creation; delete + recreate if those
//          need to change. Posted rows return 409.
// DELETE — only while UNPOSTED. Posted rows return 409 — reverse the JE
//          instead via journal-entries reverse, then file a corrective
//          adjustment.
//
// Tangerine P3 Chunk 5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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

// Validate a PATCH body against an existing row. Returns { error } or { data }.
// adjustment_type / item_id / gl_account_id / entity_id are LOCKED post-creation.
// qty_delta and unit_cost_cents move together — flipping a positive to negative
// would need NULL'ing the cost; flipping negative to positive requires supplying
// cost. So we accept those two only as a coordinated change validated against
// the would-be-new state.
export function validatePatch(body, existing) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!existing || typeof existing !== "object") return { error: "existing row required" };

  if ("adjustment_type" in body) return { error: "adjustment_type is locked post-creation" };
  if ("item_id" in body) return { error: "item_id is locked post-creation" };
  if ("gl_account_id" in body) return { error: "gl_account_id is locked post-creation" };
  if ("entity_id" in body) return { error: "entity_id is locked" };
  if ("posted_je_id" in body) return { error: "posted_je_id is set by /post, not PATCH" };
  if ("posted_at" in body) return { error: "posted_at is set by /post, not PATCH" };

  const data = {};

  if ("reason" in body) {
    if (!body.reason || !String(body.reason).trim()) {
      return { error: "reason must be non-empty" };
    }
    data.reason = String(body.reason).trim();
  }

  // qty_delta + unit_cost_cents coordinated check. We need to compute the
  // would-be-new (qty, cost) pair and ensure it still satisfies the CHECK
  // constraint (positive needs cost, negative needs null).
  const willQtyChange = "qty_delta" in body;
  const willCostChange = "unit_cost_cents" in body;

  if (willQtyChange || willCostChange) {
    let newQty = willQtyChange ? Number(body.qty_delta) : Number(existing.qty_delta);
    if (!Number.isFinite(newQty) || newQty === 0) {
      return { error: "qty_delta must be a non-zero number" };
    }

    let newCost;
    if (willCostChange) {
      if (body.unit_cost_cents == null || body.unit_cost_cents === "") {
        newCost = null;
      } else {
        const n = Number(body.unit_cost_cents);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          return { error: "unit_cost_cents must be a non-negative integer (cents) or null" };
        }
        newCost = n;
      }
    } else {
      newCost = existing.unit_cost_cents;
    }

    if (newQty > 0) {
      if (newCost == null) {
        return { error: "unit_cost_cents required when qty_delta > 0" };
      }
    } else {
      // negative
      if (newCost != null) {
        return { error: "unit_cost_cents must be null when qty_delta < 0" };
      }
    }

    if (willQtyChange) data.qty_delta = newQty;
    if (willCostChange) data.unit_cost_cents = newCost;
  }

  return { data };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("inventory_adjustments")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Inventory adjustment not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    // Fetch existing first so we can (a) gate on posted_je_id and (b) validate
    // qty+cost coordination against current values.
    const { data: existing, error: fetchErr } = await admin
      .from("inventory_adjustments").select("*").eq("id", id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!existing) return res.status(404).json({ error: "Inventory adjustment not found" });
    if (existing.posted_je_id != null) {
      return res.status(409).json({
        error: "Cannot modify a posted adjustment. Reverse the JE and file a corrective adjustment instead.",
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {}, existing);
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }

    const { data, error } = await admin
      .from("inventory_adjustments")
      .update(v.data)
      .eq("id", id)
      .is("posted_je_id", null) // belt-and-suspenders race guard
      .select()
      .single();
    if (error) {
      if (error.code === "23514") {
        return res.status(400).json({ error: `Constraint failed: ${error.message}`, code: error.code });
      }
      if (error.code === "PGRST116") return res.status(404).json({ error: "Inventory adjustment not found or already posted" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Posted rows: 409. We do a select-first to give a useful error
    // (vs. silent 0-row delete).
    const { data: existing, error: fetchErr } = await admin
      .from("inventory_adjustments").select("id, posted_je_id").eq("id", id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!existing) return res.status(404).json({ error: "Inventory adjustment not found" });
    if (existing.posted_je_id != null) {
      return res.status(409).json({
        error: "Cannot delete a posted adjustment. Reverse the JE first (journal-entries reverse).",
      });
    }

    const { error } = await admin
      .from("inventory_adjustments").delete().eq("id", id).is("posted_je_id", null);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
