// api/internal/approval-requests
//
// GET — list requests with their steps inlined. Query:
//       ?status=pending|approved|rejected|cancelled|expired (default: pending)
//       ?kind=<str>
//       ?context_table=<str>
//       ?context_id=<uuid>
//       ?limit=N (default 100, max 500)
//
// Note: POST is not exposed here. Approval requests are created by downstream
// handlers via approvalsAPI.requestIfRequired(), not by direct admin POST.
//
// Tangerine P2 Chunk 2.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_VALUES = ["pending", "approved", "rejected", "cancelled", "expired"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const status = (url.searchParams.get("status") || "pending").trim();
  if (!STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUS_VALUES.join(", ")}` });
  }
  const kind = (url.searchParams.get("kind") || "").trim();
  const contextTable = (url.searchParams.get("context_table") || "").trim();
  const contextId = (url.searchParams.get("context_id") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;

  let query = admin
    .from("approval_requests")
    .select("*, steps:approval_request_steps(*)")
    .eq("entity_id", entityId)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (kind) query = query.eq("kind", kind);
  if (contextTable) query = query.eq("context_table", contextTable);
  if (contextId) query = query.eq("context_id", contextId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
