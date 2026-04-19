// api/internal/entities/:id/vendors
//
// GET  — list vendors linked to this entity.
// POST — link an existing vendor: body { vendor_id }.
//        Idempotent: re-linking an already-active vendor is a no-op.
// DELETE ?vendor_id=<uuid> — soft-suspend the junction row (status →
//        'terminated'); hard delete can be added later if needed.

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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
    const { data, error } = await admin
      .from("entity_vendors")
      .select("*, vendor:vendors(id, name, status)")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { vendor_id } = body || {};
    if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
    const { data: v } = await admin.from("vendors").select("id").eq("id", vendor_id).maybeSingle();
    if (!v) return res.status(404).json({ error: "Vendor not found" });

    const { data, error } = await admin.from("entity_vendors").upsert({
      entity_id: entityId,
      vendor_id,
      relationship_status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "entity_id,vendor_id" }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const vendorId = url.searchParams.get("vendor_id");
    if (!vendorId) return res.status(400).json({ error: "vendor_id is required" });
    const { error } = await admin.from("entity_vendors")
      .update({ relationship_status: "terminated", updated_at: new Date().toISOString() })
      .eq("entity_id", entityId)
      .eq("vendor_id", vendorId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
