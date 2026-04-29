// api/cron/insights-digest-daily
//
// Daily digest of new risk_alert + cost_saving insights, bundled into one
// email per entity (internal procurement team). Runs at 14:00 UTC.
// Dedupe: one digest per entity per UTC calendar day.

import { createClient } from "@supabase/supabase-js";
import { digestSubject, digestBody, filterDigestInsights } from "../../_lib/notifications-phase9.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const origin = req.headers.host ? `https://${req.headers.host}` : null;
  const today = new Date().toISOString().slice(0, 10);
  const result = { started_at: new Date().toISOString(), entities_digested: 0, total_insights: 0, errors: [] };

  const { data: entities } = await admin.from("entities").select("id, name").eq("status", "active");
  const toEmails = (process.env.INTERNAL_PROCUREMENT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
    .split(",").map((e) => e.trim()).filter(Boolean);

  for (const e of entities || []) {
    try {
      const { data: rows } = await admin.from("ai_insights")
        .select("id, type, title, recommendation, status, generated_at, expires_at")
        .eq("entity_id", e.id)
        .in("type", ["risk_alert", "cost_saving"])
        .eq("status", "new")
        .gt("expires_at", new Date().toISOString())
        .order("generated_at", { ascending: false });

      const digestable = filterDigestInsights(rows || []);
      if (digestable.length === 0) continue;

      const subject = digestSubject(digestable.length);
      const body = digestBody(digestable);

      for (const email of toEmails) {
        if (!origin) break;
        await fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "ai_insight_new",
            title: subject,
            body,
            link: "/",
            metadata: { entity_id: e.id, insight_ids: digestable.map((d) => d.id) },
            recipient: { internal_id: "procurement-digest", email },
            dedupe_key: `ai_insight_digest_${e.id}_${email}_${today}`,
            email: true,
          }),
        }).catch((e) => console.error("[cron] notify fanout failed", e?.message ?? e));
      }
      result.entities_digested += 1;
      result.total_insights += digestable.length;
    } catch (err) {
      result.errors.push({ entity_id: e.id, error: err?.message || String(err) });
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
