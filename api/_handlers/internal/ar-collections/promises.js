// api/internal/ar-collections/promises
//
// GET — the promise-to-pay pipeline from v_ar_collections_promises.
//   ?state=upcoming|due_today|broken  (filter)
//   ?latest=1 (default) — only the most recent promise per (customer, invoice)
//   ?exclude_factored=1
// Read-only.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const STATES = ["upcoming", "due_today", "broken"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
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
  const state = (url.searchParams.get("state") || "").trim() || null;
  const latest = url.searchParams.get("latest") !== "0";
  if (state && !STATES.includes(state)) return res.status(400).json({ error: "invalid state" });

  try {
    let q = admin.from("v_ar_collections_promises").select("*").eq("entity_id", entityId);
    if (latest) q = q.eq("is_latest", true);
    if (state) q = q.eq("promise_state", state);
    q = q.order("promise_date", { ascending: true }).limit(2000);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
