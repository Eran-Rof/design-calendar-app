// api/internal/disputes/:id
//
// GET — full dispute + messages; marks internal as having viewed.
// PUT — update status / priority / resolution. If status='resolved',
//       sets resolved_at + resolved_by and fires dispute_resolved
//       notification to the vendor.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("disputes");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Internal-API gate. See api/_lib/auth.js. Open until INTERNAL_API_TOKEN
  // is set (logs a warn on first call); 401 once configured.
  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing dispute id" });

  if (req.method === "GET") {
    const [dRes, mRes] = await Promise.all([
      admin.from("disputes").select("*, vendor:vendors(id, name)").eq("id", id).maybeSingle(),
      admin.from("dispute_messages").select("*").eq("dispute_id", id).order("created_at", { ascending: true }),
    ]);
    if (dRes.error) return res.status(500).json({ error: dRes.error.message });
    if (mRes.error) return res.status(500).json({ error: mRes.error.message });
    if (!dRes.data) return res.status(404).json({ error: "Dispute not found" });
    await admin.from("disputes").update({ last_viewed_by_internal_at: new Date().toISOString() }).eq("id", id);
    return res.status(200).json({ dispute: dRes.data, messages: mRes.data || [] });
  }

  if (req.method === "PUT" || req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { status, priority, resolution, resolved_by, reviewer_name } = body || {};

    const updates = {};
    if (status) {
      if (!["open", "under_review", "resolved", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status" });
      updates.status = status;
    }
    if (priority) {
      if (!["low", "medium", "high"].includes(priority)) return res.status(400).json({ error: "Invalid priority" });
      updates.priority = priority;
    }
    if (resolution !== undefined) updates.resolution = resolution;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields in body" });
    updates.updated_at = new Date().toISOString();

    const { data: existing } = await admin.from("disputes").select("*").eq("id", id).maybeSingle();
    if (!existing) return res.status(404).json({ error: "Dispute not found" });

    if (updates.status === "resolved" && existing.status !== "resolved") {
      updates.resolved_at = new Date().toISOString();
      updates.resolved_by = resolved_by || reviewer_name || "Internal";
    }

    const { error: upErr } = await admin.from("disputes").update(updates).eq("id", id);
    if (upErr) return res.status(500).json({ error: upErr.message });

    // Notify vendor on status->resolved
    if (updates.status === "resolved" && existing.status !== "resolved") {
      try {
        const origin = `https://${req.headers.host}`;
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "dispute_resolved",
            title: `Dispute resolved: ${existing.subject}`,
            body: resolution ? `Resolution: ${String(resolution).trim()}` : "Your dispute has been marked resolved.",
            link: "/vendor/disputes",
            metadata: { dispute_id: id, vendor_id: existing.vendor_id },
            recipient: { vendor_id: existing.vendor_id },
            dedupe_key: `dispute_resolved_${id}`,
            email: true,
          }),
        }).catch(() => {});
      } catch { /* non-blocking */ }
    }

    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
