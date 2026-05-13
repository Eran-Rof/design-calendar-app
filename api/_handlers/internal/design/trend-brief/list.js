// api/internal/design/trend-brief/list
//
// GET — list trend briefs, newest first.
//   Query: ?status=draft|published|archived (optional, default all-non-archived)
//          ?limit=<n>  (default 24, max 100)
//   Response: { briefs: [...] }
//
// Each brief includes the full summary_md + themes_jsonb so the UI can
// render it without a second roundtrip. raw_sources is omitted from
// the list response to keep payloads small — fetch by id if needed.
//
// Auth: bearer token via authenticateDesignCalendarCaller.

import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL      = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const status = (req.query?.status || "").toString().trim();
  const limit  = Math.min(Number(req.query?.limit) || 24, 100);

  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let q = db
    .from("ip_trend_briefs")
    .select("id, brief_month, status, title, summary_md, themes_jsonb, model, token_usage, created_at, updated_at")
    .order("brief_month", { ascending: false })
    .limit(limit);

  if (status) {
    q = q.eq("status", status);
  } else {
    q = q.neq("status", "archived");
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ briefs: data || [] });
}
