// api/internal/entities/:id/branding
//
// PUT — upsert the entity_branding row for this entity. All fields are
// optional; omitted fields are left unchanged (and stay at their
// previous value, not cleared to NULL).
//
// body: {
//   logo_url, primary_color, secondary_color, favicon_url,
//   company_display_name, portal_welcome_message,
//   email_from_name, email_from_address, custom_domain
// }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getEntityId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("entities");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const entityId = getEntityId(req);
  if (!entityId) return res.status(400).json({ error: "Missing entity id" });

  const { data: entity } = await admin.from("entities").select("id").eq("id", entityId).maybeSingle();
  if (!entity) return res.status(404).json({ error: "Entity not found" });

  if (req.method === "GET") {
    const { data } = await admin.from("entity_branding").select("*").eq("entity_id", entityId).maybeSingle();
    return res.status(200).json(data || { entity_id: entityId });
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const FIELDS = ["logo_url", "primary_color", "secondary_color", "favicon_url", "company_display_name", "portal_welcome_message", "email_from_name", "email_from_address", "custom_domain"];

    const payload = { entity_id: entityId, updated_at: new Date().toISOString() };
    for (const f of FIELDS) {
      if (body && Object.prototype.hasOwnProperty.call(body, f)) {
        payload[f] = body[f] || null;
      }
    }

    // Light color validation
    for (const c of ["primary_color", "secondary_color"]) {
      if (payload[c] && !/^#[0-9a-fA-F]{3,8}$/.test(payload[c])) {
        return res.status(400).json({ error: `${c} must be a hex color (e.g. #1A56DB)` });
      }
    }

    const { data, error } = await admin.from("entity_branding").upsert(payload, { onConflict: "entity_id" }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
