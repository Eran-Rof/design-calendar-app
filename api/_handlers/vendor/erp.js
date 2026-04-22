// api/vendor/erp
//
// GET    — list the caller's ERP integrations (config is redacted —
//          only the type, status, partner_id, and last-sync metadata
//          are returned). Vendor sees at most one active integration
//          today, but the API returns a list for future-proofing.
// POST   — create OR update an integration.
//          body: { type, partner_id, webhook_url?, api_token?, active? }
//          api_token and webhook_url are AES-256-GCM encrypted before
//          being merged into config jsonb. Existing secrets are
//          preserved if the field is omitted on update.
// DELETE — ?id=uuid pauses the integration (sets status='paused') and
//          clears the encrypted config fields.

import { createClient } from "@supabase/supabase-js";
import { encryptFieldValue } from "../../_lib/crypto.js";

export const config = { maxDuration: 15 };

const ALLOWED_TYPES = ["sap", "oracle", "netsuite", "quickbooks", "sage", "custom"];

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, role").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

function redact(row) {
  if (!row) return row;
  const { config: cfg = {}, ...rest } = row;
  return {
    ...rest,
    config: {
      partner_id: cfg.partner_id || null,
      has_api_token: !!cfg.api_token_encrypted,
      has_webhook_url: !!cfg.webhook_url_encrypted,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("erp_integrations")
      .select("*")
      .eq("vendor_id", caller.vendor_id)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json((data || []).map(redact));
  }

  if (req.method === "POST") {
    if (caller.role !== "primary" && caller.role !== "admin") return res.status(403).json({ error: "Admin role required" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { id, type, partner_id, webhook_url, api_token, active } = body || {};
    if (!type || !ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(", ")}` });
    if (!partner_id || !String(partner_id).trim()) return res.status(400).json({ error: "partner_id is required" });

    let existing = null;
    if (id) {
      const { data } = await admin.from("erp_integrations").select("*").eq("id", id).eq("vendor_id", caller.vendor_id).maybeSingle();
      if (!data) return res.status(404).json({ error: "Integration not found" });
      existing = data;
    }

    const cfg = existing?.config ? { ...existing.config } : {};
    cfg.partner_id = String(partner_id).trim();
    if (webhook_url != null && String(webhook_url).trim()) {
      try { cfg.webhook_url_encrypted = encryptFieldValue(String(webhook_url).trim()); }
      catch (e) { return res.status(500).json({ error: `Encryption failed: ${e instanceof Error ? e.message : String(e)}` }); }
    }
    if (api_token != null && String(api_token).trim()) {
      try { cfg.api_token_encrypted = encryptFieldValue(String(api_token).trim()); }
      catch (e) { return res.status(500).json({ error: `Encryption failed: ${e instanceof Error ? e.message : String(e)}` }); }
    }

    const status = active === false ? "paused" : "active";
    const payload = {
      vendor_id: caller.vendor_id,
      type,
      status,
      config: cfg,
      updated_at: new Date().toISOString(),
    };

    let result;
    if (existing) {
      result = await admin.from("erp_integrations").update(payload).eq("id", existing.id).select("*").single();
    } else {
      result = await admin.from("erp_integrations").insert(payload).select("*").single();
    }
    if (result.error) return res.status(500).json({ error: result.error.message });
    return res.status(201).json(redact(result.data));
  }

  if (req.method === "DELETE") {
    if (caller.role !== "primary" && caller.role !== "admin") return res.status(403).json({ error: "Admin role required" });
    const url = new URL(req.url, `https://${req.headers.host}`);
    const id = url.searchParams.get("id");
    if (!id) return res.status(400).json({ error: "id is required" });
    const { data: row } = await admin.from("erp_integrations").select("id, vendor_id").eq("id", id).maybeSingle();
    if (!row || row.vendor_id !== caller.vendor_id) return res.status(404).json({ error: "Not found" });
    const { error } = await admin.from("erp_integrations").update({
      status: "paused",
      config: { partner_id: null },
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
