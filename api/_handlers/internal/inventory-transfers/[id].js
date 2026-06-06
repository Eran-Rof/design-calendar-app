// api/internal/inventory-transfers/:id
//
// GET    — fetch one transfer.
// PATCH  — update mutable fields (qty, notes, transfer_date) only
//          while UNPOSTED (posted_je_id IS NULL). item_id / from_location /
//          to_location / entity_id are locked post-creation; delete + recreate
//          if those need to change. Posted rows return 409.
// DELETE — only while UNPOSTED. Posted rows return 409.
//
// Tangerine P3 Chunk 7 (#1024).

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

// Validate a PATCH body. Returns { error } or { data }.
// item_id / from_location / to_location / entity_id are LOCKED post-creation.
// Allowed mutable fields: qty (positive integer), notes (string|null), transfer_date (YYYY-MM-DD).
export function validatePatch(body) {
  if (!body || typeof body !== "object") return { error: "body required" };

  if ("item_id" in body) return { error: "item_id is locked post-creation" };
  if ("from_location" in body) return { error: "from_location is locked post-creation" };
  if ("to_location" in body) return { error: "to_location is locked post-creation" };
  if ("entity_id" in body) return { error: "entity_id is locked" };
  if ("posted_je_id" in body) return { error: "posted_je_id is set by the posting flow, not PATCH" };

  const data = {};

  if ("qty" in body) {
    const qty = Number(body.qty);
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
      return { error: "qty must be a positive integer" };
    }
    data.qty = qty;
  }

  if ("notes" in body) {
    if (body.notes == null || body.notes === "") {
      data.notes = null;
    } else if (typeof body.notes === "string") {
      data.notes = body.notes.trim() || null;
    } else {
      return { error: "notes must be a string or null" };
    }
  }

  if ("transfer_date" in body) {
    if (body.transfer_date == null || body.transfer_date === "") {
      data.transfer_date = null;
    } else {
      const d = String(body.transfer_date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: "transfer_date must be YYYY-MM-DD" };
      data.transfer_date = d;
    }
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
      .from("inventory_transfers")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Inventory transfer not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    // Fetch existing first to gate on posted_je_id.
    const { data: existing, error: fetchErr } = await admin
      .from("inventory_transfers").select("*").eq("id", id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!existing) return res.status(404).json({ error: "Inventory transfer not found" });
    if (existing.posted_je_id != null) {
      return res.status(409).json({
        error: "Cannot modify a posted transfer. Reverse the JE first.",
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }

    const { data, error } = await admin
      .from("inventory_transfers")
      .update(v.data)
      .eq("id", id)
      .is("posted_je_id", null) // race guard
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Inventory transfer not found or already posted" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Select first to give a useful 409 on posted rows.
    const { data: existing, error: fetchErr } = await admin
      .from("inventory_transfers").select("id, posted_je_id").eq("id", id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!existing) return res.status(404).json({ error: "Inventory transfer not found" });
    if (existing.posted_je_id != null) {
      return res.status(409).json({
        error: "Cannot delete a posted transfer. Reverse the JE first.",
      });
    }

    const { error } = await admin
      .from("inventory_transfers").delete().eq("id", id).is("posted_je_id", null);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
