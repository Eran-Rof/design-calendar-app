// api/internal/entities/:id/vendors
//
// GET  — list vendors linked to this entity.
// POST — link an existing vendor: body { vendor_id }.
//        Idempotent: re-linking an already-active vendor is a no-op.
// PUT  — change the relationship_status. body { vendor_id,
//        relationship_status: 'active' | 'suspended' | 'terminated' }.
//        Flipping to 'suspended' fires the entity_vendor_suspended
//        notification to the vendor's admin users.
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { vendor_id, relationship_status } = body || {};
    if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
    if (!["active", "suspended", "terminated"].includes(relationship_status))
      return res.status(400).json({ error: "relationship_status must be active, suspended, or terminated" });

    const { data: existing } = await admin.from("entity_vendors")
      .select("id, relationship_status")
      .eq("entity_id", entityId).eq("vendor_id", vendor_id).maybeSingle();
    if (!existing) return res.status(404).json({ error: "entity_vendors row not found" });

    const prev = existing.relationship_status;
    const { error } = await admin.from("entity_vendors").update({
      relationship_status,
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    if (error) return res.status(500).json({ error: error.message });

    // Fire suspension notification when flipping to 'suspended'
    if (relationship_status === "suspended" && prev !== "suspended") {
      try {
        const { data: ent } = await admin.from("entities").select("name").eq("id", entityId).maybeSingle();
        const origin = `https://${req.headers.host}`;
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "entity_vendor_suspended",
            title: `Your access to ${ent?.name || "this organisation"} has been suspended`,
            body: `Your vendor relationship with ${ent?.name || "the organisation"} is currently suspended. Please reach out to your account contact if you believe this is in error.`,
            link: "/vendor",
            metadata: { entity_id: entityId, vendor_id },
            recipient: { vendor_id },
            dedupe_key: `entity_vendor_suspended_${entityId}_${vendor_id}_${new Date().toISOString().slice(0, 10)}`,
            email: true,
          }),
        }).catch(() => {});
      } catch { /* non-blocking */ }
    }

    return res.status(200).json({ ok: true, relationship_status });
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
