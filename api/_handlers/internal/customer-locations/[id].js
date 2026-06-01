// api/internal/customer-locations/[id]
//
// PATCH  — update mutable fields: name, code, address, contact_name, phone,
//           email, is_default, active.
//           If is_default is set to true, any existing default for the same
//           customer is cleared first.
//
// DELETE — soft-delete: sets active=false.  Hard-delete is intentionally not
//           provided — AR invoices may reference this location via
//           ship_to_location_id, and a hard-delete would break the FK.
//
// Ship-to locations — Tangerine customer multi-DC / multi-store (PR #shipto).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
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

  // Fetch the existing row so we know its customer_id (needed for default logic).
  const { data: existing, error: fetchErr } = await admin
    .from("customer_locations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!existing) return res.status(404).json({ error: "Location not found" });

  // ── PATCH ────────────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const patch = {};

    if ("name" in body) {
      const n = String(body.name || "").trim();
      if (!n) return res.status(400).json({ error: "name must be non-empty" });
      patch.name = n;
    }
    if ("code" in body) {
      patch.code = body.code ? String(body.code).trim() || null : null;
    }
    if ("address" in body) {
      if (body.address !== null && typeof body.address !== "object") {
        return res.status(400).json({ error: "address must be an object or null" });
      }
      patch.address = body.address || {};
    }
    if ("contact_name" in body) {
      patch.contact_name = body.contact_name ? String(body.contact_name).trim() || null : null;
    }
    if ("phone" in body) {
      patch.phone = body.phone ? String(body.phone).trim() || null : null;
    }
    if ("email" in body) {
      patch.email = body.email ? String(body.email).trim() || null : null;
    }
    if ("active" in body) {
      patch.active = body.active === true || body.active === "true";
    }
    if ("is_default" in body) {
      patch.is_default = body.is_default === true || body.is_default === "true";
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No mutable fields provided" });
    }

    // If promoting this location to default, clear any existing default first.
    if (patch.is_default === true && !existing.is_default) {
      const { error: clearErr } = await admin
        .from("customer_locations")
        .update({ is_default: false })
        .eq("customer_id", existing.customer_id)
        .eq("is_default", true)
        .neq("id", id);
      if (clearErr) {
        return res.status(500).json({ error: `Failed to clear previous default: ${clearErr.message}` });
      }
    }

    patch.updated_at = new Date().toISOString();

    const { data, error } = await admin
      .from("customer_locations")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // ── DELETE (soft) ─────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const { error } = await admin
      .from("customer_locations")
      .update({ active: false, is_default: false, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
