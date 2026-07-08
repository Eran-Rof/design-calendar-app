// api/_handlers/cron/xoro-feed-health-alert.js
//
// Daily (13:00 UTC = ~09:00 ET): read v_xoro_feed_health and ALERT — bell +
// email via the notifications system — when any Xoro-bridge feed is stale or
// has never synced. The bridge's historical failure mode is silence (2026-07-07
// audit: tanda_sos stale 19 days, accounting mirror skipped 37/40 nights with
// only an unnoticed in-app bell); this cron is the "screams when anything
// stops" layer. ip-integration-health keeps status columns fresh but by design
// does not alert — this one does.
//
// One notification per run listing every non-ok feed (severity 'error'),
// roles admin + accounting, default channels in_app + email (the email drain
// worker delivers). No notification at all when everything is ok.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const { data: rows, error } = await admin.from("v_xoro_feed_health").select("*");
  if (error) return res.status(500).json({ error: `feed health read failed: ${error.message}` });

  const bad = (rows || []).filter((r) => r.status !== "ok");
  const out = { feeds: (rows || []).length, not_ok: bad.length, alerted: false };
  if (bad.length === 0) return res.status(200).json(out);

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ ...out, error: "Default entity (ROF) not found" });

  const lines = bad.map((r) =>
    `• ${r.feed} — ${r.status.toUpperCase()}` +
    (r.last_at ? ` (last sync ${r.last_at}, ${r.hours_since}h ago, threshold ${r.threshold_hours}h)` : " (no successful sync on record)") +
    `\n    ${r.label}`);
  const body =
    `${bad.length} of ${rows.length} Xoro-bridge feeds are not flowing:\n\n` +
    lines.join("\n") +
    `\n\nXoro is the operational source of record until Tangerine go-live — a stale feed means the app is showing old numbers. ` +
    `Check the Sync Health panel (Tangerine → Integrations → Sync Health), the office PC's 21:00 fetch (.launchd-logs), and Vercel cron logs.`;

  try {
    const ev = await enqueueNotification(admin, {
      entity_id: entity.id,
      kind: "xoro_feed_stale",
      severity: "error",
      subject: `Xoro bridge: ${bad.length} feed(s) stale — ${bad.map((b) => b.feed).join(", ")}`,
      body,
      context_table: "v_xoro_feed_health",
      context_id: null,
      payload: { not_ok: bad },
      recipient_roles: ["admin", "accounting"],
    });
    out.alerted = true;
    out.notification_event_id = ev?.event_id || null;
  } catch (e) {
    out.error = `notification enqueue failed: ${String(e?.message || e)}`;
  }
  return res.status(200).json(out);
}
