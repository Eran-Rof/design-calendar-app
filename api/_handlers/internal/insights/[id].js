// api/internal/insights/:id
//
// PUT — update status: read | actioned | dismissed.
//   body: { status }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const ALLOWED = new Set(["read", "actioned", "dismissed"]);

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("insights");
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
  if (!id) return res.status(400).json({ error: "Missing insight id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const next = body?.status;
  if (!ALLOWED.has(next)) return res.status(400).json({ error: `status must be one of ${[...ALLOWED].join(", ")}` });

  const { error } = await admin.from("ai_insights")
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id, status: next });
}
