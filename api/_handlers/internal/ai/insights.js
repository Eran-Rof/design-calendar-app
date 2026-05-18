// api/internal/ai/insights
//
// Read + dismiss for ip_ai_proactive_insights (Tier 3K).
//
// GET    ?include_dismissed=1   list open (or all) insights, newest first
// PATCH  ?id=...&action=dismiss { user_id }                         mark dismissed
// PATCH  ?id=...&action=undismiss                                   clear dismissed
//
// Auth: bearer token via authenticateInternalCaller.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 10 };

function clean(s, max) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL      = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });
  const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const includeDismissed = String(req.query?.include_dismissed || "") === "1";
    let query = db
      .from("ip_ai_proactive_insights")
      .select("id, rule, severity, subject_type, subject_id, subject_label, headline, detail, metrics, detected_at, dismissed_at, dismissed_by")
      .order("detected_at", { ascending: false })
      .limit(100);
    if (!includeDismissed) {
      query = query.is("dismissed_at", null);
    }
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({
      insights: data || [],
      open_count: (data || []).filter(r => !r.dismissed_at).length,
    });
  }

  if (req.method === "PATCH") {
    const id = clean(req.query?.id, 64);
    const action = (req.query?.action || "").toString();
    if (!id) return res.status(400).json({ error: "id required" });

    if (action === "dismiss") {
      const userId = clean((req.body || {}).user_id, 80);
      if (!userId) return res.status(400).json({ error: "user_id required to dismiss" });
      const { data, error } = await db
        .from("ip_ai_proactive_insights")
        .update({ dismissed_at: new Date().toISOString(), dismissed_by: userId })
        .eq("id", id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ insight: data });
    }

    if (action === "undismiss") {
      const { data, error } = await db
        .from("ip_ai_proactive_insights")
        .update({ dismissed_at: null, dismissed_by: null })
        .eq("id", id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ insight: data });
    }

    return res.status(400).json({ error: "unknown action; use dismiss or undismiss" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
