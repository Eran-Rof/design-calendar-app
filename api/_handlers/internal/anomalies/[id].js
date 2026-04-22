// api/internal/anomalies/:id
//
// PUT — update anomaly flag status.
//   body: { status: 'reviewed' | 'dismissed' | 'escalated',
//           reviewed_by?, note? }
// Stores reviewed_by + reviewed_at. Note is appended to description
// (in a "— reviewed: ..." suffix) for quick context.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("anomalies");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing anomaly id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { status, reviewed_by, note } = body || {};
  if (!["reviewed", "dismissed", "escalated"].includes(status))
    return res.status(400).json({ error: "status must be reviewed, dismissed, or escalated" });

  const { data: existing } = await admin.from("anomaly_flags").select("id, description").eq("id", id).maybeSingle();
  if (!existing) return res.status(404).json({ error: "Anomaly not found" });

  const nowIso = new Date().toISOString();
  const updates = {
    status,
    reviewed_at: nowIso,
    reviewed_by: reviewed_by || "Internal",
    updated_at: nowIso,
  };
  if (note && String(note).trim()) {
    updates.description = `${existing.description}\n\n— ${status} by ${reviewed_by || "Internal"}: ${String(note).trim()}`;
  }

  const { error } = await admin.from("anomaly_flags").update(updates).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id, status });
}
