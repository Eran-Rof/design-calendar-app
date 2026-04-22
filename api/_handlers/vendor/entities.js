// api/vendor/entities
//
// GET — entities the caller's vendor is linked to (active junction
// rows). Returns each entity with its branding so the portal can
// render the correct logo + colors after context switch.
//
// Response:
//   [ { id, name, slug, status, relationship_status,
//       branding: { logo_url, primary_color, secondary_color,
//                   favicon_url, company_display_name,
//                   portal_welcome_message, custom_domain } | null } ]

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { vendor_id: vu.vendor_id } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const { data, error } = await admin
    .from("entity_vendors")
    .select("relationship_status, entity:entities(id, name, slug, status, branding:entity_branding(logo_url, primary_color, secondary_color, favicon_url, company_display_name, portal_welcome_message, custom_domain))")
    .eq("vendor_id", caller.vendor_id)
    .eq("relationship_status", "active")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const rows = (data || []).map((r) => {
    const ent = r.entity;
    const branding = Array.isArray(ent?.branding) ? ent.branding[0] || null : ent?.branding || null;
    return ent ? {
      id: ent.id, name: ent.name, slug: ent.slug, status: ent.status,
      relationship_status: r.relationship_status,
      branding,
    } : null;
  }).filter(Boolean);

  return res.status(200).json(rows);
}
