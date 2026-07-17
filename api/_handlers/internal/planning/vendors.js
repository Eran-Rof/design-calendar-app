// api/internal/planning/vendors
//
// Planning vendor master (ip_vendor_master) CRUD for the /planning/vendors
// screen. This is the first UI that creates / edits ip_vendor_master rows —
// the table backs the buy-plan → Tangerine-PO chain (action.vendor_id →
// ip_vendor_master → portal_vendor_id → Tangerine `vendors`).
//
//   GET   → list planning vendors, joined with their linked Tangerine vendor
//           name/code (portal_vendor_id → vendors).
//   POST  { vendor_code, name } → create (server-side uniqueness on
//           vendor_code; 409 on duplicate).
//   PATCH { id, name?, vendor_code?, portal_vendor_id? } → update. Pass
//           portal_vendor_id: null to unlink. A non-null portal_vendor_id is
//           validated against `vendors` (linking is normally done via the
//           dedicated link-planning-vendor endpoint, but PATCH accepts it too
//           for completeness).
//
// Permission: manage_integrations (this is the vendor↔Tangerine linking
// surface). x-user-email header / verified app-JWT per api/_lib/ip-permissions.

import { createClient } from "@supabase/supabase-js";
import { checkPermission } from "../../../_lib/ip-permissions.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return null; } }
  return body || {};
}

const VENDOR_SELECT = "id, vendor_code, name, country, default_lead_time_days, moq_units, active, portal_vendor_id, created_at, updated_at";

// Attach the linked Tangerine vendor's name/code to each planning vendor row.
async function withTangerineNames(admin, rows) {
  const linkIds = [...new Set(rows.map((r) => r.portal_vendor_id).filter(Boolean))];
  const tvById = new Map();
  for (let i = 0; i < linkIds.length; i += 100) {
    const { data } = await admin.from("vendors").select("id, name, code").in("id", linkIds.slice(i, i + 100));
    for (const tv of data || []) tvById.set(tv.id, tv);
  }
  return rows.map((r) => {
    const tv = r.portal_vendor_id ? tvById.get(r.portal_vendor_id) : null;
    return { ...r, tangerine_vendor_name: tv ? tv.name : null, tangerine_vendor_code: tv ? tv.code : null };
  });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const perm = await checkPermission(req, "manage_integrations");
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // ── GET — list ────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await admin.from("ip_vendor_master")
      .select(VENDOR_SELECT).order("vendor_code", { ascending: true }).limit(5000);
    if (error) return res.status(500).json({ error: `List failed: ${error.message}` });
    const vendors = await withTangerineNames(admin, data || []);
    return res.status(200).json({ vendors });
  }

  // ── POST — create ─────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = parseBody(req);
    if (!body) return res.status(400).json({ error: "Invalid JSON" });
    const vendorCode = (body.vendor_code || "").trim();
    const name = (body.name || "").trim();
    if (!vendorCode) return res.status(400).json({ error: "vendor_code required" });
    if (!name) return res.status(400).json({ error: "name required" });

    // Server-side uniqueness (vendor_code is UNIQUE in DDL — this gives a clean
    // 409 instead of a raw constraint error, and covers case-insensitive dupes).
    const { data: dup } = await admin.from("ip_vendor_master")
      .select("id, vendor_code").ilike("vendor_code", vendorCode).limit(1);
    if (dup && dup.length) return res.status(409).json({ error: `Vendor code "${vendorCode}" already exists.` });

    const { data, error } = await admin.from("ip_vendor_master")
      .insert({ vendor_code: vendorCode, name }).select(VENDOR_SELECT).single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `Vendor code "${vendorCode}" already exists.` });
      return res.status(500).json({ error: `Create failed: ${error.message}` });
    }
    const [vendor] = await withTangerineNames(admin, [data]);
    return res.status(201).json({ vendor });
  }

  // ── PATCH — update (rename / recode / link / unlink) ──────────────────────
  if (req.method === "PATCH") {
    const body = parseBody(req);
    if (!body) return res.status(400).json({ error: "Invalid JSON" });
    const id = body.id;
    if (!id) return res.status(400).json({ error: "id required" });

    const { data: existing } = await admin.from("ip_vendor_master").select("id, vendor_code").eq("id", id).maybeSingle();
    if (!existing) return res.status(404).json({ error: "Planning vendor not found" });

    const patch = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) {
      const name = (body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name cannot be empty" });
      patch.name = name;
    }
    if (body.vendor_code !== undefined) {
      const vendorCode = (body.vendor_code || "").trim();
      if (!vendorCode) return res.status(400).json({ error: "vendor_code cannot be empty" });
      if (vendorCode.toLowerCase() !== (existing.vendor_code || "").toLowerCase()) {
        const { data: dup } = await admin.from("ip_vendor_master")
          .select("id").ilike("vendor_code", vendorCode).neq("id", id).limit(1);
        if (dup && dup.length) return res.status(409).json({ error: `Vendor code "${vendorCode}" already exists.` });
      }
      patch.vendor_code = vendorCode;
    }
    if (body.portal_vendor_id !== undefined) {
      if (body.portal_vendor_id === null) {
        patch.portal_vendor_id = null; // unlink
      } else {
        const { data: tv } = await admin.from("vendors").select("id").eq("id", body.portal_vendor_id).maybeSingle();
        if (!tv) return res.status(404).json({ error: "Tangerine vendor not found" });
        patch.portal_vendor_id = body.portal_vendor_id;
      }
    }

    const { data, error } = await admin.from("ip_vendor_master")
      .update(patch).eq("id", id).select(VENDOR_SELECT).single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Vendor code already exists." });
      return res.status(500).json({ error: `Update failed: ${error.message}` });
    }
    const [vendor] = await withTangerineNames(admin, [data]);
    return res.status(200).json({ vendor });
  }

  res.setHeader("Allow", "GET, POST, PATCH, OPTIONS");
  return res.status(405).json({ error: "Method not allowed" });
}
